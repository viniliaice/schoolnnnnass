---
title: "RLS Policies (Exams)"
type: Security Policy
tags: [exams, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "Row-level security on exams table — teachers INSERT/UPDATE only for assignedSubjects, SELECT allowed for all authenticated."
linked_concepts:
  - core:data-model/exams
  - core:ui/upload-results
  - core:ui/exam-verification
---

## Policy: exams_table

| Operation | Role | Rule |
|-----------|------|------|
| INSERT | Teacher | Only for subjects where the teacher's `assignedSubjects` (JSONB) overlaps with the entry's subject |
| UPDATE | Teacher | Only for own entries matching `assignedSubjects` overlap |
| SELECT | All authenticated | All rows visible |

### Mechanism

Uses JSONB overlap check on the `assignedSubjects` column in `profiles` to determine whether the authenticated teacher may insert or update exam records for a given subject.

## Related

- [exams](../data-model/exams.md) — table protected by these policies
- [upload-results](../ui/upload-results.md) — teacher upload page (INSERT/UPDATE)
- [exam-verification](../ui/exam-verification.md) — verification page (UPDATE for approval)
- [exam-functions](../api/exam-functions.md) — functions executing under these policies
- [exam-report](../ui/exam-report.md) — report page (SELECT only)
