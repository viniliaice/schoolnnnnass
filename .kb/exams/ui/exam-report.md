---
title: "ExamReport"
type: UI Page
tags: [exams, ui, admin, teacher, supervisor]
timestamp: 2026-07-27T00:00:00Z
description: "Report page showing exam results with filtering by class, month, exam type, and subject."
linked_concepts:
  - core:data-model/exams
  - core:data-model/report-comments
  - core:api/get-midterm-report
  - core:api/get-exam-report-rpc
---

## Details

- **Routes**: `/admin/exam-reports`, `/teacher/exam-reports`, `/supervisor/reports`
- **Roles**: Admin, Teacher, Supervisor

### Features

- Filter by class, month, exam type, subject
- View aggregated exam results
- Midterm report breakdown per student
- Teacher and principal comment display
