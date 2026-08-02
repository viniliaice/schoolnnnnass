// Client wrappers for the family-ID RPCs (see supabase/migrations/20260802_family_ids.sql).
// All writes go through SECURITY DEFINER RPCs — students has no UPDATE policy.

import { supabase } from '../supabase';
import { normalizePhone, parseTransportCell } from '../transport';
import type { TransportImportRow } from '../import/transportImport';
import type { Student } from '../../types';

export interface GenerateSummary {
  familiesCreated: number;
  studentsAssigned: number;
  unattached: string[][];
  totalFamilies: number;
}

export interface FamilyLookupRow {
  id: string;
  name: string;
  className: string;
  transport: string | null;
  familyId: string | null;
  parentPhone: string | null;
}

/** Run the transactional, idempotent generator (admin only — enforced in SQL). */
export async function generateFamilyIds(): Promise<GenerateSummary> {
  const { data, error } = await supabase.rpc('generate_family_ids');
  if (error) throw error;
  return data as GenerateSummary;
}

/** Gate lookup: family ID → students + reachable parent phone (admin/supervisor only). */
export async function lookupFamily(familyId: string): Promise<FamilyLookupRow[]> {
  const { data, error } = await supabase.rpc('lookup_family', { p_family_id: familyId });
  if (error) throw error;
  return (data ?? []) as FamilyLookupRow[];
}

/** Admin quick-edit of a student's transport (WALKER / CAR / bus number). */
export async function setStudentTransport(studentId: string, transport: string): Promise<void> {
  const { error } = await supabase.rpc('set_student_transport', { p_student_id: studentId, p_transport: transport });
  if (error) throw error;
}

/** Admin manual family assignment (merge into existing family or new ID). */
export async function assignFamilyOverride(studentId: string, familyId: string): Promise<void> {
  const { error } = await supabase.rpc('assign_family_override', { p_student_id: studentId, p_family_id: familyId });
  if (error) throw error;
}

/**
 * Apply matched import rows to students: set govId, transport, and
 * parentPhone. Only rows whose match === 'matched' are written; ambiguous and
 * unmatched rows are left for the admin to resolve. Runs per-row (each write
 * is small; MBK scale is hundreds of students).
 */
export async function applyTransportImport(rows: TransportImportRow[]): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    if (row.match !== 'matched' || !row.studentId) {
      skipped.push(row.name);
      continue;
    }
    // Normalize before write so the DB sees canonical values.
    const parsed = parseTransportCell(row.transport.value);
    const transport = parsed.kind === 'left' ? null : parsed.value;
    const payload: Record<string, unknown> = {
      govId: row.govId || null,
      transport,
      parentPhone: row.secondNumber ? normalizePhone(row.secondNumber) || row.secondNumber : null,
    };

    const { error } = await supabase
      .from('students')
      .update(payload)
      .eq('id', row.studentId);
    if (error) {
      skipped.push(`${row.name} (${error.message})`);
      continue;
    }
    applied += 1;
  }

  return { applied, skipped: skipped.length };
}

/** Family roster for the admin page (students grouped by familyId). */
export function groupStudentsByFamily(students: Student[]): Map<string, Student[]> {
  const map = new Map<string, Student[]>();
  for (const student of students) {
    if (!student.familyId) continue;
    const list = map.get(student.familyId) ?? [];
    list.push(student);
    map.set(student.familyId, list);
  }
  return map;
}

/** Students who have no family ID and no grouping key (parentId or phone). */
export function findUnattached(students: Student[]): Student[] {
  return students.filter(s => !s.familyId && !s.parentId && !normalizePhone(s.parentPhone));
}

export { normalizePhone };
