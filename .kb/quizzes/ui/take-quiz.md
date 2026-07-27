---
title: "TakeQuiz"
type: UI Page
tags: [quizzes, ui, parent, student]
timestamp: 2026-07-27T00:00:00Z
description: "Student quiz-taking interface — displays active quizzes, tracks time, submits answers."
linked_concepts:
  - "core:data-model/quiz-attempts"
  - "core:api/quiz-api"
  - "core:ui/parent-quizzes"
---

## TakeQuiz

- **Route:** `/parent/quizzes` (TakeQuiz page)
- **Role access:** parent, student
- **Capabilities:**
  - Display active quiz questions (MC and direct-answer)
  - Inline timer showing remaining time based on `timeLimit`
  - Save answers in-progress
  - Submit attempt and see auto-graded MC results

## Related

- [quiz-attempts](../data-model/quiz-attempts.md) — quiz_attempts table
- [quiz-api](../api/quiz-api.md) — startAttempt, saveAnswer, submitAttempt
- [ParentQuizzes](parent-quizzes.md) — parent quiz list page
- [GradeQuizzes](grade-quizzes.md) — teacher grading UI
- [quizzes](../data-model/quizzes.md) — quizzes table
