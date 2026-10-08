---
type: API
title: "Former Students cleanup RPCs"
description: "The admin-gated SQL functions behind Former Students / Student Cleanup: matching contract, preview, atomic apply, batch rollback and the former-students directory."
tags: [admin-tools, api, rpc, security, former-students]
timestamp: 2026-10-08T00:00:00Z
linked_concepts:
  - "core:data-model/students"
  - "admin-tools:data-model/former-students"
  - "admin-tools:ui/former-student-cleanup"
  - "admin-tools:security/rls-policies"
---

# Former Students cleanup RPCs

All from `supabase/migrations/20261008_former_students_cleanup.sql`. Every one
is `SECURITY DEFINER … SET search_path = public`, re-checks
`current_profile_role() = 'admin'` internally, is `REVOKE`d from `PUBLIC` and
`GRANT EXECUTE`d to `authenticated` (the two-tier convention from
`20260925_safe_duplicate_batch.sql`). Client wrappers: `src/lib/db/formerStudents.ts`.

| Function | Kind | Purpose |
|----------|------|---------|
| `former_students_policy()` | IMMUTABLE, public | The documented policy: match key, status/action labels, `confirmPhrase` (`MARK AS FORMER STUDENTS`), `rollbackConfirmPhrase` (`ROLLBACK IMPORT`), `maxRows` (5000), auto-safe conditions, never-deactivate list, invariants. Single source of truth for rules AND UI text. |
| `_former_name_key(text)` / `_former_name_key_loose(text)` / `_former_name_similarity(a,b)` | IMMUTABLE, **EXECUTE revoked** | Name normalization + token-Jaccard similarity for COMPARISON only. |
| `_former_evaluate_rows(jsonb)` | STABLE, **EXECUTE revoked** | The matching contract. Used by both preview and apply, so the client can only NARROW scope, never widen it. |
| `preview_former_student_import(p_rows)` | STABLE | **Dry run — zero writes.** Returns `{dryRun, writesPerformed:0, summary, rows, policy}`. |
| `apply_former_student_import(p_rows, p_file_name, p_reason)` | write | One atomic transaction: re-evaluates from the LIVE table, creates the import + per-row records, flips `status`/`transport`, writes the ledger and one aggregate `audit_logs` row. |
| `rollback_former_student_import(p_import_id, p_confirm_phrase)` | write | Restores one batch, audit-checked (see ledger doc). |
| `list_former_student_imports(p_limit, p_offset)` | STABLE | Import history, newest first, with `importNumber`. |
| `get_former_student_import(p_import_id, p_limit, p_offset)` | STABLE | One import + its per-row audit trail. |
| `list_former_students(p_search, p_class, p_limit, p_offset)` | STABLE | The directory: search by name / System ID / Gov ID, filter by last class, with `markedFormerAt/By/ByName` and the latest ledger entry. |
| `set_student_former_status(p_student_id, p_status, p_reason)` | write | One student: mark former or restore to Active (restores the exact previous transport). Idempotent (`already_in_state`). |

## Matching contract (`_former_evaluate_rows`)

Match key: `upper(btrim(students.id)) = upper(btrim(uploaded System ID))` —
**exact, and the only key**. Names are never used to find a student.

| Situation | `matchStatus` | `defaultAction` | Auto-safe? |
|-----------|---------------|-----------------|------------|
| ID matches one student, names agree (exact / case / spacing / punctuation) | `exact_match` | `deactivate` | ✅ yes |
| ID matches, names differ | `id_match_name_conflict` | `review` | ❌ needs a per-row `adminConfirmed` |
| ID matches but the same ID or name repeats in the file | `possible_duplicate` | `review` | ❌ needs confirmation |
| Uploaded name missing (or DB name empty) | `requires_review` (`name_unverified`) | `review` | ❌ |
| System ID missing | `requires_review` + `blocked` | `none` | 🚫 never applied |
| System ID unknown | `not_found` + `blocked` | `none` | 🚫 never applied |
| More than one DB row for the ID (impossible under the PK, enforced anyway) | `requires_review` + `blocked` | `none` | 🚫 never applied |
| Student already `former` | `already_former` | `none` | no-op |

`name_very_different` (similarity < 0.5) only makes the warning louder — there is
no fuzzy matching and no threshold that can, by itself, mark anyone former.

## What apply writes

`status='former'`, `statusUpdatedAt=now()`, `statusUpdatedBy=actor`,
`transport='LEFT'` — and nothing else. `name`, `id`, `className`, `parentId`,
`parentPhone`, `govId`, `familyId` and every child row are untouched. No code
path in the migration deletes a student row.

## Existing objects updated (active = not former)

* `get_system_stats()` — `totalStudents` counts ACTIVE students; new `formerStudents` key.
* `promote_students()` — a leaver is never promoted (recreated from `20260906c` + one predicate).
* `mark_student_left()` — keeps `status` in sync with the family-IDs LEFT toggle (still preserves `familyId` both ways).
* `teacher_exam_progress` view and `get_class_student_subject_progress()` — see `20261008b_former_students_roster_filters.sql`.

Deliberately unchanged (historical): `class_students_for_term`,
`get_midterm_report`, `get_final_report`, `get_monthly_report`,
`monitor_marks_entries` — a report for a term a leaver attended still includes them.

## Related

* [Former Students data model](../data-model/former-students.md)
* [FormerStudentCleanup page](../ui/former-student-cleanup.md)
* [RLS policies (admin-tools)](../security/rls-policies.md)
* [promote_students](promote-students.md) · [get_system_stats](get-system-stats.md)
