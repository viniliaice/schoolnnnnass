# MBK LAN attendance connector

This is an event-driven LAN process, not a scheduler. It opens a dedicated Supabase Auth session and waits for INSERT events from explicitly requested import/test tables; it does not connect to the K40 while idle, poll for work, or perform recurring imports. The ERP API accepts only queued admin-created work. The connector has no Supabase service-role key. Never port-forward the K40's TCP port to the public internet.

## Connector environment variables

Create `connector/.env` with exactly these variable names:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_public_key
CONNECTOR_EMAIL=connector-account@example.invalid
CONNECTOR_PASSWORD=replace_with_connector_account_password
ERP_API_URL=https://your-school-preview-deployment.vercel.app
CONNECTOR_TOKEN=replace_with_the_matching_server_token
ZK_DEVICE_SERIAL=your_verified_device_serial
```

Use plain `NAME=value` entries: no Markdown links, duplicate keys, or `VITE_` names. `ERP_API_URL` is the deployed Vercel **Preview** deployment's base URL, not `localhost`; the connector appends its API path. Keep `.env` private and out of source control. The Supabase anon key is public by design, but the connector password and token are credentials and must remain private. Frontend `VITE_` variables are configured separately and do not replace these connector variables.

`CONNECTOR_TOKEN` must match the server-side Preview variable `FINGERPRINT_CONNECTOR_TOKEN`. The following belong only in the server-side Vercel Preview environment, never in `connector/.env`:

- `FINGERPRINT_CONNECTOR_TOKEN`
- `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY`
- `ZK_DEVICE_IP`
- `ZK_DEVICE_PORT`

The service-role key is not required by this connector and must not be placed in its environment file. Enter the device communication key only through **Administration → Fingerprint Attendance**; it is stored server-side encrypted and fetched only for an authorized job/test. Do not put it in `.env`, source, browser storage, a URL, or logs.

Changing `FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY` can make existing encrypted device credentials undecryptable. Before rotating it, have an administrator verify whether encrypted credentials already exist and plan a safe migration; do not delete credentials or database rows to resolve a key mismatch. Rotate exposed connector credentials and tokens in their proper secret managers, and update the matching values together. Do not replace an encryption key without first checking the existing ciphertext.

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

Enter the seven plain assignments above in VS Code, replacing each placeholder with the correct value. Save the file, then verify configuration without displaying any values:

```powershell
npm run diagnose
npm start
```

The diagnostic prints only each required variable's name and whether it is set. `npm start` loads `.env` using Node 24's built-in `--env-file` option. Stop the connector with Ctrl+C or the OS service manager.

On macOS/Linux, create `.env` only if it does not already exist with `touch .env`, restrict it with `chmod 600 .env`, edit it in your editor, then run `npm ci`, `npm run diagnose`, and `npm start` from this directory.

## Server-side setup and operation

Use the intended non-production Vercel Preview deployment and Supabase project. Configure the server-only Preview variables listed above in Vercel; do not expose them through frontend `VITE_` variables. Create a dedicated Supabase Auth connector account with trusted `app_metadata.role=fingerprint_connector`; do not grant admin or service-role access. The serial in this connector's `.env` must match the intended device serial configured by the application. Do not rerun applied migrations to clear "already exists" errors.

The connector waits for authorized manual jobs. It retrieves the encrypted device credential over its authenticated HTTPS API only after claiming a specific job/test. It does not access the device while idle.

## Connection-test and protocol status

The manual Test connection action sends one request to the LAN connector. It performs a TCP connect, legacy CommKey auth handshake and a read-only device-info command, then disconnects. It never clears logs, changes device settings/users, or requests biometric templates. The adapter's CommKey transform has synthetic unit coverage, but the K40 model/firmware handshake has not been verified on hardware. Treat a passing mock test as protocol-path testing only, not hardware compatibility. The connector reports safe outcome categories and does not log exception details or credential bytes.

Attendance retrieval is separate and remains explicit/manual. Imported raw device event fields and timestamps are preserved; the API deduplicates records and leaves employee-to-teacher mapping for manual review. Do not make payroll/attendance decisions from unmatched records.
