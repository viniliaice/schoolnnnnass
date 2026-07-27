---
type: Database Function
title: Audit Log Functions
description: "Client-side audit logging functions — createAuditLog and getAuditLogs with AuditAction and AuditEntry types."
tags: [admin-tools, api, audit]
timestamp: 2026-07-27T00:00:00Z
---

AuditAction type: user_created|user_updated|user_deleted|student_created|student_updated|student_deleted|exam_created|exam_updated|exam_deleted|exam_bulk_approved|promotion_performed|promotion_undone.
AuditEntry: id (bigint), action, details (jsonb), createdAt.
From lib/db/audit.ts.

## Related

- [Audit Logs](../data-model/audit-logs.md) — table these functions write to and query
- [Admin Dashboard](../ui/admin-dashboard.md) — UI that displays audit log data
- [Profiles](../../core/data-model/profiles.md) — user records affected by user_* audit actions
- [Students](../../core/data-model/students.md) — student records affected by student_* audit actions
