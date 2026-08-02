// Gate lookup wrapper (M2 /gate screen).
//
// lookup_family is admin/supervisor-only (enforced in SQL). Every NOT-FOUND
// lookup is audit-logged — a missed match is the safety signal that tells you
// the gate system stopped working (CEO review decision 9).

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
