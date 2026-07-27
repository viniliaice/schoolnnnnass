---
okf_version: "0.1"
title: "report_config"
type: Database Table
tags: [reports, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Report card weight configuration — CA, midterm, final weights with CA exam type membership list."
columns:
  - caWeight
  - midtermWeight
  - finalWeight
  - caTypes
source_file: "lib/db/reports.ts"
accessor_function: "getReportConfig()"
---

# `report_config`

Stores the weighting formula used to compute final composite scores.

## Columns

| Column | Type | Description |
|---|---|---|
| `caWeight` | `numeric` | Weight assigned to Continuous Assessment scores |
| `midtermWeight` | `numeric` | Weight assigned to midterm exam scores |
| `finalWeight` | `numeric` | Weight assigned to final exam scores |
| `caTypes` | `text[]` | Array of exam type identifiers that count as CA |

## Usage

Loaded by `lib/db/reports.ts` → `getReportConfig()` and used by all three report RPCs to compute weighted scores.

## Cross-References

- `exams:data-model/exam-types` — Exam types referenced by `caTypes[]`

## Related

- [report-config-type](../../core/data-model/report-config-type.md) — TypeScript type definition
- [grade-scales](grade-scales.md) — grade scale configuration
- [grading-logic](../grading-logic.md) — client-side grading helpers
- [report-rpc](../api/report-rpc.md) — report functions using this config
- [midterm-report-rpc](../api/midterm-report-rpc.md) — midterm RPC using this config
