# Monthly assessment overwrite repair — implementation and verification

**Status: prepared and tested locally; NOT applied or deployed to production.**

No production marks, student records, months, terms, subjects, labels or approval statuses were changed. Production access during this repair consisted exclusively of SELECT queries against catalogs and aggregate assessment data. No authenticated upload/merge/report RPC was invoked in production. Historical recovery is a separate, unperformed task.

## A. Investigation and root cause

### Actual structure

The table is `public.exams`. Production PostgreSQL is **17.6** (supports `NULLS NOT DISTINCT`).

| Column | Type | Nullable |
|---|---|---|
| id | text, primary key | no |
| studentId | text, FK students(id), delete cascade | no |
| subject | text | no |
| subjectId | text, FK subjects(id) | yes |
| examType | text | no |
| assessmentLabel | text | yes |
| termId | text, FK terms(id) | yes |
| month | text | **no** |
| score | numeric | yes |
| total | integer | no |
| entryState | text | no |
| status | text | no |
| date | date | no |
| createdAt | timestamptz | no |
| teacherId | text, FK profiles(id), delete cascade | no |
| parentId | text, FK profiles(id), delete set null | yes |
| uploadedBy | text, FK profiles(id), delete set null | yes |

Existing checks cover assessment labels, exam types, scored/absent/not-applicable states, positive totals, whole/half-point scores, score limits, and pending/approved/rejected status. Several historical compatibility checks are NOT VALID. None is relaxed by this repair.

Existing unique indexes are `exams_pkey(id)` and:

```sql
CREATE UNIQUE INDEX exams_bulk_assessment_identity_unique
ON public.exams ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL
  AND "assessmentLabel" IS NOT NULL;
```

Other indexes are nonunique lookups on month, studentId, parentId, teacherId, status, termId, subjectId, uploadedBy, student/date, teacher/month/type, bulk identity, and monitor scope. The new migration does not drop these lookup indexes.

The deployed `submit_bulk_grades(jsonb,text,boolean)` uses the old five-column key in all three places: update counting, preview joins, and `ON CONFLICT`. Its conflict action sets `month = EXCLUDED.month` and `status = 'pending'` regardless of whether the displayed score differs. It also always returned skippedCount=0. This is why another month's repeated label could replace the original row, and an unchanged score could lose approval.

The deployed trigger inventory contains one user trigger on exams: `enforce_exam_status_guard_trg`, calling `enforce_exam_status_guard()`. For authenticated actors other than admin/supervisor it forces status pending; it does not change month or term. This trigger is retained unchanged.

### Academic period representation

`terms.id` is a text primary key. `terms.academicYearId` references `academic_years.id`. Existing terms have non-null academic years and spans shorter than twelve months. Their configured `months` arrays are empty, so checking membership in that array alone did not validate a month. Assessment month is a canonical English month name, not the upload date.

**Identity for classified monthly assessments:** student + subject ID + exam type + label + term ID + canonical month. Academic year need not be redundantly added: term ID identifies it. The repair prevents reassignment of an assessed term to a different year, rejects ambiguous term spans, validates canonical months and checks that the selected assessment date/month belongs to the term. It never derives period from upload time.

### Complete write-path inventory

| Path | Operation and disposition |
|---|---|
| `src/pages/teacher/BulkUploadGrades.tsx` → `src/lib/bulk-grades/resolve.ts` → `src/lib/db/bulkGrades.ts` → `submit_bulk_grades` | Main monthly workbook path. Corrected duplicate identity, server preview, confirmation binding and actual upsert. |
| `src/pages/teacher/UploadResults.tsx` → `src/lib/db/bulk.ts:bulkCreateExams` | Legacy single-subject append-only INSERT, not an upsert or natural-key lookup. New classified inserts are protected by the new index; every insert/update receives the database period guard. Unlabelled legacy assessments are not inferred or deduplicated. |
| `src/lib/db/exams.ts:createExam` | INSERT with a fresh row ID, not a natural-key upsert; protected by database indexes/period guard. |
| `src/pages/admin/ExamVerification.tsx` → `updateExam` | UPDATE by exact exam ID. UI no longer offers relocation/reclassification; database independently rejects an in-place period/identity change. Score editing remains available. |
| `updateExamStatus`, `approveAllPendingExams`, `approvePendingExamsForClasses` | Explicit approval UPDATEs, no natural-key match; existing approval policies unchanged. None was invoked. |
| `admin_correct_grade(text,numeric,numeric,text,text,text)` | Locks exact exam ID, checks expected values, updates score/state and audits. No period assignment; retained unchanged. |
| `deleteExam` | Existing explicit admin deletion by ID; unchanged and never invoked in production. |
| `merge_duplicate_student(text,text,boolean)` | Deployed legacy merge overload. Exam conflict predicate patched to include period; transfers student IDs only. |
| `merge_duplicate_student(text,text,boolean,text,text)` | Deployed second overload; same predicate repair. |
| `merge_duplicate_students(text,text,text)` | Conflict-blocking merge; same period repair. |
| `merge_duplicate_students_resolved(text,text,jsonb,text)` | Conflict counting AND validation of explicit losing-row resolution both made period-aware, before any existing deletion logic. Cross-month assessments are no longer conflicts and cannot be resolved as a losing/winning pair. No merge was performed in production. |
| `get_merge_conflicts`, `preview_student_merge`, `_safe_batch_evaluate_pair` | Related preview/eligibility identities updated consistently; month included in conflict JSON where assessment identity objects exist. |
| `merge_students`, `merge_safe_duplicate_batch` and application duplicate/batch clients | Delegate to the above database merge functions; do not independently upsert assessment scores. |

Whole-repository searches included `.from('exams')`, exam INSERT/UPDATE/DELETE, `.upsert`, `onConflict`, and SQL `ON CONFLICT`, including source, migrations, scripts, API and Edge Function folders. There is no assessment-upload writer in `api/` or the two checked-in Supabase Edge Functions. Historical migration definitions and old-schema test/rehearsal fixtures remain unedited. `scripts/safe-duplicate-batch-run.mjs` seeds only its synthetic isolated rehearsal schema; it is not a production marks importer.

### Migration safety findings (read-only production evidence)

- **0** duplicate groups for fully classified proposed month-aware identities.
- **0** duplicate term-wide Midterm/Final identity groups, including NULL labels.
- **0** NULL month rows; observed months are canonical English names.
- **0** missing subjectId or termId values in current exam rows.
- **3,499** unlabelled legacy records. Breakdown: CA 1,546; Classwork 289; Homework 320; Quiz 1,307; Final 33; Midterm 4.
- Among unlabelled monthly assessments, **331 ambiguous groups / 667 rows** share student, subject, type, term and month: CA 252 groups/505 rows; Homework 4/12; Quiz 75/150. These are NOT certified duplicates; multiple real assessments may have lost/never had labels.

**Safety boundary:** replacing NULL labels with guessed HW/quiz labels, deduplicating these rows, or imposing blanket monthly uniqueness over NULL labels is unsafe and is NOT implemented. The migration retains the existing classified-record boundary for monthly uniqueness. Legacy append-only entry remains append-only, not a newly invented upsert. No promise is made that unlabeled legacy entries represent one assessment each or are deduplicated/idempotent. Full legacy classification requires source evidence and separate approval. This does not block the labelled workbook overwrite repair.

## B. Changes made

### Database migration

`supabase/migrations/20261105_monthly_assessment_identity.sql`:

1. Runs in an explicit transaction with a 10-second lock-acquisition timeout and exam table write lock. Fails rather than repairing duplicate keys, invalid months or ambiguous terms.
2. Creates the replacement unique index before dropping the month-blind one. PostgreSQL validates the index against existing rows. Any failure rolls back the entire migration.
3. Adds separate term-wide Midterm/Final uniqueness, including NULL-label protection.
4. Adds `guard_exam_assessment_period()` / its trigger: canonical month/term checks for INSERT and no silent in-place reassignment of month, term, type, label or subject ID on UPDATE. It does not rewrite any existing row.
5. Adds private RLS-protected `grade_upload_previews` metadata and rewrites `submit_bulk_grades` while preserving actor/assignment authorization, half-point validation, totals, score limits, and pending status for genuinely new/changed grades.
6. Adds `guard_assessed_term_year()` / its trigger to keep an assessed term attached to its academic year.
7. Patches the precise deployed exam-identity predicate in the merge functions listed above. Unexpected predicate drift aborts the transaction. Existing bodies, privileges and unrelated resolutions are preserved using CREATE OR REPLACE, not replaced by older migration copies.
8. Scopes the older `teacher_exam_progress` view and `get_class_student_subject_progress` RPC to the single current term. These current-dashboard widgets previously mixed the same month from different years. Their calculations remain unchanged; ambiguous multiple current terms raise rather than choosing one arbitrarily.

### Application files

- `src/lib/bulk-grades/resolve.ts`: workbook duplicate key includes month.
- `src/lib/db/bulkGrades.ts`: parses period/version, preserved months and unchanged records; exposes fail-closed `assertBulkGradePeriod`.
- `src/pages/teacher/BulkUploadGrades.tsx`: shows server-verified month, term and academic-year name in preview and confirmation; same-month counts, unchanged count, per-row month and other months being preserved; refuses old month-blind service or stale selections.
- `src/lib/db/progress.ts`: legacy client fallbacks and verification queries scope by current term as well as month. No current term means no fabricated cross-year result.
- `src/pages/admin/ExamVerification.tsx`: disables old in-place month/type editing, submits score only.
- `src/lib/db/duplicateStudents.ts`, `src/pages/admin/DuplicateStudents.tsx`: expose/display conflict month.
- `supabase/tests/rls-bulk-grades.sql`: schema assertions now require the month-aware conflict target/index and distinguish preview metadata from assessment writes.

### Confirmation and idempotency

A preview stores only private metadata, not marks: actor, raw payload hash, actual assessment-change snapshot hash, period and 30-minute expiry. Confirmation requires the same actor/key/payload/period and unchanged snapshot. A stale preview, changed score/status, changed selected period, or expired preview requires validation again.

The server serializes same-key calls with an advisory transaction lock. Confirmation locks assessment writes while checking/applying its snapshot. A batch failure rolls back all assessment and upload-ledger changes. Successful retries return the idempotency ledger result. Reuploading an identical file under a new key also leaves marks/approvals untouched: the UPSERT uses a difference predicate on score, total and entry state. Date/uploader/teacher metadata alone is deliberately not treated as a mark correction.

### Read-path verification

- The deployed monthly report already groups by **subject AND month**, filters student + term + approved/scored records, and retains every exam ID in details. It needs no formula/query rewrite.
- The authoritative marks monitor already validates term→academic year and scopes exams by term + selected month; no calculation change.
- Older progress widgets/fallbacks lacked term scope and are corrected as above.
- Parent results route uses these month/term-aware report paths. General exam lists retain row IDs; they do not deduplicate by assessment label.
- Midterm/final reports deliberately aggregate across a term under existing grading rules; those formulas and the established treatment of Quiz/MT are NOT redefined here.

## C. Exact new identity protection

```sql
CREATE UNIQUE INDEX exams_bulk_assessment_period_unique
  ON public.exams
  ("studentId", "subjectId", "examType", "assessmentLabel", "termId", month)
  NULLS NOT DISTINCT
  WHERE "subjectId" IS NOT NULL
    AND "termId" IS NOT NULL
    AND "assessmentLabel" IS NOT NULL;

CREATE UNIQUE INDEX exams_termwide_assessment_unique
  ON public.exams
  ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
  NULLS NOT DISTINCT
  WHERE "examType" IN ('Midterm', 'Final');
```

Actual bulk conflict target:

```sql
ON CONFLICT
  ("studentId", "subjectId", "examType", "assessmentLabel", "termId", month)
WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL
  AND "assessmentLabel" IS NOT NULL
DO UPDATE SET ...
WHERE (exams.score, exams.total, exams."entryState") IS DISTINCT FROM
      (EXCLUDED.score, EXCLUDED.total, EXCLUDED."entryState");
```

There is **no `month = EXCLUDED.month`** in the update action.

Month is NOT NULL in the real schema. NULL/missing/invalid monthly periods are rejected, not converted into the current month. Non-monthly Midterm/Final still carry a physical month in this schema, but their term-wide unique index deliberately does not use it; `NULLS NOT DISTINCT` prevents NULL assessment labels from defeating term-wide uniqueness. Monthly `Quiz/MT` remains monthly, not a term-wide Midterm.

## D. Automated evidence

All added regression tests use fictional IDs in PGlite (real in-process PostgreSQL). They cannot connect to production.

| Required scenario | Result | Evidence |
|---|---|---|
| 1. October approved 4 → November 5 | PASS | Actual migration/RPC: two rows; full original October row compared unchanged |
| 2. Same-month overwrite | PASS | One October row, corrected score, pending reapproval |
| 3. Both chronological/reverse upload orders | PASS | Four independent months in both sequences |
| 4. Same-file retry and new-key reupload | PASS | One row, unchanged skip, approval preserved |
| 5. Recurring labels | PASS | HW1, CPW1 (Classwork), MT (Quiz), ATTENDANCE, AKHLAAQ in October/November |
| 6. Academic-year separation | PASS | Same month/label in distinct year-bound term IDs |
| 7. Different students/subjects | PASS | Independent records, no overwrite |
| 8. Approval preservation | PASS | Full approved October row unchanged; same-month correction separately pending |
| 9. NULL/nonmonthly period | PASS | NULL monthly period rejected; NULL-label Final cannot duplicate across months |
| 10. Late batch failure | PASS | Synthetic trigger fails second insert; zero committed marks or upload ledger rows |
| 11. Preview/confirmation | PASS | Pinned year/term/month/payload; mixed periods, invalid months, date disagreement and stale data rejected; application binding tests |
| 12. Reports/monitors | PASS | Actual monthly report/monitor functions; pending November does not change published October; separate months and wrong-year rejection |
| Additional merge safety | PASS | Cross-month records both survive a resolved merge; explicit cross-month losing-row request rejected |
| Legacy preservation | PASS | Migration executed over two ambiguous unlabelled records; complete rows before/after exactly equal |
| Older widget year isolation | PASS | View/RPC exclude other-year October marks |

Test files:
- `src/lib/bulk-grades/__tests__/monthly-period.db.test.ts`
- `src/lib/__tests__/monthlyPeriod.merge.db.test.ts`
- `src/lib/__tests__/bulkGradePeriod.test.ts`
- Updated `src/lib/__tests__/progress-utils.test.ts` verifies month + current-term fallback filtering.

Focused verification: **62 tests / 7 files passed**, including existing bulk/resolve/report/progress unit tests. Of these, the three new regression files contain **23 passing tests**. See `monthly-assessment-repair-test-evidence.txt` for the actual verbose output and synthetic before/after records.

Synthetic October/November result (English, HW1, fictional-1, term-2026):

| Moment | Month | Score | Status |
|---|---|---:|---|
| Before November | October | 4 | approved |
| After November | October | 4 | approved |
| After November | November | 5 | pending |

TypeScript application and API checks, production build, and `git diff --check` passed. Full-suite verification: **1,810 passed / 6 failed; 166 test files passed / 2 failed**. The six failures are two assertions in `src/lib/__tests__/user-roles.test.ts` and four missing-RoleProvider failures in `src/pages/admin/__tests__/ManageStudentsWhatsApp.test.tsx`. The exact same six failures were reproduced by exporting the untouched HEAD into an isolated scratch directory (without switching branches) and running those files there: 6 failed / 7 passed. That scratch copy was removed after verification. These baseline failures were not modified as part of this marks repair. The full suite is therefore **not entirely green**. The final migration also received a focused 62-test rerun after the last explicit-confirmation-flag guard was added.

## E. Safety confirmation

**Existing production marks changed: NO. Approval statuses changed: NO. Student records changed: NO. Historical periods changed: NO. Production migration applied: NO. Production application deployed: NO.**

No historical restoration/backfill script is included. No automated winner selection or score/month/label cleanup is included. The new migration performs schema/function changes only; it does not execute its upload, merge, or correction functions.

## F. Remaining risks and limits

1. Historical August/September marks may already have been overwritten. The current table cannot reconstruct previous scores/months. Original workbooks, pre-overwrite backups or audit row images are required; never relabel current October in bulk.
2. Unlabelled legacy rows remain ambiguous, as expressly preserved by the original schema. A global uniqueness rule or legacy natural-key upsert cannot safely be invented for them. Separate classification and source-evidence review is required before that distinct task.
3. This verification uses actual migrations/functions in isolated schema fixtures, not a restored copy of the entire production database. A full staging restore rehearsal with production schema, roles and policies remains a release gate; do not deploy unverified drift.
4. Merge-function patching checks the exact identity predicate and aborts on missing predicates. A staging schema/function diff is still required, especially for both deployed singular merge overloads that are not both installed by the older repository test harness. The focused merge tests execute the resolved/preview paths and migration over the repository merge schema.
5. The confirmation table lock favours preservation and snapshot correctness over write concurrency. Large uploads can temporarily block other marks writes. Measure at representative volume in staging; lock acquisition times out rather than waiting indefinitely.
6. Private preview metadata expires for use after 30 minutes but is not automatically purged. A separately approved maintenance policy may later remove expired metadata; no marks cleanup belongs in that job.
7. A production browser smoke test is not claimed. The client period contract is unit-tested and the build passes; release should include a staging browser review on mobile.

## G. Deployment and recovery runbook — authorisation required

1. Keep monthly confirmations paused. Obtain explicit production authorisation only after staging checks; no command in this report authorises production changes.
2. Take/verify a recoverable database backup. Export exam rows and schema/function definitions/privileges. Run the SELECT-only `monthly-assessment-repair-preflight.sql`; do not post student-level results publicly.
3. Restore to an isolated staging project. Re-run preflight; apply this migration there. A duplicate/index/drift error is a STOP condition, not permission to modify marks.
4. Compare ALL existing exam rows before/after migration (including score, month, status, date, labels and IDs); require exact equality. Compare function grants and RLS. Run new regressions and staging browser checks with synthetic students only.
5. During an approved maintenance window, apply the database migration atomically, then deploy the matching application. Verify new index exists, old index is gone, RPC advertises identityVersion=2, and no existing row changed. Keep uploads paused until post-deployment verification is complete.
6. Old UI receives safer server behaviour, but the new UI requires the versioned period response and fails closed against the old RPC. Coordinate both releases rather than deploying just the frontend.
7. If migration fails before COMMIT: its transaction restores the original schema/functions/index automatically. Roll back the failed transaction in the migration session; investigate without changing marks.
8. If an issue appears after a successful migration: pause uploads and forward-fix under review. **Do not automatically recreate the old month-blind index**: once multiple months coexist it may fail, and enabling the old function would reintroduce data loss. An application rollback must not restore an unsafe database identity. A full backup restore requires separate recovery authorisation and consideration of subsequent legitimate writes.
9. Reconcile historical workbooks only as a separate reviewed plan, with exact per-record proposed actions and explicit approval. This prevention migration restores no historical values.

### Release state

| Item | State |
|---|---|
| Code/migration prepared | Yes |
| Required isolated regression scenarios | Passed |
| Existing ambiguous marks modified | No |
| Full restored-production staging rehearsal | Not performed; required before release |
| Production migration | Not applied |
| Production application | Not deployed |
| Historical restoration | Not attempted |
