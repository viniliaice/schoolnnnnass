-- Persist per-period instructional AI review rows and link auto-generated
-- lesson-plan quizzes back to their source plan.

CREATE TABLE IF NOT EXISTS lesson_period_ai_reviews (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,
  period_id TEXT REFERENCES lesson_plan_periods(id) ON DELETE CASCADE,
  period_order INTEGER NOT NULL,
  alignment_status TEXT NOT NULL CHECK (alignment_status IN ('fully_aligned', 'partially_aligned', 'not_aligned')),
  review_text TEXT NOT NULL,
  alignment_reason TEXT,
  alignment_gap TEXT,
  suggested_activities JSONB,
  unit_plan_id TEXT REFERENCES unit_plans(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(plan_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_period_ai_reviews_plan ON lesson_period_ai_reviews(plan_id);
CREATE INDEX IF NOT EXISTS idx_lesson_period_ai_reviews_period ON lesson_period_ai_reviews(period_id);

DROP TRIGGER IF EXISTS trg_lesson_period_ai_reviews_updated_at ON lesson_period_ai_reviews;
CREATE TRIGGER trg_lesson_period_ai_reviews_updated_at
  BEFORE UPDATE ON lesson_period_ai_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE lesson_period_ai_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_all_period_ai_reviews" ON lesson_period_ai_reviews;
CREATE POLICY "admin_all_period_ai_reviews" ON lesson_period_ai_reviews
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.auth_id = auth.uid()
        AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.auth_id = auth.uid()
        AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "teacher_select_own_period_ai_reviews" ON lesson_period_ai_reviews;
CREATE POLICY "teacher_select_own_period_ai_reviews" ON lesson_period_ai_reviews
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM lesson_plans lp
      JOIN profiles p ON p.id = lp.teacher_id
      WHERE lp.id = lesson_period_ai_reviews.plan_id
        AND p.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "supervisor_manage_period_ai_reviews" ON lesson_period_ai_reviews;
CREATE POLICY "supervisor_manage_period_ai_reviews" ON lesson_period_ai_reviews
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.auth_id = auth.uid()
        AND p.role IN ('supervisor', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.auth_id = auth.uid()
        AND p.role IN ('supervisor', 'admin')
    )
  );

-- Link quizzes generated from a lesson plan to the source plan so the review
-- page can show an inline preview without guessing by title/date.
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS lesson_plan_id TEXT REFERENCES lesson_plans(id) ON DELETE SET NULL;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_quizzes_lesson_plan ON quizzes(lesson_plan_id);

-- Source tracking for generated questions and idempotent "Add to Quiz Bank".
ALTER TABLE questions ADD COLUMN IF NOT EXISTS source_lesson_plan_id TEXT REFERENCES lesson_plans(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS source_quiz_id TEXT REFERENCES quizzes(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS source_auto_generated BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_questions_source_quiz ON questions(source_quiz_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_teacher_source_quiz_prompt_bank
  ON questions("teacherId", source_quiz_id, prompt)
  WHERE source_quiz_id IS NOT NULL AND source_auto_generated = false;
