# PR #66 — Production Deployment & Notification Module Load Diagnosis

Date: 2026-10-05
Scope: investigation + applied fix (see "Update" below).

> **Update — fix applied on branch `arena/01a10d2c-schoolnnnnass` (no production deploy yet).**
> 1. The 7 relative import specifiers below now carry explicit `.js` extensions (the actual root-cause fix).
> 2. `vercel.json` pins `api/*.ts` and `api/*/*.ts` to the `nodejs20.x` runtime.
> 3. Both push handlers wrap every failure in a readable JSON 500 (the load-time crash itself cannot be
>    caught in-process — that is what the `.js` extensions fix).
> 4. `api/push/health.ts` added: dependency-free runtime/env diagnostics.
> 5. `getVapidPublicKey()` now validates the baked env key and the API response as a 65-byte uncompressed
>    P-256 point (first byte `0x04`) and falls back to the API when the baked key is malformed.
> Verified with Vercel's own `@vercel/node` builder + executing the emitted lambdas, plus `tsc --noEmit`,
> the full 1396-test suite and `npm run validate`.

## Answer

```text
Production deployment commit:        13a3c0abd12edaa37bdceb1f2cf0ce38050becf2  (PR #66 squash commit = current main HEAD)
PR #66 commit:                       13a3c0abd12edaa37bdceb1f2cf0ce38050becf2 (merge/squash commit)
                                     PR head branch: arena/01a10cb2-schoolnnnnass @ 10a6f40b4b614337eacd177eeacd1fefcf9fbbf2
Is PR #66 in production:             YES
Are server/lib files in deployed output: YES  (traced + compiled into the function bundle as *.js — the failure is resolution, not absence)
Root cause:                          package.json "type":"module" + ESM-preserving per-file TS transpile in the Vercel Node
                                     builder leaves the extensionless relative import specifiers ('./webpush',
                                     '../../server/lib/notificationSender', …) in the emitted *.js. Node's ESM loader
                                     requires fully-specified relative paths, so the modules exist as webpush.js /
                                     notificationSender.js but cannot be resolved at runtime ->
                                     ERR_MODULE_NOT_FOUND -> 500 FUNCTION_INVOCATION_FAILED.
Required fix:                        Append explicit .js extensions to the 7 relative specifiers in the Node-facing
                                     import graph (4 files: api/notifications/send.ts, api/push/vapid-public-key.ts,
                                     server/lib/notificationSender.ts, server/lib/supabaseNotificationDb.ts).
                                     No architecture change; no Firebase; no rewrite.
```

## 1. PR #66 IS merged (verified via GitHub API, not assumption)

| Field | Value |
| --- | --- |
| PR | #66 — "Add PWA install + teacher Web Push notifications (MBK School)" |
| State | `MERGED` |
| Merged at | 2026-10-05T17:07:31Z |
| Head branch / commit | `arena/01a10cb2-schoolnnnnass` @ `10a6f40b4b614337eacd177eeacd1fefcf9fbbf2` |
| Merge commit | `13a3c0abd12edaa37bdceb1f2cf0ce38050becf2` (squash, 1 commit) |
| `main` HEAD | `13a3c0a` — no commits after it |

Vercel check on the PR **head** was `failure` / *"Deployment was blocked"* (preview); the **merge commit** produced a
successful production deployment, so the (pre-merge) blocked preview is not the production state.

## 2. Production IS running the PR #66 build

| Evidence | Result |
| --- | --- |
| Vercel commit status on `13a3c0a` | `state=success`, *"Deployment has completed"*, 2026-10-05T17:25:22Z, target `…/schoolnnnnass/HemPmwCEEvkzQSYdrhcyvVnLaKVU` |
| `GET /sw.js` (live) | Served, stamped `RAW_BUILD_ID = 'fbd2971d71f5302c'` — `public/sw.js` + the build-id stamping plugin first exist in #66 |
| `GET /api/push/vapid-public-key` (live) | `500 FUNCTION_INVOCATION_FAILED` (route exists — a pre-#66 commit would 404) |
| `POST /api/notifications/send` (live) | `500 FUNCTION_INVOCATION_FAILED` (route exists) |
| `GET /api/send-parent-credentials` (live) | `{"error":"Method Not Allowed"}` — the pre-existing, **import-free** function loads and runs, so the Node runtime, routing and `vercel.json` rewrites are healthy |

Note: the exact SHA cannot be read off the public HTTP surface (no Vercel token is available in this session); it is
pinned by Vercel's own deployment status posted against `13a3c0a` plus the #66-only artifacts being served live.
Merging `main` → production is confirmed working (that is how this build reached production at 17:25Z, after the
17:07Z merge).

## 3. Root cause — reproduced with Vercel's real builder

Method: ran the actual `@vercel/node@20.0.0` builder (the builder that produced the deployed runtime `nodejs24.x`)
locally against the repository's real files for both entrypoints, then executed the emitted lambdas exactly as the
runtime does.

Built lambda file tree (per entrypoint) — **the files are present**:

```text
api/push/vapid-public-key.js              (+ .map)
server/lib/webpush.js                     (+ .map)
api/notifications/send.js                 (+ .map)
server/lib/notificationSender.js          (+ .map)
server/lib/supabaseNotificationDb.js      (+ .map)
server/lib/supabaseRest.js                (+ .map)
package.json  ← contains "type": "module"
```

But the emitted modules are **ESM with the extensionless specifiers preserved verbatim**:

```js
// api/push/vapid-public-key.js
import { derivePublicKeyB64, generateVapidKeys } from '../../server/lib/webpush';
// api/notifications/send.js
import { sendTeacherNotification, validateSendRequest } from '../../server/lib/notificationSender';
// server/lib/notificationSender.js
import { sendWebPush } from './webpush';
```

Executing that output reproduces the production symptom verbatim:

```text
ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server/lib/notificationSender'
  imported from /var/task/api/notifications/send.js
ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server/lib/webpush'
  imported from /var/task/api/push/vapid-public-key.js
```

Contribution chain (all confirmed):

1. Root `package.json` has `"type": "module"` → emitted `.js` is executed as ESM.
2. `tsconfig.json` uses `"module": "ESNext"` + `"moduleResolution": "bundler"` + `"allowImportingTsExtensions": true`,
   and its `include` covers only `src/`, `vite.config.ts`, `help-preview.tsx` — `api/` and `server/` are **not
   type-checked**, so `npm run validate` can never catch this.
3. Vercel's Node builder transpiles each traced `.ts` file individually (no bundling) and Vercel's ESM→CJS Babel
   fallback is **skipped** for files whose nearest `package.json` is `"type": "module"` → specifiers are never
   rewritten.
4. Node's ESM loader requires fully-specified relative paths (no extension guessing) → load fails before the handler
   body runs → generic 500.
5. Only the #66 routes break: they are the first `api/` handlers in this repo with imports
   (`api/send-parent-credentials.ts` has none). Vitest/Vite resolve extensionless specifiers fine, which is why the
   test suite was green while production crashed.

Not the cause (checked and excluded): missing tracing, wrong project Root Directory, `vercel.json` catch-all rewrite
shadowing `/api/*` (the crashing routes are reached — they return function errors, not the SPA), missing `server/lib`
files in the repo, and `server/lib` being outside the deployment.

## 4. Required fix (verified)

Append `.js` to the 7 relative specifiers in the Node-facing import graph:

```diff
--- a/api/notifications/send.ts
-import { sendTeacherNotification, validateSendRequest } from '../../server/lib/notificationSender';
-import { createSupabaseNotificationDb } from '../../server/lib/supabaseNotificationDb';
-import { SupabaseRest } from '../../server/lib/supabaseRest';
-import { generateVapidKeys, type VapidConfig } from '../../server/lib/webpush';
+import { sendTeacherNotification, validateSendRequest } from '../../server/lib/notificationSender.js';
+import { createSupabaseNotificationDb } from '../../server/lib/supabaseNotificationDb.js';
+import { SupabaseRest } from '../../server/lib/supabaseRest.js';
+import { generateVapidKeys, type VapidConfig } from '../../server/lib/webpush.js';

--- a/api/push/vapid-public-key.ts
-import { derivePublicKeyB64, generateVapidKeys } from '../../server/lib/webpush';
+import { derivePublicKeyB64, generateVapidKeys } from '../../server/lib/webpush.js';

--- a/server/lib/notificationSender.ts
-import { sendWebPush, type VapidConfig } from './webpush';
+import { sendWebPush, type VapidConfig } from './webpush.js';

--- a/server/lib/supabaseNotificationDb.ts
-import type { ... } from './notificationSender';
-import { inFilter, SupabaseRest } from './supabaseRest';
+import type { ... } from './notificationSender.js';
+import { inFilter, SupabaseRest } from './supabaseRest.js';
```

Verification performed on a scratch copy (repository left untouched):

* Re-run through the real `@vercel/node` builder → emitted specifiers keep `.js`; lambda modules **load** and the
  handlers execute: `POST /api/notifications/send` → `401 {"error":"Missing Authorization bearer token."}`,
  `GET /api/push/vapid-public-key` → `200 {"publicKey":"BGvYYS…"}` with a valid VAPID key.
* `npx tsc --noEmit` → clean.
* Full suite → **94 files / 1110 tests passed** (Vite resolves `./x.js` → `x.ts`, so the frontend/test imports are
  unaffected).
* `npm run build` → green.

Options deliberately rejected: removing `"type": "module"` (repo-wide blast radius), adding an esbuild bundling step
(larger change), switching to Firebase or rewriting the notification architecture (unnecessary — the architecture is
sound and already traced correctly).

## 5. Post-fix production checklist (independent of the code fix)

1. Set Vercel **Production** env vars: `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (see `scripts/generate-vapid-keys.mjs`),
   plus `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`. Without them the fixed endpoints return an
   explicit JSON 500 (not a crash page).
2. Apply `supabase/migrations/20261005_push_notifications.sql` to the production database. The Supabase GitHub check
   is failing/disabled for PR builds (it errors on the older `20240324_reenable_rls.sql`, and "creating a new preview
   branch per PR is disabled"), so automated application to production cannot be assumed. Until the tables exist, the
   endpoint will load but fail at query time.
3. Re-verify after deploy: `GET /api/push/vapid-public-key` should return `200` with `publicKey`.

## 6. Reproduction commands

```bash
# was it merged?
gh pr view 66 --json state,mergedAt,mergeCommit,headRefOid
gh api repos/viniliaice/schoolnnnnass/commits/13a3c0abd12edaa37bdceb1f2cf0ce38050becf2/status

# is #66 live?
curl -s https://schoolnnnnass.vercel.app/sw.js | grep RAW_BUILD_ID      # -> fbd2971d71f5302c
curl -si https://schoolnnnnass.vercel.app/api/send-parent-credentials  # -> {"error":"Method Not Allowed"}
curl -si https://schoolnnnnass.vercel.app/api/push/vapid-public-key    # -> 500 FUNCTION_INVOCATION_FAILED

# rebuild the lambda locally with Vercel's own builder and inspect the emitted specifiers
npm i @vercel/node@20.0.0 @vercel/build-utils@14.17.0
# build({ files, entrypoint: 'api/notifications/send.ts', workPath, repoRootPath })
# -> server/lib/*.js present, specifiers extensionless -> node import fails with ERR_MODULE_NOT_FOUND
```
