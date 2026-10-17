# MBK Fingerprint Attendance — Release Readiness (2026-10-17)

## Decision

**Do not release to production.** No production migration/API/connector deployment or device connection was attempted. The branch work is preserved and the current protected connector will refuse K40 reads unless the communication key is positively confirmed as zero. Even with a zero key, `zkteco-js` remains unapproved pending actual compatibility and security review.

## Gate results

| Gate | Result | Evidence / remaining work |
|---|---|---|
| 1. Protect existing ERP | **PASS** | Existing ERP stack/routes remain; changes are additive. No production Supabase changes, K40 network connection, data clear, setting change, key bypass, or public port forwarding was performed. Unrelated work was not reset or reverted. |
| 2. Connector reliability | **PARTIAL** | Private-channel Postgres Changes listener reacts to INSERT and UPDATE dispatch events. Explicit admin retry re-dispatches failed work, stale queued work, or a job with expired processing lease. Atomic status compare-and-set claim, per-attempt lease token, five-minute lease, 24-hour queued dispatch expiry, job-owner/admin checks, and terminal-state checks prevent duplicate claims/stale workers from finishing. No periodic search/poll, schedule, or automatic retry. Realtime behavior/RLS has not been verified against Supabase; connector-offline and lease-expiry flow only partially simulated. |
| 3. Simulated end-to-end | **PARTIAL** | New API-handler mock test exercises admin enqueue/denial, single claim, status, simulated event batch, DB-style deduplication, timestamp preservation, protected status/export, and actual CSV/XLSX bytes parsed and checked. UI test confirms no request on mount and one request per click. Connector adapter tests cover fail-closed key and cleanup on simulated retrieval failure. Missing: actual Realtime client delivery simulation, API connection-failure plus explicit retry end-to-end, injected partial DB batch failure, cancelled/lease takeover matrix, and isolated test database. |
| 4. Full tests and dependency audit | **PARTIAL** | `npm run typecheck`, `npm run typecheck:api`, `npm run build` pass after code updates. `npm run test:ci -- --maxWorkers=1`: **165 files, 1,792 tests passed** (final serialized run after lease/retry changes; 201.97 seconds). Existing non-failing test noise includes missing static logo reads in print tests, mock-Supabase configuration warnings, and React `act(...)` environment warnings in the fingerprint page test. Three files that timed out under earlier parallel runs were each run alone and passed: `duplicateBatch.pageVsServer.test.ts` (7), `lesson-plan-submission-roster.db.test.ts` (6), `lesson-plan-weeks.db.test.ts` (5). Evidence indicates resource/parallel contention, not isolated reproducible failures. Audit remains unresolved: root tree has 21 findings (2 low, 3 moderate, 15 high, 1 critical); connector tree has zero. Safe dependency updates were attempted but npm Arborist crashed (`Cannot read properties of null (reading 'edgesOut')`), so no dependency versions were changed. |
| 5. Migration/deployment preparation | **BLOCKED** | Live read-only inspection of repository-bound candidate `qopeilyvkfqbjdeudwnz` found no fingerprint tables or 20261017 history entries; both migrations are pending. Supabase project display name is `aassaas`, so MBK production identity still needs owner confirmation. No isolated branch or verifiable backup/recovery posture; local pending migration now aligns employee mapping with `profiles.id text`, but remains unapplied/unverified. No migration/API/connector deployment attempted. |
| 6. Real K40 prerequisites | **BLOCKED** | User supplied a terminal screenshot reporting TCP/IP, `192.168.1.201:4370`, serial `2807990625055`, terminal type Linux, coreboard `JZ4725_TFT`, firmware `4.0.1 (build 82)`, algorithm VX10.0, and date format YY-MM-DD. These details are not independently verified against the physical device. A nonzero device password was disclosed in chat; its relationship to protocol CommKey is unverified and it must be treated as exposed. No TCP connection, authentication, attendance read, timestamp comparison or real cleanup test occurred. No real records or export. |

## Connector and trust boundary review

The LAN process authenticates to Supabase Realtime as a dedicated Auth identity whose **trusted `app_metadata.role`** is `fingerprint_connector`; table RLS allows it to observe only queued/failed job metadata. Realtime changes provide event-driven INSERT/UPDATE delivery. Server-issued jobs are created only after the Vercel API verifies the current Supabase user and `profiles.auth_id` mapping to an admin role. Connector-to-API calls use `FINGERPRINT_CONNECTOR_TOKEN`, distinct from Supabase credentials. The Supabase service-role key is only used by Vercel server endpoints and is not in connector configuration or code.

Claim changes `queued → running` conditionally and mints a lease token. Every later action must present that attempt token; it is cleared at terminal completion/failure or on explicit retry. A stale worker cannot complete after an admin retries and receives a new lease. Jobs older than 24 hours cannot be claimed; processing leases expire after five minutes and require explicit admin retry. Completed, partial-failed, failed, cancelled, or otherwise non-queued rows cannot trigger a fresh claim. The connector listens only for a specific row event and does not poll for jobs or touch the device while idle.

Residual caveat: Postgres Changes policy behavior and private Realtime channel authorization must be verified on the target Supabase project; there is no live evidence that the current migrations/provisioning produce the intended event. Missed or offline events are recovered through an explicit admin retry after queued expiry or lease expiry, not a background scan.

## Live Supabase inspection (read-only, 2026-10-17)

The connected account lists nine projects. The repository contains a public project reference pointing to `qopeilyvkfqbjdeudwnz`; Supabase metadata identifies that active, healthy Postgres 17 project as **`aassaas`**. Its live public schema has 48 tables and school-ERP structures, including `profiles`, `attendance`, `students`, and `class_subjects`, so it is the repository-bound candidate. However, the Supabase display name does not identify MBK and the account contains other projects; owner confirmation of this exact ref as the intended MBK production target is still required before writes. Project health reported DB/Auth/REST/Realtime healthy; Realtime reported DB/replication disconnected at inspection time.

Live `profiles.id` is `text`; `profiles.auth_id` is `uuid`; `role` is checked against admin/teacher/parent/supervisor/office. The classroom `attendance` table is a separate finalized student-attendance table (`studentId`, `className`, `date`, `status`, `teacherId`, timestamps), with status checks and FKs to students and profiles. RLS is enabled; its policies permit role-scoped reads and authorized classroom writes. No live fingerprint tables exist. Supabase migration history has ten entries through `20260721_student_promotions`, with neither 20261017 fingerprint migration present; therefore both are **PENDING**, not partially applied. Live index/constraint/policy inspection confirmed current attendance/profile schema and RLS. Existing auth helper functions include `current_profile_id`, `current_profile_role`, `is_admin`, `assert_admin`, and `can_read_profile`; all relevant inspected helpers are `SECURITY DEFINER`.

**Schema discrepancy resolved in the pending local migration:** `fingerprint_attendance_logs.employee_id` is now nullable `text` referencing `public.profiles(id) ON DELETE SET NULL`, consistent with live staff profile IDs. Current ingestion leaves it null and keeps rows in `review` until an administrator maps a device user. This edit has not been applied anywhere and still requires validation on isolated staging. The connector access migration grants authenticated SELECT on job metadata and permits its dedicated app-metadata role to see queued/failed rows; no live connector grant/policy exists because tables are absent.

No non-default database branch/test environment is available (the only listed branch is `main`; its branch metadata reports `MIGRATIONS_FAILED`). No backup/recovery posture was verifiable from the connected tools. No data writes or migrations were attempted. Live database-backed tests are therefore **BLOCKED**: testing production tables would risk real school data, and there is no isolated branch available. Classroom attendance was inspected structurally only; no rows were changed.

## Migration review and staging procedure

Files:
- `supabase/migrations/20261017_fingerprint_attendance.sql`
- `supabase/migrations/20261017b_fingerprint_connector_access.sql`

They are additive: two new tables, indexes, unique `(device_serial,dedupe_key)`, RLS read policies, connector SELECT grant/policies, private Realtime topic authorization, and publication membership. They do not alter classroom attendance/payroll or delete device records. Prerequisites: the established `profiles.auth_id`/`profiles.role` schema and Supabase-managed `realtime.messages` plus `supabase_realtime` publication must exist; project must have Realtime enabled. Apply sequentially using the repository’s approved Supabase migration workflow to a **disposable/non-production project first**. Confirm the project reference before any apply.

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

1. The user-provided terminal screenshot reports Linux, firmware `4.0.1 (build 82)`, coreboard `JZ4725_TFT`, algorithm VX10.0, TCP/IP, date format YY-MM-DD, and the reported serial/address/port; have an authorized technician verify those against the physical unit. The configured password is nonzero per the user's message, but its exact protocol meaning is unverified. Treat it as exposed because it was shared in chat; if it is the device communication password, have an authorized owner rotate it through the normal maintenance process and store the replacement securely, never in chat. Do not attempt a connection with the current adapter; it cannot set a nonzero communication key.
2. Verify on the school LAN that the connector computer can reach `192.168.1.201:4370/TCP` and that serial `2807990625055` matches the unit. Keep the LAN isolated; never port-forward TCP 4370.
3. If key is nonzero, do not set the current zero-only opt-in. Select an adapter whose supported protocol can authenticate using that key; inspect source/license/maintenance/security, pin its exact version, and add simulator tests first. Current 1.7.2 has no communication-key API. Its top-level `createSocket()` can fall back from TCP to UDP, so the adapter currently uses reviewed TCP internals directly to prevent fallback; that internal coupling is an additional production risk.
4. If key is physically confirmed as zero, this only permits a controlled test after a separate security decision; it does not approve the library. Start connector on LAN and manually request one import using synthetic or approved records. Verify read-only attendance retrieval, exact record shape, source IDs, EAT/device clock interpretation, TCP-only connection, bounded timeout, finally disconnect, and no clear/user/settings calls. Verify the same records persist once on repeat and download bytes/counts match. Record the test operator, device firmware, library version and test result.

## Required next actions before release

1. Resolve dependency audit on Node 24; decide a safe SheetJS replacement.
2. Apply migrations to an identified staging Supabase project, provision connector Auth app metadata and server-only secrets, verify Realtime dispatch/RLS and explicit retry.
3. Add the missing partial database-write/lease-expiry/API failure simulations and verify live connector-to-API path against staging.
4. Have the school verify device key and firmware in person; replace adapter if needed; run the controlled read-only K40 test.
5. Only after all above pass, request explicit owner approval for production migration/API/connector rollout.
