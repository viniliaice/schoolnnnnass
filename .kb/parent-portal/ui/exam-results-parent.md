---
okf_version: "0.1"
title: "ExamResults (Parent)"
type: UI Page
tags: [parent-portal, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent view of children's exam results filtered by child, subject, exam type, and month."
route: "/parent/results"
role: parent
cross_bundle_refs:
  - exams:api/getExamsByParent
  - exams:data-model/exams
  - core:data-model/students
---
# ExamResults (Parent)

**Route:** `/parent/results`  
**Role:** parent  

## Description

Parent-facing view of exam results for all enrolled children. Supports filtering by child, subject, exam type, and month range. Results displayed in a sortable table with score visualizations.

## Data Sources

| Data | Source |
|------|--------|
| Exam results | `exams:api/getExamsByParent` |

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| Child | Dropdown | Select which child's results to view |
| Subject | Dropdown | Filter by subject |
| Exam Type | Dropdown | e.g. "Midterm", "Final", "Quiz" |
| Month Range | Date range | Start and end date |

## Key Behaviors

- Sortable columns (date, subject, score, grade)
- Score bars with percentage labels
- Click a row to view detailed exam breakdown
- Printable report view
