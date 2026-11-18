# Manual monthly assessment SQL package

## Read this before applying anything

**Operational update:** The user reports manually applying the migration below to LIVE and subsequently confirming an August upload. Do not rerun the migration. The agent has performed only read-only production inspection; complete historical preservation has not been independently established. This repair does not recover previously overwritten marks. The execution instructions below are retained as a reference, not an instruction to apply again.

Files:

1. **Migration:** `supabase/migrations/20261105000000_fix_monthly_assessment_identity.sql`
2. **Separate read-only verification:** `docs/investigations/verify_monthly_assessment_identity.sql`
3. **These instructions:** `docs/investigations/manual-monthly-assessment-application.md`
4. **Executed local evidence:** `docs/investigations/manual-monthly-assessment-test-evidence.txt`

**Do not run a blanket migration-directory deployment.** The superseded prototype is now a local regression fixture at `supabase/tests/fixtures/monthly-identity-prototype.sql`, outside the migration directory; never apply it to LIVE. Reconcile the migration ledger separately before any future automated `supabase db push`; SQL Editor execution does not automatically reconcile that ledger. No automatic database deployment is authorised by merging this change.

The timestamp is a deterministic artifact name, not an assertion of a production execution date.

## Application compatibility — important dependency

### Main monthly workbook workflow

The repository baseline at `c0bb4d714b377f6032604fb9f887e00506c09dcb` already calls:

`submit_bulk_grades(p_records, p_idempotency_key, p_confirm_updates)`

It previews with `false`, then confirms with `true` using the **same key**. Its client does not directly issue an exam `upsert` with the old five-column conflict target. The old conflict target is **inside the currently deployed database RPC**; this migration contains its complete replacement. Therefore a separate app deployment is **not inherently required for that baseline RPC upload workflow**. The replacement keeps the signature/default/JSON contract, adds period/version fields, and uses a 30-minute actor/payload/snapshot-bound preview. Old clients can ignore extra response fields. An unchanged row is now skipped; old UI may not describe skipped rows as clearly as the repaired client.

**The actual hosted website build was not verified or exercised in this task.** Before execution, use its source/release revision or browser network inspection to confirm that its upload workflow uses this RPC and same-key preview/confirm contract. If it instead directly uses `.upsert(..., {onConflict:'studentId,subjectId,examType,assessmentLabel,termId'})`, it is **NOT compatible**: that client must be deployed with the repaired path before uploads reopen. The migration intentionally does not retain a month-blind index just to accommodate such a client. Direct legacy INSERT-only paths remain INSERT-only, not magically idempotent.

### Full website repair still has application dependencies

There are pending, **undeployed** repository changes to:

- `src/lib/db/bulkGrades.ts`, `src/lib/bulk-grades/resolve.ts`, `src/pages/teacher/BulkUploadGrades.tsx`: period/version binding, month-aware client duplicate checks and clearer previews.
- `src/pages/admin/ExamVerification.tsx`: removes period/reclassification editing that the new DB guard rejects. An older UI can still offer those fields, but the operation will fail safely instead of moving marks.
- `src/lib/db/duplicateStudents.ts`, `src/pages/admin/DuplicateStudents.tsx`: client month-aware conflict presentation. Old UI may show misleading cross-month conflicts; the repaired server validates identities and rejects an invalid cross-month losing-row resolution.
- `src/lib/db/progress.ts`: term/month-scoped client fallback queries.

**SQL alone is not a claim of a fully repaired live website UX.** Deploy those reviewed application changes separately if those interfaces/fallback paths are used; no deployment was performed or authorised here. Do not use duplicate-student merging as a live smoke test. The safe SQL repair does not authorise any real merge or historical correction.

### Existing approval/correction policies

Bulk upload: new rows are pending; genuinely changed score/total/entry-state becomes pending; identical values do not execute the UPDATE, preserving approval and every stored row field. October and November are matched separately.

Existing explicit approval functions, RLS and `enforce_exam_status_guard_trg` are preserved. The separate administrator `admin_correct_grade(text,numeric,numeric,text,text,text)` audited workflow is also left unchanged, including its existing status policy and stale-value checks. This repair does **not** redefine all administrator score edits to follow teacher-reupload approval rules. The tests for correction-triggered reapproval refer to the **bulk-upload correction path**.

## What the migration does

- Explicit BEGIN/COMMIT, 10-second lock timeout, 120-second statement timeout.
- Rejects PostgreSQL older than 15, already/partially applied repair objects, missing status guard, an unexpected old index or unexpected bulk RPC body. Duplicate application is an intentional **safe exception**, not a silent reapplication.
- Locks exams/terms against concurrent writes while preserving existing data.
- Captures exact temporary full-row snapshots and existing table/function permissions/security. Before commit, aborts if any existing exam field, function ACL/owner/security/return type, exam/term RLS flags, or original status-guard definition changed.
- Checks monthly classified duplicates, canonical months, term/year spans and termwide duplicates before index creation; never chooses a winner.
- Creates `exams_bulk_assessment_period_unique` on student/subject/type/label/term/**month**, with the existing non-NULL subject/term/label predicate and NULLS NOT DISTINCT.
- Creates `exams_termwide_assessment_unique` for Midterm/Final, omitting month and including NULL-label equality. New monthly protection is established before the old index is dropped. Unrelated indexes/constraints are not dropped.
- Adds private RLS-protected preview metadata and immutable assessment identity/period and assessed-term-year guards.
- Replaces the complete bulk RPC, preserving its authorisation, roster/assignment validation, score limits and return type. No GRANT/REVOKE is applied to an existing function or table.
- Makes related merge predicates month-aware, treating Midterm/Final as termwide. Existing merge conflict-resolution policies are not redesigned, and **no merge is invoked**.
- Scopes the existing older current-term dashboard view/RPC without changing their aggregation rules.
- Requests PostgREST schema cache reload at commit; no external webhook or notification function is called.

### Complete definitions and live-only source limitation

The main upload and new guard functions are complete CREATE OR REPLACE definitions. Five repository-backed merge/preview/evaluator function replacements are included in full, selected only after checking the deployed source body fingerprint (CRLF-normalised). The evaluator has two explicitly fingerprinted repository versions; the live version matches the older `20261008` source, not automatically the newest file.

**Two legacy `merge_duplicate_student` overloads are live-only and do not have complete literal source snapshots in this repository.** Rather than invent their bodies or downgrade their behaviour, their migration block obtains the complete current `pg_get_functiondef` inside the same transaction, checks the exact body MD5 against the two inspected live versions, replaces only the assessment identity/period fragments, and executes the complete reconstructed definition. The existing dashboard definitions are similarly retained from the catalog with exact predicate checks. This is a self-contained runtime definition-preserving operation, **not a full static source export** of those live-only functions. If you require literal source for every affected object before execution, that review requirement remains a blocker: export those full definitions securely using the preflight file and have them reviewed first; do not bypass the guards. Live-only overload execution was not covered by the disposable fixtures.

Existing merge routines contain DELETE/UPDATE statements as part of their existing, explicitly invoked resolution semantics. These occur **inside function definitions**, not as migration data-repair statements. Executing this file never runs those merges. There is no top-level legacy UPDATE/DELETE, deduplication, relabelling or relationship reassignment.

## Pre-application backup and review

1. Arrange a write pause/maintenance window for assessment uploads, approvals, corrections, direct edits and student merges. Do not test with real records while comparing manifests. Do not send parent/teacher/student notifications.
2. Take a recoverable, consistent database backup with data and schema. Verify its availability/recovery point. Include exams, students, profiles, subjects, terms/academic years, enrollments, assignments, upload/correction/merge audit records, report configuration/comments/grade scales and dependency tables. Preserve functions (all overloads), views, RLS/policies, grants/owners, triggers, constraints, indexes and migration history. CSV of exams alone is not a rollback backup. Storage file bytes, if needed for recovery, require their own backup; database metadata is not proof of their inclusion.
3. Save secure schema/definition/grant exports using `monthly-assessment-repair-preflight.sql`. In particular retain the old bulk RPC, original status guard and **both live-only merge overloads**. Keep credentials and private student data out of chat/Git.
4. Open **`docs/investigations/verify_monthly_assessment_identity.sql`**, run it read-only and save **all result sets**. It provides old/current indexes, check validation states, triggers, full-row/status/relationship fingerprints, unlabelled counts and ambiguous-group fingerprints.
5. Expected investigation reference: 35,820 exams; 32,321 labelled; 3,499 unlabelled; 331 ambiguous groups/667 rows; approved 35,092, rejected 728, pending 0. Re-establish today's baseline if legitimate activity intervened; never rewrite records to make counts match a historical number.
6. Monthly classified duplicate, termwide duplicate and invalid-month queries must return zero rows. Confirm only the old month-blind unique index is present, expected status guard is enabled, terms are valid, and the current-term dashboard has no ambiguous multiple-current-term configuration. Any unexpected object/version or duplicate is a STOP condition.
7. Confirm the hosted app compatibility described above. Review the complete migration locally, especially the function-definition preservation blocks. The test coverage is local synthetic PostgreSQL, not a restored production rehearsal or browser test; that limitation has not disappeared.

## Manual execution order

1. Keep writes/merges paused. In the Supabase SQL Editor, verify the selected project is your intended live database. The agent has not selected or executed a write target for you.
2. Open **only** `supabase/migrations/20261105000000_fix_monthly_assessment_identity.sql` and paste/upload its **entire contents**, from BEGIN through COMMIT (including the comments is fine). Do not run individual selected index/function fragments.
3. Execute once with an appropriately privileged database owner account. Existing object ownership/ACL must be preserved; the transaction has checks for drift. Do not turn off triggers or RLS to work around a failure.
4. Success: the transaction reaches COMMIT; old month-blind index is absent; both new unique indexes are present/valid/ready with NULLS NOT DISTINCT; new period/term guards and original status guard are enabled; preview table is private/RLS; existing data/ACL checks did not raise. This is database-schema success, not proof all browser workflows passed.
5. **Before any new writes**, run the separate verification file again. Compare full-row/status/relationship fingerprints and all 3,499 legacy rows/331 group fingerprints with the saved baseline. All existing rows and statuses must be identical; new tables/indexes/functions are the only intended changes. A legitimate upload afterwards changes the exam fingerprint, so compare first.
6. Review the actual app build, then reopen only the approved workflows. The DB remains authoritative; do not remove an index/guard if an old client receives an error.

## If SQL fails

- Stop. A failed statement in this explicit transaction prevents COMMIT; run `ROLLBACK;` if the SQL Editor session remains in an aborted transaction, then use read-only verification. Do not rerun selected trailing statements.
- Lock timeout: no changes committed. Schedule a quiet write pause and retry the **whole reviewed file** after rollback, not with unbounded locking.
- Duplicate/invalid period/schema/fingerprint failure: preserve error and baseline; investigate without changing records. Do not delete/deduplicate, invent labels, disable guards or edit the SQL to skip the assertion.
- Already-applied message: inspect objects; do not drop them to force another application. A rejected second application leaves marks unchanged.
- Failure after successful COMMIT (for example a website client incompatibility): pause writes and use a reviewed forward fix or compatible app revision. Do not blindly recreate the old month-blind index: valid cross-month rows can now coexist and the old upsert could reintroduce loss. Restoring a backup over live data is a separate explicitly authorised recovery procedure accounting for subsequent legitimate writes. No destructive rollback script is supplied.

## Verify October/November through the website

Only use an independently authorised synthetic/test identity; do not change a real student's marks merely to smoke test this migration. If no safe live test identity is available, keep verification read-only.

1. Capture the full October HW1 row fingerprint/score/status for the chosen test student/subject/term using the targeted verification query (fill its three empty ID values). October should be 4/approved for the requested fixture scenario.
2. Upload/preview November HW1=5 with a fresh key, inspect the period, then confirm with the same key. October's **entire row** must remain unchanged; November must have a different row token, score 5 and pending status.
3. Approve the test November record via the existing approved workflow if authorised. Capture October and November again.
4. **Do not use 6 for HW1:** its existing maximum is 5. The local test verifies 6 is rejected without changing either row. Use 4.5 for a valid November correction; only November should become pending through bulk reupload. October remains 4/approved.
5. Approve November again if authorised, then upload identical November=4.5 with a fresh key/preview/confirmation. Approval and stored fields must remain unchanged; there must still be one November identity.
6. Attempting to edit month/term/type/label/subject in place must be rejected by the period guard. Do not attempt this on real historical data. A different-month upload is an INSERT, never relocation.
7. Read October and November reports separately. Pending November must not change October's published report; after approved November, the term report can expose both independent month results. Midterm/Final must not gain one-per-month duplicates.

## Executed tests and limits

The **actual new migration file**, not a retyped upsert snippet, was executed in isolated disposable PGlite PostgreSQL. Synthetic Supabase Auth/session shims were used; no network/provider credentials or notifications. The separate verification file was also executed there.

Coverage includes October 4/approved retained after November 5/pending, valid November correction and identical reupload approval retention, rejecting HW1=6, attempted period moves, Midterm/Final NULL-label uniqueness across months, original full-row preservation for **3,499 synthetic unlabelled rows and 331 groups/667 rows**, multiple month orders, half points, preview payload/state changes, expiry, late batch failure rollback, monthly reports/monitor/current-term widgets, safe duplicate application and repository preview/resolved merge paths.

The two live-only merge overloads and the live-version evaluator were inspected by catalog fingerprint and guarded in SQL, but their execution is not proven by these fixture tests. No real independent-session concurrency, hosted Supabase Auth/RLS integration, browser/mobile workflow, full restored schema or production marks preservation through an executed migration was tested. PGlite uses a single backend; no concurrency success is claimed. No unrelated baseline test failures were fixed to make this package green.

Final focused run: **22 passed / 0 failed**, two files. `npx tsc --noEmit` passed. The initial merge-fixture setup lacked the bulk RPC and was corrected to load its real repository definition; the final artifact tests above were rerun successfully. See the persisted test evidence for the command. Production remains unchanged by this task.
