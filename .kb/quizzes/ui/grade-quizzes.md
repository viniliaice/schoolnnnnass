---
title: "GradeQuizzes"
type: UI Page
tags: [quizzes, ui, teacher, admin, supervisor]
timestamp: 2026-07-27T00:00:00Z
description: "Manual grading interface for direct-answer quiz questions with per-attempt review."
linked_concepts:
  - "core:data-model/quiz-attempts"
  - "core:api/quiz-api"
  - "core:data-model/quiz-questions"
---

## GradeQuizzes

- **Routes:** `/admin/grade-quizzes`, `/teacher/grade-quizzes`, `/supervisor/grade-quizzes`
- **Role access:** admin, teacher, supervisor
- **Capabilities:**
  - View submitted quiz attempts grouped by quiz
  - Review student answers per attempt
  - Manually grade direct-answer questions using a rubric
  - Update scores and mark attempts as graded
