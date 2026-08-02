# Investigation — Family IDs feature (MBK dismissal gate)

Date: 2026-08-02 · Branch: `arena/019fc308-schoolnnnnass` · Scope: `/admin/family-ids`, `/gate`, parent portal family card, release log, related SQL migrations & tests.

## Update (2026-08-02, later same day) — fixes applied

The following findings are now **FIXED** on this branch:

| Finding | Fix |
|---|---|
| **3.1 HIGH — import Apply never wrote** (direct `.update()` on SELECT-only `students`) | `set_student_import_fields()` admin-only SECURITY DEFINER RPC (`supabase/migrations/20260802_family_import_rpc.sql`); `applyTransportImport` now calls the RPC and returns real per-row errors (`ApplyTransportResult.errors`) surfaced as an error toast. Tests: `family-ids.test.ts` (RPC path + regression: no direct UPDATE) + `supabase/tests/rls-family-import.sql` (real-schema assertions). |
| **3.4 MEDIUM — oversized override ID bricks Generate** | `assign_family_override()` (SQL) + `assignFamilyOverride()` (client) both cap IDs at 4 digits with a clear error; `handleOverride` prompt says "exactly 4 digits". Tests: `family-ids.test.ts` override-guard block + `rls-family-import.sql` §4–5. |
| **Office-role save failure** (found in this follow-up; same bug class as 3.1) | `createUser(role:'office')` wrote `profiles` via direct INSERT, denied by SELECT-only RLS. Fixed with `create_user_profile()` + `set_user_role()` admin-only SECURITY DEFINER RPCs (`supabase/migrations/20260802_user_role_rpc.sql`). Tests: `user-roles.test.ts` + `supabase/tests/rls-user-role.sql`. |

Still **open**: 3.2 (audit_logs RLS — deliberately out of scope), 3.3 (stale root schema — out of scope), 3.5, 3.6 (advisory lock on generate), 3.7, 3.8, 3.10 (flagged in TODOS.md).

## 1. What the feature is

The Family-ID system is the school's dismissal-gate identity scheme (built to prevent the wrong-parent handoff incident):

- **Admin page** (`/admin/family-ids`, `src/pages/admin/FamilyIds.tsx`): stats → **Generate** `MBK-####` IDs → **Import** transport sheet (paste / drop .xlsx / .csv) → families table → unattached bucket (manual override) → **Print cards** (pocket / lanyard / placard PDFs with QR).
- **Gate screen** (`/gate`, `src/pages/admin/gate/GateScreen.tsx`): staff type or scan a family ID → students shown with transport + parent phone → per-student **Release** button. Soomaali-first, English toggle.
- **Parent portal**: family ID card + printable card + recent pickups on the parent dashboard.
- **Data layer**: `students.govId / transport / parentPhone / familyId` columns; writes go through SECURITY DEFINER RPCs (`generate_family_ids`, `lookup_family`, `set_student_transport`, `assign_family_override`, `record_release`) in `supabase/migrations/20260802_family_ids.sql` + `20260802_release_log.sql`; `office` gate role in `20260802_office_role.sql`.

## 2. Finding summary

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | 🔴 **High** | Import **"Apply" never writes** — client does a direct `UPDATE students`, but `students` is SELECT-only under RLS | `src/lib/db/familyIds.ts:76` |
| 2 | 🟠 Medium | `audit_logs` is open read + open insert for **all authenticated users** — family events (releases, NOT-FOUND lookups) leak to parents; anyone can forge audit rows | `supabase/migrations/00001_create_audit_logs.sql:13,18` |
| 3 | 🟠 Medium | Root `supabase-schema.sql` is a stale/legacy snapshot — no `govId/transport/parentPhone/familyId`, no `office` role, no `release_log`; still contains a dangerous `FOR ALL USING (true)` policy on students | `supabase-schema.sql:22,372` |
| 4 | 🟠 Medium | A long manual override ID breaks `generate_family_ids` permanently (`MAX(…::INTEGER)` overflows) | `20260802_family_ids.sql:83,225` |
| 5 | 🟡 Low | Admin quick-edit dropdown can only set WALKER/CAR — **cannot set a bus number**, even though import/DB/RPC support bus numbers | `FamilyIds.tsx:30` |
| 6 | 🟡 Low | Two concurrent Generate runs can hand out the same ID to different families (design doc overclaims the race is killed) | `20260802_family_ids.sql:70-95` |
| 7 | 🟡 Low | `lookupFamily()` in `familyIds.ts` is dead code (only the gate wrapper is used) | `src/lib/db/familyIds.ts:33` |
| 8 | 🟡 Low | Printed card footer badge shows only the **first** student's transport in mixed-mode families | `src/lib/print/familyCards.tsx:169` |
| 9 | ⚪ Info | Gate accepts 5–6 digits but generated IDs are 4 — only meaningful for manual overrides; fine but undocumented | `gate-utils.ts:8-14` |
| 10 | ⚪ Info | Systemic: *all* client-side writes to `students` are RLS-denied, not just this feature (ManageStudents add/edit/delete, promotions, bulk insert) | `students.ts:114-132`, `promotions.ts:115`, `bulk.ts:46` |

---

## 3. Findings in detail

### 🔴 3.1 HIGH — Import "Apply" can never save data (RLS blocks the direct UPDATE)

**Evidence.** `src/lib/db/familyIds.ts` `applyTransportImport()` writes via the REST client:

```ts
const { error } = await supabase
  .from('students')
  .update(payload)          // govId, transport, parentPhone
  .eq('id', row.studentId);
```

The client is created with the **anon key** (`src/lib/supabase.ts`), so RLS applies. `students` has **SELECT-only policies** — "Parents can read own children", "Admins can read all students", "Teachers can read assigned class students" (`20260708_profiles_auth_session_rls.sql:48-75`), "Office can read all students" (`20260802_office_role.sql:17`) — and **no INSERT/UPDATE/DELETE policy anywhere in `supabase/migrations/`** (verified by exhaustive grep; the `office` migration even asserts this is the intended design).

The file's own comment says it: *"All writes go through SECURITY DEFINER RPCs — students has no UPDATE policy."* The implementation violates that intent. Every row's update returns a permission error → `applied: 0`, everything lands in `skipped`, and the UI toast shows only a count: **"Applied 0 row(s), N skipped"** — the per-row error messages are swallowed (`skipped.push(row.name + error.message)` but only `skipped.length` is returned).

**Impact.** The transport sheet import — step 2 of the intended workflow — silently does nothing. Gov-id, bus, and phone never land on students, so grouping at Generate has no phone key and no transport data for cards/gate. The unit test (`family-ids.test.ts`) mocks `supabase.from` so it passes green; only a real DB reveals the failure.

**Fix (recommended).** Add an admin-only SECURITY DEFINER RPC, e.g.

```sql
CREATE FUNCTION public.set_student_import_fields(
  p_student_id TEXT, p_gov_id TEXT, p_transport TEXT, p_parent_phone TEXT
) RETURNS VOID ...
-- admin role check; validate transport with the same rule as set_student_transport;
-- UPDATE students; INSERT audit_logs ('family_ids.import')
```

and call it per row from `applyTransportImport` (or one RPC taking a JSON array for a single round-trip). This matches the repo's established RPC pattern. Update the unit test to assert the RPC is called.

### 🟠 3.2 MEDIUM — audit_logs: open read + open write for every authenticated user

`00001_create_audit_logs.sql` grants:

- `FOR SELECT TO authenticated USING (true)` — **any parent can read every audit row**, including `family_ids.generate/transport/override/release` events (studentId, familyId, staffId) and `family_ids.gate_not_found` lookups.
- `FOR INSERT TO authenticated WITH CHECK (true)` — **any authenticated user can forge audit entries** (e.g. spam fake gate_NOT_FOUND rows; the gate audit trail becomes untrustworthy).

The office migration even relies on this ("office is already covered for reading family_ids.gate_not_found") — that works, but it is wider than needed. The family RPCs write their own secure entries server-side, so those are trustworthy; the gap is the client-facing policies.

**Fix.** Scope the read policy to gate roles (`admin/supervisor/office`) or a dedicated viewer function; restrict insert to a SECURITY DEFINER path (`audit()` function) or at minimum a `WITH CHECK (action LIKE 'family_ids.%' AND current_profile_role() IN (...))`.

### 🟠 3.3 MEDIUM — root `supabase-schema.sql` is stale and misleading

- `students` there has only `id, name, className, parentId, createdAt` — no `govId / transport / parentPhone / familyId`.
- `profiles.role` CHECK there excludes `'office'`.
- No `release_log` table, no `lookup_family` etc.
- It still contains `CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true)` (line 372) — if anyone applies this file against a live DB, RLS on students is effectively switched off for all roles.

Anyone onboarding via this file gets the wrong model. **Fix:** regenerate the snapshot from migrations, or delete/replace it with a pointer to `supabase/migrations/` (keep `feature-schema.sql` out of it too — it is also a separate, older layer).

### 🟠 3.4 MEDIUM — an over-long manual family ID bricks Generate

`assign_family_override` (line 208) normalizes to digits and stores `lpad(v_norm, 4, '0')` **without an upper bound** — `'999999999999'` is stored as-is. Then `generate_family_ids` computes:

```sql
SELECT COALESCE(MAX(NULLIF(normalize_family_id("familyId"), '')::INTEGER), 0)
```

→ `value out of range for type integer` exception → **every future Generate fails** until the row is manually fixed in SQL. The UI only says "Generate failed". The admin prompt (`window.prompt`) accepts anything.

**Fix.** Cap in the RPC (`IF char_length(v_norm) > 4 … ` or `lpad(left(v_norm,4),4,'0')`), validate client-side before prompting, and/or compute the next ID with `MAX(...) OVER` on a bounded cast with a try/catch fallback to `COUNT`.

### 🟡 3.5 LOW — quick-edit can't set bus numbers

`TRANSPORT_OPTIONS = ['WALKER', 'CAR']` (FamilyIds.tsx:30) — but `set_student_transport` and the DB CHECK accept `\d+`. So an admin who needs to move a student from bus 9 to bus 5 has no UI path (import would have to be re-run). **Fix:** add a small "Bus …" number input when a bus mode is desired, or add `Bus` options to the select.

### 🟡 3.6 LOW — concurrent Generate race (design doc overclaims)

`generate_family_ids` is transactional per call but takes no lock: two parallel calls can both read `MAX = 42` and both assign `0043` to *different* groups. The `WHERE "familyId" IS NULL` guard prevents re-assigning the same student but not two groups receiving the same ID (they'd merge into one family at the gate). The design doc (DESIGN-family-id-generator.md) says RPC generation "kills the concurrent-run duplicate race" — only the per-student double-write is prevented. **Fix:** `PERFORM pg_advisory_xact_lock(hashtext('family_ids_generate'))` at the top of the function, or use a sequence/`nextval`.

### 🟡 3.7 LOW — dead code

`lookupFamily()` + `FamilyLookupRow` in `familyIds.ts` have no callers (the gate uses `lookupGateFamily` in `gate.ts`). Harmless, but either use it in the admin page or remove.

### 🟡 3.8 LOW — mixed-transport family card shows one badge

`CardShell` footer: `transportLabel(data.students[0]?.transport)` — a family with a walker and a bus rider shows only the first student's mode on every card. **Fix:** join distinct modes ("Lug + Bus 9") or drop the badge.

### ⚪ 3.9 INFO — gate input range

`normalizeGateInput` caps at 6 digits and `gateCanCheck` requires ≥4. Generated IDs are exactly 4; only manual overrides can produce longer ones. Consistent with lookup normalization, but worth a one-line hint if overrides >4 digits become common.

### ⚪ 3.10 INFO — systemic RLS-write gap on `students`

The same SELECT-only RLS that breaks the family import also blocks other client-side writes that predate the feature: `students.ts:114` (insert), `:123` (update), `:132` (delete) — ManageStudents; `promotions.ts:115` — class promotion; `bulk.ts:46` — bulk student insert. If the 20260708 RLS migration is applied in production, those flows fail too. This looks like a platform-wide "migrate student writes to RPCs or add admin-scoped DML policies" task, not a family-feature bug — but it is the same root cause as Finding 3.1.

---

## 4. What is solid (verified good)

- **Role gating in SQL** — all five family RPCs are SECURITY DEFINER, `SET search_path = public`, and check `current_profile_role()` (admin for generate/transport/override; admin/supervisor/office for lookup & release). A parent cannot enumerate families via `lookup_family` (returns `[]`).
- **Idempotent generation** — `WHERE "familyId" IS NULL` on every update; existing IDs never reassigned; numbering continues past `MAX`.
- **Release-log integrity** — `record_release` verifies the student actually belongs to the typed family before logging; no direct DML policies on `release_log`; staff read-all / parents own-children-only RLS; mirrored to audit_logs.
- **Parent isolation** — `getParentFamilyCard` / `getRecentReleases` are parentId-scoped *and* enforced by RLS; the RLS tests assert no unrestricted student SELECT policy exists.
- **NOT-FOUND audit** at the gate (`family_ids.gate_not_found`) is best-effort and non-blocking.
- **Transport normalization** is centralized (`parseTransportCell`, `normalizePhone`, `mapSheetClassCode`) and used by import, edit, print, and gate consistently; DB CHECK `NOT VALID` matches.
- **Print/QR** — QR encodes the bare 4-digit ID; `displayFamilyId` adds the MBK- prefix only at display/print (design decision 8); 3 layouts sized per spec.
- **Tests** — 9 family/gate/portal/card test files, ~40 tests, all green (see below).

## 5. Test coverage inventory

All pass (150/153 full suite; the 3 failures are the pre-existing unrelated `lesson-plan-decisions.test.ts` supabase-auth mocks):

| File | Covers |
|---|---|
| `transport.test.ts` | parseTransportCell, normalizePhone, class-code map, displayFamilyId, transportLabel |
| `transportImport.test.ts` | header-name mapping, quoted Gov-id, bus/LEFT/unknown flags, noise rows, matching & ambiguity |
| `transportTemplate.test.ts` | example workbook/CSV parses cleanly via the real parser |
| `family-ids.test.ts` | RPC wrappers, apply-import (mocked — **misses Finding 3.1**), grouping helpers |
| `gate.test.ts` | lookup found/NOT-FOUND-audit/error, recordRelease |
| `gate-utils.test.ts` | input normalization, 4-digit gate, display format |
| `familyPortal.test.ts` | own-family card + recent releases |
| `familyIdCard.test.tsx` | card state classifier (loading/pending/ready) |
| RLS SQL scripts | `rls-office-role.sql` (office read-only, parent isolation), `rls-release-log.sql` (release log shape + policies) |

**Coverage gaps:** no test exercises `applyTransportImport` against real RLS (the bug); no test for the override-length edge (3.4); no test for concurrent generate (3.6).

## 6. Recommended action order

1. **Fix 3.1** — import writes via an admin RPC (unblocks the whole sheet → apply → generate workflow).
2. **Fix 3.4** — cap override IDs (prevents a bricked generator from one typo).
3. **Fix 3.2** — scope audit_logs policies (privacy + audit integrity).
4. **Fix 3.6** — advisory lock on generate (cheap, makes idempotency airtight).
5. **Fix 3.3** — retire/regenerate the stale root schema snapshot.
6. **Low items** (3.5, 3.7, 3.8) as time permits; 3.10 is a separate platform task worth its own investigation.
