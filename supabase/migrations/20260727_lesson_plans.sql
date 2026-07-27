-- Migration: AI Lesson & Unit Plan Review System
-- Creates: lesson_plans, lesson_plan_periods, ai_reviews tables
-- RLS policies, indexes, trigger, and atomic save RPC

-- ============================================================================
-- DAY-OF-WEEK ENUM PATH-DEPENDENCY NOTE
-- ============================================================================
-- The day_of_week enum below binds the school's confirmed teaching week
-- (Saturday through Wednesday). If a Sunday-prep day or Thursday is ever
-- added to the teaching schedule, this enum must be extended.
--
-- CRITICAL: PostgreSQL does NOT allow ALTER TYPE ... ADD VALUE inside the
-- same transaction as any other DDL on a table referencing that enum.
-- Therefore, adding a new teaching day requires TWO separate migrations:
--   1. ALTER TYPE day_of_week ADD VALUE 'Thursday' (standalone, no DDL on
--      lesson_plan_periods in same transaction)
--   2. Any schema changes that depend on the new value
--
-- Do NOT combine these into one migration file.
-- ============================================================================
CREATE TYPE day_of_week AS ENUM ('Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday');

-- ============================================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- LESSON PLANS (one row per week per teacher, per subject)
-- ============================================================================
CREATE TABLE lesson_plans (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  class_name TEXT NOT NULL,
  week_label TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'ai_failed')),
  period_count INTEGER NOT NULL CHECK (period_count BETWEEN 5 AND 6),
  previous_score INTEGER,
  previous_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lesson_plans_teacher_week ON lesson_plans(teacher_id, week_label);
CREATE INDEX IF NOT EXISTS idx_lesson_plans_status ON lesson_plans(status);

CREATE TRIGGER trg_lesson_plans_updated_at
  BEFORE UPDATE ON lesson_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- LESSON PLAN PERIODS (individual periods within a plan)
-- ============================================================================
CREATE TABLE lesson_plan_periods (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,
  day day_of_week NOT NULL,
  period_number INTEGER NOT NULL CHECK (period_number BETWEEN 1 AND 6),
  topic TEXT NOT NULL,
  activities TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(plan_id, day, period_number)
);

CREATE TRIGGER trg_lesson_plan_periods_updated_at
  BEFORE UPDATE ON lesson_plan_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- AI REVIEWS (one review per plan)
-- ============================================================================
CREATE TABLE ai_reviews (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES lesson_plans(id) ON DELETE CASCADE,
  scores JSONB NOT NULL,
  executive_summary TEXT NOT NULL,
  total_score INTEGER NOT NULL,
  percentage INTEGER NOT NULL,
  performance_level TEXT NOT NULL,
  strengths JSONB NOT NULL DEFAULT '[]',
  improvements JSONB NOT NULL DEFAULT '[]',
  ai_summary_notes JSONB NOT NULL DEFAULT '{}',
  additional_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed')),
  supervisor_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_reviews_status ON ai_reviews(status);

CREATE TRIGGER trg_ai_reviews_updated_at
  BEFORE UPDATE ON ai_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE lesson_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_plan_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reviews ENABLE ROW LEVEL SECURITY;

-- Admin: full access to everything (same wide-open pattern as existing tables)
CREATE POLICY "admin_all_plans" ON lesson_plans FOR ALL USING (true);
CREATE POLICY "admin_all_periods" ON lesson_plan_periods FOR ALL USING (true);
CREATE POLICY "admin_all_reviews" ON ai_reviews FOR ALL USING (true);

-- Teacher: full CRUD on own plans
CREATE POLICY "teacher_manage_own_plans" ON lesson_plans
  FOR ALL
  USING (teacher_id = auth.uid());

-- Teacher: full CRUD on own plan periods
CREATE POLICY "teacher_manage_own_periods" ON lesson_plan_periods
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM lesson_plans WHERE id = plan_id AND teacher_id = auth.uid())
  );

-- Teacher: read own reviews
CREATE POLICY "teacher_select_own_reviews" ON ai_reviews
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM lesson_plans WHERE id = plan_id AND teacher_id = auth.uid())
  );

-- Supervisor: read all plans and periods
CREATE POLICY "supervisor_select_all_plans" ON lesson_plans
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'supervisor')
  );

CREATE POLICY "supervisor_select_all_periods" ON lesson_plan_periods
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'supervisor')
  );

-- Supervisor: full access to reviews (including status/comment UPDATE)
CREATE POLICY "supervisor_manage_reviews" ON ai_reviews
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'supervisor')
  );

-- ============================================================================
-- ATOMIC SAVE RPC
-- ============================================================================
-- Saves all periods for a plan in a single transaction (delete-all + insert).
-- The caller passes the full day's period array as JSONB; this RPC ensures
-- all-or-nothing semantics so a partial failure never leaves orphan periods.
-- Uses SAVEPOINT to guard against mid-operation failure (process death between
-- DELETE and INSERT would otherwise leave the plan with zero periods).
CREATE OR REPLACE FUNCTION save_lesson_plan_periods(
  p_plan_id TEXT,
  p_periods JSONB
) RETURNS SETOF lesson_plan_periods
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  _sp TEXT := 'save_periods';
BEGIN
  SAVEPOINT _sp;

  DELETE FROM lesson_plan_periods WHERE plan_id = p_plan_id;

  INSERT INTO lesson_plan_periods (id, plan_id, day, period_number, topic, activities, sort_order)
  SELECT
    'period-' || p_plan_id || '-' || (elem->>'day') || '-' || (elem->>'period_number'),
    p_plan_id,
    (elem->>'day')::day_of_week,
    (elem->>'period_number')::INTEGER,
    elem->>'topic',
    elem->>'activities',
    row_number() OVER () - 1
  FROM jsonb_array_elements(p_periods) AS elem;

  RELEASE SAVEPOINT _sp;

  RETURN QUERY
  SELECT * FROM lesson_plan_periods
  WHERE plan_id = p_plan_id
  ORDER BY day, period_number;
EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK TO SAVEPOINT _sp;
    RAISE;
END;
$$;
