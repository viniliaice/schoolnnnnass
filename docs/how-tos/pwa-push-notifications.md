# PWA install + teacher push notifications

This upgrade makes `https://schoolnnnnass.vercel.app/` installable as “MBK School”
and lets administrators/supervisors push real OS notifications to teacher devices.
All existing functionality is unchanged.

## What was added

| Area | File(s) |
| --- | --- |
| Web app manifest | `public/manifest.webmanifest` (name/short_name “MBK School”, standalone, theme `#54758D`) |
| Icons (any + maskable + apple-touch) | `public/icons/*.png` (generated from `assets/logo.png`) |
| Service worker | `public/sw.js` (offline shell, push display, click deep-links, versioned caches, safe updates) |
| SW registration / update banner / deep-link bridge | `src/lib/pwa/register.ts`, `src/lib/pwa/navigationBus.ts` |
| Install flow | `src/lib/pwa/install.ts`, `src/components/pwa/InstallAppCard.tsx`, `src/pages/teacher/TeacherInstallPage.tsx` |
| Push subscription (browser side) | `src/lib/pwa/pushClient.ts` |
| Teacher notification centre (enable, settings, devices, history) | `src/pages/teacher/TeacherNotifications.tsx` |
| Admin send UI + history | `src/pages/admin/SendTeacherNotifications.tsx` (route `/admin/teacher-notifications`) |
| Server push sender (RFC 8291/8292, zero deps) | `server/lib/webpush.ts`, `server/lib/notificationSender.ts`, `server/lib/supabaseNotificationDb.ts`, `server/lib/supabaseRest.ts` |
| Vercel functions | `api/push/vapid-public-key.ts` (GET, public key only), `api/notifications/send.ts` (POST, admin/supervisor only) |
| Database | `supabase/migrations/20261005_push_notifications.sql` |
| Deploy config | `vercel.json` (SPA rewrites for deep links + correct MIME headers for sw/manifest/icons) |
| Key generation helper | `scripts/generate-vapid-keys.mjs` |

## Deployment steps

The delivery-hardening changes do not alter the schema and require no new migration. For a first-time push deployment only, apply the original migration once: `supabase/migrations/20261005_push_notifications.sql`.

1. **Generate VAPID keys**: `node scripts/generate-vapid-keys.mjs`.
2. **Set Vercel environment variables** (server-side only):
   - `SUPABASE_SERVICE_ROLE_KEY` (never prefixed `VITE_`)
   - `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (the subject must be a bare `mailto:` or `https:` URI)
   - Do not set `VITE_VAPID_PUBLIC_KEY`; the browser always fetches the current public key from `/api/push/vapid-public-key`.
   (`SUPABASE_URL`/`SUPABASE_ANON_KEY` fall back to the existing `VITE_` values.)
3. Deploy as usual. The build stamps `dist/sw.js` with a content hash so installed
   PWAs detect new versions; users see “New version available — Update Now”.

## Security model

- Teachers write only their own `push_subscriptions` / `notification_preferences`
  and read only their own `notification_recipients` (RLS, re-checked per row).
- `/api/notifications/send` validates the caller’s Supabase access token through
  `current_session_context()` and requires role `admin`/`supervisor` → 403 otherwise.
  Hiding the UI is not the boundary.
- The VAPID private key and service-role key exist only in Vercel server env vars.
- The service worker never caches `/api/*` or cross-origin (Supabase) responses, so
  no student/teacher data is stored where another user could read it.

## Testing performed

- `npm run validate` runs app typecheck, API/server typecheck, the complete Vitest suite and production build.
- Push coverage includes VAPID subject/key validation, HTTP/network failure classification, subscription retirement rules, authenticated send/diagnostics handlers, stale-key re-registration, and the RFC 8291 encrypt→decrypt round-trip / RFC 8292 header checks.
- `pushNotifications.db.test.ts` loads the existing migration into PGlite and proves RLS as a non-owner `authenticated` role; this delivery fix adds no migration.
- Production phone delivery still requires the production Vercel/Supabase environment and a real device; sandbox tests use a scripted push service.

Live push delivery requires the production Vercel + Supabase environment (a real
push service); it cannot be exercised inside the sandbox.
