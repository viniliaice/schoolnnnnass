---
okf_version: "0.1"
title: "ParentQuizzes (Parent Portal)"
type: UI Page
tags: [parent-portal, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "List of available quizzes for a parent's children with links to TakeQuiz."
route: "/parent/quizzes"
role: parent
cross_bundle_refs:
  - quizzes:api/getQuizzesByParent
  - quizzes:data-model/quizzes
  - core:data-model/students
---
# ParentQuizzes

**Route:** `/parent/quizzes`  
**Role:** parent  

## Description

Lists all quizzes available to a parent's children. Each entry shows quiz title, subject, due date, status (pending/completed), and score if already taken. "Take Quiz" button launches the `TakeQuiz` component.

## Data Sources

| Data | Source |
|------|--------|
| Quizzes | `quizzes:api/getQuizzesByParent` |

## Key Behaviors

- Filter by child, subject, status (pending/completed)
- "Take Quiz" button disabled if already completed
- Completed quizzes show score and grade
- Due date highlighted in red if overdue
