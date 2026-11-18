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

/**
 * A single record's before/after state, as computed by the server preview from
 * the ACTUAL existing exam row (never from the uploaded workbook). Present only
 * on a preview response (p_confirm_updates = false).
 */
export interface BulkGradeChange {
  studentId: string;
  studentName: string | null;
  className: string | null;
  subject: string;
  subjectId: string;
  assessmentLabel: AssessmentLabel;
  examType: ExamType;
  newScore: number | null;
  newEntryState: EntryState;
  existingScore: number | null;
  existingEntryState: EntryState | null;
  existingStatus: string | null;
  changeType: 'new' | 'update' | 'unchanged';
  newMonth?: string;
  existingMonth?: string | null;
  preservedPeriods?: string[];
  isApproved: boolean;
}

export interface BulkGradeSubmissionResult {
  identityVersion?: number;
  period?: { termId: string; termName: string; academicYearId: string; academicYearName?: string; month: string };
  requiresConfirmation: boolean;
  insertCount: number;
  updateCount: number;
  skippedCount: number;
  /** Number of existing grades that are currently approved and will be replaced. */
  approvedChangeCount: number;
  /** True when at least one approved grade will change (UI must require acknowledgement). */
  requiresApprovedAcknowledgement: boolean;
  /** Per-record old -> new detail (preview only). Empty on a committed result. */
  changes: BulkGradeChange[];
  uploadId?: string;
  message?: string;
}

function parseChange(value: unknown): BulkGradeChange | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    studentId: String(c.studentId ?? ''),
    studentName: c.studentName == null ? null : String(c.studentName),
    className: c.className == null ? null : String(c.className),
    subject: String(c.subject ?? ''),
    subjectId: String(c.subjectId ?? ''),
    assessmentLabel: c.assessmentLabel as AssessmentLabel,
    examType: c.examType as ExamType,
    newScore: num(c.newScore),
    newEntryState: (c.newEntryState as EntryState) ?? 'scored',
    existingScore: num(c.existingScore),
    existingEntryState: (c.existingEntryState as EntryState | null) ?? null,
    existingStatus: c.existingStatus == null ? null : String(c.existingStatus),
    changeType: c.changeType === 'unchanged' ? 'unchanged' : c.changeType === 'update' ? 'update' : 'new',
    newMonth: typeof c.newMonth === 'string' ? c.newMonth : undefined,
    existingMonth: c.existingMonth == null ? null : String(c.existingMonth),
    preservedPeriods: Array.isArray(c.preservedPeriods) ? c.preservedPeriods.map(String) : [],
    isApproved: Boolean(c.isApproved),
  };
}

function parseResult(value: unknown): BulkGradeSubmissionResult {
  if (!value || typeof value !== 'object') throw new Error('The grade upload service returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (typeof result.error === 'string') throw new Error(result.error);
  const changes = Array.isArray(result.changes)
    ? (result.changes.map(parseChange).filter(Boolean) as BulkGradeChange[])
    : [];
  return {
    identityVersion: typeof result.identityVersion === 'number' ? result.identityVersion : undefined,
    period: result.period as BulkGradeSubmissionResult['period'],
    requiresConfirmation: Boolean(result.requiresConfirmation),
    insertCount: Number(result.insertCount ?? 0),
    updateCount: Number(result.updateCount ?? 0),
    skippedCount: Number(result.skippedCount ?? 0),
    approvedChangeCount: Number(result.approvedChangeCount ?? 0),
    requiresApprovedAcknowledgement: Boolean(result.requiresApprovedAcknowledgement),
    changes,
    uploadId: typeof result.uploadId === 'string' ? result.uploadId : undefined,
    message: typeof result.message === 'string' ? result.message : undefined,
  };
}

/**
 * Previews or atomically submits a normalized bulk-grade payload. The RPC
 * derives the authenticated actor and assigned teacher server-side; callers
 * never send teacherId, parentId, subject name, or approval status.
 *
 * When confirmUpdates is false, the returned `changes` array describes every
 * record's old -> new state (existing values sourced from the database), and
 * `requiresApprovedAcknowledgement` flags whether any approved grade will change.
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

/** Fail closed against the old month-blind service or a stale UI selection. */
export function assertBulkGradePeriod(result: BulkGradeSubmissionResult, records: BulkGradeRecord[], termId: string, academicYearId: string, month: string): void {
  const period = result.period;
  if (result.identityVersion !== 2 || !period || period.termId !== termId || period.academicYearId !== academicYearId || period.month !== month ||
      !records.length || records.some(r => r.termId !== termId || r.month !== month)) {
    throw new Error('The upload period could not be verified. Select the assessment period and validate again.');
  }
}
