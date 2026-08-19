// Card data for printing family ID cards.
//
// Why this exists instead of reusing getStudents() + getParentNames():
// those are RLS-scoped REST reads, so the CARD CONTENT depended on who was
// printing. A supervisor's only students policy is "Teachers can read
// assigned class students", so they printed cards MISSING SIBLINGS; and
// profiles is readable only by self/admin, so office and supervisor printed
// cards with a blank parent name. A card that under-lists a family is
// dangerous at a dismissal gate.
//
// get_family_cards() is SECURITY DEFINER (complete roster for every gate
// role) and STABLE (Postgres rejects writes inside it), so this read can
// never create or change a family ID.

import { supabase } from '../supabase';
import type { FamilyCardData } from '../print/familyCards';
import type { Student } from '../../types';

const LOG = '[family-cards]';

/** Shape returned by the get_family_cards RPC (JSONB). */
interface FamilyCardRow {
  familyId: string;
  parentName: string;
  parentPhone: string;
  students: Student[];
}

/**
 * Load complete, print-ready card data for the given family IDs.
 *
 * Input may be raw or display-formatted ('42', '0042', 'MBK-0042') — the RPC
 * normalizes. Families that do not exist (or contain only students who left)
 * are simply absent from the result; the caller reports them as skipped.
 *
 * Returns families sorted by familyId, each with students sorted by name —
 * the same ordering the previous client-side builder produced.
 */
export async function getFamilyCards(familyIds: string[]): Promise<FamilyCardData[]> {
  const ids = [...new Set(familyIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const { data, error } = await supabase.rpc('get_family_cards', { p_family_ids: ids });
  if (error) {
    console.error(`${LOG} get_family_cards failed`, {
      message: error.message, code: error.code, details: error.details, hint: error.hint,
    });
    throw error;
  }

  const rows = (data ?? []) as FamilyCardRow[];
  console.log(`${LOG} loaded`, { requested: ids.length, returned: rows.length });

  return rows.map(row => ({
    familyId: row.familyId,
    parentName: row.parentName ?? '',
    parentPhone: row.parentPhone ?? '',
    students: row.students ?? [],
  }));
}
