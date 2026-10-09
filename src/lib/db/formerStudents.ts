// Former Students / Student Cleanup — data access.
//
// Every mutation goes through an admin-gated SECURITY DEFINER RPC
// (supabase/migrations/20261008_former_students_cleanup.sql). `students` has no
// client INSERT/UPDATE policy, so the role check in SQL is the enforcement
// point — assertCanManageFormerStudents() below is only a convenience guard for
// the UI layer, exactly like assertCanImportClasses() for the class import.
//
// Nothing in this module deletes a student row: the RPCs only move
// students.status between 'active' and 'former'.

import { supabase } from '../supabase';
import type { Role } from '../../types';
import type { FormerStudentEvaluation } from '../import/formerStudents';

export const FORMER_STUDENT_CONFIRM_PHRASE = 'MARK AS FORMER STUDENTS';
export const FORMER_STUDENT_ROLLBACK_PHRASE = 'ROLLBACK IMPORT';

export function assertCanManageFormerStudents(role: Role | null | undefined): void {
  if (role !== 'admin') {
    throw new Error('Only administrators can run the Former Students cleanup.');
  }
}

// ── Policy ──────────────────────────────────────────────────────────────────
export interface FormerStudentsPolicy {
  policyId: string;
  version: number;
  nameEn: string;
  matchKeyEn: string;
  neverDeleteEn: string;
  confirmPhrase: string;
  rollbackConfirmPhrase: string;
  maxRows: number;
  statuses: Record<string, string>;
  actions: Record<string, string>;
  autoSafeConditions: string[];
  neverDeactivateWhen: string[];
  invariants: Record<string, string>;
}

export async function getFormerStudentsPolicy(): Promise<FormerStudentsPolicy | null> {
  const { data, error } = await supabase.rpc('former_students_policy');
  if (error) return null; // older database without the feature: the UI falls back
  return data as FormerStudentsPolicy;
}

// ── Preview / apply ─────────────────────────────────────────────────────────
export interface FormerStudentImportRowInput {
  rowNumber: number;
  name: string;
  systemId: string;
  action?: 'deactivate' | 'keep_active' | 'review';
  adminConfirmed?: boolean;
}

export interface FormerStudentSummary {
  totalUploaded: number;
  validRecords: number;
  missingNames: number;
  missingSystemIds: number;
  duplicateSystemIds: number;
  duplicateNames: number;
  foundInDatabase: number;
  notFoundInDatabase: number;
  exactMatches: number;
  nameConflicts: number;
  possibleDuplicates: number;
  requiresReviewStatus: number;
  alreadyFormer: number;
  requiresReview: number;
  readyToDeactivate: number;
  noAction: number;
  blocked: number;
}

export interface FormerStudentPreviewResult {
  dryRun: boolean;
  writesPerformed: number;
  summary: FormerStudentSummary;
  rows: FormerStudentEvaluation[];
  policy?: FormerStudentsPolicy;
  evaluatedAt?: string;
}

export interface FormerStudentApplyResult {
  importId: string;
  importNumber: number;
  committed: boolean;
  atomic: boolean;
  fileName: string | null;
  adminId: string;
  adminName: string | null;
  deactivated: number;
  skipped: number;
  keptActive: number;
  blocked: number;
  deleted: number;
  formerStudentIds: string[];
  skippedRows: Array<{ rowNumber: number; uploadedSystemId: string; reason: string }>;
  summary: FormerStudentSummary;
  invariants?: Record<string, string>;
  durationMs?: number;
  completedAt?: string;
}

/**
 * READ-ONLY dry run. The database matches every uploaded row by System ID and
 * returns the status/summary the review screen shows. No row is written.
 */
export async function previewFormerStudentImport(
  rows: FormerStudentImportRowInput[],
): Promise<FormerStudentPreviewResult> {
  const { data, error } = await supabase.rpc('preview_former_student_import', { p_rows: rows });
  if (error) throw new Error(error.message);
  return data as FormerStudentPreviewResult;
}

/**
 * The single write path. Atomic: either every eligible row is applied or none
 * is. The server re-evaluates each row from the live table, so a row the client
 * marked "deactivate" is still refused when the System ID is missing, unknown or
 * ambiguous, or when a review row was not explicitly confirmed.
 */
export async function applyFormerStudentImport(
  rows: FormerStudentImportRowInput[],
  fileName?: string | null,
  reason?: string | null,
): Promise<FormerStudentApplyResult> {
  const { data, error } = await supabase.rpc('apply_former_student_import', {
    p_rows: rows,
    p_file_name: fileName ?? null,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  return data as FormerStudentApplyResult;
}

// ── Rollback ────────────────────────────────────────────────────────────────
export interface FormerStudentRollbackResult {
  importId: string;
  restored: number;
  skipped: number;
  restoredStudentIds: string[];
  skippedRows: Array<{ studentId: string; studentName?: string; reason: string; lastChangeReason?: string }>;
  importStatus: 'rolled_back' | 'partially_rolled_back';
  completedAt?: string;
}

export async function rollbackFormerStudentImport(
  importId: string,
  confirmPhrase: string,
): Promise<FormerStudentRollbackResult> {
  const { data, error } = await supabase.rpc('rollback_former_student_import', {
    p_import_id: importId,
    p_confirm_phrase: confirmPhrase,
  });
  if (error) throw new Error(error.message);
  return data as FormerStudentRollbackResult;
}

// ── Import history ──────────────────────────────────────────────────────────
export interface FormerStudentImportRecord {
  id: string;
  importNumber: number;
  fileName: string | null;
  adminId: string | null;
  adminName: string | null;
  reason: string | null;
  status: 'applied' | 'rolled_back' | 'partially_rolled_back';
  uploadedCount: number;
  validCount: number;
  missingNameCount: number;
  missingSystemIdCount: number;
  duplicateSystemIdCount: number;
  duplicateNameCount: number;
  foundCount: number;
  notFoundCount: number;
  exactMatchCount: number;
  nameConflictCount: number;
  possibleDuplicateCount: number;
  reviewCount: number;
  alreadyFormerCount: number;
  readyCount: number;
  deactivatedCount: number;
  skippedCount: number;
  restoredCount: number;
  rollbackSkippedCount: number;
  rolledBackAt: string | null;
  rolledBackByName: string | null;
  createdAt: string;
}

export interface FormerStudentImportRowRecord {
  id: string;
  rowNumber: number | null;
  uploadedName: string | null;
  uploadedSystemId: string | null;
  studentId: string | null;
  studentName: string | null;
  className: string | null;
  matchStatus: string;
  nameMatch: string | null;
  nameSimilarity: number | null;
  reasons: string[];
  requestedAction: string;
  adminConfirmed: boolean;
  actionTaken: 'deactivated' | 'kept_active' | 'skipped' | 'blocked' | 'already_former';
  actionReason: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  restoredAt: string | null;
}

export async function listFormerStudentImports(limit = 25, offset = 0): Promise<{
  total: number; imports: FormerStudentImportRecord[];
}> {
  const { data, error } = await supabase.rpc('list_former_student_imports', {
    p_limit: limit, p_offset: offset,
  });
  if (error) throw new Error(error.message);
  return data as { total: number; imports: FormerStudentImportRecord[] };
}

export async function getFormerStudentImport(importId: string, limit = 500, offset = 0): Promise<{
  import: FormerStudentImportRecord; rows: FormerStudentImportRowRecord[]; rowTotal: number;
}> {
  const { data, error } = await supabase.rpc('get_former_student_import', {
    p_import_id: importId, p_limit: limit, p_offset: offset,
  });
  if (error) throw new Error(error.message);
  return data as { import: FormerStudentImportRecord; rows: FormerStudentImportRowRecord[]; rowTotal: number };
}

// ── Former Students directory ───────────────────────────────────────────────
export interface FormerStudentRecord {
  id: string;
  name: string;
  className: string;
  govId: string | null;
  parentId: string | null;
  parentName: string | null;
  parentPhone: string | null;
  transport: string | null;
  familyId: string | null;
  status: 'former';
  markedFormerAt: string | null;
  markedFormerBy: string | null;
  markedFormerByName: string | null;
  createdAt: string;
  lastChange: {
    reason: string;
    at: string;
    by: string | null;
    fileName: string | null;
    importId: string | null;
  } | null;
}

export interface FormerStudentListResult {
  total: number;
  students: FormerStudentRecord[];
  classes: string[];
}

export async function listFormerStudents(opts: {
  search?: string;
  className?: string | null;
  limit?: number;
  offset?: number;
} = {}): Promise<FormerStudentListResult> {
  const { data, error } = await supabase.rpc('list_former_students', {
    p_search: opts.search ?? '',
    p_class: opts.className ?? null,
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  return data as FormerStudentListResult;
}

export async function setStudentFormerStatus(
  studentId: string,
  status: 'active' | 'former',
  reason?: string | null,
): Promise<{ studentId: string; status: 'active' | 'former'; changed: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc('set_student_former_status', {
    p_student_id: studentId,
    p_status: status,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { studentId: string; status: 'active' | 'former'; changed: boolean; reason?: string };
}

/** Status history of one student (append-only ledger, admin readable). */
export interface StudentStatusChange {
  id: string;
  studentId: string;
  studentName: string | null;
  previousStatus: string;
  newStatus: string;
  reason: string;
  previousTransport: string | null;
  changedBy: string | null;
  changedByName: string | null;
  importId: string | null;
  fileName: string | null;
  note: string | null;
  createdAt: string;
}

export async function getStudentStatusHistory(studentId: string): Promise<StudentStatusChange[]> {
  const { data, error } = await supabase
    .from('student_status_changes')
    .select('*')
    .eq('studentId', studentId)
    .order('createdAt', { ascending: false });
  if (error) return [];
  return (data ?? []) as StudentStatusChange[];
}

/** Human label for a ledger reason (audit view). */
export function statusChangeReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'former_import': return 'Former-student import';
    case 'former_manual': return 'Marked former by an administrator';
    case 'import_rollback': return 'Import rolled back';
    case 'manual_restore': return 'Restored to Active by an administrator';
    case 'legacy_left_backfill': return 'Backfill (was already marked LEFT)';
    default: return reason ?? '—';
  }
}

/** Human label for a match status returned by the RPCs. */
export function matchStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'exact_match': return 'Exact Match';
    case 'id_match_name_conflict': return 'ID Match but Name Different';
    case 'possible_duplicate': return 'Possible Duplicate';
    case 'requires_review': return 'Requires Review';
    case 'not_found': return 'System ID Not Found';
    case 'already_former': return 'Already a Former Student';
    default: return status ?? '—';
  }
}

export function actionTakenLabel(action: string | null | undefined): string {
  switch (action) {
    case 'deactivated': return 'Marked as Former Student';
    case 'kept_active': return 'Kept Active';
    case 'skipped': return 'Skipped';
    case 'blocked': return 'Blocked by a safety rule';
    case 'already_former': return 'Already a Former Student';
    default: return action ?? '—';
  }
}
