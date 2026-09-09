import { supabase } from '../supabase';

/**
 * Admin Grade Correction data layer.
 *
 * The actual mutation goes through the SECURITY DEFINER RPC `admin_correct_grade`
 * (never a direct table update): the server authenticates the caller, verifies
 * the admin role, locks the target exam row by id, validates the new value,
 * applies the correction, appends an immutable audit record, and resets the row
 * to 'pending' — all atomically. The client submits ONLY the exam id, the value
 * it reviewed (for optimistic concurrency), the new value, and the reason.
 */

export type CorrectionEntryState = 'scored' | 'absent' | 'not_applicable';

export interface GradeCorrectionResult {
  auditId: string;
  examId: string;
  studentId: string;
  subject: string;
  assessmentLabel: string | null;
  oldScore: number | null;
  newScore: number | null;
  oldEntryState: CorrectionEntryState | null;
  newEntryState: CorrectionEntryState;
  oldStatus: string;
  newStatus: string;
  total: number;
  reason: string;
  correctedBy: string;
  message: string;
}

export interface GradeCorrectionHistoryEntry {
  id: string;
  examId: string;
  oldScore: number | null;
  newScore: number | null;
  oldEntryState: CorrectionEntryState | null;
  newEntryState: CorrectionEntryState;
  oldStatus: string | null;
  newStatus: string | null;
  reason: string;
  correctedBy: string;
  correctedByName: string | null;
  correctedAt: string;
  source: string;
}

export interface CorrectGradeInput {
  examId: string;
  /** The score the admin reviewed (for optimistic concurrency). */
  expectedOldScore: number | null;
  /** The score the admin reviewed the row in (defaults to 'scored'). */
  expectedOldEntryState?: CorrectionEntryState;
  newScore: number | null;
  newEntryState?: CorrectionEntryState;
  reason: string;
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * Applies an admin grade correction through the secure RPC. Throws with a
 * user-facing message on any authorization/validation/concurrency failure.
 */
export async function correctGrade(input: CorrectGradeInput): Promise<GradeCorrectionResult> {
  const { data, error } = await supabase.rpc('admin_correct_grade', {
    p_exam_id: input.examId,
    p_expected_old_score: input.expectedOldScore,
    p_new_score: input.newScore,
    p_reason: input.reason,
    p_expected_old_entry_state: input.expectedOldEntryState ?? 'scored',
    p_new_entry_state: input.newEntryState ?? 'scored',
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    auditId: String(r.auditId ?? ''),
    examId: String(r.examId ?? ''),
    studentId: String(r.studentId ?? ''),
    subject: String(r.subject ?? ''),
    assessmentLabel: r.assessmentLabel == null ? null : String(r.assessmentLabel),
    oldScore: num(r.oldScore),
    newScore: num(r.newScore),
    oldEntryState: (r.oldEntryState as CorrectionEntryState | null) ?? null,
    newEntryState: (r.newEntryState as CorrectionEntryState) ?? 'scored',
    oldStatus: String(r.oldStatus ?? ''),
    newStatus: String(r.newStatus ?? ''),
    total: Number(r.total ?? 0),
    reason: String(r.reason ?? ''),
    correctedBy: String(r.correctedBy ?? ''),
    message: String(r.message ?? 'Grade corrected successfully.'),
  };
}

/** Fetches the full chronological correction history for one exam (staff only). */
export async function getGradeCorrectionHistory(examId: string): Promise<GradeCorrectionHistoryEntry[]> {
  const { data, error } = await supabase.rpc('get_grade_correction_history', { p_exam_id: examId });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row): GradeCorrectionHistoryEntry => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      examId: String(r.examId ?? ''),
      oldScore: num(r.oldScore),
      newScore: num(r.newScore),
      oldEntryState: (r.oldEntryState as CorrectionEntryState | null) ?? null,
      newEntryState: (r.newEntryState as CorrectionEntryState) ?? 'scored',
      oldStatus: r.oldStatus == null ? null : String(r.oldStatus),
      newStatus: r.newStatus == null ? null : String(r.newStatus),
      reason: String(r.reason ?? ''),
      correctedBy: String(r.correctedBy ?? ''),
      correctedByName: r.correctedByName == null ? null : String(r.correctedByName),
      correctedAt: String(r.correctedAt ?? ''),
      source: String(r.source ?? 'admin_correction'),
    };
  });
}
