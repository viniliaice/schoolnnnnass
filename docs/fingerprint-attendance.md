# MBK Fingerprint Attendance

See [`FINGERPRINT_RELEASE_READINESS.md`](./FINGERPRINT_RELEASE_READINESS.md) for gate status, test evidence, audit details, staging instructions, device prerequisites and blockers.

## Current behavior

- Admin page is `/admin/fingerprint-attendance`; opening it does not create an import or connect to hardware.
- An authorized button click creates a UUID import job. Supabase Realtime Postgres Changes (INSERT/UPDATE) is the event dispatch; there is no queue polling/scheduled work.
- The dedicated connector identity can observe only queued/failed dispatch metadata. It claims by compare-and-set and receives a per-attempt lease token. API writes require a separate `FINGERPRINT_CONNECTOR_TOKEN`, not a Supabase credential.
- Queued events expire after 24 hours; processing leases expire after five minutes. The administrator can explicitly retry failed jobs, expired queued jobs, or expired leases. Retries reset counts and cannot override a newer lease. No automatic retry exists.
- Records are stored in separate raw fingerprint tables with a database uniqueness constraint. Exports are generated from validated stored rows and protected by administrator/job-owner checks. Partial/failed jobs are not exportable.
- The adapter refuses to read with an unknown/nonzero communication key. It does not clear logs, edit device state, manage device users, or retrieve biometric templates.

## Apply to staging only

Apply `supabase/migrations/20261017_fingerprint_attendance.sql`, then `supabase/migrations/20261017b_fingerprint_connector_access.sql` to a disposable/non-production Supabase project after confirming the project reference. Ensure the existing `profiles.auth_id` and `profiles.role` schema and Supabase Realtime objects/publication are present. Verification SQL, policy tests and rollback limitations are in the release-readiness report. Neither migration has been applied in this work.

## Vercel server environment

Set only in protected server/API environment (never `VITE_`):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FINGERPRINT_CONNECTOR_TOKEN` — high-entropy secret shared with connector through a protected local environment file
- `ZK_DEVICE_SERIAL` (initially `2807990625055`) for server-side serial validation

The Vercel service-role key must never be placed in the frontend or connector.

## Local LAN connector

1. Provision a dedicated Supabase Auth account. Set trusted `app_metadata.role` to `fingerprint_connector`; do not grant admin, service-role, table write access, or use user-editable metadata for this authorization.
2. On an always-on computer on the school LAN, install Node 24. In `connector/`, run `npm ci`, copy `.env.example` to a protected `.env`, and configure `SUPABASE_URL`, public anon key, connector Auth login, Vercel API URL, shared connector token, and the device values.
3. Physically verify the K40 communication key before any test. `zkteco-js@1.7.2` has no communication-key API; do not turn on its zero-key opt-in for an unknown or nonzero key. Details and adapter risks are in the release report.
4. Run `npm start`; it waits for Realtime events and does not open a device socket while idle. Stop with Ctrl-C or SIGTERM. Offline/missed events require the explicit administrator retry button after expiry; the connector does not poll for pending jobs.
5. Never expose TCP 4370 to the internet or use router port forwarding.

This connector and the staging procedure are **not production-approved** until Realtime/RLS is verified in staging, dependency issues resolved, failure/retry tests completed, and the actual device is tested under an approved, verified key configuration.
