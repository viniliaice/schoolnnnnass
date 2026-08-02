import { supabase } from '../supabase';
import type { AssessmentLabel, EntryState } from '../excel-parser';
import type { ExamType } from '../../types';

export interface BulkGradeRecord {
  studentId: string;
  subjectId: string;
  assessmentLabel: AssessmentLabel;
  examType: ExamType;
  score: number | null;
  total: number;
  entryState: EntryState;
  month: string;
  date: string;
  termId: string;
}

export interface BulkGradeSubmissionResult {
  requiresConfirmation: boolean;
  insertCount: number;
  updateCount: number;
  skippedCount: number;
  uploadId?: string;
  message?: string;
}

function parseResult(value: unknown): BulkGradeSubmissionResult {
  if (!value || typeof value !== 'object') throw new Error('The grade upload service returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (typeof result.error === 'string') throw new Error(result.error);
  return {
    requiresConfirmation: Boolean(result.requiresConfirmation),
    insertCount: Number(result.insertCount ?? 0),
    updateCount: Number(result.updateCount ?? 0),
    skippedCount: Number(result.skippedCount ?? 0),
    uploadId: typeof result.uploadId === 'string' ? result.uploadId : undefined,
    message: typeof result.message === 'string' ? result.message : undefined,
  };
}

/**
 * Previews or atomically submits a normalized bulk-grade payload. The RPC
 * derives the authenticated actor and assigned teacher server-side; callers
 * never send teacherId, parentId, subject name, or approval status.
 */
export async function submitBulkGrades(
  records: BulkGradeRecord[],
  idempotencyKey: string,
  confirmUpdates: boolean,
): Promise<BulkGradeSubmissionResult> {
  const { data, error } = await supabase.rpc('submit_bulk_grades', {
    p_records: records,
    p_idempotency_key: idempotencyKey,
    p_confirm_updates: confirmUpdates,
  });
  if (error) throw new Error(error.message);
  return parseResult(data);
}
