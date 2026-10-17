# MBK Fingerprint Attendance — Release Readiness (2026-10-17)

## Decision

**Do not release yet.** Read-only inspection of the expected Supabase project found the fingerprint schema objects from all three migrations, but their versions are absent from the Supabase migration ledger and the only branch still reports `MIGRATIONS_FAILED`. The credential-workflow commit and the subsequent documentation update both passed Vercel Preview deployment checks; however, Vercel environment variables cannot be inspected from this sandbox, so encryption/connector secrets and the runtime DB URL remain unverified. No credential was entered or used, no device connection or attendance retrieval occurred, and no database writes or migrations were performed during this verification.

## Gate results

| Gate | Result | Evidence / remaining work |
|---|---|---|
| 1. Protect existing ERP | **PASS** | Existing ERP stack/routes remain; changes are additive. No production Supabase changes, K40 network connection, data clear, setting change, key bypass, or public port forwarding was performed. Unrelated work was not reset or reverted. |
| 2. Connector reliability | **PARTIAL** | Existing import path remains event-driven and leased. New device tests are inserted only by an authenticated admin, claimed once by the LAN connector, and reported with safe result codes; connector absence is surfaced after 30 seconds. No polling or background device connection. Realtime behavior/RLS and recovery on the actual Preview project are unverified. |
| 3. Simulated end-to-end | **PARTIAL** | Existing API mock tests exercise manual import, admin denial, claim, dedupe, timestamps, status/export. New crypto tests verify AES-GCM round trip, tamper rejection, and missing-key failure; UI tests preserve manual-only import behavior; connector tests cover a synthetic CommKey vector, auth success/rejection, refused address vs unreachable network, credential-not-verified, and cleanup. No actual Realtime/Supabase or hardware handshake test. |
| 4. Full tests and dependency audit | **PARTIAL** | Latest `npm run typecheck`, `npm run typecheck:api`, and `npm run build` passed. Latest `npm run test:ci`: **166 files, 1,796 tests passed**. Connector test suite: **7/7 passed**. Warnings remain from existing missing logo reads, mock Supabase configuration, and React `act(...)` test setup. Dependency audit remains unresolved: root has 21 findings (2 low, 3 moderate, 15 high, 1 critical); connector tree has zero. |
| 5. Migration/deployment preparation | **PARTIAL / BLOCKED** | Read-only schema inspection confirms the fingerprint tables, RLS policies, Realtime publication entries, and candidate-promotion RPC on `aassaas` (`qopeilyvkfqbjdeudwnz`). Supabase migration history has no `20261017*` entries and the only branch reports `MIGRATIONS_FAILED`. Vercel Preview deployment checks passed for the feature and documentation commits; the environment variables cannot be inspected here. No migration, secret, or database write was made. |
| 6. Real K40 prerequisites | **BLOCKED** | The device identity, address, port, model/firmware, and credential must be explicitly confirmed by an authorized technician and configured server-side; code has no target fallback. The new legacy CommKey handshake is only covered by synthetic fixtures and has not been verified against this K40. No device contact or real records occurred. |

## Connector and trust boundary review

The LAN process authenticates to Supabase Realtime as a dedicated Auth identity whose **trusted `app_metadata.role`** is `fingerprint_connector`; table RLS allows it to observe only queued job/test metadata. Realtime changes are event-driven. Admin API requests verify the current Supabase user and `profiles.auth_id` mapping to an admin role. Connector-to-API calls use `FINGERPRINT_CONNECTOR_TOKEN`, distinct from Supabase credentials. The Supabase service-role key and `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` are server-only.

Device credentials use AES-256-GCM in a service-role-only encrypted store. Saving a replacement creates a separately encrypted candidate; the active key is preserved until an authenticated read-only connection test succeeds. A database RPC promotes the exact candidate revision tested, atomically; a failed or stale candidate is never claimed as active. The frontend receives configured/pending status only, never the saved key. Connector receives decrypted bytes only for a specifically claimed job/test over the authenticated API; source, `.env`, browser storage, URLs and diagnostics do not hold the device credential.

### Required runtime settings and verification

The API/serverless runtime requires `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` (canonical base64 for exactly 32 random bytes), `SUPABASE_URL` (or `VITE_SUPABASE_URL`), `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`, `FINGERPRINT_CONNECTOR_TOKEN`, `ZK_DEVICE_SERIAL`, `ZK_DEVICE_IP`, and `ZK_DEVICE_PORT`. `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` must remain stable across deploys while encrypted credentials exist. The connector host separately needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, its dedicated Auth email/password, `ERP_API_URL`, matching `CONNECTOR_TOKEN`, and matching `ZK_DEVICE_SERIAL`; it does not store the device communication key or target address/port.

Verification result: no local `.env` exists; the Vercel CLI is not installed and no Vercel environment-management connector is available. Supabase project secret metadata does not expose the Vercel serverless environment and does not list `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY`. Therefore these settings are **not verified in the runtime that needs them**. Do not create the encryption key in Supabase project secrets as a substitute for Vercel Preview secrets.

Claim changes `queued → running` conditionally and mints a lease token. Every later action must present that attempt token; it is cleared at terminal completion/failure or on explicit retry. A stale worker cannot complete after an admin retries and receives a new lease. Jobs older than 24 hours cannot be claimed; processing leases expire after five minutes and require explicit admin retry. Completed, partial-failed, failed, cancelled, or otherwise non-queued rows cannot trigger a fresh claim. The connector listens only for a specific row event and does not poll for jobs or touch the device while idle.

Residual caveat: Postgres Changes policy behavior and private Realtime authorization must be verified on the intended Preview project. If no connector claims a test within 30 seconds, the UI reports connector unavailable and the administrator can start a new test; the system does not poll, retry automatically, or connect while idle.

## Live Supabase inspection (read-only, 2026-10-17)

The connected account lists nine projects; `aassaas` (`qopeilyvkfqbjdeudwnz`, Postgres 17, `eu-west-1`) is the only active project. The repository's seed config and the PR's Supabase Preview check link point to this project, so it is the best-supported intended Supabase target. The repo has no local `.env`, and Vercel's compiled `VITE_SUPABASE_URL` / server environment could not be inspected; therefore the actual deployed API-to-database URL still needs confirmation in Vercel Preview settings. The only Supabase branch listed is `main`; its status is `MIGRATIONS_FAILED` although project services report healthy. Realtime reports service healthy but `db_connected=false` and `replication_connected=false` at inspection.

Read-only SQL inspection found all five expected tables: `fingerprint_import_jobs`, `fingerprint_attendance_logs`, `fingerprint_device_credentials`, `fingerprint_device_credential_candidates`, and `fingerprint_device_test_requests`. Credential columns are ciphertext/nonce/tag only; RLS is enabled, and `authenticated` has no table access to active or candidate credentials. `fingerprint_attendance_logs.employee_id` is nullable text referencing `profiles(id) ON DELETE SET NULL`, with unique `(device_serial,dedupe_key)`. The device-test table has the expected status constraint, admin-read policy, and connector-read policy restricted to queued rows. The import-job table has admin and trusted connector policies. The private Realtime topic policy exists; the publication includes the import-job and device-test tables. The `finish_fingerprint_device_test(uuid,text,text)` RPC exists as `SECURITY DEFINER` with `search_path=public,pg_temp`, executable by `service_role` and not by `authenticated`; it promotes the candidate revision only on success.

**Migration-history discrepancy:** Supabase `list_migrations` and `supabase_migrations.schema_migrations` both end at `20260721_student_promotions`; they do not list any `20261017*` entries. Thus the expected schema is present, consistent with manual SQL application, but these changes are not recorded as successful managed migrations. Do not rerun the SQL blindly. Confirm the migration ledger and the branch's `MIGRATIONS_FAILED` condition before future managed deployment. The authenticated role has table-level INSERT privilege on some of the fingerprint tables by default, but RLS has no authenticated INSERT policies, so such writes are denied by policy; a future hardening migration could revoke those unused DML grants after review.

No classroom attendance rows were queried or modified during this inspection. No production data writes, credential writes, or migration changes were made.

## Migration review and staging procedure

Files:
- `supabase/migrations/20261017_fingerprint_attendance.sql`
- `supabase/migrations/20261017b_fingerprint_connector_access.sql`
- `supabase/migrations/20261017c_fingerprint_device_credentials.sql` (encrypted active/candidate stores, admin test request table, atomic candidate promotion after successful auth)

They are additive: new fingerprint tables, indexes, unique `(device_serial,dedupe_key)`, RLS read policies, connector SELECT policies, private Realtime topic authorization, publication membership, and credential-promotion RPC. They do not alter classroom attendance/payroll or delete device records. Read-only checks on `qopeilyvkfqbjdeudwnz` found the expected objects, but no migration-ledger entries. Do not rerun these files blindly; first resolve the branch's migration failure and reconcile the manually applied SQL with the managed migration history on the confirmed target.

Suggested verification queries in staging:

```sql
select to_regclass('public.fingerprint_import_jobs'), to_regclass('public.fingerprint_attendance_logs');
select relrowsecurity from pg_class where oid in ('public.fingerprint_import_jobs'::regclass, 'public.fingerprint_attendance_logs'::regclass);
select schemaname, tablename from pg_publication_tables where pubname='supabase_realtime' and tablename='fingerprint_import_jobs';
select policyname, tablename, roles, cmd from pg_policies where tablename in ('fingerprint_import_jobs','fingerprint_attendance_logs');
```

Also test admin/non-admin/connector JWTs, private channel join, one queued INSERT event, one explicit UPDATE redispatch, expired-job rejection, unique duplicate conflict, and protected exports using synthetic records. Do not seed real biometric data. Migrations have no automatic rollback script. Since they are additive, rollback in a disposable test project can drop only these new tables/policies/publication membership after confirming no other dependency; in a persistent project, take a backup and obtain approval before any rollback/drop. Never use a destructive rollback as a test.

## Dependency audit detail

`npm audit --json` on the root lock reports 21 advisories:

- **High/critical and direct:** `react-router-dom` (high; router advisories include SSR/RSC and redirect issues), `vite` (high; dev-server path/file-read issues), `vite-plugin-singlefile` (high; transitive `braces`/`micromatch`), `supabase` CLI (high, plus vulnerable `tar` transitive **critical**), and `xlsx@0.18.5` (high; SheetJS prototype pollution/ReDoS, npm reports no fix).
- **Moderate direct:** `vitest@4.1.4` / `@vitest/mocker` path traversal.
- Remaining transitive reports include `@babel/core`, `@tootallnate/once`, `baseline-browser-mapping`, `browserslist`, `form-data`, `nanoid`, `picomatch`, `postcss`, `source-map-js`, and `ws` (2 low, 3 moderate, 15 high, 1 critical overall).
- Root install was done with `npm ci --ignore-scripts` after regular `npm ci` failed because Supabase CLI postinstall could not verify its GitHub release certificate. Runtime here is Node 22.22.3 while the repository requires Node 24.
- `npm update`, explicit safe same-major install attempts, and `npm audit fix --dry-run` failed in npm 10.9.8 with Arborist `Cannot read properties of null (reading 'edgesOut')`; no versions/lockfiles were changed. Do not force a downgrade from `vite-plugin-singlefile` to npm’s suggested 0.9.0 major line, upgrade Supabase CLI 1→2 blindly, or assume xlsx is fixed. Next action: reproduce dependency updates in a clean Node 24 environment; choose tested patched same-major versions for Vite/Vitest/router, evaluate a compatible supported single-file plugin path, replace or isolate SheetJS for server export, and upgrade CLI only with migration-command regression tests. Connector lock audit: zero findings.

## Real hardware procedure (not yet performed)

1. Before any device test, owner/technician verifies the K40 serial, fixed LAN IP, and port; these must be configured explicitly in Vercel Preview server secrets. No code default target is allowed. Keep TCP 4370 LAN-only; do not port-forward it.
2. Confirm the Vercel Preview runtime points to the intended non-production Supabase project and resolve the absent migration-ledger entries / `MIGRATIONS_FAILED` status without rerunning DDL blindly. Configure a durable random 32-byte base64 `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY`, connector token, exact device target, and dedicated connector auth identity in their actual secret managers. Ensure the connector `.env` is ignored and owner-only.
3. Authorized admin enters the temporary credential only through the masked UI. It is staged encrypted, not activated. Start the connector on the school LAN, then use **Test connection** once. It should report address/port refusal, network failure, timeout, authentication rejection, unsupported response, connector unavailable, or success. On successful CommKey authentication and read-only device-info response, the tested candidate is atomically promoted; on failure the previous active key remains.
4. The CommKey transform is manually ported from a published pyzk reference and has a synthetic vector test, but model/firmware compatibility remains unverified. A passing simulator test is not evidence of hardware support. Do not claim success or run attendance retrieval until the real test verifies on the intended K40. The test must use only TCP to the configured address/port and must never clear logs, change users/settings, or retrieve biometric templates. No attendance or payroll data is modified by this connection test.

## Required next actions before release

1. Confirm Vercel Preview's Supabase URL and server variables without exposing values. The sandbox has no Vercel CLI/connector access; do not use the Supabase SQL editor project secrets as a substitute for Vercel secrets.
2. Reconcile the manually present schema against Supabase migration history and resolve `MIGRATIONS_FAILED`; do not rerun DDL unless an approved repair plan confirms it is safe.
3. Configure the server-only encryption key, connector token, and explicitly verified device target in Vercel Preview; provision the dedicated connector identity and protected `.env` on an always-on school-LAN host.
4. Authorized owner enters the temporary credential through the protected UI, then runs one connector-mediated Test connection. Confirm protocol/auth compatibility before any attendance-interface read. No credential entry or device test has occurred here.
5. Resolve dependency audit issues and remaining integration-test gaps. Only after the Preview and hardware gates pass, obtain explicit approval before production rollout.
