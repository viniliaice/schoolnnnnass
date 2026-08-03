# Investigation — Manage Users "Only admins may create user profiles" (403)

Date: 2026-08-02 · Scope: Manage Users (`/admin/manage-users`), `createUser()` flow, admin-gated RPCs, live-DB drift vs `supabase/migrations/`.

## Status: FIXED (verified in browser 2026-08-02)

Two stacked root causes — both **live-DB drift**, not app code:

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | `create_user_profile` 403: **"Only admins may create user profiles."** even for fardosa (role `admin`) | Legacy live `current_profile_role()` compared `profiles.id` (TEXT domain id, e.g. `admin-…`) to `auth.uid()` (UUID) — never matches → NULL for everyone. The correct `WHERE auth_id = auth.uid()` definition from `20260708_profiles_auth_session_rls.sql` was **never applied to the live DB** | Re-applied the correct function definitions (`current_profile_role` + `current_profile_id`) via SQL editor — see fix SQL below |
| 2 | `create_user_profile` 400: **violates check constraint "users_role_check"** | Live table kept the legacy constraint name `users_role_check` (no `'office'`). `20260802_office_role.sql` drops/creates `profiles_role_check`, so its drop was a no-op live and `'office'` stayed illegal | Dropped both names, recreated `profiles_role_check` with `'office'`; also applied the office read policy + `lookup_family` widening (migration `20260802_fix_live_role_check.sql`) |

## 1. What the feature is

Manage Users creates app users (teacher / supervisor / parent / office). Auth users are created via `supabase.auth.signUp()`, then the profile row is written through the admin-only SECURITY DEFINER RPC `create_user_profile()` (`supabase/migrations/20260802_user_role_rpc.sql`) — `profiles` is SELECT-only under RLS, so the RPC is the only write path.

## 2. Root cause detail

### 2.1 `current_profile_role()` — legacy definition in the live DB

Live (`pg_get_functiondef`):

```sql
SELECT role FROM profiles WHERE id = auth.uid()::text;   -- never matches
```

`profiles.id` is the app domain id (`admin-1774255472831-xwbiak`); `auth.uid()` is the auth UUID (`0006c093-…`). The comparison is always false → returns NULL → `create_user_profile` (and every other admin-gated RPC: `set_user_role`, `generate_family_ids`, `set_student_import_fields`, `lookup_family`, …) raises `Only admins may …` for **every** user, including admins.

This is the same root cause as the earlier family-import failure ("Only admins may apply the transport import") — the `[diag]` message in `familyIds.ts` pointed exactly at this.

Correct definition (re-applied):

```sql
SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
```

### 2.2 Role check constraint name drift

The live table's constraint is `users_role_check` (legacy name, without `'office'`). `20260802_office_role.sql` operates on `profiles_role_check` only, so applying it never touched the live constraint.

## 3. App-side changes (this investigation, all verified)

- `src/lib/supabase.ts` — `createAuthedClient(accessToken)`: Supabase client pinned to a specific JWT. Verified against installed supabase-js **2.99.3** with a fetch-probe: every request carries `Authorization: Bearer <token>`; postgrest-js does **not** pre-set Authorization in this version, so the pin holds.
- `src/lib/db/profiles.ts` `createUser()` — (1) guard: capture session via `getSession()` and verify it resolves to a profile with `role === 'admin'` *before* creating anything (a previous failed attempt leaves the *new user's* session in storage; `signUp()` swaps the shared client's session and `setSession()` restore is unreliable — silent no-op paths in auth-js `_setSession`/`_callRefreshToken`, confirmed from the installed source); (2) run the RPC only on the pinned client with the admin's token.
- `src/lib/auth.ts` — `getProfileByAuthId()` uses `.maybeSingle()` (missing profile is a normal mid-signup state, not a `.single()` crash).
- Tests: `src/lib/__tests__/user-roles.test.ts` (pinned-token RPC assertions, stale-session rejection), 170/170 pass, typecheck clean.

## 4. Fix SQL (applied to live DB via dashboard SQL editor)

```sql
-- (1) current_profile_role / current_profile_id — correct bridge definitions
create or replace function public.current_profile_id()
returns text language sql stable security definer set search_path = public
as $$ select id from public.profiles where auth_id = auth.uid() limit 1; $$;

create or replace function public.current_profile_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.profiles where auth_id = auth.uid() limit 1; $$;

-- (2) role check constraint (both names → canonical one allowing office)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor', 'office'));

-- (3) office read policy + lookup_family widening — see
--     supabase/migrations/20260802_fix_live_role_check.sql (full file)
```

## 5. Operational notes / pitfalls

- **Verify live functions with `pg_get_functiondef`** before assuming `supabase/migrations/` matches the live project. This project's live DB has drifted at least twice (`current_profile_role`, `users_role_check`) — migrations were applied selectively/edited in the SQL editor.
- **Failed `createUser` leaves an orphan auth user + a corrupted stored session** (the new user's). Retrying with the same email fails with "User already registered"; retrying without re-signing-in hits the guard ("Not signed in as an admin. Sign out and log in again, then retry."). Delete the orphan in Dashboard → Authentication → Users, or use a fresh email.
- **Supabase clients pin to the session in `localStorage` on creation** — an "authed" client created mid-flow can pick up the wrong user's token. The `accessToken` option (as used in `createAuthedClient`) is the reliable pin.

## 6. Verification

- Browser: after fixes, creating an office user succeeds (toast "office created successfully"); family transport import no longer reports "Only admins may apply".
- `npm run typecheck` clean; `npm run test:ci` 170/170.
