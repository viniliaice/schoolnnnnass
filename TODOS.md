# TODOS.md — MBK International School

Deferred work from CEO review (2026-08-02) — Family ID Generator.

## RLS write-path fixes (family-ID/gate) — DONE (2026-08-02)
- **Root cause:** the app's Supabase client uses the anon key, so RLS applies to every REST write. `students` and `profiles` are SELECT-only under RLS (20260708_profiles_auth_session_rls) — **no INSERT/UPDATE policy for any role** — so every direct `supabase.from(...).update()/.insert()` is silently denied. Two instances of this bug class shipped inside the family-ID feature; both fixed by moving writes to admin-only SECURITY DEFINER RPCs:
  1. **Transport import "Apply"** (`applyTransportImport`) used `supabase.from('students').update()` → always "Applied 0 row(s)". Fixed with `set_student_import_fields()` RPC (`supabase/migrations/20260802_family_import_rpc.sql`); client now reports real per-row errors instead of a silent success count.
  2. **Office-role save** — `createUser(role:'office')` used `supabase.from('profiles').insert()` → the office account never persisted. Fixed with `create_user_profile()` + `set_user_role()` RPCs (`supabase/migrations/20260802_user_role_rpc.sql`).
  3. Also hardened: `assign_family_override()` now caps manual IDs at 4 digits so an oversized override can't overflow `generate_family_ids()`'s `MAX(::INTEGER)` and permanently brick the generator.
- **Tests:** `src/lib/__tests__/family-ids.test.ts` (RPC path + regression: no direct UPDATE; real error propagation; override guard), `src/lib/__tests__/user-roles.test.ts` (office role persists via RPC; non-admin rejected), `supabase/tests/rls-family-import.sql` + `supabase/tests/rls-user-role.sql` (real-schema assertions: no direct write policies, RPCs are SECURITY DEFINER + admin-gated + PUBLIC-execute revoked).

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
