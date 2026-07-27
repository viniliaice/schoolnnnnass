---
okf_version: "0.1"
title: "ExamReport (Admin/Supervisor/Teacher)"
type: UI Page
tags: [reports, ui, admin, teacher, supervisor]
timestamp: 2026-07-27T00:00:00Z
description: "Cross-role exam report page with filtering by class, month, exam type, and subject."
routes:
  - "/admin/exam-reports"
  - "/teacher/exam-reports"
  - "/supervisor/reports"
---

# ExamReport (Admin / Supervisor / Teacher)

Multi-role page for viewing and managing exam reports across classes.

## Routes

| Role | Route |
|---|---|
| Admin | `/admin/exam-reports` |
| Teacher | `/teacher/exam-reports` |
| Supervisor | `/supervisor/reports` |

## Filters

- Class
- Month
- Exam type (CA, Midterm, Final)
- Subject

## Capabilities

- **Teachers**: Write and edit report comments per student/subject
- **Supervisors**: Read all comments, approve/reject
- **Admin**: Full access — view, edit, approve, override

## Cross-References

- `security/rls-policies.md` — Row-level security for comment access
- `api/report-rpc.md` — `getReportComment` / `upsertReportComment`
- `exams:data-model/exams` — Source exam data

## Related

- [report-rpc](../api/report-rpc.md) — getReportComment / upsertReportComment
- [midterm-report-rpc](../api/midterm-report-rpc.md) — midterm RPC
- [report-config](../data-model/report-config.md) — weight configuration
- [grade-scales](../data-model/grade-scales.md) — grade scale mapping
- [grading-logic](../grading-logic.md) — client-side grading helpers
- [RLS Policies](../security/rls-policies.md) — comment access policies
- [exams](../../exams/data-model/exams.md) — source exam data
- [MonthlyReport](monthly-report.md) — monthly report UI
- [MidtermReport](midterm-report.md) — midterm report UI
- [FinalReport](final-report.md) — final report UI
