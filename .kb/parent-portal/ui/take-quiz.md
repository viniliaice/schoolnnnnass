---
okf_version: "0.1"
title: "TakeQuiz (Parent)"
type: UI Page
tags: [parent-portal, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Quiz-taking interface for students — displays questions, tracks answers, submits for grading."
route: "/parent/quizzes"
component: TakeQuiz
role: parent
cross_bundle_refs:
  - quizzes:data-model/quizzes
  - quizzes:data-model/quiz-questions
  - quizzes:api/submitQuizAttempt
---
# TakeQuiz (Parent)

**Route:** `/parent/quizzes` (TakeQuiz component)  
**Role:** parent  

## Description

Quiz-taking interface rendered as a component within the ParentQuizzes page. Displays one question at a time with multiple-choice or short-answer options. Tracks answers client-side and submits the entire attempt for grading via `quizzes:api/submitQuizAttempt`.

## Data Sources

| Data | Source |
|------|--------|
| Quiz questions | `quizzes:data-model/quiz-questions` |
| Submission | `quizzes:api/submitQuizAttempt` |

## Key Behaviors

- Single-question-per-page navigation (Previous / Next)
- Progress indicator (e.g. "Question 3 of 10")
- Timer display if quiz is timed
- Review mode before final submission
- Auto-save on each answer
- Submission confirmation with score summary
