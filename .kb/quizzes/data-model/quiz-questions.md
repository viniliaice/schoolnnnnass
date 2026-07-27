---
title: "quiz_questions"
type: Database Table
tags: [quizzes, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Junction table linking quizzes to questions with snapshots for immutability."
linked_concepts:
  - "core:data-model/questions"
  - "core:data-model/quizzes"
---

## quiz_questions

| Column               | Type     | Notes                              |
|----------------------|----------|------------------------------------|
| id                   | text PK  | Primary key                        |
| quizId               | text FK  | → `quizzes.id` CASCADE             |
| questionId           | text FK  | → `questions.id`                   |
| orderIndex           | int      | Display order                      |
| points               | int      | Default 1                          |
| promptSnapshot       | text     | Immutable prompt at quiz-creation  |
| optionsSnapshot      | JSONB    | Immutable options at quiz-creation |
| correctAnswerSnapshot| text     | Immutable answer at quiz-creation  |
| typeSnapshot         | text     | Immutable type at quiz-creation    |

**Index:** `idx_quiz_questions_quiz` ON (quizId).

## Related

- [questions](questions.md) — questions table (questionId FK)
- [quizzes](quizzes.md) — quizzes table (quizId FK)
- [quiz-api](../api/quiz-api.md) — addQuestionToQuiz, removeQuestionFromQuiz
- [CreateQuiz](../ui/create-quiz.md) — quiz creation UI
