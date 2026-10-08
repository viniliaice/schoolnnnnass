---
type: Data Model
title: "Former Students — status ledger and import history"
description: "student_status_changes, former_student_imports and former_student_import_rows: the audit trail behind the Former Students / Student Cleanup feature."
tags: [admin-tools, data-model, audit, former-students]
timestamp: 2026-10-08T00:00:00Z
linked_concepts:
  - "core:data-model/students"
  - "admin-tools:data-model/audit-logs"
  - "admin-tools:api/former-students-rpcs"
---

# Former Students — status ledger and import history

Added by `supabase/migrations/20261008_former_students_cleanup.sql`. Three
tables, all RLS **SELECT-for-admin only** with **no client write policy**: rows
are created inside the SECURITY DEFINER RPCs, so a status change can never be
forged or rewritten from the browser.

## student_status_changes (append-only ledger)

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | `ssc-<micros>-<hash8>` (backfill rows: `ssc-backfill-<studentId>`) |
| `studentId` | `text` FK | → `students.id` ON DELETE CASCADE |
| `studentName` | `text` | Name at the time of the change |
| `previousStatus` / `newStatus` | `text` | `active` \| `former` |
| `reason` | `text` CHECK | `former_import`, `former_manual`, `import_rollback`, `manual_restore`, `legacy_left_backfill` |
| `previousTransport` | `text` | Exact transport value before the change — this is what makes a restore/rollback exact instead of a guess |
| `changedBy` / `changedByName` | `text` | Acting administrator |
| `importId` / `fileName` | `text` | Provenance when the change came from an uploaded file |
| `note` | `text` | Free-text reason from the admin |
| `createdAt` | `timestamptz` | |

Indexes: `(studentId, createdAt DESC)`, `importId`, `createdAt DESC`.

**Rollback reads this table first.** `rollback_former_student_import` only
restores a student when the newest ledger row for them is the one its own import
wrote; anything changed afterwards is skipped and reported, so a rollback never
overwrites an unrelated later decision.

## former_student_imports (one row per uploaded file)

`id` (`fsi-<ms>-<hash6>`), `seq` **BIGSERIAL UNIQUE** → the human "Import #12"
number, `fileName`, `adminId`, `adminName`, `reason`, `status`
(`applied` \| `rolled_back` \| `partially_rolled_back`), the full preview
counters (`uploadedCount`, `validCount`, `missingNameCount`,
`missingSystemIdCount`, `duplicateSystemIdCount`, `duplicateNameCount`,
`foundCount`, `notFoundCount`, `exactMatchCount`, `nameConflictCount`,
`possibleDuplicateCount`, `reviewCount`, `alreadyFormerCount`, `readyCount`),
the outcome counters (`deactivatedCount`, `skippedCount`, `restoredCount`,
`rollbackSkippedCount`), `rolledBackAt/By/ByName`, `summary` JSONB, `createdAt`.

## former_student_import_rows (per-row result)

`id` (`fsr-…`), `importId` FK CASCADE, `rowNumber`, `uploadedName`,
`uploadedSystemId`, `studentId`, `studentName`, `className`, `matchStatus`,
`nameMatch`, `nameSimilarity`, `reasons` JSONB, `requestedAction`,
`adminConfirmed`, `actionTaken` (`deactivated` \| `kept_active` \| `skipped` \|
`blocked` \| `already_former`), `actionReason`, `previousStatus`, `newStatus`,
`restoredAt`, `restoredBy`, `createdAt`.

## Relationship to audit_logs

Per-student detail lives in `student_status_changes`; `audit_logs` gets one
aggregate entry per operation (`students.former_import`,
`students.former_import_rollback`, `students.status_change`,
`students.status_backfill`) carrying the student-id array and the counters — the
same convention the safe duplicate merge uses.

## Related

* [students](../../core/data-model/students.md) — the `status` column these tables explain.
* [Former Students cleanup RPCs](../api/former-students-rpcs.md) — the only write path.
* [audit-logs](audit-logs.md) — aggregate audit entries.
