# MBK LAN attendance connector

This is an event-driven LAN process, not a scheduler. It opens a dedicated Supabase Auth session and waits for INSERT events from the explicitly requested import/test tables; it does not connect to the K40 while idle, poll for work, or perform recurring imports. The ERP API accepts only queued admin-created work. The connector has no Supabase service-role key. Never port-forward the K40's TCP port to the public internet.

## Credential and target handling

The device communication key is entered in Administration → Fingerprint Attendance and stored only as AES-256-GCM ciphertext in the server database. It is fetched over the connector's authenticated HTTPS API only after the connector claims a specific authorized job/test. It is never put in this `.env`, browser storage, source, URL, or logs. The connector's `.env` must be owner-only and is Git-ignored; it contains only the connector's own login/API credentials and the verified device serial.

Set these **server-side Preview environment variables** before enabling the workflow:
- `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY`: base64 encoding of exactly 32 random bytes (generate once with `openssl rand -base64 32`, store in the deployment secret manager; preserve it across deployments/backups or existing ciphertext cannot be decrypted).
- `FINGERPRINT_CONNECTOR_TOKEN`: long random API bearer token, also placed in this connector `.env`.
- `ZK_DEVICE_SERIAL`: serial verified on the intended K40, mirrored in connector `.env`.
- `ZK_DEVICE_IP` and `ZK_DEVICE_PORT`: the explicitly approved LAN target only. No default/fallback target is used. Port 4370 is not to be exposed publicly.
- Optional `ZK_TIMEOUT_MS` (default 15000).

## Install

1. Verify the actual non-production Supabase Preview project/branch, apply the required additive migrations there, and set Preview server secrets. Do not apply to an ambiguous production project.
2. Create a dedicated Supabase Auth connector account. Set trusted `app_metadata.role=fingerprint_connector`; do not grant admin or service-role access. Ensure the realtime table policies/publication required by the migrations are enabled.
3. On an always-on school LAN computer, install Node 24, copy this directory, run `npm ci`, copy `.env.example` to `.env`, fill the connector credentials and verified serial, and restrict file access (for example `chmod 600 .env`). The device key is not stored in this file.
4. Start `npm start`; it logs only subscription/operational status. Stop with Ctrl-C or the OS service manager. Keep TCP 4370 LAN-only.

## Connection-test and protocol status

The manual Test connection action sends one request to the LAN connector. It performs a TCP connect, legacy CommKey auth handshake and a read-only device-info command, then disconnects. It never clears logs, changes device settings/users, or requests biometric templates. The adapter's CommKey transform is a local port of the published pyzk reference and has synthetic unit coverage, but the K40 model/firmware handshake has **not** been verified on hardware. Treat a passing mock test as protocol-path testing only, not hardware compatibility. The connector reports safe outcome categories and does not log exception details or credential bytes.

Attendance retrieval is separate and remains explicit/manual. Imported raw device event fields and timestamps are preserved; the API deduplicates records and leaves employee-to-teacher mapping for manual review. Do not make payroll/attendance decisions from unmatched records.
