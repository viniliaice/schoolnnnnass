---
type: UI Page
title: "AcademicWorkspace"
description: "Curriculum document management, workload analytics dashboard, and teaching assignment summaries."
tags: [admin-tools, ui, admin]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Central hub for academic administration. Provides curriculum document upload/management (PDF), workload analytics with visual dashboards, and teaching assignment summaries.

# Route

`/admin/academic` (AcademicWorkspace tab)

# Sub-Components

| Component | Purpose |
|-----------|---------|
| CurriculumPdf | PDF upload and management for curriculum documents |
| Summary | Teaching assignment summary view |
| WorkloadAnalytics | Dashboard with workload distribution charts and metrics |

# Custom Hooks

| Hook | Purpose |
|------|---------|
| useAcademicWorkspaceData | Fetches and caches workspace data from the API |

# Utility Modules

| Module | Purpose |
|--------|---------|
| workloadWarnings | Generates warnings for over/under-allocated teachers |
| curriculumPdfExport | Handles PDF generation and export for curriculum documents |

## Related

- [Admin Dashboard](admin-dashboard.md) — parent admin UI that hosts this workspace as a tab
- [Subjects](../../core/data-model/subjects.md) — subject data used in workload analytics
- [Class-Subjects](../../core/data-model/class-subjects.md) — teaching assignments driving the Summary view
- [Admin Role](../../admin-role.md) — role required to access academic workspace
