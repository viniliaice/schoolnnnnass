---
title: "questions"
type: Database Table
tags: [quizzes, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Reusable question bank — multiple choice and direct answer questions with rubrics."
linked_concepts:
  - "core:data-model/quiz-questions"
  - "core:api/quiz-api"
---

## questions

| Column         | Type     | Notes                             |
|----------------|----------|-----------------------------------|
| id             | text PK  | Primary key                       |
| prompt         | text     | Question prompt                   |
| type           | text     | CHECK: `multiple_choice` | `direct_answer` |
| options        | JSONB    | For multiple-choice options       |
| correctAnswer  | text     | Correct answer                    |
| rubric         | text     | Grading rubric                    |
| teacherId      | text FK  | → `profiles.id`                   |
| createdAt      | timestamp| Creation timestamp                |

## Related

- [quiz-questions](quiz-questions.md) — junction linking questions to quizzes
- [quiz-api](../api/quiz-api.md) — CRUD functions for questions
- [RLS Policies](../security/rls-policies.md) — teacher/student access rules
- [students](../../core/data-model/students.md) — student records
