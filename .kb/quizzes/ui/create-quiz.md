---
title: "CreateQuiz"
type: UI Page
tags: [quizzes, ui, teacher, admin, supervisor]
timestamp: 2026-07-27T00:00:00Z
description: "Quiz builder — create questions, assemble quizzes, set scheduling and time limits."
linked_concepts:
  - "core:data-model/questions"
  - "core:data-model/quizzes"
  - "core:data-model/quiz-questions"
  - "core:api/quiz-api"
---

## CreateQuiz

- **Routes:** `/admin/quizzes`, `/teacher/quizzes`, `/supervisor/quizzes`
- **Role access:** admin, teacher, supervisor
- **Capabilities:**
  - Create and manage reusable questions (MC + direct-answer)
  - Assemble quizzes by adding questions from the bank
  - Set scheduling (open/due dates), time limit, question ordering
  - Publish (status → active) or close quizzes
