# MBK LAN attendance connector

The connector is a manual-job worker, not an attendance scheduler. Run it on a computer connected to the school LAN when imports are needed. It makes an outbound authenticated HTTPS request to the deployed Preview API every 10 seconds for an authorized admin-created import or device-test request. It does not connect to the K40 while idle. Stop it with Ctrl+C when it is no longer needed. No Supabase Realtime subscription or dedicated Supabase connector login is used.

## Connector environment variables

Create `connector/.env` with exactly these entries:

```dotenv
ERP_API_URL=https://your-school-preview-deployment.vercel.app
CONNECTOR_TOKEN=the_same_random_token_as_server_preview_setting
ZK_DEVICE_SERIAL=your_verified_device_serial
```

Use plain `NAME=value` entries with one copy of each name. `ERP_API_URL` is the deployed Vercel **Preview** deployment's base URL, not `localhost`; the connector appends the API path. This is an outbound request from the connector to the hosted API, so `localhost` would mean the connector computer itself and would not reach Vercel.

`CONNECTOR_TOKEN` must match Vercel Preview's server-only `FINGERPRINT_CONNECTOR_TOKEN`. The connector no longer uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CONNECTOR_EMAIL`, or `CONNECTOR_PASSWORD`; the Preview API performs server-side database access. Do not put a service-role key in the connector environment.

The following belong only in Vercel's server-side Preview environment, never in `connector/.env`:

- `FINGERPRINT_CONNECTOR_TOKEN`
- `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY`
- `ZK_DEVICE_IP`
- `ZK_DEVICE_PORT`

The device communication key is entered only through **Administration → Fingerprint Attendance**. It is encrypted server-side and fetched only for an authorized job/test. Do not put it in `.env`, source, browser storage, a URL, or logs.

Changing `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` can make existing encrypted device credentials undecryptable. Before rotating it, have an administrator check whether encrypted credentials exist and plan a safe migration. Do not delete credentials or database rows to resolve a key mismatch. Rotate exposed connector tokens in the proper secret manager and update the server and local values together.

## Install and start on Windows PowerShell

Install Node.js 24, open PowerShell, and change to the copied connector directory:

```powershell
Set-Location 'C:\path\to\connector'
npm ci
if (-not (Test-Path -LiteralPath .env)) { New-Item -ItemType File -Path .env | Out-Null }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls .env /inheritance:r
icacls .env /grant:r "$($identity):(F)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)"
code .env
```

Enter the three plain assignments above using your private values. Save the file, then check variable presence without displaying values and start the worker:

```powershell
npm run diagnose
npm start
```

The diagnostic reports only whether each required variable is set. While the connector is running, an admin can choose a date range and request an import from **Administration → Fingerprint Attendance**. The connector checks for that request every 10 seconds and contacts the K40 only after claiming a queued job. Keep it running until the import completes, then stop it with Ctrl+C.

The device library returns attendance logs before applying the selected date filter. The connector filters the records to the requested inclusive dates in Africa/Mogadishu local time before upload, and the server independently enforces the same range before saving. Thus only matching records are stored for that import, although the device may return its full log set to the local connector first.

On macOS/Linux, create `.env` only if absent with `touch .env`, restrict it with `chmod 600 .env`, edit it, then run `npm ci`, `npm run diagnose`, and `npm start` from this directory.

## Server-side setup and safety

Use the intended non-production Vercel Preview deployment. Set the matching `FINGERPRINT_CONNECTOR_TOKEN`, the explicit `ZK_DEVICE_SERIAL`, `ZK_DEVICE_IP`, `ZK_DEVICE_PORT`, and `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` in Vercel's server-side Preview environment. Keep frontend `VITE_` values separate. Do not rerun already-applied migrations to clear "already exists" errors.

The admin action requires both a start and end date, queues that bounded request, and does not start background attendance retrieval. The connector uses an authenticated claim/lease flow so only a queued request is processed, and records are deduplicated on save. Never expose the K40's TCP port to the public internet.

## Connection-test and protocol status

The manual Test connection action performs a TCP connect, legacy CommKey auth handshake and a read-only device-info command, then disconnects. It never clears logs, changes device settings/users, or requests biometric templates. Synthetic unit tests exercise the protocol path, but the K40 model/firmware handshake has not been verified on hardware. A passing mock test is not hardware compatibility verification. The connector suppresses credential details in logs.

Attendance imports are separate and explicit. Imported records require manual review for employee-to-teacher mapping; do not make payroll/attendance decisions from unmatched records.
