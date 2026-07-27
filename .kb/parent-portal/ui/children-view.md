---
okf_version: "0.1"
title: "ChildrenView"
type: UI Page
tags: [parent-portal, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Detailed view of all enrolled children with class info, academic stats, and quick links to reports."
route: "/parent/children"
role: parent
cross_bundle_refs:
  - core:data-model/students
  - core:schemas/student
  - exams:data-model/exams
  - attendance:data-model/attendance
  - homework:data-model/homework
---
# ChildrenView

**Route:** `/parent/children`  
**Role:** parent  

## Description

Detailed view listing all children linked to the parent account. Each entry includes class name, teacher name, academic performance summary, attendance stats, and quick-action links to exam reports, quiz lists, and homework overview.

## Data Sources

| Data | Source |
|------|--------|
| Children list | `getParentPortalSnapshot().children` |
| Academic stats | `getParentPortalSnapshot().recentExams` |
| Attendance | `getParentPortalSnapshot().attendanceSummary` |

## Key Behaviors

- Expandable rows for each child's detailed stats
- Quick links: "View Results" → `/parent/results?childId=:id`, "View Quizzes" → `/parent/quizzes?childId=:id`
- Color-coded performance indicators (green ≥ 80%, yellow ≥ 60%, red < 60%)
- Search and filter by child name or class
