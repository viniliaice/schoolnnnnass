---
title: "Quiz DB Functions"
type: Database Function
tags: [quizzes, api]
timestamp: 2026-07-27T00:00:00Z
description: "Database-level quiz operations: startAttempt, saveAnswer, submitAttempt, gradeDirectAnswer, and all CRUD functions from lib/db/quizzes.ts."
linked_concepts:
  - "core:data-model/quiz-attempts"
  - "core:data-model/quiz-questions"
  - "core:ui/take-quiz"
  - "core:ui/grade-quizzes"
---

## Quiz DB Functions

Located in `lib/db/quizzes.ts`:

| Function           | Description                                                |
|--------------------|------------------------------------------------------------|
| createQuestion     | Insert a new question into the bank                        |
| updateQuestion     | Update an existing question (teacher-owned)                |
| deleteQuestion     | Soft/hard delete a question                                |
| getQuestions       | List questions (filterable by teacher, type, class)        |
| createQuiz         | Create a quiz definition                                   |
| updateQuiz         | Update quiz metadata                                       |
| deleteQuiz         | Remove a quiz                                              |
| getQuiz            | Fetch a single quiz with its questions                     |
| listQuizzes        | List quizzes (filterable by class, teacher, status)        |
| addQuestionToQuiz  | Link a question to a quiz (takes snapshot)                 |
| removeQuestionFromQuiz | Unlink a question from a quiz                          |
| reorderQuestions   | Update question ordering                                   |
| startAttempt       | Begin a new quiz attempt for a student                     |
| saveAnswer         | Persist an in-progress answer                              |
| submitAttempt      | Finalize attempt, compute auto-grade for multiple-choice   |
| gradeDirectAnswer  | Teacher grades a direct-answer question manually           |
| getAttempt         | Fetch a single attempt with answers                        |
| listAttempts       | List attempts for a quiz or student                        |

## Related

- [questions](../data-model/questions.md) — questions table
- [quizzes](../data-model/quizzes.md) — quizzes table
- [quiz-questions](../data-model/quiz-questions.md) — quiz_questions junction table
- [quiz-attempts](../data-model/quiz-attempts.md) — quiz_attempts table
- [CreateQuiz](../ui/create-quiz.md) — quiz creation UI
- [GradeQuizzes](../ui/grade-quizzes.md) — quiz grading UI
- [TakeQuiz](../ui/take-quiz.md) — student quiz-taking UI
