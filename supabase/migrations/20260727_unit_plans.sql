-- Migration: Unit Plans
-- Creates: unit_plans table, unit_id column on lesson_plans
-- RLS policies, indexes

-- ============================================================================
-- UNIT PLANS
-- ============================================================================
CREATE TABLE unit_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  week_number_start INTEGER NOT NULL CHECK (week_number_start >= 1),
  week_number_end INTEGER NOT NULL CHECK (week_number_end >= week_number_start),
  objectives TEXT NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unit_plans_teacher ON unit_plans(teacher_id);
CREATE INDEX IF NOT EXISTS idx_unit_plans_term ON unit_plans(term_id);
CREATE INDEX IF NOT EXISTS idx_unit_plans_class_subject ON unit_plans(class_name, subject_id);

CREATE TRIGGER trg_unit_plans_updated_at
  BEFORE UPDATE ON unit_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- LESSON PLANS: add unit_id FK
-- ============================================================================
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS unit_id TEXT REFERENCES unit_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lesson_plans_unit ON lesson_plans(unit_id);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE unit_plans ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "admin_all_unit_plans" ON unit_plans FOR ALL USING (true);

-- Teacher: full CRUD on own unit plans
CREATE POLICY "teacher_manage_own_unit_plans" ON unit_plans
  FOR ALL
  USING (teacher_id = auth.uid());

-- Supervisor: read all unit plans
CREATE POLICY "supervisor_select_all_unit_plans" ON unit_plans
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'supervisor'));
