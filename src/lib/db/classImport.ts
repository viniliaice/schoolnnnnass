// Commit path for the Student Class Update & New Student Import.
//
// The preview is assembled client-side (src/lib/import/classImport.ts) with
// ZERO database writes; the only mutation is this single RPC call, which the
// database executes atomically. Students has no client INSERT/UPDATE RLS
// policies, so — exactly like the transport import (set_student_import_fields)
// and promotions (promote_students) — the write path is an admin-gated
// SECURITY DEFINER function. The role check in SQL is the enforcement point;
// assertCanImportClasses() is a convenience guard for the UI layer.

import { supabase } from '../supabase';
import type { ClassChangeCommit, NewStudentCommit } from '../import/classImport';
import { assertCanImportClasses } from '../import/classImport';

export { assertCanImportClasses };

export interface AppliedClassChange {
  studentId: string;
  name: string;
  fromClass: string;
  toClass: string;
}

export interface CreatedStudent {
  studentId: string;
  name: string;
  className: string;
}

export interface ClassImportApplyResult {
  importRef: string;
  updatedCount: number;
  createdCount: number;
  skippedCount: number;
  changes: AppliedClassChange[];
  created: CreatedStudent[];
}

export interface ClassImportResolution {
  index: number;
  status: 'matched' | 'ambiguous' | 'new';
  matchMethod?: 'student_id' | 'gov_id' | 'name_phone';
  matchedStudentId?: string;
  matchedName?: string;
  matchedClassName?: string;
  reason?: string;
  candidates?: { id: string; name: string; className: string }[];
}

/**
 * Authoritative, READ-ONLY identity resolution against the LIVE database. The
 * client matcher classifies against the downloaded roster; this confirms
 * identity (Student ID → Gov ID → name+phone) server-side so an existing
 * student — identified by their Gov ID even without an internal Student ID
 * column — is never created as new.
 */
export async function resolveClassImportRows(
  rows: { studentId: string; govId: string; name: string; parentPhone: string }[],
): Promise<ClassImportResolution[]> {
  const { data, error } = await supabase.rpc('resolve_class_import_rows', {
    p_rows: rows,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error('The import service returned an invalid identity response.');
  return data as ClassImportResolution[];
}

export interface ClassImportPreflightProblem {
  kind: string;
  message: string;
  studentId?: string;
  govId?: string;
  existingId?: string;
  existingName?: string;
  existingClassName?: string;
  claimedAs?: string;
}

export interface ClassImportPreflightResult {
  ok: boolean;
  problemCount: number;
  problems: ClassImportPreflightProblem[];
}

/**
 * Authoritative, READ-ONLY validation against the live database. Run this
 * before applyStudentClassImport(): the preview classifies rows against the
 * roster the browser downloaded, which can be incomplete; the server is the
 * source of truth for "does this ID/Gov ID already exist". Returns every
 * problem (per row) so the UI can move misclassified rows to manual review
 * instead of failing the whole atomic commit.
 */
export async function checkClassImportPayload(
  changes: ClassChangeCommit[],
  newStudents: NewStudentCommit[],
): Promise<ClassImportPreflightResult> {
  const { data, error } = await supabase.rpc('check_class_import_payload', {
    p_changes: changes,
    p_new_students: newStudents,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error('The import service returned an invalid preflight response.');
  const r = data as Record<string, unknown>;
  return {
    ok: r.ok === true,
    problemCount: Number(r.problemCount ?? 0),
    problems: Array.isArray(r.problems) ? (r.problems as ClassImportPreflightProblem[]) : [],
  };
}

function parseApplyResult(value: unknown): ClassImportApplyResult {
  if (!value || typeof value !== 'object') throw new Error('The import service returned an invalid response.');
  const result = value as Record<string, unknown>;
  return {
    importRef: typeof result.importRef === 'string' ? result.importRef : '',
    updatedCount: Number(result.updatedCount ?? 0),
    createdCount: Number(result.createdCount ?? 0),
    skippedCount: Number(result.skippedCount ?? 0),
    changes: Array.isArray(result.changes) ? (result.changes as AppliedClassChange[]) : [],
    created: Array.isArray(result.created) ? (result.created as CreatedStudent[]) : [],
  };
}

/**
 * Atomically apply the confirmed import: class changes + new students in ONE
 * transaction. Throws on any validation or permission failure — the database
 * guarantees nothing is partially applied.
 */
export async function applyStudentClassImport(
  changes: ClassChangeCommit[],
  newStudents: NewStudentCommit[],
  academicYearId?: string | null,
  importRef?: string,
): Promise<ClassImportApplyResult> {
  const { data, error } = await supabase.rpc('apply_student_class_import', {
    p_changes: changes,
    p_new_students: newStudents,
    p_academic_year_id: academicYearId ?? null,
    p_import_ref: importRef ?? null,
  });
  if (error) throw new Error(error.message);
  return parseApplyResult(data);
}
