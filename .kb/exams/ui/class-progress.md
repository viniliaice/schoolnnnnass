---
title: "ClassProgress"
type: UI Page
tags: [exams, ui, admin, progress]
timestamp: 2026-07-27T00:00:00Z
description: "Admin view of per-student exam entry progress for a selected class and month."
linked_concepts:
  - core:api/class-student-subject-progress
  - core:ui/exam-verification
---

## Details

- **Route**: `/admin/class-progress`
- **Role**: Admin
- **Depends on**: `getClassStudentSubjectProgress` RPC

### Features

- Select class and month
- Per-student, per-subject progress table
- Shows which exam types are missing per student
- Links to verification for bulk actions
