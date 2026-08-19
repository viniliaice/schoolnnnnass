// Client wrappers for the family-ID RPCs (see supabase/migrations/20260802_family_ids.sql
// + 20260802_family_import_rpc.sql). All writes go through SECURITY DEFINER
// RPCs — students has no UPDATE policy, so direct REST writes are RLS-denied.

import { supabase } from '../supabase';
import { normalizePhone } from '../transport';
import { bucketOf, type ImportBucket, type TransportImportRow } from '../import/transportImport';
import type { Student } from '../../types';

const LOG = '[family-ids]';

/** Extract PostgREST error fields for the console, not just the message. */
function errInfo(error: unknown) {
  const e = error as { message?: string; code?: string; details?: string; hint?: string };
  return { message: e?.message, code: e?.code, details: e?.details, hint: e?.hint };
}

/**
 * A student who joined an existing family because they SHARE ITS PHONE
 * (no parentId link). Almost always a real sibling imported from the sheet,
 * but two households can legitimately share a number — so these joins are
 * reported for review rather than silently trusted. Split a wrong one with
 * assign_family_override().
 */
export interface PhoneJoin {
  familyId: string;
  phone: string;
  studentIds: string[];
}

export interface GenerateSummary {
  familiesCreated: number;
  /**
   * Students who joined an ALREADY EXISTING family (a sibling enrolling
   * later). Before the 20260819 migration these were wrongly given a brand
   * new ID, splitting one physical family across two MBK numbers.
   */
  studentsJoined?: number;
  /** Subset of studentsJoined that matched on phone only — review these. */
  phoneJoins?: PhoneJoin[];
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

/** Run the transactional, idempotent generator (admin only — enforced in SQL).
 * Pass a transport filter to generate only for a subset of unassigned students:
 * `'bus'` (digits), `'walker'` (WALKER/CAR), `'empty'` (NULL/blank),
 * `'all'` / `undefined` = no filter. */
export async function generateFamilyIds(filter?: string): Promise<GenerateSummary> {
  const params: Record<string, string> = {};
  if (filter && filter !== 'all') params.p_transport_filter = filter;
  const { data, error } = await supabase.rpc('generate_family_ids', params);
  if (error) {
    console.error(`${LOG} generate_family_ids failed`, errInfo(error));
    throw error;
  }
  console.log(`${LOG} generate_family_ids ok`, { filter, ...data });
  return data as GenerateSummary;
}

/** Gate lookup: family ID → students + reachable parent phone (admin/supervisor only). */
export async function lookupFamily(familyId: string): Promise<FamilyLookupRow[]> {
  const { data, error } = await supabase.rpc('lookup_family', { p_family_id: familyId });
  if (error) throw error;
  return (data ?? []) as FamilyLookupRow[];
}

/** parentId → profile name, for printing the parent name on family cards. */
export async function getParentNames(parentIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(parentIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from('profiles').select('id,name').in('id', ids);
  if (error) throw error;
  return new Map((data ?? []).map(p => [p.id, p.name]));
}

/** Admin quick-edit of a student's transport (WALKER / CAR / bus number). */
export async function setStudentTransport(studentId: string, transport: string): Promise<void> {
  const { error } = await supabase.rpc('set_student_transport', { p_student_id: studentId, p_transport: transport });
  if (error) {
    console.error(`${LOG} set_student_transport failed`, { studentId, transport, ...errInfo(error) });
    throw error;
  }
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
  if (error) {
    console.error(`${LOG} assign_family_override failed`, { studentId, digits, ...errInfo(error) });
    throw error;
  }
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
 * left for the admin to resolve. Pass `buckets` to apply only a subset of
 * rows (e.g. just NB walkers, or just empty-bus cells); rows outside the
 * set are skipped.
 *
 * Writes MUST go through the RPC: students is SELECT-only under RLS, so a
 * direct supabase.from('students').update() is denied and would silently
 * "apply 0 rows" (the bug this replaces). Errors are collected and returned
 * so the UI reports the real failure instead of a success count.
 */
export async function applyTransportImport(rows: TransportImportRow[], buckets?: Set<ImportBucket>): Promise<ApplyTransportResult> {
  let applied = 0;
  let diagPushed = false;
  const skipped: string[] = [];
  const errors: string[] = [];

  console.log(`${LOG} apply start`, { rows: rows.length, buckets: buckets ? Array.from(buckets) : undefined });

  for (const row of rows) {
    if (row.match !== 'matched' || !row.studentId) {
      skipped.push(row.name);
      continue;
    }
    const bucket = bucketOf(row.busRaw);
    if (buckets && !buckets.has(bucket)) {
      console.log(`${LOG} apply skipped (filter)`, { name: row.name, bucket, busRaw: row.busRaw });
      skipped.push(row.name);
      continue;
    }
    // LEFT or unrecognized bus values never reach the RPC: unknown sheet text
    // like '?' or 'Bike' is rejected with 22023, and NULL means "keep the
    // stored transport" server-side (COALESCE in set_student_import_fields),
    // so an unknown/LEFT row never wipes an existing bus number.
    const transport =
      row.transport.kind === 'left' || row.transport.kind === 'unknown'
        ? null
        : row.transport.value;
    const payload = {
      p_student_id: row.studentId,
      p_gov_id: row.govId || null,
      p_transport: transport,
      p_parent_phone: row.secondNumber ? normalizePhone(row.secondNumber) || row.secondNumber : null,
    };
    console.log(`${LOG} apply row → set_student_import_fields`, { name: row.name, ...payload });

    const { error } = await supabase.rpc('set_student_import_fields', payload);
    if (error) {
      skipped.push(row.name);
      // Surface the full PostgREST message + code for in-app diagnosis
      console.error(`${LOG} set_student_import_fields failed`, { name: row.name, studentId: row.studentId, ...errInfo(error) });
      errors.push(`${row.name} (${error.message})`);
      // If error.code is '42501' we are not admin; if it's PGRST it's missing function.
      if (
        (error as any).code === '42501' ||
        error.message.toLowerCase().includes('insufficient_privilege') ||
        error.message.toLowerCase().includes('admin')
      ) {
        // One normal-check returns this for all rows — report once.
        if (applied === 0 && !diagPushed) {
          diagPushed = true;
          errors.push('[diag] All rows likely failing because `current_profile_role()` returns non-admin. Check profiles.role for your auth_id.');
        }
        continue;
      }
      continue;
    }
    applied += 1;
    console.log(`${LOG} apply row ok`, { name: row.name, studentId: row.studentId });
  }

  console.log(`${LOG} apply done`, { applied, skipped: skipped.length, errors });
  return { applied, skipped: skipped.length, errors };
}

/**
 * Family roster for the admin page (students grouped by familyId).
 *
 * Students marked as left keep their familyId (so a restore rejoins the same
 * family) but are excluded here — they get no family row and no gate card.
 */
export function groupStudentsByFamily(students: Student[]): Map<string, Student[]> {
  const map = new Map<string, Student[]>();
  for (const student of students) {
    if (!student.familyId) continue;
    if (student.transport === 'LEFT') continue;
    const list = map.get(student.familyId) ?? [];
    list.push(student);
    map.set(student.familyId, list);
  }
  return map;
}

/** Students who have no family ID and no grouping key (parentId or phone). */
export function findUnattached(students: Student[]): Student[] {
  return students.filter(s => !s.familyId && !s.parentId && !normalizePhone(s.parentPhone) && s.transport !== 'LEFT');
}

/** Students marked as left the school (transport = 'LEFT'). */
export function findLeftStudents(students: Student[]): Student[] {
  return students.filter(s => s.transport === 'LEFT');
}

/** Mark / restore a student as left (admin only — enforced in SQL). */
export async function markStudentLeft(studentId: string, left: boolean): Promise<void> {
  const { error } = await supabase.rpc('mark_student_left', { p_student_id: studentId, p_left: left });
  if (error) {
    console.error(`${LOG} mark_student_left failed`, { studentId, left, ...errInfo(error) });
    throw error;
  }
  console.log(`${LOG} mark_student_left ok`, { studentId, left });
}

export { normalizePhone };
