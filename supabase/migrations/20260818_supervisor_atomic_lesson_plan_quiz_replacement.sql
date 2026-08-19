-- Correct the atomic lesson-plan quiz replacement authorization without
-- rewriting the already-applied 20260813 migration. Generation and semantic
-- validation remain outside this RPC; the browser calls it only after every
-- subject has a complete validated 3-by-4 replacement.
--
-- The authenticated actor must be a supervisor/admin. Generated quizzes and
-- questions remain attributed to the teacher who owns the lesson plan.

CREATE OR REPLACE FUNCTION replace_generated_lesson_plan_quizzes(
  p_plan_id TEXT,
  p_quizzes JSONB,
  p_questions JSONB,
  p_quiz_questions JSONB
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_actor_profile_id TEXT;
  v_actor_role TEXT;
  v_plan_teacher_id TEXT;
  v_quiz_count INTEGER;
  v_question_count INTEGER;
  v_junction_count INTEGER;
BEGIN
  SELECT id, role INTO v_actor_profile_id, v_actor_role
  FROM profiles
  WHERE auth_id = auth.uid();

  IF v_actor_profile_id IS NULL
     OR COALESCE(v_actor_role, '') NOT IN ('supervisor', 'admin') THEN
    RAISE EXCEPTION 'Only a supervisor or administrator may replace generated lesson-plan quizzes.'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent redo attempts for the same plan before touching the
  -- current set. A later complete redo may win, but sets can never interleave.
  SELECT teacher_id INTO v_plan_teacher_id
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lesson plan % was not found.', p_plan_id
      USING ERRCODE = 'P0002';
  END IF;


  IF jsonb_typeof(p_quizzes) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_questions) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_quiz_questions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Quiz replacement payloads must be JSON arrays.'
      USING ERRCODE = '22023';
  END IF;

  v_quiz_count := jsonb_array_length(p_quizzes);
  v_question_count := jsonb_array_length(p_questions);
  v_junction_count := jsonb_array_length(p_quiz_questions);

  -- Each represented subject must contain exactly three quizzes and every quiz
  -- exactly four questions. The upper bound prevents oversized direct RPC use.
  IF v_quiz_count < 3
     OR v_quiz_count > 90
     OR v_quiz_count % 3 <> 0
     OR v_question_count <> v_quiz_count * 4
     OR v_junction_count <> v_question_count THEN
    RAISE EXCEPTION 'Quiz replacement must contain three quizzes per subject and four questions per quiz.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT quiz.value ->> 'subject' AS subject_id, COUNT(*) AS quiz_count
      FROM jsonb_array_elements(p_quizzes) AS quiz(value)
      GROUP BY quiz.value ->> 'subject'
    ) AS subject_sets
    WHERE subject_id IS NULL OR quiz_count <> 3
  ) THEN
    RAISE EXCEPTION 'Each quiz subject must have exactly three quizzes.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT COUNT(DISTINCT quiz.value ->> 'id') FROM jsonb_array_elements(p_quizzes) AS quiz(value)) <> v_quiz_count
     OR (SELECT COUNT(DISTINCT question.value ->> 'id') FROM jsonb_array_elements(p_questions) AS question(value)) <> v_question_count
     OR (SELECT COUNT(DISTINCT junction.value ->> 'id') FROM jsonb_array_elements(p_quiz_questions) AS junction(value)) <> v_junction_count THEN
    RAISE EXCEPTION 'Quiz replacement IDs must be present and unique.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_quizzes) AS quiz(value)
    WHERE quiz.value ->> 'lesson_plan_id' IS DISTINCT FROM p_plan_id
       OR quiz.value ->> 'teacherId' IS DISTINCT FROM v_plan_teacher_id
       OR quiz.value -> 'auto_generated' IS DISTINCT FROM 'true'::JSONB
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_questions) AS question(value)
    WHERE question.value ->> 'source_lesson_plan_id' IS DISTINCT FROM p_plan_id
       OR question.value ->> 'teacherId' IS DISTINCT FROM v_plan_teacher_id
       OR question.value -> 'source_auto_generated' IS DISTINCT FROM 'true'::JSONB
       OR NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_quizzes) AS quiz(value)
         WHERE quiz.value ->> 'id' = question.value ->> 'source_quiz_id'
       )
  ) THEN
    RAISE EXCEPTION 'Quiz replacement rows do not belong to this lesson plan and teacher.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_quizzes) AS quiz(value)
    WHERE (SELECT COUNT(*)
           FROM jsonb_array_elements(p_questions) AS question(value)
           WHERE question.value ->> 'source_quiz_id' = quiz.value ->> 'id') <> 4
       OR (SELECT COUNT(*)
           FROM jsonb_array_elements(p_questions) AS question(value)
           WHERE question.value ->> 'source_quiz_id' = quiz.value ->> 'id'
             AND question.value ->> 'type' = 'direct_answer') < 1
  ) THEN
    RAISE EXCEPTION 'Every quiz must have four questions including a direct-answer question.'
      USING ERRCODE = '22023';
  END IF;

  -- Require a one-to-one question/junction mapping, matching quiz ownership,
  -- and a complete unambiguous 0..3 order for each quiz.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_questions) AS question(value)
    WHERE (SELECT COUNT(*)
           FROM jsonb_array_elements(p_quiz_questions) AS junction(value)
           WHERE junction.value ->> 'questionId' = question.value ->> 'id'
             AND junction.value ->> 'quizId' = question.value ->> 'source_quiz_id') <> 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_quiz_questions) AS junction(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_questions) AS question(value)
      WHERE question.value ->> 'id' = junction.value ->> 'questionId'
        AND question.value ->> 'source_quiz_id' = junction.value ->> 'quizId'
    )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_quizzes) AS quiz(value)
    WHERE (SELECT COUNT(DISTINCT (junction.value ->> 'orderIndex')::INTEGER)
           FROM jsonb_array_elements(p_quiz_questions) AS junction(value)
           WHERE junction.value ->> 'quizId' = quiz.value ->> 'id') <> 4
       OR (SELECT MIN((junction.value ->> 'orderIndex')::INTEGER)
           FROM jsonb_array_elements(p_quiz_questions) AS junction(value)
           WHERE junction.value ->> 'quizId' = quiz.value ->> 'id') <> 0
       OR (SELECT MAX((junction.value ->> 'orderIndex')::INTEGER)
           FROM jsonb_array_elements(p_quiz_questions) AS junction(value)
           WHERE junction.value ->> 'quizId' = quiz.value ->> 'id') <> 3
  ) THEN
    RAISE EXCEPTION 'Quiz replacement junction rows are incomplete or malformed.'
      USING ERRCODE = '22023';
  END IF;

  -- A function call is one PostgreSQL transaction: if any insert or constraint
  -- fails, these deletes and all prior inserts are rolled back automatically.
  DELETE FROM quizzes
  WHERE lesson_plan_id = p_plan_id
    AND auto_generated = true;

  DELETE FROM questions
  WHERE source_lesson_plan_id = p_plan_id
    AND source_auto_generated = true;

  INSERT INTO quizzes (
    id, "className", subject, title, description, "openDate", "dueDate",
    "timeLimit", "questionOrder", "teacherId", status, "createdAt",
    lesson_plan_id, auto_generated
  )
  SELECT
    row.id, row."className", row.subject, row.title, row.description,
    row."openDate", row."dueDate", row."timeLimit", row."questionOrder",
    row."teacherId", row.status, row."createdAt", row.lesson_plan_id,
    row.auto_generated
  FROM jsonb_to_recordset(p_quizzes) AS row(
    id TEXT,
    "className" TEXT,
    subject TEXT,
    title TEXT,
    description TEXT,
    "openDate" DATE,
    "dueDate" DATE,
    "timeLimit" INTEGER,
    "questionOrder" TEXT,
    "teacherId" TEXT,
    status TEXT,
    "createdAt" TIMESTAMPTZ,
    lesson_plan_id TEXT,
    auto_generated BOOLEAN
  );

  INSERT INTO questions (
    id, prompt, type, options, "correctAnswer", rubric, "teacherId",
    "createdAt", source_lesson_plan_id, source_quiz_id, source_subject_id,
    source_class_name, source_auto_generated
  )
  SELECT
    row.id, row.prompt, row.type, row.options, row."correctAnswer", row.rubric,
    row."teacherId", row."createdAt", row.source_lesson_plan_id,
    row.source_quiz_id, row.source_subject_id, row.source_class_name,
    row.source_auto_generated
  FROM jsonb_to_recordset(p_questions) AS row(
    id TEXT,
    prompt TEXT,
    type TEXT,
    options JSONB,
    "correctAnswer" TEXT,
    rubric TEXT,
    "teacherId" TEXT,
    "createdAt" TIMESTAMPTZ,
    source_lesson_plan_id TEXT,
    source_quiz_id TEXT,
    source_subject_id TEXT,
    source_class_name TEXT,
    source_auto_generated BOOLEAN
  );

  INSERT INTO quiz_questions (
    id, "quizId", "questionId", "orderIndex", points, "promptSnapshot",
    "optionsSnapshot", "correctAnswerSnapshot", "typeSnapshot"
  )
  SELECT
    row.id, row."quizId", row."questionId", row."orderIndex", row.points,
    row."promptSnapshot", row."optionsSnapshot", row."correctAnswerSnapshot",
    row."typeSnapshot"
  FROM jsonb_to_recordset(p_quiz_questions) AS row(
    id TEXT,
    "quizId" TEXT,
    "questionId" TEXT,
    "orderIndex" INTEGER,
    points INTEGER,
    "promptSnapshot" TEXT,
    "optionsSnapshot" JSONB,
    "correctAnswerSnapshot" TEXT,
    "typeSnapshot" TEXT
  );

  RETURN jsonb_build_object(
    'quiz_count', v_quiz_count,
    'question_count', v_question_count
  );
END;
$$;

REVOKE ALL ON FUNCTION replace_generated_lesson_plan_quizzes(TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_generated_lesson_plan_quizzes(TEXT, JSONB, JSONB, JSONB) TO authenticated;
