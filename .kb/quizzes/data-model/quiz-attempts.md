---
title: "quiz_attempts"
type: Database Table
tags: [quizzes, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Student quiz submissions — answers, scores, timing, and grading status."
linked_concepts:
  - "core:data-model/quizzes"
  - "core:ui/grade-quizzes"
  - "core:ui/take-quiz"
---

## quiz_attempts

| Column        | Type     | Notes                                  |
|---------------|----------|----------------------------------------|
| id            | text PK  | Primary key                            |
| quizId        | text FK  | → `quizzes.id` CASCADE                 |
| studentId     | text FK  | → `students.id` CASCADE                |
| answers       | JSONB    | Student answers                        |
| totalEarned   | numeric  | Score earned                           |
| totalPossible | numeric  | Maximum possible score                 |
| startedAt     | timestamp| When attempt began                     |
| submittedAt   | timestamp| When attempt was submitted             |
| status        | text     | `in_progress` | `submitted` | `graded` |

**Constraints:** UNIQUE (quizId, studentId).

**Indexes:** `idx_quiz_attempts_quiz` ON (quizId), `idx_quiz_attempts_student` ON (studentId).

## Related

- [quizzes](quizzes.md) — quizzes table (quizId FK)
- [quiz-api](../api/quiz-api.md) — startAttempt, submitAttempt, gradeDirectAnswer
- [TakeQuiz](../ui/take-quiz.md) — student quiz-taking UI
- [GradeQuizzes](../ui/grade-quizzes.md) — teacher grading UI
- [RLS Policies](../security/rls-policies.md) — student/teacher access rules
- [students](../../core/data-model/students.md) — student records
