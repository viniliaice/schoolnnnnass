# Teacher Web Push Delivery Fix — Implementation Report

Date: 2026-10-06
Branch: `arena/6d022169-schoolnnnnass`

> **Checkout note:** The initial working tree was clean. `PUSH_FIX_FULL.patch` and the previously described `PUSH_DELIVERY_FIX_REPORT.md` were not present in this checkout, so this implementation was reconstructed from the user-provided specification. No production VAPID or Supabase secret values were inspected or recorded; test VAPID keys were generated in memory only.

## 1. Root cause

The established production diagnosis identifies two independent delivery blockers:

1. `VAPID_SUBJECT` contains a Markdown link rather than a bare `mailto:`/`https:` URI. Push services reject the resulting VAPID JWT. The health route previously reported only environment-variable presence, so it could call this invalid configuration healthy.
2. A stored row can be the preview placeholder endpoint (`preview.push.local`) rather than a real device. DNS failures were previously collapsed into a generic failure and did not retire or explain anything.

The send path now classifies HTTP/transport failures, validates VAPID configuration before auth or database writes, persists sanitized failure details, and retires only subscriptions the push service definitively marks expired (HTTP 404/410). It keeps 401/403 rows for safe diagnosis/re-registration because those statuses do not prove the endpoint is dead; server-side token/config mistakes therefore cannot mass-retire devices. Admin diagnostics flags synthetic hosts and malformed key shapes, and describes all-device 401/403 responses as a possible key-rotation/authorization mismatch rather than a proven old key.

## 2. Files changed

- **Server delivery:** `server/lib/webpush.ts`, `server/lib/notificationSender.ts`, `server/lib/pushDiagnostics.ts` (new). Existing explicit `.js` specifiers in `server/lib/supabaseNotificationDb.ts` were left unchanged.
- **API:** `api/notifications/send.ts`, `api/push/health.ts`, `api/push/vapid-public-key.ts`, `api/push/diagnostics.ts` (new). Node-facing relative imports keep explicit `.js` suffixes.
- **Teacher client:** `src/lib/pwa/pushClient.ts`, `src/components/pwa/EnableNotificationsCard.tsx`, `src/lib/auth.ts`, `src/context/RoleContext.tsx`.
- **Admin UI:** `src/components/admin/PushDiagnosticsPanel.tsx` (new), `src/pages/admin/SendTeacherNotifications.tsx`.
- **Validation/tests:** `tsconfig.api.json` (new), `package.json`, and push delivery/health/diagnostics/session/client UI tests under `src/lib/__tests__/` and `src/components/admin/__tests__/`.

`package.json` remains ESM (`"type": "module"`). No Firebase, bundling architecture, or auth/database redesign was added.

## 3. Database changes / migrations / RPCs

**None.** The implementation uses the existing `notification_recipients.last_error`, `delivered_devices`, and `failed_devices` columns. No migration or RPC change is required.

## 4. Vercel environment variable names

- `VAPID_SUBJECT`
- `VAPID_PRIVATE_KEY`
- `VITE_VAPID_PUBLIC_KEY` (must remain unset so the API-served key is authoritative)
- Existing Supabase names, unchanged: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

No environment-variable values are included in this report.

## 5. Tests run

`npm run validate` — **passed**:

- `tsc --noEmit`
- `tsc -p tsconfig.api.json`
- Vitest: **135 files / 1,476 tests passed**
- `vite build` — passed; single-file production HTML and service-worker build completed
- GitHub PR checks: Vercel Preview **passed**; Supabase Preview **skipped** (no DB changes)

The 10 push-related test suites run separately also passed (**99 tests**). They cover VAPID validation and health agreement, authentication/authorization, send fan-out and partial delivery, dead-row retirement, retryable/network failures, diagnostics redaction/hints, key-rotation resubscription, and stale refresh-token cleanup.

The workspace runtime was Node 22 while `package.json` pins Node 24.x; commands passed under the available runtime. `npm ci`'s Supabase CLI postinstall could not verify GitHub's TLS certificate in this sandbox, so dependencies were installed with `npm ci --ignore-scripts`; the Supabase CLI is not needed by validation.

## 6. Production verification / final send result

**Not verified in production in this session.** Read-only requests to the production host were unavailable from this sandbox (`fetch failed`). No production deployment was performed, no production bearer session/device endpoint was available, and no notification was sent to the teacher's phone. Therefore there is no honest production send result to report yet.

Local end-to-end fake-service assertion: **1 recipient / 1 device / 1 accepted / 0 failed**, with `deliveryOk: true`; separate tests assert 404/410 retirement, VAPID/config failures, and one-delivered/one-failed partial outcomes. These are tests—not proof of delivery to a real phone. The real-device acceptance still requires the manual steps below after production deploy.

## 7. Manual actions still required

1. In Vercel, set `VAPID_SUBJECT` to a **bare** `mailto:` URI (no Markdown, brackets, or quotes).
2. Rotate `VAPID_PRIVATE_KEY`; the previously exposed value must be treated as compromised. Generate a new keypair locally with `node scripts/generate-vapid-keys.mjs`, update the Vercel private key, and do not paste it into chat or source control.
3. Keep `VITE_VAPID_PUBLIC_KEY` unset.
4. Merge/deploy this change after the environment is corrected; env changes require a fresh production deployment.
5. On the teacher's installed iOS app, tap **Fix notifications** (or **Enable Notifications**) to register with the new public key.
6. In Admin → Teacher Notifications, inspect Push Diagnostics. For a diagnostics test, enter the teacher's profile ID first (the real-send button requires confirmation); alternatively use the send form with only that teacher selected. Confirm the phone notification and history shows **1 sent / 0 failed**. If diagnostics flags a synthetic preview row, retire only that identified placeholder row—do not mass-delete subscriptions.
