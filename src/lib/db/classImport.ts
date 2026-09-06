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
