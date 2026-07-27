---
title: "UploadResults"
type: UI Page
tags: [exams, ui, teacher]
timestamp: 2026-07-27T00:00:00Z
description: "Teacher-facing bulk exam entry page — select class, subject, exam type, month and enter scores per student."
linked_concepts:
  - core:data-model/exams
  - core:api/teacher-exam-progress
  - core:security/rls-policies
---

## Details

- **Route**: `/teacher/results`
- **Role**: Teacher
- **Depends on**: `lib/db/exams.ts` (insert/update exam functions)

### Flow

1. Select class, subject, exam type, month
2. System loads students for the selected class
3. Teacher enters scores per student
4. Bulk submit creates pending exam entries
