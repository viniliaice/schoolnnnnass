// M3 — parent portal family card data.
//
// A parent sees ONLY their own family: the query is scoped by parentId, and
// RLS ("Parents can read own children": parentId = current_profile_id())
// enforces the same boundary at the database. A parent cannot fetch another
// family's data by any route — verified in supabase/tests/rls-office-role.sql.

import { supabase } from '../supabase';
import type { Student } from '../../types';

export interface ParentFamilyCard {
  /** Family ID ('0421') or null when Generate hasn't run for this family yet. */
  familyId: string | null;
  students: Student[];
  /** Set when the parent has children but none carry a familyId yet. */
  pending: boolean;
}

/**
 * Load the logged-in parent's own family: children (name, grade, transport,
 * familyId) via the parentId-scoped query. RLS additionally guarantees the
 * rows returned belong to this parent only.
 */
export async function getParentFamilyCard(parentId: string): Promise<ParentFamilyCard> {
  const { data, error } = await supabase
    .from('students')
    .select('id,name,className,parentId,createdAt,govId,transport,parentPhone,familyId')
    .eq('parentId', parentId);

  if (error) throw error;
  const students = (data ?? []) as Student[];
  if (students.length === 0) return { familyId: null, students: [], pending: false };

  const withIds = students.filter(s => s.familyId);
  const familyId = withIds.length > 0 ? withIds[0].familyId! : null;
  return {
    familyId,
    students,
    pending: familyId === null,
  };
}
