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

1. **Run the migration** on the Supabase project (Dashboard → SQL, or `supabase db push`):
   `supabase/migrations/20261005_push_notifications.sql`.
2. **Generate VAPID keys**: `node scripts/generate-vapid-keys.mjs`.
3. **Set Vercel environment variables** (server-side only):
   - `SUPABASE_SERVICE_ROLE_KEY` (never prefixed `VITE_`)
   - `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   - Optionally `VITE_VAPID_PUBLIC_KEY` (public, skips the `/api` lookup)
   (`SUPABASE_URL`/`SUPABASE_ANON_KEY` fall back to the existing `VITE_` values.)
4. Deploy as usual. The build stamps `dist/sw.js` with a content hash so installed
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

- `npm run typecheck` — clean.
- `npm run test:ci` — 127 files / 1387 tests pass, including:
  - `webpush.test.ts`: RFC 8291 encrypt→decrypt round-trip + RFC 8292 VAPID header.
  - `notificationSender.test.ts`: multi-device delivery, preference skips,
    no-device and 410-deactivation paths.
  - `pushNotifications.db.test.ts`: the real migration loaded into PGlite; RLS
    proven as a non-owner `authenticated` role.
  - Render smoke tests for all new pages/cards.
- `npm run build` + served `dist/`: `/sw.js` (`application/javascript`),
  `/manifest.webmanifest` (`application/manifest+json`), icons (`image/png`),
  deep link `/teacher/lesson-plans` → 200 HTML (SPA rewrite).

Live push delivery requires the production Vercel + Supabase environment (a real
push service); it cannot be exercised inside the sandbox.
