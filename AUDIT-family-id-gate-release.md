# Audit Report — MBK Family ID & Gate Release System

**Repo:** `viniliaice/schoolnnnnass` · **Branch:** `arena/01a05d61-schoolnnnnass` (off `main` @ `8e53fa7`)
**Audit date:** 2026-09-01 · **Scope:** Family ID generation, printable family cards, and the `/gate` release screen — across **architecture, processes, permissions, and operations**.

**Method & caveats.** This audit is a static review of the checked-out source (client code in `src/`, SQL in `supabase/migrations/` + `supabase/tests/`, and the repo's own design/investigation docs). Two things I could **not** verify live, and which the reader should treat as residual verification debt:

- The Supabase project/database was not reachable from this session, so every claim about *what is applied in the live DB* is inferred from the migration files. The repo's own history flags this as a real risk class — `supabase/migrations/20260802_fix_live_role_check.sql` and `supabase/tests/preflight-family-id-stability.sql` both exist because **the live DB has drifted from the migration files before** (a constraint kept the legacy name `users_role_check`; an RPC kept a stale body). Anyone trusting this report to be true of production should run the repo's own preflight (`supabase/tests/preflight-family-id-stability.sql`) against the live project.
- Unit tests could not be executed here (`node_modules` is not installed in this checkout, so Vitest cannot resolve `vite`/`@tailwindcss/vite`). All statements about test coverage are from reading the test files, not from a green run.

One structural correction up front: **there is no `family_ids` table.** The audit prompt's framing assumes one, but `familyId` is a *column on `students`*, and the "family-ID system" is a set of `SECURITY DEFINER` RPCs plus the `release_log` and `audit_logs` tables. This is confirmed by the migration comment in `supabase/migrations/20260802_office_role.sql` ("There is no family_ids table — familyId lives on students") and by a full grep finding no `CREATE TABLE … family_ids` anywhere in `supabase/`. Nothing about the design depends on the table existing; I note it only so the rest of the report is read against the actual model.

---

## 1. How it works (architecture)

The system is a column-based family identity scheme: a stable 4-digit `MBK-####` per family, stored on every student row, produced by an idempotent SQL generator, printed as QR-carrying PDF cards, and resolved live at the gate.

**Summary.** Source roster → import → generate → print → gate lookup is wired end-to-end, and the payload that is *encoded on the card* is exactly the value the gate *decodes and looks up*. Grouping is `parentId` first, then normalized shared phone, with a SQL-level manual override — but the **override UI is only reachable for "unattached" students**, so the two edge cases the override exists for (split a shared phone, merge multiple phones) cannot actually be performed from the UI once students hold IDs. "Non-bus" detection is marker-based and a malformed value can silently fall through to "walker." Offline is deferred by design and the UI fails safely (distinct error screen, never a false match).

### Findings

- **OK — Data model is column-based, not table-based.** `students` gains `govId`, `transport`, `parentPhone`, `familyId` (`supabase/migrations/20260802_family_ids.sql`). `transport` carries a bus number (`'9'`), `'WALKER'`, `'CAR'`, or `'LEFT'` (status), with a `CHECK` constraint (`students_transport_check`, widened to allow `'LEFT'` in `20260802_mark_student_left.sql`). `familyId` is a zero-padded 4-digit string (`'0042'`), `NULL` until generated.

- **OK — Import path is real and writes through an RPC.** Google Sheet export → `src/lib/import/transportImport.ts` (`parseTransportImport`, header-name mapped: `Name`, `Bus`, `Grade`, `Gov-id`, `SECOND NUMBER`) → `matchImportRows` (name-first, class as disambiguator) → `applyTransportImport` (`src/lib/db/familyIds.ts`) → `set_student_import_fields()` RPC (`supabase/migrations/20260802_family_import_rpc.sql`). The RPC is admin-only, validates transport, `COALESCE`s transport so an unknown/LEFT sheet cell can't wipe an existing bus number, and writes `family_ids.import` to `audit_logs`.

- **OK — Generation is transactional, idempotent, and race-safe.** `generate_family_ids(p_transport_filter)` (`supabase/migrations/20260819_family_id_stability_and_cards.sql`) only touches `familyId IS NULL` rows, takes `pg_advisory_xact_lock(hashtext('family_ids_generate'))` so two concurrent runs can't mint the same ID, and **reuses an existing family's ID** when a new sibling shares the family key (fixes the earlier "Xalimo/Ahmed = 0001, new sibling = 0002" split). The stale 0-arg overload was dropped, so exactly one definition exists (verified by `supabase/tests/preflight-family-id-stability.sql` GATE 1).

- **OK — Grouping resolution is `parentId` → normalized phone → unattached.** In the generator the key is `'p:'||parentId` else `'t:'||normalize_phone(parentPhone)` else `NULL` (unattached, reported as `unattached` and shown in the admin UI bucket). `normalize_phone` (`20260802_family_ids.sql`) strips non-digits and drops a leading `252` country code.

- **RISK — The two override edge cases are *designed for* but not *actually operable from the UI*.** `assign_family_override()` (SQL, admin-only, 4-digit capped) can move any student to any existing or new family — so split and merge are *possible in SQL*. But the only UI entry point is the **"Unattached" bucket** in `src/pages/admin/FamilyIds.tsx` (`handleOverride`, line ~740), and `findUnattached()` is defined as students with **no familyId AND no parentId AND no phone**. The exact cases the override exists for — a phone-join that must be *split* (both households' kids already hold an ID) and a multi-phone family that must be *merged* (kids already hold IDs) — do **not** appear in that bucket, and `FamiliesTable.tsx`/browse mode expose no "Assign/re-assign" control at all. Net: a wrong phone-join surfaced by the `phoneJoins` review panel ("assign them a new family ID below") **cannot be fixed in the app**; it needs a manual SQL `UPDATE` or the override RPC run by hand. This is the most material architecture gap (see Top Issues #1).

- **RISK — Phone-keyed grouping is flagged, not trusted (good), but the "phone-join" signal is only produced on later runs.** The generator reports `phoneJoins` (JSONB of familyId/phone/studentIds) only when a *new* unassigned student joins an existing family across runs (`20260819_family_id_stability_and_cards.sql`). A phone-shared grouping created in the *first* run is not surfaced as `phoneJoins`, so two households that shared a number from day one are never explicitly presented for review. The override UI gap above compounds this.

- **OK — Card printing uses a STABLE, role-independent read.** `get_family_cards()` (`20260819_family_id_stability_and_cards.sql`) is `SECURITY DEFINER` + `STABLE` (Postgres rejects writes inside it) and returns the *complete* family for every gate role, fixing the earlier defect where supervisors printed cards missing siblings and office printed blank parent names. Client wrapper: `src/lib/db/familyCards.ts`. The card is drawn by `src/lib/print/familyCards.tsx` (`@react-pdf/renderer`), three layouts (pocket/lanyard/placard), front + back with duplex mirroring.

- **OK — QR is generated as an SVG path, not a PNG/DOM node.** `src/lib/print/qrPath.ts` uses the `qrcode` package's `create()` to get the module grid and emits a single `<Path d="…">` that `@react-pdf/renderer` renders natively (error correction `M`). No canvas, no data URL, no async.

- **OK — Encoded payload ≡ scanned payload ≡ lookup key.** `CardBack` encodes `data.familyId` verbatim (e.g. `'0042'`); the printed text is `displayFamilyId` (`MBK-0042`). At the gate, `GateScreen.onScan` → `normalizeGateInput` strips non-digits → `'0042'`; the typed path does the same; `lookupGateFamily` (`src/lib/db/gate.ts`) strips non-digits again and calls `lookup_family('0042')`, which matches `students.familyId = normalize_family_id('0042')`. Typing the card's printed `MBK-0042` and scanning its QR converge on the same row. Verified consistent across `qrPath.ts`, `familyCards.tsx`, `transport.ts` (`displayFamilyId`), `gate/gate-utils.ts`, and `db/gate.ts`.

- **OK — No dead `react-qr-code` assumptions.** `package.json` does not list `react-qr-code`; a grep of `src/` and `api/` finds zero references. The only QR dependencies in use are `qrcode` (generation) and `html5-qrcode` (scanning in `GateScreen.tsx`). (The M1 design note "QR generated as a PNG data URL" was superseded by the SVG-path approach — not a bug.)

- **RISK — "Non-bus" detection is marker-based and a malformed value can fall through un-flagged.** `parseTransportCell` (`src/lib/transport.ts`) treats `nb`, `n/b`, `no bus`, `0`, `-`, and empty as `WALKER`; digits as bus; `left/dropped/…` as `LEFT`; anything else as `kind: 'unknown'`. Unknown cells are only a *warning* at import (`UNKNOWN_TRANSPORT`), and when applied they leave `transport` unchanged (`COALESCE`), which for a NULL cell means the student silently reads as **WALKER at the gate** (`normalizeTransport`: empty ⇒ `WALKER`). A typo'd bus cell ("`Bik`", "`?`") therefore produces a walker at the gate unless a busy admin notices the import warning and the "Other / flagged" apply bucket. No student is *blocked* or loudly *un-flagged* — mitigation is a warning line and a filter chip, not a gate-time signal.

- **OK — Offline fails safely (no silent false match).** The gate's `doCheck` wraps the RPC in try/catch; on any error it sets `status: 'error'` and renders a distinct red `role="alert"` panel ("Something went wrong / Try again") — it never renders the green "found" screen and never falls through to NOT-FOUND. NOT-FOUND is reached *only* on a successful, empty response. Offline caching (PWA) remains deferred per `TODOS.md`. **RISK note:** while the UI fails safely, with Supabase unreachable every lookup is an error, so staff revert to memory — the exact behavior the system exists to eliminate. There is no degraded read-only fallback.

- **OK — QR/scan pipeline is camera-keyed, hardware-scanner friendly.** `GateScreen.tsx` keeps the `#gate-scanner` element always in the DOM (hidden when off) so `Html5Qrcode.start()` can't race React; camera denial surfaces `cameraDenied` ("use the keypad") rather than hanging.

---

## 2. Processes

**Summary.** The gate flow is a clean, scriptable loop (type/scan → found/not-found/error → release), with loud, non-color-only result states. The NOT-FOUND audit fires on every empty lookup but is **client-side, best-effort, and missing the staff identity**, so it is weaker than it looks. The release log *is* implemented (TODOS' "deferred" note is stale), but it still does not record **to whom** the child was handed — only which staff released which child of which family when — so a post-match wrong handoff is still not attributable to the receiving adult. Keypad/scanner input handling is intact.

### Findings

- **OK — The release script.** Staff open `/gate` → ID display is dominant and auto-focused → type 4 digits on the keypad, let a hardware scanner type + Enter, or press 📷 to scan the card QR → "checking" → **found** (green panel, double-beep, each child's name + grade + transport badge + reachable parent phone + a per-student "Sii Day / Release" button) → tap Release → `record_release` logs it, timestamp + "Released" state shown → **NOT FOUND** (full-screen red + buzz, the typed ID shown, "Logged to audit" note) → **error** (red panel + retry) when the network/RPC fails. All states are text+icon, not color-only; Soomaali-first with EN toggle (`src/lib/i18n/gateStrings.ts`).

- **RISK — NOT-FOUND audit is logged client-side, best-effort, and lacks the staff identity.** `lookupGateFamily` (`src/lib/db/gate.ts`) calls `createAuditLog('family_ids.gate_not_found', { familyId })` after the RPC returns `[]`; failures are swallowed (`catch {}`). Consequences: (a) **no staff attribution** — `details` contains only `{familyId}`, so "who ran the failed lookup" is not recorded; (b) the write is a separate client round-trip, so if the network drops between the lookup and the audit insert, the NOT-FOUND is lost; (c) `audit_logs.INSERT` is open to all authenticated users (see §3), so the trail is also spoofable. Timestamp is present (`createdAt`, client-supplied) and the entered value is present (`familyId`) — but the third field the prompt asks for (staff) is absent. Recommend moving NOT-FOUND logging into the `lookup_family` RPC (or a dedicated `record_gate_lookup` RPC) so it is server-side, atomic with the lookup, and captures `current_profile_id()`.

- **RISK — The release-log "gap" is only half closed.** `TODOS.md` still lists "who released which kid to whom" under release-log as DONE, and indeed `release_log` + `record_release()` exist (`supabase/migrations/20260802_release_log.sql`): it records `studentId`, `familyId`, `staffId`, `createdAt`, verifies the student actually belongs to the family, and mirrors to `audit_logs` (`family_ids.release`). But **the receiving adult is not recorded** — there is no name/photo/ID/card-scan of the person who took the child. So the system can *confirm a match* and *prove staff tapped release*, but it cannot answer "to whom was the child handed" if a wrong-handoff is discovered later. Additionally, Release is an optional tap: a staff member can hand the child over and never tap it, leaving no record at all. Flag as a process risk: **release logging does not bind a release to a verified adult.**

- **OK — Keypad/hardware-scanner input handling is intact.** The keypad buttons use `onPointerDown={e => e.preventDefault()}` so tapping a key never steals focus from the display `<input>`; `appendDigit` re-focuses the input; a hardware scanner (which emulates a keyboard) types into the focused input and its trailing Enter is caught by `onInputKeyDown` → `doCheck()`. This is the same code path as the on-screen keypad, exactly as designed (`GateScreen.tsx`). No regression found in the current source.

- **RISK — Nothing invalidates or versions a printed card.** There is no `family_card_prints` history or card-status column — explicitly deferred to Phase 2 (`SPEC-family-id-printing-implementation.md` F8). Because the gate lookup is *live*, a stale card's **QR still resolves** to the family's current children (transferred/`LEFT` students are excluded by `lookup_family`), which is correct for identity. But the card's *printed* roster/phone text can go stale (family regrouped, phone changed, sibling added) and staff reading the card rather than the screen would see old data. There is no way to know which cards were printed when, so there is no targeted reprint list. Reprints are possible (browse → row "Print" → `PrintCardsDialog`) but untracked.

- **OK — The FamiliesTable browse surface is the reprint surface.** Search by family ID/student/parent/phone, per-row "Print", "Print selected", "Print all (filtered)", plus a "Print by students…" picker that flags "no Family ID" and "marked LEFT" rows instead of silently dropping them (`src/pages/admin/family-ids/FamiliesTable.tsx`, `PrintCardsDialog.tsx`). All print paths converge on `useCardPdf.tsx` → `get_family_cards()`, so printing can never create or change an ID.

---

## 3. Permissions

**Summary.** The family-ID write surface is correctly routed through admin/office-gated `SECURITY DEFINER` RPCs, and the `office` role is fully wired (route, client switch, RPC gates, and an account-provisioning script) with a deliberately narrow write scope. Two permission problems remain: **`audit_logs` is still open read + open insert for every authenticated user** (the explicitly-deferred item, still open), and the **office role can be *created* but not *changed on an existing account* via the UI** (and the general edit/delete-user paths are still the un-fixed direct-write bug class).

### RLS policy enumeration (as of the migration set)

**`students`** (RLS enabled, SELECT-only — no INSERT/UPDATE/DELETE policy for any role):
- `"Parents can read own children"` — SELECT where `parentId = current_profile_id()` (own children only).
- `"Admins can read all students"` — SELECT where role = `admin`.
- `"Teachers can read assigned class students"` — SELECT where role in (`teacher`,`supervisor`) and `className` in the caller's `assignedClasses`.
- `"Office can read all students"` — SELECT where role = `office`.
*(`supabase/migrations/20260708_profiles_auth_session_rls.sql`, `20260802_office_role.sql`, `20260802_fix_live_role_check.sql`)*

**`family_ids`** — **does not exist** (see §1 correction). Family access is governed by the `students` policies above plus the role checks inside the RPCs.

**`profiles`** (RLS enabled, SELECT-only): `"Profiles can read own profile"` (`auth.uid() = auth_id`), `"Admins can read all profiles"`. No write policies — this is the root cause of the office-role save bug and why role/profile writes go through `create_user_profile()` / `set_user_role()`.

**`audit_logs`** (RLS enabled):
- `"Allow all authenticated users to read audit_logs"` — SELECT `USING (true)` → **any authenticated user can read every audit row.**
- `"Allow all authenticated users to insert audit_logs"` — INSERT `WITH CHECK (true)` → **any authenticated user can insert arbitrary audit rows.**
- No UPDATE/DELETE policies.

**`release_log`** (RLS enabled): `"Staff can read all releases"` (admin/supervisor/office), `"Parents can read own children releases"` (EXISTS own-child join). **No direct write policies** — `record_release()` is the only writer.

**Write RPCs (all `SECURITY DEFINER`, `SET search_path = public`, role-checked, `PUBLIC` execute revoked):**
- `generate_family_ids(TEXT)` — **admin**
- `assign_family_override(TEXT,TEXT)` — **admin**
- `mark_student_left(TEXT,BOOL)` — **admin**
- `set_student_import_fields(...)` — **admin**
- `set_student_transport(TEXT,TEXT)` — **admin + office** (`20260820_office_transport_edit.sql`)
- `lookup_family(TEXT)` — **admin + supervisor + office**
- `get_family_cards(TEXT[])` — **admin + supervisor + office**
- `record_release(TEXT,TEXT)` — **admin + supervisor + office**
- `create_user_profile(...)` / `set_user_role(TEXT,TEXT)` — **admin**

### Findings

- **OK — Office role is fully wired end-to-end.** `Role` type includes `'office'` (`src/types/index.ts`); route guard `ROUTE_ACCESS['/gate'] = ['admin','supervisor','office']` with a single enforcement point in `App.tsx` (the `canAccessRoute` check now actually runs before any page renders); an `office` switch in `App.tsx` routes to `OfficeDashboard` → `/gate`, `/admin/family-ids` (browse), `/directory`; `Sidebar.tsx` has an office nav group. SQL agrees: `lookup_family`, `get_family_cards`, and `record_release` all admit `office`.

- **OK — Office scope is narrow and tested.** Office can read all students (name/grade/transport/familyId/`parentPhone`/`govId` — needed at the gate), read all releases, read the audit trail, and — since `20260820_office_transport_edit.sql` — change exactly one column (`transport`) on one student, with an explicit guard that office cannot un-`LEFT` a student. Office is **blocked by construction** from `generate_family_ids`, `assign_family_override`, `mark_student_left`, and `set_student_import_fields`, and from all grade/exam/promotion writes — each asserted in `supabase/tests/rls-office-role.sql` and `rls-office-transport.sql` (the latter verifies the "narrow-widening invariant": transport edit gained office and *nothing else*). Two scope notes: (a) office read-all-students includes `parentPhone`/`govId` for the *whole school*, which is broader than "gate only" but is the documented front-desk intent; (b) office also gets `/messages` and `/streams` — unrelated to the gate, harmless but worth knowing.

- **OK — The office-role assignment bug is fixed *for account creation*.** `createUser()` (`src/lib/db/profiles.ts`) no longer does a direct `profiles.insert()`; it pins an admin-authenticated client and calls `create_user_profile()` (`20260802_user_role_rpc.sql`), which enforces the admin check in SQL. A `scripts/create-office-accounts.mjs` service-role script exists to provision Umal/Maxamed/Abdurahman idempotently. Covered by `src/lib/__tests__/user-roles.test.ts` and `supabase/tests/rls-user-role.sql`.

- **BROKEN (partial) — Role *change* on an existing account has no UI, and the surrounding edit/delete paths are still the un-fixed bug class.** `set_user_role()` exists (SQL) and `setUserRole()` exists (client wrapper, `src/lib/db/profiles.ts`), but **nothing calls `setUserRole`** — the ManageUsers "Edit User" dialog only edits name/email. So an admin can grant `office` to a *new* staff member ("Add User" → Office) but cannot flip an *existing* account to office without SQL/Admin API. Separately, `updateUser()` and `deleteUser()` still issue direct `profiles.update()/.delete()` and `students.update()`, which RLS denies (no write policy) — these fail silently in production and are explicitly still open in `TODOS.md` ("Flagged — same bug class OUTSIDE the family-ID/gate feature (NOT fixed, per scope)"). Net: user *editing/deleting* is broken today even though the office-role *creation* path is fixed.

- **RISK — `audit_logs` RLS is still effectively unpoliced.** The deferred item (INVESTIGATION finding 3.2, "deliberately out of scope"; `DESIGN-family-id-printing-FINAL.md` F8) is still open: read is `USING (true)` and insert is `WITH CHECK (true)` for all authenticated users. Consequences: (a) any parent/teacher can read the whole audit trail, including `family_ids.release` (studentId/familyId/staffId) and NOT-FOUND lookups; (b) any authenticated user can forge audit rows, so the `family_ids.gate_not_found` trail — the safety signal the gate depends on — is not tamper-evident. The office migration even *relies* on the broad read ("office is already covered"). Recommend: read scoped to gate roles (or a dedicated viewer RPC), and insert routed through a `SECURITY DEFINER` audit function with an action allow-list.

- **OK — No non-gate role reaches `/gate` or the family lookup RPC.** Client: `canAccessRoute` + `App.tsx` redirect any role not in the `/gate` list to its default dashboard before rendering. Server: `lookup_family` returns `[]` for any caller not in (admin/supervisor/office). Parents additionally can only read their own children (`parentId`-scoped policy + `familyPortal.ts` queries + `rls-office-role.sql` §6 asserts no unrestricted students SELECT policy exists).

- **RISK (pre-existing, adjacent to gate data) — teachers/supervisors can read `parentPhone`/`govId` for assigned classes.** `"Teachers can read assigned class students"` has no column restriction, so it returns `parentPhone`, `govId`, and `familyId` for every student in an assigned class — broader contact-data read than the gate feature itself needs. Not a `/gate` access bug (teachers still can't open the gate or call `lookup_family`), but worth tightening if parent contact data is meant to be office/admin-only.

- **OK — No lingering PIN/shift-login assumptions.** Grep of `src/`, `supabase/`, and `scripts/` finds no PIN input, no "shift login," and no shared-device PIN mode. The only "pin" hits are unrelated (`search_path` pinning, session pinning). The shift-login/PIN approach was fully dropped in favor of named `office` accounts.

---

## 4. How to use it (operational)

**Summary.** Gate staff and office both have working, documented-in-code flows. The go-live blockers are **not** the parent-portal display (M3 is implemented — see below), but rather: (1) the override UI can't fix grouping errors on already-ID'd students, and (2) NOT-FOUND logging doesn't record staff. Both make parts of this guide "can't actually be done in the app yet."

### Gate staff — Umal, Maxamed, Abdurahman

1. **Log in** with your own email + password (named account, no PIN). Your account's role is `office`; an admin creates it for you. After login you land on the Office Dashboard — tap **Dismissal Gate** (or open `/gate`).
2. **Look up a family** either way:
   - **Keypad:** type the 4 digits from the card (e.g. the `0042` in `MBK-0042`), then **✓ Check** (or press Enter).
   - **Scan:** tap 📷, aim at the card's QR. The app fills the ID and checks automatically. If the camera is denied or unsupported, use the keypad.
3. **Match (green):** you see every child in that family with grade and transport, plus the parent's phone number. Verify the adult against the children shown, then tap **Sii Day / Release** next to each child you hand over. A released child shows the release time.
4. **NOT FOUND (full red screen):** re-check the number and try again. A miss is logged. If it keeps failing, **do not release from memory** — escalate (the lookup may be down, or the card/ID is wrong).
5. **Error screen:** the system couldn't reach the server. This is not a match. **Do not release from memory** — retry, and report it (this is exactly the network case the system doesn't yet handle offline).

### Admin / office

- **Generate IDs:** Family IDs → **Setup & Generate** (admin only) → import the transport sheet → **Generate / Dhali lambarrada**. Re-running is safe (never reassigns existing IDs). Watch the amber "joined by phone number — please check" panel.
- **Print / reprint cards:** Family IDs (browse) → find the family → **Print** (pocket/lanyard/placard, front + back). "Print by students" prints only selected students and warns about siblings left off. Reprints are unlimited and untracked.
- **Fix a grouping error (split/merge):** ⚠️ **BLOCKED in the UI today.** The "Assign →" override only appears for students in the **Unattached** bucket (no parent, no phone, no ID). A student who already has a family ID — the split-shared-phone and merge-multiple-phones cases the override was built for — cannot be reassigned from the app; it currently requires an admin to run `assign_family_override()` via SQL (or a manual `UPDATE students SET "familyId" = …`). **Go-live blocker #1.**
- **Grant the office role:** for a **new** staff member, Manage Users → Add User → choose **Office** (this path is fixed and works). For an **existing** account, there is **no in-app way to change the role** — `set_user_role()` exists in SQL but is not wired to any button. **Go-live blocker #2** (admin must use SQL/Admin API for now). Also note user *edit/delete* (name/email change, delete) is still broken in production (same un-fixed RLS write bug) — avoid relying on those buttons until fixed.

### Go-live blockers (things this guide can't yet deliver in-app)

1. **Manual override is unreachable for already-ID'd students** — cannot split or merge families from the UI.
2. **No in-app role-change** to grant `office` to an existing user (creation works; change doesn't).
3. **User edit/delete** (Manage Users "Save Changes" / delete) still use direct RLS-denied writes — silently do nothing in production.
4. **NOT-FOUND audit has no staff attribution** and can be lost/spoofed (client-side, open `audit_logs` insert).

*(The audit prompt's example of "M3 parent-portal family ID display, if still pending" is **not** pending: `src/pages/parent/components/FamilyIdCard.tsx` + `RecentReleases.tsx` are rendered in `ParentDashboard.tsx`, backed by `getParentFamilyCard()`/`getRecentReleases()`. The parent-side card uses the same `@react-pdf/renderer` pocket layout. What *is* deferred is parent **self-service reprint** ("Parent portal card reprint link" in `TODOS.md`).)*

---

## Top issues to fix before this is the sole gate-release check

1. **Override UI can't fix grouping errors once IDs exist (BROKEN).** `assign_family_override` is only exposed for unattached students (`src/pages/admin/FamilyIds.tsx`); the split-a-shared-phone and merge-multiple-phones cases — the entire point of the override — are unreachable in-app. Add a per-student "Re-assign family" action (with confirmation + the existing 4-digit guard) to the families table, so a `phoneJoins` finding or a split family can be corrected by staff. *Files: `FamilyIds.tsx`, `FamiliesTable.tsx`, `supabase/migrations/20260802_family_import_rpc.sql`.*

2. **NOT-FOUND logging is not a trustworthy audit record (RISK).** It's client-side and best-effort (`src/lib/db/gate.ts` → `createAuditLog`), records no staff identity, and can be dropped or forged. Move the write into the `lookup_family` RPC (or a `record_gate_lookup` RPC) so every NOT-FOUND is atomic with the lookup and carries `current_profile_id()` + timestamp. *Files: `src/lib/db/gate.ts`, `supabase/migrations/20260802_family_ids.sql` (lookup_family), `00001_create_audit_logs.sql`.*

3. **`audit_logs` RLS is open read + open insert for all authenticated users (RISK).** The explicitly-deferred item is still open: parents/teachers can read the full audit trail (including release records) and can forge `gate_not_found` entries. Scope read to gate roles (or a viewer function) and route inserts through a SECURITY DEFINER audit function with an allow-list. *File: `supabase/migrations/00001_create_audit_logs.sql`.*

4. **Release log records staff→child→family but not the receiving adult (RISK).** A wrong handoff after a *valid* match is still not attributable to the person who took the child, and Release is an optional tap so it can be skipped. Decide the minimum viable adult verification (e.g. prompt gate staff to record the adult's name, or scan a parent's own card) and make release recording a required step of a handoff. *Files: `supabase/migrations/20260802_release_log.sql`, `src/pages/admin/gate/GateScreen.tsx`.*

5. **Office role change + user edit/delete are still broken in production (BROKEN/partial).** `set_user_role` has no UI, and `updateUser`/`deleteUser` still use direct RLS-denied writes (the acknowledged, still-open bug class in `TODOS.md`). At minimum wire a role selector into Manage Users (via `setUserRole`) so the office team can be expanded/rotated, and fix or remove the silently-failing edit/delete buttons. *Files: `src/lib/db/profiles.ts`, `src/pages/admin/ManageUsers.tsx`, `supabase/migrations/20260802_user_role_rpc.sql`.*

*(Supporting, lower-priority: add a server-side "unknown transport" gate — see §1 — so malformed Bus cells can't silently become walkers; add card-print tracking/reprint reasons when reprints become routine; and run `supabase/tests/preflight-family-id-stability.sql` against the live DB before trusting any of the above, given the repo's documented live-drift history.)*
