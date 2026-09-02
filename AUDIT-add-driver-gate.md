# Audit — Add Driver at Gate (with photo)

**Scope:** the `Add Driver at Gate` feature implemented in commit `212559b` (branch `arena/01a05d61-schoolnnnnass`).
**Method:** static re-read of the changed files (`src/`, `supabase/migrations/20260901_authorized_pickups.sql`, `supabase/tests/`), plus `tsc --noEmit`, the full Vitest suite (476/476), and a production `vite build` — all green. I could not run against the live Supabase project (not reachable from this session), so database-side claims are from the migration text and the SQL assertion tests, not a live apply.

Short version up front: **the feature is safe and internally consistent, with two deliberate spec deviations you should sign off on** — (1) there is no `family_id` column (authorization is per-student across families, so the link lives in `authorized_pickup_students`), and (2) the photo path is `authorized-pickups/{person_id}.jpg`, not `{family_id}/{person_id}.jpg`. The one real security finding is that **the photo bucket is publicly readable by URL**.

---

## 1. Reuse, not duplication

- **OK — Card-scan/lookup is reused, not duplicated.** No second scanner was built. The Add Driver surface lives *inside* the existing `/gate` screen: the "Authorized pickups" block and the `+ Add driver` button are rendered in `GateScreen.tsx`'s existing `status === 'found'` branch, and `AddDriverPanel` is a child dialog of that screen. Scan/lookup still flows through the unchanged `lookupGateFamily()` → `lookup_family` RPC. (`src/pages/admin/gate/GateScreen.tsx`, `src/lib/db/gate.ts`)
- **BROKEN (spec assumption) — the "Office Dashboard photo feature" does not exist to reuse.** Verified by full-repo grep in the previous turn: there is no `authorized_pickups` table, no pickup-photo UI, and no camera-capture component anywhere in the repo. So I built a new, generic `PhotoCapture` component (`src/components/photo/PhotoCapture.tsx`) + `src/lib/photoResize.ts`. It is not duplication (it's the first/only such component), and it's deliberately placed in shared `src/components/photo/` so the future Office feature reuses *it* rather than the reverse. If the Office photo feature does exist on another branch, this should be reconciled against it.

## 2. Form correctness

- **OK — `name` and `phone` are required.** Client (`AddDriverPanel.save()`) blocks save with `t.driverFieldsRequired` if either is empty; the RPC independently raises `Name is required.` / `Phone number is required.` (server is the enforcement point, per repo convention).
- **NOTE — `relationship` is NOT required.** It is optional in both the client (not validated) and the RPC (`NULLIF(trim(p_relationship), '')` → stored NULL). This matches the spec's wording (only "Name (required)" and "Phone number (required)" were marked required; relationship was never marked required), but the audit question assumed all three — **flag for confirmation** if relationship must be mandatory.
- **OK — Photo is required; there is no skip option.** Client: `if (!photoBlob) { setError(t.photoRequired); return; }`. Server: `IF p_photo_url IS NULL OR trim(p_photo_url) = '' THEN RAISE EXCEPTION 'A photo is required.'`. The "skip photo / photo_status=pending" idea from the original prompt was superseded by your revision (photo captured once at creation, permanent).
- **OK — Retake exists before save.** `PhotoCapture` shows the resized preview with a "Retake" button that clears the blob and reopens the camera; no upload happens until the final "Save driver".

## 3. Photo handling

- **OK — Resized client-side before upload, never full-resolution.** `resizeImageToSquare(file, 400)` (`src/lib/photoResize.ts:61-81`): loads the file to an `<img>`, center-crops to a square (`computeSquareCrop`), draws to a 400×400 canvas, encodes JPEG at quality 0.85, and **re-encodes at 0.6 if the blob exceeds 120KB**. The captured phone photo (3–8MB) is reduced to roughly 30–80KB before upload. The blob (not the original `File`) is what's passed to storage.
- **OK — `capture="environment"` is set** on the `<input type="file" accept="image/*" capture="environment">` (`PhotoCapture.tsx:61`). On mobile browsers this opens the rear camera directly. **Caveat (inherent, not a bug):** the attribute is a hint — on desktop browsers it is ignored and falls back to a generic file picker; on some Android WebViews it opens a camera/file chooser. If the gate device is a desktop, staff get a file picker rather than a camera.
- **RISK/DEVIATION — upload path is `authorized-pickups/{person_id}.jpg`, not `{family_id}/{person_id}.jpg`.** The spec's `{family_id}/{person_id}.jpg` path can't work under your multi-family model (one person spans many families), so the path keys on the person id only. **Collision safety is fine:** `person_id = pickup-<Date.now()>-<6 random base36 chars>` (`AddDriverPanel.tsx`), so two simultaneous adds produce different ids; `upsert: true` would overwrite an identical path, but that requires an astronomically unlikely id collision. If you still want the folder to mirror the spec, we'd need `authorized-pickups/{family_id}/{person_id}.jpg` with a documented "first family wins" rule — flag which you prefer.

## 4. Data model

- **OK — the person columns exist, with one deviation.** `authorized_pickups` has `id`, `name`, `"phoneNumber"`, `relationship`, `"photoUrl"`, `"addedByStaffId"` (NOT NULL), `"addedAt"` (NOT NULL DEFAULT NOW()) — i.e. everything the spec listed **except `family_id`**.
- **RISK/DEVIATION — there is no `family_id` column at all.** This is the deliberate consequence of your per-student, multi-family answer. Family linkage is modeled properly in `authorized_pickup_students(authorizedPickupId → authorized_pickups.id, studentId → students.id)` with **real foreign keys**, which is the correct normalization — but if any downstream consumer (or the spec reviewer) expects a `family_id` on the person row, it isn't there. Note also there is **no `families` table anywhere in this schema** (`familyId` lives as a loose text column on `students`, pre-existing), so a "proper FK to a family table" is architecturally impossible regardless.
- **NOTE — column naming is camelCase, not the spec's snake_case.** `phone_number` → `"phoneNumber"`, `photo_url` → `"photoUrl"`, `added_by_staff_id` → `"addedByStaffId"`, `added_at` → `"addedAt"`. This is consistent with the existing repo convention (`students.parentPhone`, `students.govId`, `profiles.phone1`), but it does not literally match the column names the spec wrote.
- **OK — `added_by_staff_id` is populated from the logged-in session, not hardcoded/client-supplied.** The client never sends it; the RPC sets `v_actor_id := public.current_profile_id()` and stores it server-side (`addedByStaffId` = the authenticated staff profile id). It is `NOT NULL`, so it can't be silently empty, and it can't be spoofed by the caller.

## 5. Immediate usability

- **OK — the new driver is usable without a re-scan.** On success, `AddDriverPanel` calls `onAdded()`, which `GateScreen` wires to `loadPickups(result.familyId)` — the authorized list (and each student's "Release to" dropdown, computed from the same `pickups` state) refreshes in place while the family result stays on screen. The new person appears in the list and in the release dropdown with no re-scan or page reload. Minor note: the refresh is async, so there's a brief "…" while `get_family_pickups` returns.

## 6. Audit trail

- **OK — "driver added" is logged with staff ID + timestamp.** `create_authorized_pickup` inserts `authorized_pickups.create` into `audit_logs` with `{ personId, name, staffId (= current_profile_id()), studentIds, photoCaptured: true }` and `createdAt = NOW()` (`supabase/migrations/20260901_authorized_pickups.sql:135-149`). The release path mirrors the driver id into `family_ids.release` as well.
- **OK (this feature's write) / RISK (the table as a whole) — it does NOT inherit the insecure client path.** The audit write happens inside the **SECURITY DEFINER** RPC, i.e. server-side, so it bypasses the open `audit_logs` INSERT policy and is gated by the RPC's role check (`admin/supervisor/office`). A parent cannot forge a `authorized_pickups.create` row. **However, issue #3 from the original audit is still unfixed at the table level:** `audit_logs` still has `FOR SELECT USING (true)` and `FOR INSERT WITH CHECK (true)` for all authenticated users (`00001_create_audit_logs.sql`), so (a) any authenticated user can still **read** these new audit rows (driver names, staff ids, student ids), and (b) the client-side `createAuditLog()` still writes `family_ids.gate_not_found` through the open INSERT policy. This feature adds protected *writes* but does not close the open *read* (or the open client insert).

## 7. Error handling

- **OK — upload failure leaves no half-saved record.** The flow is upload → resolve URL → `create_authorized_pickup` RPC. If the upload itself fails, it throws before any DB write; the panel shows the error inline + a toast, and no record exists. The DB write is a single plpgsql function whose `RAISE EXCEPTION` rolls back its own transaction, so a failure partway through (e.g. a student was marked LEFT between scan and save) leaves no partial rows.
- **OK — orphan-photo cleanup is attempted.** If the RPC fails *after* a successful upload, the catch block calls `storage.from(BUCKET).remove([path])` before surfacing the error, so a failed save doesn't strand a photo. **Minor caveat:** the cleanup is best-effort — if that `remove` also fails (e.g. still offline), an orphan object can remain. There is no retry loop, which is acceptable for the gate (the user can just re-save), but worth knowing.
- **OK — scan that doesn't resolve to a valid family can't reach Add Driver.** An empty `lookup_family` result takes the existing full-screen NOT-FOUND state; the Add Driver button only exists in the `found` branch, so there's no path to create a driver without a matched family.

## 8. Speed / UX at the gate

- **OK — a handful of taps.** From scan: `+ Add driver` (1) → tap name field + type → tap phone + type → tap relationship + type (optional) → `Take Photo` (1) + camera capture → `Save driver` (1). Roughly **6 taps + 3 short fields + one photo** after the scan, with zero navigation away from the result screen. Every key tap is on a familiar result screen, and the photo step has no "confirm" dialog (preview shows with Retake).
- **OK — loading indicators exist.** `PhotoCapture` shows "…" while resizing (`processing`), and the Save button shows a `Loader2` spinner + "Saving…" while the photo upload + RPC run (`AddDriverPanel.tsx:220`). There's no percentage bar, which is fine at 30–80KB, but staff on very slow wifi will just see the spinner for a beat.

## 9. Security

- **OK — only authenticated staff can reach or execute Add Driver.** Client: `/gate` is route-gated to admin/supervisor/office (`src/lib/routing.ts`), and the button only renders in the found state of that screen. Server (the real enforcement): `create_authorized_pickup` raises `insufficient_privilege` for any `current_profile_role()` outside `('admin','supervisor','office')`; storage INSERT/UPDATE policies require the same roles *and* `bucket_id = 'authorized-pickups'`; `authorized_pickups`/`authorized_pickup_students` have SELECT-only policies for gate roles and **no direct write policies at all**.
- **RISK — the photo bucket is public (`public = true`).** `INSERT INTO storage.buckets ... (id, name, public, ...) VALUES ('authorized-pickups', ..., true, ...)` means any URL like `/storage/v1/object/public/authorized-pickups/<id>.jpg` serves the photo **with no authentication** — anyone who obtains the URL can view it. I chose public read so the gate can render `<img src=…>` without signed-URL plumbing. Mitigations in place: ids are unguessable (timestamp + random), uploads are role-gated, and mime type is restricted to images. But driver photos are personal data; if you want them non-public, flip the bucket to `public = false` and switch the gate/panel to short-lived signed URLs (or a proxy edge function). **This is the top item I'd change before go-live.**

---

## Top issues from this self-audit

1. **Photo bucket is publicly readable by URL (RISK).** Flip `authorized-pickups` to private and use signed URLs for the gate's `<img>` tags, if driver photos are considered sensitive.
2. **`audit_logs` table-level RLS is still open (pre-existing #3, not fixed here).** The new writes are safe (server-side RPC), but any authenticated user can still *read* the driver/release audit rows and the client `gate_not_found` path still writes through the open INSERT policy. Scope read to gate roles and route client inserts through a SECURITY DEFINER audit function.
3. **Two deliberate spec deviations need explicit sign-off:** (a) no `family_id` column — authorization is per-student via `authorized_pickup_students` (correct for your multi-family model); (b) storage path is `authorized-pickups/{person_id}.jpg` rather than `{family_id}/{person_id}.jpg`. Confirm both are acceptable.
4. **Column naming is camelCase (`phoneNumber`, `photoUrl`, `addedByStaffId`, `addedAt`), not the spec's snake_case.** Consistent with the repo, but confirm no downstream consumer expects the literal names.
5. **Confirm `relationship` optionality** — it is currently optional (spec never marked it required); make it mandatory if intended.
6. **Minor:** orphan-photo cleanup after a failed RPC is best-effort; `capture="environment"` falls back to a file picker on desktop browsers (inherent to the attribute).
