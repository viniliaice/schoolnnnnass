# Dismissal Gate — Transport Eligibility, Driver Assignment & Fast Office Release

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
3. **How should transport determine eligibility?** Transport is the student's
   PERMANENT/default classification; the CURRENT pickup arrangement is separate
   (the junction). Rules:
   - `WALKER` / `CAR` / unset → **eligible**: one-click walking release, AND may be
     assigned a registered driver for a temporary pickup (permanent transport is
     NOT overwritten).
   - `DRIVER` → **eligible**: release requires an assigned registered driver.
   - numeric (bus) → **excluded**: never released AND never assigned a driver
     (server rejects both).
   - `LEFT` / unrecognized → **excluded**.
   (Decision: `CAR` is walking-equivalent — parent pickup, not a registered driver.)
4. **How is the release path reused?** Same `record_release` RPC; a driver id may now
   accompany a walking student (temporary pickup) — the RPC branches on "driver
   passed or not", not only on transport. Bulk release orchestrates N individual
   `record_release` calls — no batch shortcut.
5. **Bulk reuse of validation?** The bulk button loops `record_release` per student;
   every student is individually validated and individually audited. Bulk covers
   walking-with-driver AND driver-with-driver students, never bus.
6. **Avoiding duplicate driver records?** Drivers are registered centrally
   (`/admin/drivers`, admin+office). The gate only SEARCHES registered drivers and
   assigns — it can never create or register a driver. Phone de-dupe stays in
   `create_authorized_pickup`.
7. **DB/RPC constraints?** `students_transport_check` += `DRIVER`;
   `set_student_transport` validator += `DRIVER`; `record_release` server-side
   transport gate + driver-assignment gate; `attach_students_to_authorized_pickup`
   rejects bus/LEFT students; `release_log` unique per (student, UTC day).
8. **Race / double-release?** A UNIQUE index on `release_log ("studentId",
   ("createdAt" AT TIME ZONE 'UTC')::date)`; concurrent inserts → one wins, the other
   gets `unique_violation` → clear error.

Security: every new/changed RPC is `SECURITY DEFINER` + pinned `search_path` + explicit
role check. `search_authorized_pickups` returns driver identity ONLY (no student/family
data) so supervisor at the gate cannot cross-reference families through a shared driver.

## Spec

### Data model
- `students.transport` — the PERMANENT/default classification (`WALKER`/`CAR`/`DRIVER`/
  numeric bus/`LEFT`). Gains `'DRIVER'`.
- `authorized_pickup_students` — the CURRENT pickup arrangement (one driver per
  student, REPLACE semantics). A walking student with a temporary pickup keeps
  `transport = WALKER`; only the junction row changes.
- `authorized_pickups` — driver identity (unchanged).
- `release_log` — `pickupPersonId` NULL for a walking release, the driver id for a
  pickup (driver OR walking-with-driver); unique (studentId, UTC day).

### New/changed RPCs
Migrations are append-only: `20260903_gate_eligibility.sql` adds the transport
CHECK (`DRIVER`), the walking/driver/bus release classification, the per-day
double-release UNIQUE index (with same-day dedup), `remove_student_driver()`, and
`search_authorized_pickups()`. `20260904_gate_walking_driver.sql` then relaxes the
release rule for walking-with-a-driver and adds bus rejection to assignment.

- `record_release(student_id, family_id, pickup_person_id)` — pickup nullable.
  - no driver → walking release (WALKER/CAR only; a DRIVER student is rejected and
    must pick a driver).
  - with driver → driver pickup (WALKER, CAR, or DRIVER; must exist + be assigned).
  - bus/LEFT/unknown → rejected. Double-release: `unique_violation` → error.
  - audit/return carry `mode` (`driver`/`walking`) + `transport` (permanent) +
    `driverId`, so "walking student temporarily picked up by a driver" is auditable.
- `attach_students_to_authorized_pickup(pickup_id, student_ids)` — REPLACE per
  student; rejects LEFT and bus students.
- `remove_student_driver(student_id)` — clears a student's assignment(s).
- `search_authorized_pickups(query)` — driver identity search (gate roles).
- `set_student_transport` — validator accepts `DRIVER` (admin+office, unchanged scope).

### UI
- `/gate` found state: per-student rows.
  - walking (unassigned): `🚶 Walking · Driver not assigned` + `[✓ Release]` + `[+ Assign driver]`.
  - walking (assigned): `🚗 Driver pickup · ASKO · 980797` + `[✓ Release]` + `[Change driver]` + `[Remove driver]`.
  - driver (unassigned): `🚗 Driver · Driver not assigned` + `[+ Assign driver]` (no release yet).
  - driver (assigned): `🚗 Driver · ASKO · 980797` + `[✓ Release]` + `[Change driver]` + `[Remove driver]`.
  - bus: `🚌 Bus N · Not eligible for Dismissal Gate`, no buttons.
- `[+ Assign driver]` / `[Change driver]` open a search-and-select of REGISTERED
  drivers (no creation, no registration).
- `[Release all for NAME]` when ≥2 eligible students (walking OR driver) share that
  driver. Bus students are never included.
- Bulk partial failure: `X of Y released` + per-student ✓/✗.

### Audit
Each release writes its own `family_ids.release` entry with `mode` (`walking`/`driver`),
`transport` (the permanent transport), and `driverId` (driver pickups). Bulk produces
N individual entries. A walking student released to a driver records
`transport = WALKER` + a `driverId` — distinct from a DRIVER-transport pickup.

### Acceptance criteria (testable)
- Transport: walking→eligible, driver→eligible, bus→rejected (release AND assignment,
  UI + server).
- Walking student released one-click (no driver) succeeds; walking student released
  to an assigned driver succeeds; permanent transport is unchanged.
- Driver student without a driver cannot release; with a driver can.
- Registered driver accepted; unregistered rejected (`Driver not found`).
- One driver reused across families (junction; no family column on driver).
- Change driver replaces (no duplicate); remove deletes assignment, keeps driver.
- Bus release and bus driver assignment both rejected server-side.
- Bulk: N eligible students (walking + driver) → N releases → N audits; mixed family
  releases only eligible students; partial failure reports per-student.
- Double release same student same day rejected; concurrent requests → one winner.
