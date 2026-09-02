// Gate lookup + release wrappers (M2 /gate screen).
//
// lookup_family is admin/supervisor/office-only (enforced in SQL). Every
// NOT-FOUND lookup is audit-logged — a missed match is the safety signal that
// tells you the gate system stopped working (CEO review decision 9).
// record_release logs every SUCCESSFUL handoff (student, family, staff,
// timestamp) to release_log — the accountability record that makes a future
// wrong-handoff traceable.

import { supabase } from '../supabase';
import { createAuditLog } from './audit';

export interface GateLookupRow {
  id: string;
  name: string;
  className: string;
  transport: string | null;
  familyId: string | null;
  parentPhone: string | null;
}

export interface GateLookupResult {
  found: boolean;
  /** Normalized digits (e.g. '0421'). */
  familyId: string;
  students: GateLookupRow[];
}

/** Look up a family by raw input (digits; 'MBK-' prefix tolerated). */
export async function lookupGateFamily(rawInput: string): Promise<GateLookupResult> {
  const familyId = rawInput.replace(/\D/g, '');
  const { data, error } = await supabase.rpc('lookup_family', { p_family_id: familyId });
  if (error) throw error;

  const students = (data ?? []) as GateLookupRow[];
  if (students.length === 0) {
    // Best-effort audit; never blocks the gate flow.
    try {
      await createAuditLog('family_ids.gate_not_found', { familyId });
    } catch { /* audit is non-critical at the gate */ }
    return { found: false, familyId, students: [] };
  }
  return { found: true, familyId, students };
}

export interface ReleaseRecord {
  id: number;
  studentId: string;
  familyId: string;
  staffId: string;
  /** The assigned driver who received the child — NULL for a walking release. */
  pickupPersonId: string | null;
  /** 'driver' when released to a driver, 'walking' otherwise. */
  mode: 'driver' | 'walking';
  createdAt: string;
}

/**
 * Record a successful handoff. The RPC decides driver-vs-walking from the
 * student's transport:
 *  - walking/car → pass `null`; released one-click.
 *  - driver      → pass the assigned registered driver id; the RPC rejects a
 *    missing driver, an unknown driver, or a driver not assigned to the student.
 *  - bus/left/unknown → the RPC rejects the release outright.
 * The RPC also refuses a second release of the same student on the same day.
 */
export async function recordRelease(
  studentId: string,
  familyId: string,
  pickupPersonId: string | null,
): Promise<ReleaseRecord> {
  const { data, error } = await supabase.rpc('record_release', {
    p_student_id: studentId,
    p_family_id: familyId,
    p_pickup_person_id: pickupPersonId ?? null,
  });
  if (error) throw error;
  return data as ReleaseRecord;
}
