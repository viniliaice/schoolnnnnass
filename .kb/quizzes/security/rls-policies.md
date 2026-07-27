---
title: "RLS Policies (Quizzes)"
type: Security Policy
tags: [quizzes, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "RLS on quiz tables — teachers own their quizzes/questions, students can read assigned quizzes and submit attempts."
linked_concepts:
  - "core:data-model/questions"
  - "core:data-model/quizzes"
  - "core:data-model/quiz-questions"
  - "core:data-model/quiz-attempts"
---

## RLS Policies

### questions
- **Teacher SELECT/INSERT/UPDATE/DELETE:** own questions only (`teacherId = auth.uid()`)
- **Student SELECT:** only questions linked to an active quiz the student is assigned to
- **Admin SELECT/INSERT/UPDATE/DELETE:** all rows

### quizzes
- **Teacher SELECT/INSERT/UPDATE/DELETE:** own quizzes only (`teacherId = auth.uid()`)
- **Student SELECT:** active or closed quizzes for their class
- **Admin SELECT/INSERT/UPDATE/DELETE:** all rows

### quiz_questions
- **Teacher SELECT/INSERT/UPDATE/DELETE:** quiz is owned by teacher
- **Student SELECT:** quiz is visible to student
- **Admin SELECT/INSERT/UPDATE/DELETE:** all rows
- **CASCADE deletes** on quiz removal

### quiz_attempts
- **Student INSERT:** self only (`studentId = auth.uid()`), one attempt per quiz
- **Student SELECT:** own attempts only
- **Student UPDATE:** own in-progress attempts only (`status = 'in_progress'`)
- **Teacher SELECT:** attempts on own quizzes
- **Teacher UPDATE:** grade direct-answer questions (`status` → `graded`, set `totalEarned`)
- **Admin SELECT/UPDATE:** all rows

## Related

- [questions](../data-model/questions.md) — questions table
- [quizzes](../data-model/quizzes.md) — quizzes table
- [quiz-questions](../data-model/quiz-questions.md) — quiz_questions junction table
- [quiz-attempts](../data-model/quiz-attempts.md) — quiz_attempts table
- [quiz-api](../api/quiz-api.md) — DB functions enforcing these policies
