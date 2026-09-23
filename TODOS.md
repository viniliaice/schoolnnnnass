# TODOS.md — MBK International School

Deferred work from CEO review (2026-08-02) — Family ID Generator.

## RLS write-path fixes (family-ID/gate) — DONE (2026-08-02)
- **Root cause:** the app's Supabase client uses the anon key, so RLS applies to every REST write. `students` and `profiles` are SELECT-only under RLS (20260708_profiles_auth_session_rls) — **no INSERT/UPDATE policy for any role** — so every direct `supabase.from(...).update()/.insert()` is silently denied. Two instances of this bug class shipped inside the family-ID feature; both fixed by moving writes to admin-only SECURITY DEFINER RPCs:
  1. **Transport import "Apply"** (`applyTransportImport`) used `supabase.from('students').update()` → always "Applied 0 row(s)". Fixed with `set_student_import_fields()` RPC (`supabase/migrations/20260802_family_import_rpc.sql`); client now reports real per-row errors instead of a silent success count.
  2. **Office-role save** — `createUser(role:'office')` used `supabase.from('profiles').insert()` → the office account never persisted. Fixed with `create_user_profile()` + `set_user_role()` RPCs (`supabase/migrations/20260802_user_role_rpc.sql`).
  3. Also hardened: `assign_family_override()` now caps manual IDs at 4 digits so an oversized override can't overflow `generate_family_ids()`'s `MAX(::INTEGER)` and permanently brick the generator.
- **Tests:** `src/lib/__tests__/family-ids.test.ts` (RPC path + regression: no direct UPDATE; real error propagation; override guard), `src/lib/__tests__/user-roles.test.ts` (office role persists via RPC; non-admin rejected), `supabase/tests/rls-family-import.sql` + `supabase/tests/rls-user-role.sql` (real-schema assertions: no direct write policies, RPCs are SECURITY DEFINER + admin-gated + PUBLIC-execute revoked).

## Safe duplicate batch merge — DONE (2026-09-25)
- **What:** Admin → Duplicate Students gained **Merge All Safe Duplicates**: a dry-run preview, a three-confirmation + typed-phrase gate, then chunked atomic merges (25 per transaction, max 50) with per-pair results and per-student audits. The individual guided merge is untouched.
- **Where the rules live:** `supabase/migrations/20260925_safe_duplicate_batch.sql` — `safe_duplicate_batch_policy()`, `_safe_batch_evaluate_pair()`, `_safe_batch_candidate_pairs()`, `_safe_batch_unhandled_child_rows()`, `get_safe_duplicate_batch()`, `preview_safe_duplicate_batch()`, `merge_safe_duplicate_batch()`, `student_merge_batches` + batch columns on `student_merge_audits`. All RPCs are admin-only `SECURITY DEFINER` with `EXECUTE` revoked from PUBLIC; eligibility is recomputed at execution time and a client-supplied list can only narrow the scope (a pair without both ids is rejected outright). The three `_safe_batch_*` helpers behind them are **internal**: each re-checks `current_profile_role() = 'admin'` (`insufficient_privilege`) and `EXECUTE` is revoked from PUBLIC/anon/authenticated, so no signed-in teacher/parent/supervisor can call them directly to read Gov IDs, parent phones or family ids for students their RLS hides — the RPCs still reach them inside their own `SECURITY DEFINER` chain (audit finding 1, fixed 2026-09-25).
- **Keeper policy:** the **parent-assigned** record is kept (only when exactly one side has a parent) — not "the older row", not the caller's canonical. Excluded and left in individual review: >2 records per name+class, both/neither parents, Gov ID conflicts or a Gov ID owned by a third student, differing parent phones or transport (including a value that exists only on the unassigned record), differing family IDs, a missing parent profile, `LEFT`, ambiguous enrollments, any exam/attendance/quiz/release/report identity conflict, and rows in a student relationship the merge does not move.
- **Prerequisite fix:** `supabase/migrations/20260926_fix_get_merge_conflicts_exam_identity.sql` — 20260924 shipped `c.subjectId` **unquoted** in the exam identity comparison, so PostgreSQL folded it to `c.subjectid` and *every* `get_merge_conflicts()` call failed ("column c.subjectid does not exist"), which broke `merge_duplicate_students_resolved()` / `merge_with_resolution()` for any pair with exams — and therefore the batch that reuses it. The fix is one quoted identifier; no rule or return shape changed.
- **Race/staleness:** rows are locked `FOR UPDATE` in Student ID order (same order as the individual merge, so no deadlock), every pair carries an md5 `fingerprint` of the fields the contract depends on, and the fingerprint is compared both against the reviewed preview and again after locking (`candidate_changed_since_preview` / `candidate_changed_during_batch` → skipped). Vanished rows → `already_resolved`. Any failure inside a chunk aborts the **whole** chunk and names the pair.
- **Audit:** one `student_merge_audits` row per merged student with full individual detail plus `batch_id` / `batch_policy` / `batch_size` / `merge_kind='safe_batch'` (default stays `'individual'`); `audit_logs` gets `students.merge` per merge and `students.merge_batch` per chunk; `student_merge_batches` stores the chunk results (RLS: admin/supervisor SELECT only, no write policies). A client-supplied `p_batch_id` may only reuse a batch row that the **same** administrator created: the check takes `pg_advisory_xact_lock` on the id (closing the two-concurrent-chunks creation race), runs before any merge, refuses anyone else with `batch_id_not_owned`, and the accumulate path can never rewrite `admin_id` (audit finding 2, fixed 2026-09-25).
- **UI:** `src/pages/admin/SafeBatchMergePanel.tsx` (bilingual EN/عربي via `duplicateBatch.*` keys) + thin wrappers in `src/lib/db/duplicateStudents.ts` that contain no eligibility logic; mock implementations of the three RPCs in `src/lib/supabase.ts` keep preview mode working.
- **Tests:** `src/lib/__tests__/duplicateBatch.eligibility.db.test.ts` (35), `duplicateBatch.execution.db.test.ts` (23), `duplicateBatch.security.db.test.ts` (32 — helper authorization for teacher/parent/supervisor/anon vs admin, `SET ROLE authenticated` grant enforcement, and batch-id ownership across two administrators), `duplicateBatch.sqlAssertions.db.test.ts` (2) — all against real PostgreSQL via PGlite + the shipped migrations (`pgDuplicateBatchHarness.ts`); `duplicateBatch.client.test.ts` (18) and `src/pages/admin/__tests__/SafeBatchMergePanel*.test.tsx` (7) against the mock client; `supabase/tests/safe-duplicate-batch.sql` for `psql -v ON_ERROR_STOP=1`. Includes the C/raxmaan Axmed Daahir phone-conflict regression, whole-chunk rollback, and anon/teacher/parent/supervisor denial. Measured in PGlite: 240 candidate groups → report in ~0.3 s; a 25-merge chunk → ~0.1 s.
- **Docs:** `docs/explanations/safe-duplicate-batch.md`.

## Flagged — same bug class OUTSIDE the family-ID/gate feature (NOT fixed, per scope)
Direct `.insert()/.update()/.delete()` on RLS-protected tables from the anon-key client will be denied in production for the same reason. Audit each before/at go-live:
- `src/lib/db/profiles.ts` — `updateUser()` (`.update` on profiles), `deleteUser()` (`.delete` on profiles + `.update` on students)
- `src/lib/db/students.ts:114/123/132` — ManageStudents create/edit/delete
- `src/lib/db/bulk.ts:46` — bulk student insert
- `src/lib/db/promotions.ts:115` — class promotion `.update` on students
- `src/lib/devSeed.ts` — dev-seed inserts (dev only, but same class)

**Fix pattern when addressed:** same as above — admin-only SECURITY DEFINER RPCs (or role-scoped DML policies if the table genuinely needs direct REST writes).

## Release log + parent visibility — DONE (2026-08-02)
- **Implemented:** `supabase/migrations/20260802_release_log.sql` — `release_log` table (studentId, familyId, staffId, createdAt) + `record_release()` RPC (admin/supervisor/office, verifies student belongs to family, mirrors to audit_logs as `family_ids.release`). Gate screen has per-student "Sii Day / Release" buttons with released-state + timestamp; parent dashboard shows own children's recent pickups (`RecentReleases`). RLS: staff read-all, parents own-children-only, no direct writes. Tests: gate wrapper + portal + `supabase/tests/rls-release-log.sql`.

## Offline-first gate mode
- **What:** Gate screen becomes a PWA that caches the family lookup table; works with zero connectivity (data labeled "as of last sync").
- **Why:** The gate is exactly where networks fail; if lookup is down, staff fall back to memory — the thing being eliminated.
- **Pros:** Gate never waits on the network; resilience where it matters.
- **Cons:** PWA/service-worker complexity; stale-data risk needs clear labeling.
- **Context:** Deferred in CEO review (Expansion 2). Decide after M2 pilot — if the gate has usable signal, this stays deferred.
- **Effort:** M (human ~1 day / CC ~20 min)
- **Priority:** P3
- **Depends on:** M2 pilot results (gate network reality).

## Gate access for Umal's team
- **What:** Confirm whether Umal Kharye Xuseen, Maxamed Aden, and Abdurahman Aw Nuux have app logins; if not, add supervisor accounts or a PIN-gated shared-device gate mode.
- **Why:** The gate screen is admin/supervisor-only by review decision (2026-08-02); the named gate team needs a way in.
- **Context:** Open question from CEO review (Issue 5/7). Do not build before confirming who needs access.
- **Effort:** S (human ~2-4 hrs / CC ~10 min)
- **Priority:** P2
- **Depends on:** Answer from school leadership.

## NOT in scope (rejected in CEO review 2026-08-02)
- Year-based ID renewal & bulk reprint (skipped — ad hoc reprint acceptable)
- Pickup-zone color bands (visual flourish; fold into card design later if wanted)
- SMS/WhatsApp release notifications (needs vendor decision; portal visibility deferred with release log)
- Pickup-time analytics dashboard (post-M3, if demand appears)

## E2E harness + gate-flow E2E tests
- **What:** Add Playwright E2E infra (config + a `gate-flow.e2e.ts` covering type-ID → kids shown, camera-scan → kids, hardware-scanner input) and wire into `test:ci`.
- **Why:** The gate flow is the safety-critical interaction; the user explicitly chose E2E over unit-only for it (eng review 2026-08-02).
- **Pros:** Highest-confidence coverage of the exact flow that prevents wrong-parent handoffs.
- **Cons:** Needs browser download (blocked in current sandbox) + a runnable Supabase test env; adds CI surface.
- **Context:** Decided in /plan-eng-review (2026-08-02). Unit tests for lookup logic ship in the build; this is the E2E layer deferred because the repo has no browser infra today. Playwright must be added to devDeps when this is picked up.
- **Effort:** M (human ~1 day / CC ~30 min)
- **Priority:** P2
- **Depends on:** M2 gate screen shipped; browser-available environment.

## DESIGN.md (design system doc) gap
- **What:** Create a minimal DESIGN.md capturing the existing `src/index.css` tokens (`--primary #0F4C3A`, gold `#C8A24A`, dark gradients) as the project's design system.
- **Why:** /plan-design-review (2026-08-02) found no DESIGN.md; the app has a coherent token system that isn't documented, so future features drift.
- **Pros:** Future design reviews calibrate against it; new features match the look.
- **Cons:** Doc maintenance; low urgency.
- **Context:** Existing tokens verified in src/index.css. Small doc, high leverage.
- **Effort:** S (human ~1h / CC ~5min)
- **Priority:** P3
- **Depends on:** —

## Parent portal card reprint link
- **What:** After M3 (family ID in portal), add a printable reminder-card link so parents can reprint a lost card.
- **Why:** Office prints the initial run (design decision 2026-08-02); reprints shouldn't need the office.
- **Pros:** Self-service; QR size/contrast caveat documented.
- **Cons:** Variable parent printers → scanning reliability risk (mitigate: fixed layout, min QR size).
- **Context:** Card-issuance decision in design review (office-first). Follow-up after M3.
- **Effort:** S (human ~2h / CC ~10min)
- **Priority:** P3
- **Depends on:** M3 parent portal family ID.
