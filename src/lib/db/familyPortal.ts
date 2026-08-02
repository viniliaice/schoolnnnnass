// M3 — parent portal family card data.
//
// A parent sees ONLY their own family: the query is scoped by parentId, and
// RLS ("Parents can read own children": parentId = current_profile_id())
// enforces the same boundary at the database. A parent cannot fetch another
// family's data by any route — verified in supabase/tests/rls-office-role.sql.

import { supabase } from '../supabase';
import type { Student } from '../../types';

export interface RecentRelease {
  id: number;
  studentId: string;
  familyId: string;
  staffId: string;
  createdAt: string;
  students: { name: string; className: string } | null;
}

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

/**
 * A parent's recent releases (pickups) — own children only. The query is
 * scoped to the parent's kids, and the release_log RLS policy
 * ("Parents can read own children releases") enforces the same boundary at
 * the database: a parent can never see another family's releases.
 */
export async function getRecentReleases(parentId: string, limit = 5): Promise<RecentRelease[]> {
  const { data: kids, error: kidsError } = await supabase
    .from('students')
    .select('id')
    .eq('parentId', parentId);
  if (kidsError) throw kidsError;

  const studentIds = (kids ?? []).map(k => (k as { id: string }).id);
  if (studentIds.length === 0) return [];

  const { data, error } = await supabase
    .from('release_log')
    .select('id,studentId,familyId,staffId,createdAt,students(name,className)')
    .in('studentId', studentIds)
    .order('createdAt', { ascending: false })
    .limit(limit);
  if (error) throw error;
  // PostgREST types the to-one join as an array; the runtime shape is an
  // object (or null), so cast via unknown.
  return (data ?? []) as unknown as RecentRelease[];
}
