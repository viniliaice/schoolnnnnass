---
okf_version: "0.1"
title: "RLS Policies (Reports)"
type: Security Policy
tags: [reports, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "Report comment RLS — teachers write own, supervisors read/approve, parents read own children's."
---

# RLS Policies — Report Comments

## `report_comments` Table

| Role | Access | Policy |
|---|---|---|
| Teacher | **Write own** — `INSERT`, `UPDATE` where `teacher_id = auth.uid()` | Can create and edit their own comments on assigned subject/student combinations |
| Teacher | **Read own** — `SELECT` where `teacher_id = auth.uid()` | Can read back their own written comments |
| Supervisor | **Read all** — `SELECT` on any comment in their supervised classes | Can review any teacher's comments |
| Supervisor | **Approve** — `UPDATE` approval status | Can mark comments as approved |
| Parent | **Read own children** — `SELECT` where `student_id IN (auth.user().wards)` | Can only view comments on their own children's reports |
| Admin | **Full access** — no RLS restriction | Bypasses all policies |

## Cross-References

- `core:security/role-hierarchy` — Role definitions
- `ui/exam-report-admin.md` — UI consuming these policies

## Related

- [exams](../../exams/data-model/exams.md) — ExamResult source data
- [report-comments](../../exams/data-model/report-comments.md) — report_comments table
- [ExamReport](../ui/exam-report-admin.md) — exam report admin UI
- [report-rpc](../api/report-rpc.md) — report functions
