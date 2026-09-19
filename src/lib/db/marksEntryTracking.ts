import { supabase } from '../supabase';
import {
  normalizeMarksEntryRows,
  type MarksEntryRow,
  type MarksEntryStatusFilter,
  type MarksExamScope,
} from '../marksEntryTracking';

export interface MarksEntryTrackingQuery {
  academicYearId: string;
  termId: string;
  examScope: MarksExamScope;
  month?: string | null;
  teacherId?: string;
  className?: string;
  subjectId?: string;
}

/**
 * Fetches derived rows from the SECURITY DEFINER monitor RPC. There is no
 * client-side fallback: if this function is missing or denied, showing a
 * partial roster would be more dangerous than showing the error state.
 */
export async function fetchMarksEntryTracking(query: MarksEntryTrackingQuery): Promise<MarksEntryRow[]> {
  const { data, error } = await supabase.rpc('monitor_marks_entries', {
    p_academic_year_id: query.academicYearId,
    p_term_id: query.termId,
    p_exam_scope: query.examScope,
    p_month: query.month || null,
    p_teacher_id: query.teacherId || null,
    p_class_name: query.className || null,
    p_subject_id: query.subjectId || null,
  });
  if (error) throw error;
  return normalizeMarksEntryRows(data);
}

/** Kept as a small exported type helper for filters that stay client-side. */
export type { MarksEntryStatusFilter };
