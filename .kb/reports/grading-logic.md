---
okf_version: "0.1"
title: "Grading Logic Constants"
type: Configuration
tags: [reports, grading]
timestamp: 2026-07-27T00:00:00Z
description: "Client-side grading helpers: getGrade (A≥90/B≥80/C≥70/D≥60/F<60), isPassing, getPerformanceLevel, PERFORMANCE_LEVELS with min scores and colors."
source_file: "src/types/index.ts"
---

# Grading Logic Constants

Defined in `src/types/index.ts`.

## `getGrade(score: number): string`

Returns letter grade from numeric score:

| Range | Grade |
|---|---|
| ≥ 90 | A |
| ≥ 80 | B |
| ≥ 70 | C |
| ≥ 60 | D |
| < 60 | F |

## `isPassing(grade: string): boolean`

Returns `true` for grades A, B, C; `false` for D and F.

## `getPerformanceLevel(score: number): string`

Categorizes a score into a named performance level.

## `PERFORMANCE_LEVELS`

Array of `{ minScore: number; label: string; color: string }` used for UI color coding.

## Cross-References

- `data-model/grade-scales.md` — Server-side equivalent grade mapping
- `ui/monthly-report.md` — Consumer of these helpers
- `ui/midterm-report.md` — Consumer
- `ui/final-report.md` — Consumer

## Related

- [grade-scales](data-model/grade-scales.md) — server-side grade scale mapping
- [report-config](data-model/report-config.md) — weight configuration for composite scores
- [report-rpc](api/report-rpc.md) — report computation functions
- [MonthlyReport](ui/monthly-report.md) — monthly report UI
- [MidtermReport](ui/midterm-report.md) — midterm report UI
- [FinalReport](ui/final-report.md) — final report UI
