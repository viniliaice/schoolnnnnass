---
title: "quizzes"
type: Database Table
tags: [quizzes, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Quiz definitions — title, schedule, time limit, question ordering, and lifecycle status."
linked_concepts:
  - "core:data-model/quiz-questions"
  - "core:data-model/quiz-attempts"
  - "core:ui/create-quiz"
---

## quizzes

| Column        | Type     | Notes                                      |
|---------------|----------|--------------------------------------------|
| id            | text PK  | Primary key                                |
| className     | text     | Target class                               |
| subject       | text     | Subject                                    |
| title         | text     | Quiz title                                 |
| description   | text     | Quiz description                           |
| openDate      | date     | When quiz becomes available                |
| dueDate       | date     | Submission deadline                        |
| timeLimit     | int      | Time limit in minutes                      |
| questionOrder | text     | `created` | `randomized`                   |
| teacherId     | text FK  | → `profiles.id`                            |
| status        | text     | `draft` | `active` | `closed`                |
| createdAt     | timestamp| Creation timestamp                         |

**Indexes:** `idx_quizzes_class` ON (className), `idx_quizzes_teacher` ON (teacherId).

## Related

- [quiz-questions](quiz-questions.md) — junction table linking quizzes to questions
- [quiz-attempts](quiz-attempts.md) — student quiz submissions
- [quiz-api](../api/quiz-api.md) — CRUD functions for quizzes
- [CreateQuiz](../ui/create-quiz.md) — quiz creation UI
- [GradeQuizzes](../ui/grade-quizzes.md) — quiz grading UI
- [RLS Policies](../security/rls-policies.md) — teacher/student access rules
- [students](../../core/data-model/students.md) — student records
