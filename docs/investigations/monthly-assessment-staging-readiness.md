# Monthly assessment repair: staging readiness investigation

## Final decision: NOT READY — BLOCKERS IDENTIFIED

**A full production-equivalent restored staging rehearsal could not be executed in this session. No staging migration or application workflow result is claimed.** The blocker is the absence of an identified, accessible production restore in an isolated environment, plus unverified notification isolation. Synthetic PGlite fixtures from the previous task are not a production restore.

No deployment, production migration, production upload, account creation, notification, merge, relabelling, approval, or historical restoration was performed. Production database activity was SELECT-only catalog/aggregate inspection. The repair code and migration were not modified in this task. New files are investigation documentation and a mocked supplemental review test only.

## Environment and provenance gate

- Supabase project listing returned one active project, the known production project `qopeilyvkfqbjdeudwnz`. Other returned projects were inactive and have no verified restore provenance; none was repurposed or activated.
- The production project's branch listing returned only its default `main` branch, pointing to the production reference itself. **That is not a staging target.** No non-default restored staging branch was listed. Its historical `MIGRATIONS_FAILED` metadata is not evidence that this repair ran or that current production is broken.
- No `.dump`, `.backup`, backup-named restore file, or original XLSX was found in the bounded workspace search (depth three, excluding dependency/git trees). This is not a claim that no backup exists anywhere.
- `psql`, `pg_restore`, Docker and the Supabase CLI were not found on PATH. Node/PGlite is available, but cannot substitute for the requested restored production database, independent sessions, Auth, RLS and notification setup.
- The available Supabase connector lists branches and executes SQL, but exposes no database-backup listing/download/restore operation. Creating a schema-only branch would not prove a data restore or preserve the 3,499 legacy records. No branch/project was created.
- No verified staging app endpoint, isolated Auth/test identities, restore timestamp, backup manifest, or disabled notification configuration was supplied or discovered.

**Unblocking requirement:** provide an accessible, explicitly identified isolated staging restore with production-backup provenance, or a securely supplied backup and authorised isolated restore destination. Provide the staging project reference and restore date, not passwords or service-role keys in chat. The staging environment must suppress outbound email/SMS/push/webhooks/cron before any test writes or logins. Production approval remains a separate later decision.

## A. Migration execution results

| Check | Restored staging result |
|---|---|
| Apply `20261105_monthly_assessment_identity.sql` | **NOT RUN — no verified restored target** |
| Month-aware index creation and old-index replacement | Not verified on restored data |
| Fully labelled records preserved | No staging before/after comparison available |
| Midterm/Final uniqueness including NULL labels | No staging migration result available |
| 3,499 unlabelled rows preserved | Not verified through migration on restored rows |
| 331 ambiguous groups preserved | Not verified through migration on restored groups |
| Function/RLS/grant compatibility and deployed overloads | Not verified on full restored schema |

Repair migration reviewed, unchanged SHA-256:

`177d10f0524e4da253dfcc8955117d53800ae385e9fbfaa0a274526b54e866e9`

Prior local migration/RPC results remain documented in `monthly-assessment-repair.md` and its test-evidence file. They must not be promoted to staging sign-off.

## B. Integrity inventory and missing before/after evidence

A single consistent read-only production query returned:

| Measurement | Observed value |
|---|---:|
| Exams | 35,820 |
| Unlabelled exams | 3,499 |
| Ambiguous unlabelled monthly groups | 331 |
| Invalid/NULL canonical month rows | 0 |
| Term-wide Midterm/Final duplicate identity groups | 0 |
| New repair index present in production | **No** |

Ordered row fingerprints (MD5 of ordered per-row JSONB fingerprints):

- All exams: `e69c1cb5ac89ce0d84af27f3b1c5c719`
- Unlabelled exams: `9d18d589c2df63111b18ea568a9ccca3`

These are **production read-only inventory fingerprints**, not staging pre-migration hashes. There is no post-migration production hash, because production migration was prohibited. They do not by themselves prove a staging migration preserved data, nor rule out independent legitimate live activity after the read.

Prepared `staging-rehearsal-integrity.sql` captures all/labelled/unlabelled/termwide row counts and full-row fingerprints, ambiguous-group counts/fingerprints, status totals, term/month totals, unique indexes and triggers in a repeatable-read, read-only transaction. It has **not** been executed against a staging restore. Run it immediately before and after migration, before seeding synthetic accounts/marks; require exact preservation of every existing exam row and compare all 331 group memberships/scores/statuses securely. Hash equality is an aid, not a replacement for backups or secure row-by-row comparison.

## C. October/November evidence — scope matters

Previous actual **isolated synthetic PostgreSQL** evidence (not rerun as a staging workflow in this task):

| Point | Student | Subject/label | Term | Month | Score | Status |
|---|---|---|---|---|---:|---|
| Before November | fictional-1 | English / HW1 | term-2026 | October | 4 | approved |
| After November | fictional-1 | English / HW1 | term-2026 | October | 4 | approved |
| After November | fictional-1 | English / HW1 | term-2026 | November | 5 | pending |

The existing test also compared the entire original October row unchanged. Source: `monthly-assessment-repair-test-evidence.txt`, `SYNTHETIC OCTOBER/NOVEMBER EVIDENCE`.

**Restored-data October/November result: NOT AVAILABLE.** No real student's marks were used for testing.

## D. Teacher and administrator workflows

All requested real application workflows are **BLOCKED / NOT RUN**, not passed:

1. Teacher August upload.
2. Teacher September upload with repeated labels.
3. Teacher October upload.
4. Teacher November upload.
5. Admin month-by-month monitor review.
6. Teacher individual student-report review and report permissions.
7. Admin approval-status review.
8. Teacher October correction and intended reapproval.
9. Identical November reupload.
10. Admin duplicate-student merge with distinct assessment months.

Use only synthetic accounts, students, class assignments and assessment rows on the verified staging restore. Preserve all restored identities and legacy marks. Run the app locally against staging; do not deploy an application to perform this rehearsal. Capture browser evidence plus database row IDs/periods/score/status after each operation. Do not count mocked UI tests or direct SQL fixtures as these browser workflows.

## E. Concurrency, stale previews, expiry and rollback

**No two-independent-session restored-database concurrency test was executed.** Prior PGlite tests establish sequential behaviour and late-batch rollback only. Source inspection shows advisory same-key locking, an exam-table confirmation lock, snapshot/payload binding, and a 30-minute expiry check; source inspection is not concurrency proof.

Required staging matrix (all outstanding):

| Scenario | Required observation |
|---|---|
| Different users confirm October/November simultaneously | Distinct periods survive; original approvals unchanged; no deadlock/data loss |
| Two keys/actors confirm the same new monthly identity | One assessment; later stale confirmation rejected or forced to revalidate; no duplicate |
| Same key/payload confirmed twice simultaneously | Safe idempotent outcome; no partial rows; ownership checks preserved |
| Mark/approval changed after preview by another user | Stale confirmation rejected; subsequent validation reflects new state |
| Preview expires | Confirmation rejects; fresh validation required; no assessment writes |
| Direct API/SQL bypasses browser validation | Canonical period checks and database indexes still reject invalid/duplicate identities |
| Failure after an earlier batch row has written | Entire transaction rolls back, including upload ledger; existing marks unchanged |
| Upload failure/timeout under table-write contention | No partial batch; bounded waits and useful retry behaviour measured |

Use separate database connections and separate authenticated test actors, with controlled barriers to ensure overlap. Promise.all on one single-backend fixture is not an adequate concurrency rehearsal. Expire only synthetic preview metadata, never change restored marks or production clocks/data.

## F. Analysis of all six baseline failures

### Reproduction and indirect-effect check

The two affected files were rerun on the current working tree: **6 failed / 7 passed**. An untouched `git archive HEAD` copy of `c0bb4d714b377f6032604fb9f887e00506c09dcb` was tested separately: **the same six tests failed / seven passed**, with the same errors. No git branch was switched. The temporary baseline export was removed afterwards.

`git diff HEAD` confirms the following files are unchanged: `profiles.ts`, `user-roles.test.ts`, `ManageStudents.tsx`, `ManageStudentsWhatsApp.test.tsx`, and `RoleContext.tsx`.

#### Failure 1

**File:** `src/lib/__tests__/user-roles.test.ts`

**Test:** `createUser (office-role assignment path) > rejects a stale session that is not an admin profile before creating anything`

- Expected: rejection text matches `/Not signed in as an admin/`, followed by assertions that signUp/session restoration/admin-pinned client are never called.
- Actual: function rejects with `Only administrators can create staff accounts. Office users may create parent accounts.` The regex assertion fails first, so the original test never reaches its side-effect assertions.
- Cause: stale expected error wording, not evidence of account creation succeeding. `profiles.ts:143–160` performs the role/profile guard before signUp.
- Supplemental mocked investigation test explicitly verifies rejection AND zero signUp/setSession/createAuthedClient/RPC calls for this case: **PASS**.
- Assessment connection: this is account provisioning, not marks upload. Auth remains a prerequisite for the real workflow rehearsal; no server authorisation conclusion follows from this mocked test alone.
- Indirect change assessment: this function imports only types, auth and Supabase client; those files and the function are unchanged by the repair. It does not invoke modified bulk/progress/merge paths. Exact baseline reproduction confirms this particular failure is pre-existing.

#### Failure 2

**File:** `src/lib/__tests__/user-roles.test.ts`

**Test:** `createUser (office-role assignment path) > rejects a captured session whose profile role is not admin`

- Expected: same old regex when an office profile attempts to create an office/staff account; zero account/pinned-client calls.
- Actual: same new denial wording. The office-to-parent exception does not allow this office-to-office attempt.
- Supplemental mocked test confirms zero side effects and denial: **PASS**.
- Pre-existing/indirect assessment: same as Failure 1. No changed repair dependency on the tested execution path.
- Required disposition: review/update the stale assertion separately under the account-provisioning test contract, not weaken authorisation or silently waive it. No unrelated code/test was changed here.

#### Failure 3

**File:** `src/pages/admin/__tests__/ManageStudentsWhatsApp.test.tsx`

**Test:** `ManageStudents - Send WhatsApp > renders View Parent & WhatsApp button, and upon viewing, clicking Send WhatsApp opens WhatsApp with parent email`

- Expected: render, load a parent on demand, click mocked WhatsApp action, verify generated link content.
- Actual: render throws `useRole must be used within a RoleProvider` before parent retrieval or link interaction.
- Cause: `ManageStudents` calls `useRole()` at component entry. Test `renderPage()` mounts `<ManageStudents />` directly, mocking ToastContext but not supplying RoleProvider/useRole.

#### Failure 4

**Same file. Test:** `ManageStudents - Send WhatsApp > handles multiple students belonging to the same parent`

- Expected: two student rows can resolve the shared parent and use the proper WhatsApp credential-link behaviour.
- Actual: identical missing-provider render failure; shared-parent behaviour is **not exercised**.

#### Failure 5

**Same file. Test:** `ManageStudents - Send WhatsApp > handles a student with a different parent email`

- Expected: resolve the distinct parent and generate that parent's link, without mixing recipients.
- Actual: identical missing-provider render failure; recipient separation is **not exercised**.

#### Failure 6

**Same file. Test:** `ManageStudents - Send WhatsApp > shows error toast "Parent email not found" when parent email is missing and does not open WhatsApp`

- Expected: missing email displays the error toast and does not open WhatsApp.
- Actual: identical missing-provider render failure; the missing-email/no-send safeguard is **not exercised**.

**Assessment relevance of failures 3–6:** not proof that WhatsApp is safe or broken. They leave communications behaviour unverified; therefore staging notification isolation must be established independently, and these tests must not be used as a notification-safety sign-off. They do not execute marks upload or merge code. `ManageStudents`, its role hook and these tests are unchanged. Changed progress/bulk/duplicate pages are not called by the failing render; its exam/report/academic readers are mocked in the fixture and the exception occurs before effects run. Existing indirect import loading does not cause this particular exception; the required provider is absent on both baseline and working tree. Adding the missing fixture context later may expose additional issues, so this report does not claim that one fixture change will make all four green.

**No blanket harmless classification:** these six failures are genuinely pre-existing and have identified causes, but two original security tests do not finish their assertions, and four communications tests never reach their intended checks. They require a separate owner disposition. The present NOT READY decision is independently required by the missing restored rehearsal.

Supplemental artifact: `staging-auth-denial.review.test.ts` (two mocked tests; no network/account creation). New reproduction evidence: `staging-baseline-failure-analysis.txt`.

## G. Legacy data preservation and recovery-source investigation

### Current read-only evidence

- 3,499 rows still have NULL assessment labels; 331 ambiguous monthly identity groups remain present.
- 3,462 are monthly/non-termwide legacy records, outside the classified monthly unique index's predicate.
- 37 are unlabelled Midterm/Final records; they are covered by the new proposed term-wide index. Current read-only duplicate check found zero conflicting term-wide groups.
- Zero invalid canonical month values were observed.
- `grade_correction_audit` exists with old/new score, entry state and status columns, but currently has **0 rows**. It provides no historical score recovery evidence in this snapshot.
- `grade_uploads` has **72 ledger rows**, with payload hashes/result metadata; **0 results contain a `changes` key**. A payload hash is not a workbook or historical row image and cannot reconstruct the overwritten assessments.
- Provider backups/PITR/WAL availability is **unknown**, not confirmed absent. The connector has no backup catalogue/restore API. No backup was obtained/restored and no historical audit values were inferred.

### Workbook availability

Read-only Drive metadata searches located the following **candidate sources**, not certified original upload files:

- `2C Teacher Planner 2026/27`: `1C1OnAJwIqTeVDW6yG3hH4TV_RWiYjHzp5FU1BjI33DQ`
- `BACKUP 2026-10-17 2C Teacher Planner (pre Sem1 Att correction)`: `1XqXxaltL371su8K1w3V-hYXEmwwrGjQfWrK1apZXjHo`
- `2C_Teacher_Planner_2026-27_15Oct_1520Z.xlsx`: `1ZcRmxiqiBrBv8E2xnc7vaT2rWweDU9_2`
- Multiple review, synthetic and corrected copies also exist and must not be confused with originals.

The narrower Grade-2C workbook search returned 25 files with no next page. A separate backup/database-name search returned spreadsheet/script candidates, not a verified PostgreSQL database restore artifact. This is bounded discovery, not an exhaustive backup inventory. Raw student cells were not downloaded or exposed. No file was edited, shared or used to reconstruct marks. Sender confirmation, workbook period metadata, immutable student/subject IDs and original-upload provenance are still needed. Planners from October do not automatically establish pre-overwrite August/September values.

### Effects of proposed constraints on legacy records

No legacy labels are filled or guessed. The new monthly index excludes NULL labels; term-wide uniqueness includes NULL labels without choosing winners. The new guard can reject future attempts to move/reclassify an existing assessment in place; it does not rewrite existing legacy rows. Any ambiguous term-wide collision discovered on the actual restore is a STOP condition. Current aggregate checks support continued staging investigation but **do not prove an unexecuted restored migration preserves all legacy rows**.

## H. Newly discovered defects and unresolved risks

- No new repair defect was reproduced in a restored environment because no such environment was available.
- Confirmed newly analysed baseline test defects: two stale error-message assertions and four missing-role-context fixtures. No auth bypass was observed in the supplemental mocked denial checks.
- Unresolved release gates: actual deployed-schema drift (including both legacy merge overloads), Auth/RLS behaviour under real accounts, table-lock contention, preview expiry, browser UX, independent-session concurrency, complete row preservation and notification suppression.
- Do not report these as passed or non-blocking simply because earlier focused unit tests were green.

## I. Exact production deployment sequence — plan only, NOT authorised

1. Complete the blocked restored staging rehearsal first. Record restore provenance, PostgreSQL version/extensions, all function overloads/grants/RLS, disabled scheduled/external actions, before/after integrity manifests, 10 workflows and concurrency matrix. Stop on any mismatch, restore-row mutation or unexpected constraint failure.
2. Resolve/disposition all staging blockers and assign owners for the six baseline failures. Obtain explicit production migration/deployment approval covering the reviewed migration hash and exact application revision.
3. Schedule a maintenance window, pause marks writes/confirmations and competing merges, and verify the release artefact. Take a recoverable production backup and secure exam/schema/function/grant exports; verify restore accessibility and recovery point.
4. On production, re-run approved SELECT-only preflight and capture an integrity manifest under the write pause. Duplicate keys, invalid months, ambiguous terms or schema drift abort the release; never auto-clean marks.
5. Apply **only** `20261105_monthly_assessment_identity.sql` through the approved migration process with stop-on-error. Its explicit transaction establishes the replacement index before dropping the old one. Do not apply unrelated pending migrations inadvertently.
6. Before reopening writes, compare all existing exam rows, hashes, status totals and all legacy groups against step 4; require equality. Verify new monthly/termwide indexes, absent old monthly index, guarded periods, preserved grants/RLS and versioned preview metadata. Do not invoke a production grade upload as a smoke test on real students.
7. Deploy the exact verified application revision only after separate explicit authorisation. Verify schema/API cache visibility and the authenticated read-only screens. The new UI must fail closed against an old month-blind service.
8. Obtain the release owner's sign-off, reopen writes and monitor errors/locks/duplicate violations/preview rejection rates. Any historical data recovery remains an entirely separate approved activity.

No step above was executed against production in this task. The user has explicitly prohibited deployment at this stage.

## J. Rollback and recovery requirements

- **Migration fails before commit:** roll back the failed transaction; PostgreSQL restores the old schema/function/index definitions atomically. Confirm via read-only checks; no destructive workaround or loser selection.
- **Issue after successful migration:** pause writes, preserve evidence, prefer a reviewed forward fix. Do not recreate the month-blind index or restore the unsafe upsert automatically; legitimate multi-month rows may now coexist and the old index may fail or reintroduce overwrites.
- **Application rollback:** only a reviewed revision compatible with the corrected database identity; keep writes paused if compatibility is unknown. Preserve the database safety boundary.
- **Database recovery:** separately authorised restore from a verified backup/PITR point, preferably to another isolated recovery target first. Inventory legitimate writes since the backup and agree recovery objectives. Do not overwrite live data merely to roll back this code repair.
- Recovery prerequisites still missing here: accessible restore source, verified recovery point, restored-data comparison, measured restore duration, app/Auth/role compatibility and notification isolation.

## Summary of actual actions

Completed: environment/branch discovery, read-only legacy inventory, bounded Drive source discovery, exact six-failure reproduction on baseline/current tree, source/dependency-path analysis, two supplemental mocked denial tests, and integrity/deployment/recovery documentation.

Not completed: production-equivalent restore, staging migration, staging row preservation, actual teacher/admin workflows, independent-session concurrency, expiry rehearsal, restore recovery drill or production deployment.

**Decision remains: NOT READY — BLOCKERS IDENTIFIED.** Request an isolated restored staging target and provenance/suppression evidence, then resume the rehearsal. No production action is authorised by this report.
