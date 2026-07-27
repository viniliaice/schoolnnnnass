---
title: "MonitorTeachers"
type: UI Page
tags: [exams, ui, admin, monitoring]
timestamp: 2026-07-27T00:00:00Z
description: "Admin dashboard for monitoring teacher exam entry progress across all classes and months."
linked_concepts:
  - core:api/teacher-exam-progress
  - core:ui/upload-results
---

## Details

- **Route**: `/admin/monitor`
- **Role**: Admin
- **Depends on**: `lib/db/progress.ts`

### Features

- Overview of all teachers' exam entry completion
- Per-teacher completion percentage and missing exam types
- Drill-down to specific class/subject/month
- Identify teachers behind on data entry
