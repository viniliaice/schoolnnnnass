// Client wrappers for the family-ID RPCs (see supabase/migrations/20260802_family_ids.sql
// + 20260802_family_import_rpc.sql). All writes go through SECURITY DEFINER
// RPCs — students has no UPDATE policy, so direct REST writes are RLS-denied.

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

/** Normalize a raw family-ID input to digits ('MBK-0043' → '0043'). */
export function normalizeFamilyIdInput(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Admin manual family assignment (merge into existing family or new ID).
 * Rejects oversized input client-side (same guard as the RPC) so an ID
 * longer than 4 digits can never reach the DB and brick generate_family_ids().
 */
export async function assignFamilyOverride(studentId: string, familyId: string): Promise<void> {
  const digits = normalizeFamilyIdInput(familyId);
  if (!digits) throw new Error('A family ID is required.');
  if (digits.length > 4) throw new Error('Family ID must be at most 4 digits (0001-9999).');
  const { error } = await supabase.rpc('assign_family_override', { p_student_id: studentId, p_family_id: digits });
  if (error) throw error;
}

export interface ApplyTransportResult {
  applied: number;
  skipped: number;
  /** Real per-row error messages (e.g. RLS/permission) — surfaced to the UI. */
  errors: string[];
}

/**
 * Apply matched import rows to students: set govId, transport, and
 * parentPhone via the admin-only set_student_import_fields RPC. Only rows
 * whose match === 'matched' are written; ambiguous and unmatched rows are
 * left for the admin to resolve.
 *
 * Writes MUST go through the RPC: students is SELECT-only under RLS, so a
 * direct supabase.from('students').update() is denied and would silently
 * "apply 0 rows" (the bug this replaces). Errors are collected and returned
 * so the UI reports the real failure instead of a success count.
 */
export async function applyTransportImport(rows: TransportImportRow[]): Promise<ApplyTransportResult> {
  let applied = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    if (row.match !== 'matched' || !row.studentId) {
      skipped.push(row.name);
      continue;
    }
    // Normalize before write so the DB sees canonical values.
    const parsed = parseTransportCell(row.transport.value);
    const transport = parsed.kind === 'left' ? null : parsed.value;

    const { error } = await supabase.rpc('set_student_import_fields', {
      p_student_id: row.studentId,
      p_gov_id: row.govId || null,
      p_transport: transport,
      p_parent_phone: row.secondNumber ? normalizePhone(row.secondNumber) || row.secondNumber : null,
    });
    if (error) {
      skipped.push(row.name);
      errors.push(`${row.name} (${error.message})`);
      continue;
    }
    applied += 1;
  }

  return { applied, skipped: skipped.length, errors };
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
