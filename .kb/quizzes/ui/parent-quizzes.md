---
title: "ParentQuizzes (Quizzes)"
type: UI Page
tags: [quizzes, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent overview of available quizzes for their children."
linked_concepts:
  - "core:ui/take-quiz"
  - "core:data-model/quiz-attempts"
  - "core:data-model/quizzes"
---

## ParentQuizzes

- **Route:** `/parent/quizzes` (ParentQuizzes page — list view)
- **Role access:** parent
- **Capabilities:**
  - See all available (active) quizzes for linked students
  - View status, due dates, and scores for completed attempts
  - Navigate to the TakeQuiz page to start or resume an attempt

## Related

- [quizzes](../data-model/quizzes.md) — quizzes table
- [quiz-attempts](../data-model/quiz-attempts.md) — quiz_attempts table
- [quiz-api](../api/quiz-api.md) — listQuizzes, getQuiz functions
- [TakeQuiz](take-quiz.md) — student quiz-taking page
- [ParentDashboard](../../parent-portal/ui/parent-dashboard.md) — parent dashboard
