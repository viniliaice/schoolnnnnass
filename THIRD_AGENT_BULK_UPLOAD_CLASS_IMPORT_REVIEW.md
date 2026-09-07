# Third-Agent Independent Review — Bulk Upload Grades & Student Class Import

**Reviewer:** Third independent senior engineering reviewer
**Date:** 2026-09-06
**Method:** Direct inspection of `main`, PR #28 (`arena/01a076de-schoolnnnnass`), PR #29 (`arena/01a076e2-schoolnnnnass`); test suites run locally; edge-case behaviour of the Excel matcher probed empirically with generated workbooks; SQL/migrations read line by line.

Evidence labels used throughout:

- **VERIFIED** — independently confirmed by reading code/running tests/probing behaviour.
- **CLAIMED BY AGENT** — asserted in an agent's report but not yet true.
- **INCORRECT** — the claim contradicts the checked-in code/schema.
- **NOT VERIFIED** — plausible but could not be confirmed in this checkout (needs a live DB).
- **MISSING** — the agent did not address it.

---

# Executive Verdict

## **REQUEST CHANGES (do not deploy PR #29's migration or workflow until the blockers are fixed)**

The two pieces of work do **not yet** form a safe end-to-end system. The client-side matching/preview code in PR #29 is genuinely well-designed and its conservative hierarchy ("never match on name alone", "unknown ID + existing name → manual review, never a duplicate") was **VERIFIED** empirically to prevent the worst duplicate-student outcomes. The bulk-grade RPC (PR #9-era, already on `main`) also derives teacher/class/subject authority server-side.

However:

1. **The security premise of PR #29 is false.** Agent A repeatedly claims and even writes an automated SQL test asserting "students has **no** client INSERT/UPDATE policies; the only write path is the admin-checked SECURITY DEFINER RPC." The checked-in baseline schema contains `CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);` (`supabase-schema.sql:372`), it is **never dropped by any migration**, and `FOR ALL` includes INSERT and UPDATE. That policy makes the RPC **redundant as a security control** and makes the feature's own RLS test fail against the real schema. This is the single most important finding because it inverts the feature's stated trust model. **(CRITICAL)**
2. **The same migration replaces `promote_students()` with a definition that drops `SECURITY DEFINER`** (the original never had it, but more importantly the new definition is created *without* explicit grants/revokes), and the codebase calls student-writing paths directly from the browser — so promotion, class-import undo, Manage Students, and the legacy Bulk Import all currently rely on the wide-open policy to function. The migration's stated security model and the app's actual write paths are inconsistent and fragile. **(HIGH)**
3. **A mid-year class move silently corrupts historical class-comparison reporting.** `get_midterm_report` (and its client fallback) computes class averages, class ranks and "highest in class" from `students` sharing the student's **current** `className`. After a 7A→7B move, a student's **already-issued** midterm report for a past term is recomputed against the new class's peers. Grades themselves are safe (they reference `studentId`), but the report's class context is not. Agent A's "historical data stays safe" claim is therefore only half true; Agent B flagged "class is not part of grade identity" but did not trace the report peer-group bug. **(HIGH)**
4. **Identity matching is robust against duplicates but brittle against Excel data formats that the school's real sheet actually uses.** The school's live Google Sheet has **no internal student-ID column** (the transport import maps `Gov-id, Bus, Grade, Name, SECOND NUMBER, Status`). Numeric Gov IDs rendered by Excel as numbers lose precision above ~15 digits, and numeric IDs lose leading zeros; a row that then fails to match can fall through to a **new-student** classification. The safe path (the new "Export current students" template) works, but the feature's headline workflow ("upload the Google Sheet export") is not the sheet that exists. **(HIGH)**
5. **Bulk Upload Grades remains a class-first, one-class-per-upload UI.** The end-to-end scenario (Arabic+Tarbiya teacher across 5A/5B/6A/6B) requires **4 full upload cycles**; Agent B documented this accurately and recommended the correct C+D wizard. It is a usability/process risk, not a data-integrity risk. **(MEDIUM)**

None of these are fatal to the *concept*, and the matching engine itself is good. But **the migration and the security claims must be corrected and re-tested against a migrated database before this goes live.** Agent B's audit (PR #28) is a strong, accurate document; its main gap is the same missing live-RLS verification and the midterm peer-group issue.

---

## 1. What Agent B Got Right

VERIFIED against the code, Agent B's audit (`BULK_UPLOAD_GRADES_AUDIT.md`) is accurate on essentially everything it asserts about the *current* bulk-grades system:

- **Class-first, one-class-per-upload UI.** `BulkUploadGrades.tsx` keeps `selectedClass` as a single string; `getStudentsByClasses([selectedClass])`; `downloadTemplate()` emits one `Grades` sheet; `parseExcel()` reads only `wb.SheetNames[0]`. The Arabic+Tarbiya teacher needs **4 cycles** (not 8, since multiple subjects per class *are* supported). **VERIFIED.**
- **Server derives authority.** `submit_bulk_grades(JSONB, TEXT, BOOLEAN)` (`20260802_bulk_grade_integrity.sql`) looks up the student's class/parent from `students`, the subject from `subjects`, and the assigned teacher from `class_subjects` keyed by **derived** class + subject. The client never sends `teacherId`/`parentId`/status. **VERIFIED.**
- **Per-subject Akhlaaq isolation.** Grade identity is `(studentId, subjectId, examType, assessmentLabel, termId)` via partial unique index `exams_bulk_assessment_identity_unique`. Arabic AKHLAAQ and Tarbiya AKHLAAQ are different `subjectId`s and cannot collide. **VERIFIED.**
- **Assessment block table (HW1–HW4 /5, CPW1–CPW4 /15, ATTENDANCE /20, MT→Quiz /20, AKHLAAQ→Discipline /10)** matches `ASSESSMENT_DEFINITIONS` in `excel-parser.ts` and the server allowlist exactly. **VERIFIED.**
- **Two meanings of "Attendance"**: the numeric 0–20 grade block vs. the daily present/absent/late `attendance` table are separate. **VERIFIED** (and confirmed by `attendance.ts` + schema).
- **MT is stored as `Quiz`, not `Midterm`.** **VERIFIED.**
- **Preflight (no writes) → confirm (atomic upsert)**, with `p_confirm_updates`, idempotency key, 10,000-record cap, and first-error-fails transaction semantics. **VERIFIED.**
- **Overwrite is a real upsert that resets `status='pending'` and replaces teacher/parent/date/month.** **VERIFIED** in the `ON CONFLICT … DO UPDATE` clause.
- **`class_subjects` has no RLS and no unique constraint in the source; legacy `USING(true)` policies exist.** Agent B explicitly flagged these as live-database verification items. **VERIFIED they are absent in source** (see §7).
- **The O(n²) JSON duplicate scan and per-record lookups** in the RPC, and the 5 MB browser cap / first-worksheet-only parsing. **VERIFIED.**
- **Month is not part of grade identity** (only term is). **VERIFIED** — a re-upload of the same student/subject/label in a later month of the same term overwrites.
- Agent B **ran no tests/typecheck/build** (deps not installed in its checkout) and said so honestly rather than claiming green.

## 2. What Agent B Missed

1. **The historical-report class-context bug (HIGH).** Agent B noted "class is not part of grade identity; if students move mid-term you need an enrollment table," but did not trace the concrete consequence: `get_midterm_report` builds the peer set with `SELECT s.id FROM students s JOIN target_student ts ON ts."className" = s."className"` and computes class average/rank/highest from that set (`20260802_bulk_grade_integrity.sql:~428`; client fallback `reports.ts:155` does the same). A move retroactively changes a past term's reported class rank/average. This is the most direct interaction between Agent A's feature and Agent B's domain, and neither agent connected it.
2. **The bulk-grades UI itself has no roster/IDs in the template.** Agent B says teachers "must source IDs separately," but did not note the operational coupling with PR #29: the class-import *template export* is now the only in-app artifact that lists stable IDs + classes, and it lives on a separate admin page. The recommended Grade-sheet wizard should generate roster-prefilled sheets (Agent B does recommend prefilled rosters — good — but didn't identify the existing admin template as the immediate stopgap).
3. **Legacy/approval interaction on overwrite (MEDIUM).** On update, `status` is forced back to `pending`; an already-approved grade silently returns to the approval queue without an audit row recording the old value or the approving authority. Agent B mentioned "approved grades should require permission" in a recommendation but understated that today an approved grade *is* rewritten by any teacher holding the assignment at confirm time.
4. **The admin bulk-grades path.** `/admin/bulk-grades` renders the same component with *all* classes; the server treats admins as authorized for any assignment that has *a* teacher (`v_role='teacher'` is the only teacher-equality test). Agent B described this but did not flag that admin uploads for an unassigned class fail with "No assigned teacher exists" — an operational surprise worth a clearer message. (LOW)
5. **`promote_students()`/promotion undo security** is adjacent to Agent B's scope but directly affects grade rosters; not analysed (the undo function writes `students.className` directly from the browser — see §7).

## 3. What Agent A Got Right

VERIFIED in code and tests:

- **Genuinely atomic commit.** `apply_student_class_import` runs class changes and new-student inserts in one PL/pgSQL function (one transaction); any `RAISE EXCEPTION` rolls back everything. `FOR UPDATE` locking on each changed student; duplicate student IDs within the batch raise; new-student IDs that already exist raise `unique_violation`. **VERIFIED** in the SQL and in `classImportApply.test.ts` (error propagation).
- **Server-side admin gate.** The function raises `insufficient_privilege` unless `current_profile_role() = 'admin'`; it is `SECURITY DEFINER`, `SET search_path = public`, with `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO authenticated`. This pattern matches `set_student_import_fields`/`mark_student_left`. **VERIFIED** the function *itself* is correctly written.
- **The conservative matching hierarchy works empirically.** Probed with generated workbooks:
  - unknown ID + **existing name** → `ambiguous` with `STUDENT_ID_NOT_FOUND`, **never** a new duplicate; **VERIFIED.**
  - name alone (even a unique name) → `ambiguous`/manual review; **VERIFIED.**
  - name + matching phone → auto-match (`name_phone`); shared family phone + ambiguous name → `ambiguous`; **VERIFIED.**
  - two rows resolving to one student → second row `CONFLICTING_ROWS` held back; **VERIFIED.**
  - in-file duplicate student ID / duplicate gov ID / exact-duplicate row handled; **VERIFIED.**
  - unknown class (`7Z`, `Grade 9-Z`) → `invalid`, never invented; **VERIFIED.**
  - only the **first worksheet** is parsed (a malicious second sheet is ignored); **VERIFIED.**
- **Class changes update only `students.className`** plus insert `student_promotions(source='class_import')` and `audit_logs` rows; the function contains **no** reference to `exams` or `attendance`. **VERIFIED** (and the SQL test string-asserts this).
- **Promotion guard compatibility.** `promote_students()` re-run guard now counts only `source='promotion'`, so a mid-year import move for one child in 7A does not block the later whole-class promotion of 7A. **VERIFIED** logic.
- **Idempotent no-op**: a student already in the target class is counted `skipped`, not re-written/history-logged. **VERIFIED.**
- **Tests genuinely run and pass on the branch: 555/555** (515 on `main` + 40 added); **typecheck passes; `vite build` passes** — all independently re-run. Performance at realistic scale is fine (1,350 rows: parse ~50 ms, match ~21 ms, payload ~64 KB; template ~279 KB).
- **Route guard is wired into the single enforcement point** (`App.tsx` consults `canAccessRoute` before the role switch), and `/admin/class-import` is `['admin']` only; sidebar entry admin-only. **VERIFIED.**
- **After commit, `queryClient.invalidateQueries()`** refreshes caches, and teacher rosters derive from `students.className`, so a moved student appears in the new class's Bulk Upload roster. **VERIFIED** data flow (see §10).

## 4. What Agent A Missed / Got Wrong

1. **INCORRECT — "students has no client INSERT/UPDATE policies."** This claim appears in `REPORT-student-class-import.md` §2/§10, in the migration header comment, in `src/lib/db/classImport.ts` header, and is even encoded as an automated assertion in `supabase/tests/rls-student-class-import.sql` ("students must still have NO UPDATE/INSERT policies"). Reality: `supabase-schema.sql:372` creates `ON students FOR ALL USING (true)`, no migration drops it, and the pre-existing `rls-family-import.sql` makes the *same* assertion — meaning these catalog tests have apparently never been run against a migrated database. The live policy set must be audited before this claim is trusted.
2. **NOT ADDRESSED — the migration replaces `promote_students()`** and the new definition (like the old) is `LANGUAGE plpgsql` **without `SECURITY DEFINER`** and without explicit `GRANT`. If/when the wide-open student policy is ever locked down (as security hygiene demands), both end-of-year promotion and class-import undo (`undoPromotion` writes `students.className` directly from the client) will break. The migration hardens one function while leaving the sibling function in the inconsistent state it relies on.
3. **HIGH — Excel numeric coercion on identity columns.** The school sheet stores Gov IDs as numbers in places. Empirically: a 17-digit numeric gov ID is read as `22100100000000000` (precision-corrupted), fails to match the real student, and — if the name is also new/spelled differently — becomes a **new student** with a corrupted gov ID. A `01001`-style numeric ID loses the leading zero, fails to match, and is held for manual review (safe in *that* probe because the name collided, but a name variant flips it to a new student). The parser reads identity columns with `raw: true` and `String(value)` — it never forces text or warns on numeric identity cells.
4. **HIGH — the school's real sheet has no Student ID column and uses `Gov-id` as the identity** (per `transportImport.ts` aliases: `Gov-id, Bus, Grade, Name, SECOND NUMBER, Status`). On that sheet, *every* match depends on the gov-id key (which suffers the numeric issue above) or name+phone (which requires the phone column; the school sheet's `SECOND NUMBER` is available, but missing/changed phones force manual review). The safe, recommended path — downloading Agent A's own "Export current students" template (which carries correct text IDs and round-trips to all-no-change; **VERIFIED**) — works, but the feature's marketing copy ("upload the Google Sheet") describes the riskier artifact.
5. **MEDIUM — no DB-level uniqueness or normalisation on `govId`.** There is no unique index on `students."govId"`; the RPC inserts new students' `govId`/`parentPhone` **raw** (`trim` only), unlike `set_student_import_fields` which stores `normalize_phone(...)`. Consequences: (a) two new students in one import can be created with the same gov ID; (b) a new student's phone is stored un-normalised, which breaks future name+phone matching (the matcher normalises both sides, but `set_student_import_fields`-written phones are digits-only while import-written phones keep `+252`/spaces) and family-ID grouping.
6. **MEDIUM — new-student records are minimal.** Inserted columns are only `id, name, className, govId, parentPhone, createdAt`. `parentId` (parent-portal linkage) is NULL by design (disclosed in the report), and `transport` is NULL — which the family-ID feature interprets as **WALKER** (its documented business rule). A newly imported child whose transport is unknown is silently treated as a walker in dismissal logic. No warning is surfaced.
7. **MEDIUM — `attendance.className` and `homework.className` snapshots are not updated and not reconciled.** Attendance rows written *before* a move keep the old class; new daily attendance is keyed by the teacher's currently-selected class. Attendance history display for the teacher's old class loses the moved child mid-term (rows keyed `className=old AND date`), while the child's old attendance remains filed under the old class. Agent A's report says attendance keeps "the class of that day as a snapshot" — true, but the *workflow* gap (teacher editing a class register after a move) is not discussed.
8. **MEDIUM — re-imports duplicate `student_promotions` history.** Re-uploading the *already-imported* sheet produces all-no-change skips (good), but re-importing a sheet that still contains a moved row against a database whose class was changed by a *different* admin, or re-importing after a manual edit, writes a second promotion row. There is no uniqueness guard on `(studentId, fromClass, toClass, academicYearId, source)` and no de-dup of class-import history.
9. **MEDIUM — no payload row cap.** The grade RPC caps at 10,000 records; `apply_student_class_import` has **no** array-length cap. A pathological/huge workbook becomes a multi-thousand-statement transaction (the client renders only the first 500 rows per tab, so the admin cannot even visually inspect the whole batch).
10. **LOW — claim mismatch in report counts.** `REPORT` §1 says "41 new/updated tests" while §13 says "38 new for this feature"; actual delta measured is **40** (555 vs 515). Minor, but it underscores that the reports were not cross-checked.
11. **LOW — `getStudentClasses()` (used to build the authoritative class list) issues `.select('className')` with no limit**, relying on PostgREST's default 1,000-row cap; harmless at 1,300 students (≈40 classes) but silently truncates the class list in a much larger deployment, which would make valid classes "not exist" and block imports.
12. **LOW — `knownClasses` includes every class any student ever had**, including classes that no longer exist in `class_subjects` (a move target is accepted if *any* student is currently in it). Combined with free-text class names this allows moving a child into a typo'd class already present on one other record.

---

## 5. Independent Architecture Verification

**End-to-end data flow, traced:**

```
School Google Sheet (.xlsx)
  → ClassImport.tsx handleFile()          [client; admin route]
  → parseClassImportFile()                [xlsx; first sheet only; header-name mapping]
  → matchClassImportRows(rows, ALL students from getStudents() [cap 10,000], knownClasses)
  → preview tabs (class_change / new / ambiguous / invalid / duplicate)
  → admin confirms
  → apply_student_class_import() RPC       [SECURITY DEFINER; admin check; 1 transaction]
       UPDATE students."className"        (matched movers)
       INSERT students                    (new)
       INSERT student_promotions          (source='class_import')
       INSERT audit_logs                  (per-move + summary)
  → queryClient.invalidateQueries()
  ↓
Teacher opens Bulk Upload Grades
  → class list from class_subjects.teacherId = me
  → roster = students WHERE className = selectedClass   (getStudentsByClasses, cap 10,000)
  → template filled by teacher; parsed; resolved against roster by studentId
  → submit_bulk_grades() RPC               [SECURITY DEFINER; derives class from studentId,
                                            checks class_subjects(class,subject).teacherId = me]
       INSERT/UPSERT exams
```

**VERIFIED claims:**

- `students.className` is the *current* class; there is no enrollment/roster-history table. **VERIFIED** in schema.
- Grades (`exams`) reference `studentId`; attendance references `studentId`; homework references `studentId`; family linkage via `parentId`/`parentPhone`. **VERIFIED.**
- A class move changes roster membership for grade entry because the roster query filters on current `className`. The post-commit roster test (`rosterForClass`) and the real query (`getStudentsByClasses`) both reflect this. **VERIFIED.**
- The two features share the **same identity key** (`students.id`) and the **same class string** (`className`), so a committed move *is* visible to grade rosters immediately after cache invalidation.

**Architecture weakness that survives both agents:** there is no **enrollment period** dimension. `className` is overloaded as "current class" for roster/authorization *and* as implicit historical context for reports. This works for annual promotion in bulk (everyone moves together between terms) but is semantically wrong for mid-term transfers (the stated use case "some students moved A→B/C" between uploads).

---

## 6. Database Review

**Student identity (authoritative):** `students.id` (TEXT primary key). App-generated IDs look like `student-<ts>-<rand>` (`students.ts createStudent`, `generateNewStudentId()`); the school-facing sheet has historically used `Gov-id` as the de-facto identity because internal IDs are not printed. `govId` is a non-unique, nullable TEXT column with only a non-unique index (`idx_students_gov_id`).

- **VERIFIED:** matching hierarchy in code is `studentId` (case/trim-insensitive via `normId`) → `govId` (must resolve to exactly one student) → name+normalized-phone; name alone never auto-matches.
- **VERIFIED safe:** unknown-ID + existing-name never creates a duplicate (routes to manual resolve).
- **VERIFIED risk:** numeric-Excel coercion of ID/govId cells (precision loss / leading zeros) can defeat matching; the code applies no cell-format coercion or warning.
- **VERIFIED risk:** blank/duplicate gov IDs are handled in-file, but two *new* students may be inserted with the same gov ID; nothing in the DB prevents it.

**Constraints / schema:**

- `exams` has FKs to students/subjects/terms/profiles and the partial unique identity index. **VERIFIED.**
- `students` has no unique constraint on `govId`, `parentPhone`, or `familyId`; `className` is free text with no `classes` table/FK. **VERIFIED.**
- `class_subjects` has no unique constraint on `(className, subjectId)` — duplicate assignment rows make the authorization `LIMIT 1` nondeterministic (Agent B found this; still unfixed on `main`).
- New-student INSERT omits nullable columns; all NOT NULL columns (`id`, `name`, `className`, `createdAt`) are supplied, so inserts won't fail on schema. **VERIFIED.**
- `student_promotions."academicYearId"` is nullable; the UI defaults to the current academic year but permits "— none —", in which case import history rows have NULL year and will not appear in year-filtered promotion history/undo.

**RLS state in source (VERIFIED):**

| Table | RLS enabled in source? | Policies found in source |
|---|---|---|
| `students` | Yes (baseline + 20260708) | **`"Allow all operations on students" FOR ALL USING(true)` (never dropped)** + added narrower SELECT policies. Permissive policies combine with OR → the open policy dominates for writes. |
| `profiles` | Yes | analogous open `"Allow all operations on profiles"` (narrower SELECT added later, never dropped). |
| `class_subjects` | **No `ENABLE RLS` anywhere in source** | none → fully writable by any authenticated key if the live DB matches source. |
| `attendance`, `homework`, `quizzes`, `questions`, `quiz_attempts`, `report_comments`, `student_promotions` | **No RLS in source** | direct client writes/reads. |
| `exams` | Yes | replaced in 20260802 with role/teacher/parent-scoped policies (reasonable). |
| `audit_logs` | Yes | locked down in 20260902 to staff SELECT; INSERT via SECURITY DEFINER only. |
| `grade_uploads` | Yes | enabled; no explicit policies beyond enablement. |

This means the *direct* client writes the app already performs — `createStudent`/`updateStudent`/`deleteStudent` (Manage Students), `promoteStudentsByClass` (legacy Bulk Import), `undoPromotion` (Class Promotion), attendance/homework/quiz writes — are **functioning today only because of the wide-open `FOR ALL` policy (or RLS being off)**. That is a pre-existing systemic exposure, not introduced by Agent A, but it directly falsifies Agent A's security narrative and its test.

**`promote_students()` replacement:** the new body is functionally correct for the source-tagging guard, but it is created **without `SECURITY DEFINER`** and with **no grant block**, and the function performs `UPDATE students` — it only succeeds for non-owner roles if a permissive UPDATE policy exists. It is an accident waiting to happen the moment the student policy is tightened.

---

## 7. Security Review

### Finding 7.1 — CRITICAL — students table has a permissive FOR ALL policy in source; RPC is not the only write path

- **Severity:** CRITICAL (blocks the feature's stated security model).
- **Evidence:** `supabase-schema.sql:372` → `CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);`. No `DROP POLICY "Allow all operations on students"` exists in any migration (verified by grep). The migration header in `20260906_student_class_import.sql`, `src/lib/db/classImport.ts`, and `REPORT-student-class-import.md` all assert the opposite; `supabase/tests/rls-student-class-import.sql` DO-block #1 asserts zero INSERT/UPDATE policies, which would **fail** against the migrated schema (the pre-existing `rls-family-import.sql` makes the identical failing assertion).
- **Why it matters:** Any authenticated user (teacher, parent, office — anyone who can log in and obtain the anon key, which is embedded in the bundle) can, via direct PostgREST calls, `INSERT`, `UPDATE`, or `DELETE` rows in `students`. That includes editing their own roster/class assignment data, fabricating students, or moving classes outside the audited RPC — defeating every admin gate the feature claims to enforce. It also means the "RPC-only write path" audit trail is bypassable.
- **Recommended fix:** In the migration, explicitly `DROP POLICY IF EXISTS "Allow all operations on students" ON public.students;` and replace with deliberate policies: read access per role (admin/supervisor all, teacher by assigned classes — noting the legacy `assignedClasses` JSONB vs `class_subjects` mismatch, parents by `parentId`), and **no** client INSERT/UPDATE/DELETE (all writes through SECURITY DEFINER RPCs). Then *fix every existing direct client write* (`createStudent/updateStudent/deleteStudent`, `promoteStudentsByClass`, `undoPromotion`) to go through admin RPCs, or they will break. Enable RLS on `class_subjects`, `attendance`, `homework`, `quizzes`, `student_promotions` with role-appropriate policies. Run the catalog tests in CI against a migrated database.
- **Blocks production:** Yes.

### Finding 7.2 — HIGH — class_subjects has no RLS / no uniqueness in source

- **Severity:** HIGH.
- **Evidence:** no `ALTER TABLE class_subjects ENABLE ROW LEVEL SECURITY` and no policy in any migration/schema; the page `ManageClassSubjects` writes rows directly from the client. The bulk-grade authorization `can_submit_exam_target` *trusts* `class_subjects` to decide whether a teacher may grade a class/subject.
- **Why it matters:** a teacher who can reach PostgREST directly could insert an assignment row giving themselves a class+subject, after which the (correct) RPC would authorize grade writes for the hijacked target — privilege escalation into grade entry. Agent B flagged this as a verification item; it remains unmitigated and is now load-bearing for the class-import → grade-upload chain.
- **Recommended fix:** enable RLS; admin-only write policies; add a unique index on active `("className","subjectId")` and resolve existing duplicates.
- **Blocks production:** Yes (verify live; if RLS is also off in production, block).

### Finding 7.3 — MEDIUM — client-supplied academic year and new-student fields trusted by RPC (within admin role)

- **Evidence:** `p_academic_year_id` is any existing academic year (validated) or NULL; `govId`/`parentPhone` stored raw; no normalization; new-student `id` is client-supplied and only checked for *current* existence.
- **Why it matters:** within an admin session the blast radius is limited, but raw phone storage fragments matching/family grouping, and a typo'd year tags history against the wrong academic year. No way to verify the *correctness* of the chosen year server-side beyond existence.
- **Fix:** normalize phone via existing `public.normalize_phone()`; reject/flag duplicate govIds; default year to the current year server-side when NULL.
- **Blocks production:** No (but fix before relying on history/family features).

### Finding 7.4 — LOW/MEDIUM — audit log spoofing surface and missing actor column

- `audit_logs` has no `actor` column; the feature stuffs `actor: current_profile_id()` into `details`, which is correct, but legacy open-INSERT policies on audit_logs were only closed in 20260902; verify that migration is applied.
- RLS test philosophy (catalog assertions only, no `SET ROLE`/`set_config` impersonation) means **none** of the SQL tests actually exercise a denied request; they grep the catalog. Real end-to-end denial tests are MISSING.

---

## 8. Class Import Review

- **Parsing:** header-alias mapping is order/extra-column tolerant; header row searched in first 5 rows; blank and summary rows skipped; `.xlsx/.xlsm` only (UI), no size cap on the import page (unlike the 5 MB grade cap) — a large file is parsed fully in memory (tested 1,350 rows trivially; no cap means an adversarial multi-MB sheet is a browser DoS). First worksheet only; hidden sheets/rows are not handled (hidden rows *are* read by `sheet_to_json`, which is correct; hidden extra sheets are ignored). Formulas evaluate via `cellDates`/raw defaults; dates are not expected in identity columns.
- **Matching:** conservative and safe on duplicates (see §3); brittle on numeric/leading-zero identity cells and on the school's actual ID-less sheet (§4.3–4.4).
- **Preview:** full classification with per-row resolution and exclusion; only committable, non-excluded rows reach the payload (`buildCommitPayload`); ambiguous/invalid/duplicate rows never commit. Renders first 500 rows per tab (all rows still counted and committed — visually unverifiable for large batches; MEDIUM).
- **Commit:** atomic, admin-gated, audited, idempotent on no-op; re-import of identical sheet is safe; re-import after drift writes duplicate promotion history (MEDIUM). No row cap (MEDIUM).
- **Transaction atomicity (the "1,000th row fails" question):** **VERIFIED** — everything is in the single PL/pgSQL transaction; any exception rolls the entire batch (0 applied). This is correct and a genuine strength.
- **Concurrency:** `FOR UPDATE` locks each matched student, so two admins importing simultaneously serialize on touched rows and produce a consistent last-writer result with separate audit rows; new-student ID collisions raise and abort. Two simultaneous imports of overlapping sheets do not corrupt, but both write promotion/audit rows (history duplication, MEDIUM). There is no advisory import lock.
- **Academic-year safety:** class change updates `className` regardless of year; the move is *not* constrained to the selected year's date range, so an admin can perform a mid-term transfer against "current year" (intended) or any past year label. The bigger academic-year issue is that current-class is global, not period-scoped (see §11).

---

## 9. Bulk Grade Upload Review

- **Grade blocks:** HW1–HW4, CPW1–CPW4, Attendance, MT, Akhlaaq all validated client **and** server against fixed totals/types; integers only; 0 ≤ score ≤ total; Absent/N/A produce null-score records with explicit `entryState`. **VERIFIED.**
- **Akhlaaq per-subject:** isolated by `subjectId` in the unique key; 5A Arabic Akhlaaq cannot overwrite 5A Tarbiya Akhlaaq. **VERIFIED.**
- **Authorization:** teacher must equal the `class_subjects.teacherId` for the **student's derived class** and the record's subject; admin may submit for any assignment that has a teacher; no teacherId/parentId/maximum is trusted from the client. **VERIFIED.** Direct-RPC tampering with teacherId is impossible (not accepted); tampering with subjectId/studentId is validated by join.
- **Overwrite:** upsert on identity key; preflight reports counts only (no old/new values); confirmed overwrite replaces score/state/date/month/teacher/parent and resets `status='pending'`. Already-approved grades return to pending silently (MEDIUM).
- **Class+subject assignment model:** the check is exact (`className` + `subjectId` + `teacherId`), so "teaches Arabic" does **not** authorize Arabic in a class where the teacher is not assigned. **VERIFIED.** Weakness: the `LIMIT 1` over duplicate `class_subjects` rows and the lack of unique constraint (§7.2).
- **Class/subject resolution in the UI:** subjects are bound from the *selected class's* assignments, so a workbook block for a subject not assigned to that class errors client-side and is rejected server-side.

---

## 10. Multi-Class Teacher Workflow Review

**Scenario:** Arabic + Tarbiya across 5A/5B/6A/6B.

- **VERIFIED current behaviour:** the teacher selects one class button, chooses subjects (both supported per class), downloads one `Grades` sheet, fills it, uploads, resolves, preflights, confirms, then repeats for the next class → **4 full cycles**. Eight would be needed only if they chose one subject per file, which the UI does not require. Agent B's "four uploads" is correct.
- **Is it practical?** No for the described teacher; it is repetitive and the template contains **no roster and no IDs**, so the teacher must separately obtain correct student IDs for every class. A single mislabeled file (5B's IDs uploaded while 5A is selected) produces "student not in class" errors rather than corruption (server derives class from ID), so the failure mode is safe but tedious.
- **Post-class-import roster correctness:** after the admin import, the teacher's roster for 7B includes Ahmed and the 7A roster excludes him, because both the class list and the roster are live `students.className` reads and the import invalidates the React Query cache. **VERIFIED** by code tracing (`BulkUploadGrades` loads roster in a `selectedClass` effect fresh on mount; `ClassImport` calls `queryClient.invalidateQueries()`). A teacher with the page **already open** across the import moment holds a stale roster until reload — minor (LOW).
- **Recommendation:** adopt Agent B's C+D wizard (multi-class selection from exact assignment matrix → one workbook with one roster-prefilled sheet per class → whole-file validation → one atomic commit). The class-import template export already demonstrates roster prefill; reuse it for grade sheets.

---

## 11. Historical Data Review

**The precise distinction the prompt asks about:**

- **Grade rows themselves:** preserved and still linked to the student (`studentId` FK; the import never touches `exams`). **VERIFIED safe.**
- **Attendance rows:** preserved, keyed by `studentId`, with `attendance.className` holding the class at time of writing.
- **Reports that display historical class context — NOT safe after a move:**
  - `get_midterm_report` RPC and the client fallback compute class peers from the student's **current** `className`. After a mid-year transfer, a previously issued midterm report recomputes class average, subject rank, "highest in class", and overall rank against the *new* class. **HIGH**. Evidence: `20260802_bulk_grade_integrity.sql` (`target_student`/`class_students` join) and `src/lib/db/reports.ts:~150-170`.
  - Daily-attendance per-class views (`getAttendanceForDate(className,date)`) lose moved students from the old class's historical register view and attribute past records to a class the child no longer belongs to; same for homework lists (`getHomeworkByClass`) and class announcements.
  - `teacher_exam_progress` and class progress RPCs join `class_subjects.className = students.className`, so progress/monitoring after a move reflects current enrolment (desirable for "who still needs to enter grades", undesirable as historical record).
- **Net:** Agent A's claim "historical records remain safe because grades reference studentId" is **true for the exam rows but INCORRECT for report class-context**. For *end-of-year* promotion (everyone moves between terms, old term reports already finalised) the model is adequate; for *mid-term* transfers (the feature's stated scenario) the historical peer-group recomputation is a real correctness bug that needs either (a) an enrollment table snapshotting `studentId, className, termId/academicYearId`, or (b) report RPCs that derive the historical class from `student_promotions`/attendance snapshots rather than current `className`.

---

## 12. New Student Review

- **Decision point for "new student":** a row becomes `new_student` only when (i) no exact ID match, (ii) no unique-govId match, (iii) no name+phone match, (iv) it was not routed to ambiguity (unknown ID + existing name → ambiguous), and (v) name + resolvable class are present. **VERIFIED.**
- **Can an existing student be falsely classified new?** Only if **all** weak signals fail simultaneously and the name is unknown: a changed/invalid ID **and** no/unmatched govId **and** a changed/missing/normalization-fragmented phone **and** a name spelling that does not exactly normalize-equal an existing student. This is the residual risk, and the empirical probes show it is reachable via numeric gov-ID corruption or leading-zero loss on ID-less sheets. The mitigation (in-app template round-trip) eliminates it for admins who use it.
- **Fields populated:** `id` (sheet value or `student-<ts>-<rand>`), `name`, `className`, `govId?`, `parentPhone?`, `createdAt`. `parentId` NULL (no parent portal), `transport` NULL (interpreted WALKER), `familyId` NULL (groups later). Mandatory NOT NULL columns all supplied → no insert failure. Defaults are safe schema-wise but operationally incomplete (§4.6).
- **Duplicate hidden identifier:** possible for govId (no unique index; RPC doesn't check new-vs-new or new-vs-existing govId). **MEDIUM.**
- **Parent/family:** no required family info; disclosed.

---

## 13. Data Integrity Review

- **Grade identity:** strong partial unique index + RLS; legacy unclassified (`assessmentLabel NULL`) rows can coexist with classified rows (Agent B's legacy-duplication caveat stands).
- **Attendance:** `UNIQUE(studentId, date)`; upsert-on-conflict handles re-entry; moved students keep old rows; new records use current class.
- **Promotions:** no uniqueness on `student_promotions`; repeated/drifted imports duplicate history rows; `source` tag protects the promotion re-run guard (good).
- **Students:** PK on id; no unique govId; class free-text; duplicate `class_subjects` possible.
- **Repeated imports:** identical re-import → skips (safe); re-import after manual/third-party edits → duplicate history + possibly redundant class writes (harmless to grades).
- **Concurrent imports:** row-locking prevents lost updates; no cross-import advisory lock; audit rows capture per-import changes (good forensics).

---

## 14. Performance Review

- **Class import client:** measured 1,350 rows — parse ~50 ms, classify ~21 ms, template build ~42 ms (~279 KB), commit payload ~64 KB. Fine for ~1,300 students. No payload row cap on the RPC; preview renders 500 rows/tab (full batch still commits).
- **N+1 / round trips:** matching is fully client-side in one pass over a single `getStudents()` fetch (cap 10,000 — above the school's ~1,300, but a future cap risk). The RPC does per-record SELECTs (`students FOR UPDATE`, class validation via precomputed array) — acceptable at ~1,300 changes (sub-second); the O(n) loop with audit inserts is the dominant cost but well within limits at this scale.
- **Bulk grades RPC:** O(n²) in-payload duplicate scan and per-record lookups; 10k record cap. At the school's realistic class sizes (≤~40 students × ~11 blocks per subject, a few hundred records per upload) it is fine. Agent B's scaling analysis is sound for whole-school hypothetical volumes.
- **Memory:** whole-workbook parsed in browser in both features; grade upload caps 5 MB, class import does not. Add a cap.

---

## 15. Test Quality Review

- **Class-import unit tests (`classImport.test.ts`, 2k-line parser tests, apply tests, routing tests):** the pure matching logic is genuinely tested — hierarchy priority, ambiguity, conflicts, duplicates, in-file repeats, class-alias resolution, round-trip template, 2,000-row timing, exclusion, manual resolution. These tests test *real production logic* (the pure matcher), not mocks. Good.
- **`classImportApply.test.ts`:** mocks Supabase and asserts the RPC is called with the right payload and errors propagate. It does **not** test SQL.
- **`supabase/tests/rls-student-class-import.sql`:** catalog/static assertions only (policy counts, `prosecdef`, substring grep of function body). It: (a) does **not** run any query as an impersonated role (no `SET ROLE`/`set_config('request.jwt.claims',...)`), so denials are never exercised; (b) **its first assertion is false against the checked-in schema** (the open FOR ALL policy) — proof that the SQL tests were never run against a migrated database; there is **no CI** (`.github/workflows/` does not exist) and the Supabase CLI postinstall cannot run in this environment.
- **Bulk-grade tests:** parser tests are real; `bulk-grades.test.ts` is mock-only (Agent B noted this); **no** SQL integration test for `submit_bulk_grades` exists.
- **Coverage gaps that matter:** numeric/leading-zero identity cells; gov-id precision loss; two-new-students same govId; phone normalization mismatch between importers; the midterm peer-group recomputation after a move; actual role-denial on the RPC; concurrent imports; preview row-cap behaviour; >1,300 student roster cap.
- **Verdict on "555/555 pass":** true on the branch (re-verified), typecheck/build true — but the green tests prove the *client classifier* is correct; they do **not** prove the database enforces anything.

---

## 16. Critical Findings

| # | Severity | Finding | Blocks production |
|---|---|---|---|
| F1 | **CRITICAL** | Open `FOR ALL USING(true)` policy on `students` (and `profiles`); never dropped; direct client student writes exist; contradicts feature claims and fails the feature's own RLS test. | **Yes** |
| F2 | **HIGH** | `class_subjects` has no RLS/unique constraint in source; it is the grade-authorization trust anchor → escalation risk + nondeterministic `LIMIT 1`. | **Yes** (verify live) |
| F3 | **HIGH** | Midterm/report peer groups recomputed from current `className`; mid-term moves rewrite historical class rank/average context. | **Yes** for mid-term moves |
| F4 | **HIGH** | Numeric Excel identity cells (precision loss >15 digits; leading-zero loss) can route existing students to new-student/duplicate; school's real sheet lacks the internal ID column the matcher prefers. | **Yes** (template workflow mitigates; must be the enforced path or add coercion/warnings) |
| F5 | **HIGH** | `promote_students()` replaced without SECURITY DEFINER/grants; promotion undo & several admin flows do direct browser writes — break the moment F1 is fixed. Must be migrated to RPCs in the same change. | **Yes** (bundle with F1) |
| F6 | **MEDIUM** | No unique constraint / duplicate check on `students.govId`; new-student govId/parentPhone stored raw (phone not normalized → matching/family fragmentation). | No |
| F7 | **MEDIUM** | Repeated/drifted imports duplicate `student_promotions` rows; no idempotency key on the import; NULL-year rows hide from history. | No |
| F8 | **MEDIUM** | Approved grades are silently reset to `pending` on bulk overwrite; no old/new/approval detail, no change audit. | No |
| F9 | **MEDIUM** | New students created with `transport=NULL` (→ WALKER) and `parentId=NULL` without warnings; missing completeness gating. | No |
| F10 | **MEDIUM** | No size/row cap on class import; preview only shows 500 rows/tab; admin cannot visually inspect a huge batch; RPC has no array cap. | No |
| F11 | **MEDIUM** | Attendance/homework class snapshots + per-class views are not reconciled after moves (register history attribution drift). | No |
| F12 | **MEDIUM** | Bulk Grades requires 4 cycles for the Arabic+Tarbiya/4-class teacher; template has no roster/IDs (usability/process risk). | No (per Agent B roadmap) |
| F13 | **LOW** | `getStudentClasses()` no limit (PostgREST 1,000 cap) could truncate class list at large scale; stale roster if teacher page open during import; report test-count inconsistency. | No |

---

## Production Decision

1. **Can administrators safely import class changes from the school's Excel spreadsheet?**
   **Not as shipped against the real Google Sheet.** Via the new in-app **"Export current students" template round-trip** the matching is safe and atomic. Against the live sheet (no internal IDs, numeric gov IDs), identity coercion risks make it unsafe until numeric-cell handling, govId uniqueness, and explicit warnings are added. The *commit* is atomic and audited; the *classification* input is the weak point.

2. **Can administrators safely add new students using the spreadsheet?**
   **Partially.** New-student creation is correctly conservative and won't silently duplicate a matched student, but it can create duplicates of students whose identifiers were mangled by Excel, can create duplicate govIds, and writes un-normalised/incomplete records (no parent link, transport defaulting to WALKER). Fix F4/F6/F9 before using in production.

3. **Can students move 7A → 7B without losing or corrupting historical data?**
   **Grade and attendance rows survive** (they reference `studentId`; the RPC never touches them). But **historical report class-context is recomputed** from the new class (midterm ranks/averages), attendance/homework class views drift, and — while the open student policy stands — the *write path itself* is unprotected. So: data rows yes, historical reporting semantics **no**, security **no** (F1/F3).

4. **Will Bulk Upload Grades correctly use the student's new class?**
   **Yes — VERIFIED.** Roster and authorization derive from current `students.className` via `class_subjects`; the import invalidates caches; Ahmed appears in 7B and not 7A. (Minor stale-on-open caveat.)

5. **Can an Arabic+Tarbiya teacher across four classes use the workflow efficiently?**
   **No — 4 repetitive cycles today**, with no roster/IDs in the template. Functionally correct (subject-per-class authorization is exact), operationally impractical. Agent B's C+D multi-class, roster-prefilled, per-class-sheet wizard is the right fix.

6. **Can an unauthorized teacher upload grades for a class/subject they don't teach?**
   Through the **RPC, no** — server-side join enforces exact class+subject+teacher and ignores client-supplied identity. Through **direct table/RIS manipulation, the environment is currently unsafe** if `class_subjects` RLS is off (F2): an attacker could first grant themselves the assignment. Verify live RLS; the source indicates F2 is exploitable.

7. **Can the Excel import create duplicate students?**
   **By design, not via matched students** (unknown-ID + existing-name → manual review; verified). **Yes in practice** when Excel mangles numeric IDs/leading zeros and the name doesn't exactly match — a false "new student" is reachable on the school's real sheet. Server-side govId dedup is absent. High-severity until F4/F6 are fixed.

8. **Can repeated imports create duplicate history/data?**
   Identical re-import → safe skips. Drifted/concurrent re-imports → **duplicate `student_promotions` rows** (no unique guard); grades never duplicate (unique index + idempotency). Fix F7.

9. **Is the database-side security strong enough?**
   **No.** The new RPC is written correctly, but it sits on a schema where the students table has a wide-open policy, `class_subjects`/attendance/homework/etc. show no RLS in source, and the feature's own security test asserts a falsehood. The RPC is a well-built lock on an unlocked door.

10. **Is the implementation production-ready?**
    **No — REQUEST CHANGES.** The client classifier, UX, and atomic/admin-gated RPC are good engineering and the tests honestly cover the pure logic. But the deployment would (a) leave the student table directly writable by any authenticated user, (b) risk duplicate students from real-sheet Excel formatting, and (c) alter historical report context on mid-term transfers.

---

## Go / No-Go

### **NO-GO for the current PR #29 migration/workflow in production.**

The build is green and the matching engine is sound, but production admission requires, at minimum, these blocking fixes:

1. **F1 (CRITICAL):** Drop the open `students`/`profiles` FOR ALL policies in a migration; replace with deliberate per-role read policies and **no** client write policies; migrate every existing direct client write (Manage Students create/update/delete, legacy `promoteStudentsByClass`, promotion `undoPromotion`, class-subject edits, attendance/homework/quiz writes) to admin/SECURITY DEFINER RPCs so the app still works after lockdown. Enable RLS on `class_subjects` (F2), `attendance`, `homework`, `quizzes`, `student_promotions`.
2. **F5:** Re-create `promote_students()` **with `SECURITY DEFINER`, admin gate, `SET search_path`, and explicit grants/revokes** in the same migration.
3. **F4:** Force identity columns to text (detect/warn on numeric ID/govId cells; preserve leading zeros; reject/flag >15-digit numeric gov IDs), and make the roster-prefilled **in-app template the documented/expected** input rather than the raw Google Sheet; or add gov-id normalization + cross-key safety.
4. **F3:** Fix historical report peer-groups to use the class the student was in for that term (enrollment/term-scoped class from `student_promotions`/attendance snapshots, or an enrollment table) before any mid-term transfers are performed; until then, restrict the import window to between terms.
5. **F6:** Add a unique index/dedup on `students.govId`, normalize `parentPhone` via the existing `normalize_phone()`, and validate new-student identifiers server-side.
6. **Verification:** run the `supabase/tests` (corrected to include real role-impersonation denials) against a migrated staging database in CI — the current RLS tests have evidently never been executed (they assert a policy that exists). Fix the false assertion in `rls-student-class-import.sql`.
7. **Then** proceed to the non-blocking hardening (F7–F13): import idempotency/dedup, approved-grade overwrite protection, new-student completeness/transport warnings, size/row caps and full preview, attendance/homework reconciliation, and Agent B's multi-class roster-prefilled grade wizard.

Once F1–F6 are implemented and verified against a migrated database with role-based denial tests, the class-import feature can ship; the bulk-grade multi-class wizard (Agent B's roadmap) should follow to make the teacher workflow practical.

**PR #28 (the audit) is documentation-only and accurate; it can merge, with the caveats in §2 (midterm peer-group bug, RLS live-verification) incorporated into the same blocking work.**
