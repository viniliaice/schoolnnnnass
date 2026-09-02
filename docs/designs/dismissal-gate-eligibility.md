# Dismissal Gate — Transport Eligibility, Driver Assignment & Fast Release

**Status:** spec for implementation (gstack `/plan-eng-review` + `/spec`)
**Branch:** arena/01a05d61-schoolnnnnass
**Supersedes gate-release behavior from:** 20260901_authorized_pickups.sql, 20260902_manage_drivers.sql

## Architecture review (plan-eng-review)

Reused systems (no new tables, no second driver system):
- `authorized_pickups` + `authorized_pickup_students` — the registered-driver store and
  per-student junction. ONE driver → MANY students → MANY families is already the
  data model (no `familyId` on the driver).
- `lookup_family` — the gate scan/lookup is untouched.
- `record_release` + `release_log` + `audit_logs` — the single validated release path.
- `get_family_pickups`, `attach_students_to_authorized_pickup` — assignment read/write.

Answers to the required questions:
1. **Where should student↔driver assignment live?** `authorized_pickup_students`
   (junction). One driver per student is enforced by `attach_students_to_authorized_pickup`
   becoming a REPLACE (delete-then-insert) and a student-centric
   `remove_student_driver()`.
2. **Can one driver serve multiple families?** Yes — the junction links a driver to
   individual students; students live in different families. No schema change needed.
3. **How should transport determine eligibility?** New stored value `DRIVER`.
   - `WALKER` / `CAR` / unset → **walking** (one-click release, no driver).
   - `DRIVER` → **driver** (release requires an assigned registered driver).
   - numeric (bus) → **excluded** (no release button; server rejects).
   - `LEFT` / unrecognized → **excluded**.
   (Decision: `CAR` is walking-equivalent — parent pickup, not a registered driver.)
4. **How is the release path reused?** Same `record_release` RPC branches on transport;
   bulk release orchestrates N individual `record_release` calls — no batch shortcut.
5. **Bulk reuse of validation?** The bulk button loops `record_release` per student;
   every student is individually validated and individually audited.
6. **Avoiding duplicate driver records?** Drivers are registered centrally
   (`/admin/drivers`, admin+office). The gate only SEARCHES registered drivers and
   assigns — it can no longer create a driver. Phone de-dupe stays in
   `create_authorized_pickup`.
7. **DB/RPC constraints?** `students_transport_check` += `DRIVER`;
   `set_student_transport` validator += `DRIVER`; `record_release` server-side
   transport gate + driver-assignment gate; `release_log` unique per (student, UTC day).
8. **Race / double-release?** A UNIQUE index on `release_log ("studentId",
   ("createdAt" AT TIME ZONE 'UTC')::date)`; concurrent inserts → one wins, the other
   gets `unique_violation` → clear error.

Security: every new/changed RPC is `SECURITY DEFINER` + pinned `search_path` + explicit
role check. `search_authorized_pickups` returns driver identity ONLY (no student/family
data) so supervisor at the gate cannot cross-reference families through a shared driver.

## Spec

### Data model
- `students.transport` gains `'DRIVER'`.
- `authorized_pickups` — driver identity (unchanged): id, name, phoneNumber,
  relationship, photoPath.
- `authorized_pickup_students` — one driver per student (REPLACE semantics going
  forward). Structural many-to-many kept (removal is hard-delete of the junction row;
  no soft-delete pattern exists in this schema).
- `release_log` — `pickupPersonId` NULL for walking; unique (studentId, UTC day).

### New/changed RPCs
- `record_release(student_id, family_id, pickup_person_id)` — pickup nullable.
  walking: pickup forced NULL. driver: pickup required + must exist + must be assigned.
  bus/LEFT/unknown: rejected. Double-release: `unique_violation` → error.
- `attach_students_to_authorized_pickup(pickup_id, student_ids)` — REPLACE per student.
- `remove_student_driver(student_id)` — clears a student's assignment(s).
- `search_authorized_pickups(query)` — driver identity search (gate roles).
- `set_student_transport` — validator accepts `DRIVER` (admin+office, unchanged scope).

### UI
- `/gate` found state: per-student rows classified walking / driver / bus.
  - walking: `[✓ Release]` one-click.
  - driver: `Driver: NAME · PHONE` + `[✓ Release]` + `[Change driver]` + `[Remove driver]`;
    or `Driver not assigned` + `[+ Add driver]`.
  - bus: `Not eligible for Dismissal Gate`, no button.
- `[+ Add driver]` / `[Change driver]` open a search-and-select of REGISTERED drivers
  (no creation, no photo).
- `[Release all for NAME]` when ≥2 eligible driver students share that driver.
- Bulk partial failure: `X of Y released` + per-student ✓/✗.

### Audit
Each release writes its own `family_ids.release` entry with `mode` (`walking`/`driver`)
and `driverId` (driver releases). Bulk produces N individual entries.

### Acceptance criteria (testable)
- Transport: walking→eligible, driver→eligible, bus→rejected (UI + server).
- Registered driver accepted; unregistered rejected (`Driver not found`).
- One driver reused across families (junction; no family column on driver).
- Change driver replaces (no duplicate); remove deletes assignment, keeps driver.
- Walking release succeeds with null driver; driver release requires assignment.
- Bus release rejected server-side.
- Bulk: N driver students → N releases → N audits; mixed family releases only driver
  students; partial failure reports per-student.
- Double release same student same day rejected; concurrent requests → one winner.
