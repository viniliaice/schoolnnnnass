---
type: Configuration
title: ReportConfig
description: "Report card weight configuration — CA/midterm/final percentages and which exam types count as continuous assessment. Defined in src/types/index.ts but table has no CREATE in any SQL file."
tags: [core, configuration, reports]
timestamp: 2026-07-27T00:00:00Z
---

ReportConfig: caWeight, midtermWeight, finalWeight, caTypes[].
Used by reports.ts getReportConfig().

## Related

* [Constants](constants.md) — CA_TYPES constant informs `caTypes` defaults.
* [Missing Tables](missing-tables.md) — migration note for the report_config table's CREATE statement.
