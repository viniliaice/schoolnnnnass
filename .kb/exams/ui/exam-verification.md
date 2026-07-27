---
title: "ExamVerification"
type: UI Page
tags: [exams, ui, admin, supervisor]
timestamp: 2026-07-27T00:00:00Z
description: "Admin/supervisor page for approving or rejecting pending exam entries. Shows teacher-level progress with completion indicators."
linked_concepts:
  - core:data-model/exams
  - core:api/exam-status-counts
  - core:api/teacher-exam-progress
  - core:security/rls-policies
---

## Details

- **Routes**: `/admin/exams`, `/supervisor/verifications`
- **Roles**: Admin, Supervisor
- **Depends on**: `lib/db/exams.ts` (approvePending functions)

### Features

- Teacher-level progress indicators with completion status
- Approve or reject pending entries in bulk
- Filter by teacher, class, month, subject
- Uses `get_exam_status_counts` for dashboard counts
