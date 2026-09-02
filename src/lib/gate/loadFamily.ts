// Single, atomic loader for one Family ID at the dismissal gate.
//
// WHY THIS EXISTS (layout-shift fix, 2026-09-02)
// ----------------------------------------------
// The gate used to do this:
//
//     lookup_family()  ─→ setStatus('found') ─→ render students
//                                             └→ get_family_pickups() ─→ driver
//                                                                        appears,
//                                                                        buttons
//                                                                        swap,
//                                                                        card grows
//
// Two problems: (1) a needless REQUEST WATERFALL — `get_family_pickups` only
// needs the *normalized digits*, which are known client-side before the first
// request, so it never had to wait for `lookup_family`; (2) the UI committed a
// half-complete family to the screen, so every card resized when the driver
// arrived.
//
// This module issues both RPCs IN PARALLEL and resolves a SINGLE complete
// snapshot. The screen commits one state object — students and their drivers
// always arrive together, so a rendered card never changes shape.
//
// The pickup list is advisory: a failed driver lookup degrades to "no driver
// assigned" (with `pickupsFailed` for a quiet inline notice) and must never
// block a release.

import { lookupGateFamily, type GateLookupResult, type GateLookupRow } from '../db/gate';
import { getFamilyPickups, type FamilyPickup } from '../db/authorizedPickups';
import { normalizeGateInput } from './gate-utils';

export interface GateFamilyState {
  found: boolean;
  /** Normalized digits (e.g. '0421'). */
  familyId: string;
  students: GateLookupRow[];
  /** Registered drivers authorized for someone in this family. */
  pickups: FamilyPickup[];
  /** studentId → assigned driver id (first wins; the RPC enforces one). */
  assignmentByStudent: Record<string, string>;
  /** True when the driver lookup failed — students still render and release. */
  pickupsFailed: boolean;
}

/** studentId → their assigned driver id. Pure; shared with the UI + tests. */
export function buildAssignmentIndex(pickups: FamilyPickup[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pickups) {
    for (const sid of p.studentIds) if (!map[sid]) map[sid] = p.id;
  }
  return map;
}

/**
 * Load everything the final family result needs, in parallel, and return it as
 * one complete snapshot. Callers render only after this resolves, which is what
 * guarantees zero layout shift: there is no intermediate "students but no
 * drivers" state to paint.
 */
export async function loadGateFamily(rawInput: string): Promise<GateFamilyState> {
  const familyId = normalizeGateInput(rawInput);

  // PARALLEL — neither request depends on the other's response.
  const [lookupSettled, pickupsSettled] = await Promise.allSettled([
    lookupGateFamily(familyId),
    getFamilyPickups(familyId),
  ]);

  // The family lookup is the critical path: if it fails, the whole scan failed.
  if (lookupSettled.status === 'rejected') throw lookupSettled.reason;
  const lookup: GateLookupResult = lookupSettled.value;

  const pickupsFailed = pickupsSettled.status === 'rejected';
  const pickups = pickupsSettled.status === 'fulfilled' ? pickupsSettled.value : [];

  return {
    found: lookup.found,
    familyId: lookup.familyId,
    students: lookup.students,
    pickups,
    assignmentByStudent: buildAssignmentIndex(pickups),
    pickupsFailed,
  };
}

/**
 * Re-read ONLY the driver assignments (after assign/change/remove) and fold
 * them into the existing snapshot. Returns a new object so React sees one
 * atomic update instead of a students-then-drivers two-step.
 */
export async function refreshGateFamilyDrivers(state: GateFamilyState): Promise<GateFamilyState> {
  try {
    const pickups = await getFamilyPickups(state.familyId);
    return { ...state, pickups, assignmentByStudent: buildAssignmentIndex(pickups), pickupsFailed: false };
  } catch {
    return { ...state, pickupsFailed: true };
  }
}
