import { getGrade } from '../types';
import type { MonthlyScore } from '../types';

/** Monthly reports always use CA 40% + Quiz 60%. Not taken from report_config (Final). */
export const MONTHLY_CA_WEIGHT = 40;
export const MONTHLY_QUIZ_WEIGHT = 60;

/**
 * Coursework types that form the Monthly CA component.
 *
 * `report_config.caTypes` / `CA_TYPES` list CA, Homework, Classwork, Quiz, and
 * Attendance as continuous-assessment members. For Monthly reports Quiz is a
 * separate 60% component, so it is carved out here. Discipline / Midterm /
 * Final never count as CA.
 */
export const MONTHLY_CA_EXAM_TYPES = ['CA', 'Homework', 'Classwork', 'Attendance'] as const;

export type MonthlyCaExamType = (typeof MONTHLY_CA_EXAM_TYPES)[number];

export interface MonthlyExamInput {
  id?: string;
  subject: string;
  month: string;
  examType: string;
  assessmentLabel?: string | null;
  score: number | null;
  total: number;
  date?: string | null;
  entryState?: string | null;
  status?: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isMonthlyCaExam(exam: Pick<MonthlyExamInput, 'examType'>): boolean {
  return (MONTHLY_CA_EXAM_TYPES as readonly string[]).includes(exam.examType);
}

/**
 * Any `examType = 'Quiz'` row is a Monthly Quiz component, including bulk-uploaded
 * monthly tests stored as `assessmentLabel = 'MT'`. Midterm *reports* still treat
 * MT as midterm; Monthly simply stops dropping those Quiz records.
 */
export function isMonthlyQuizExam(exam: Pick<MonthlyExamInput, 'examType'>): boolean {
  return exam.examType === 'Quiz';
}

export function examPercentage(score: number | null | undefined, total: number): number | null {
  if (score == null || !Number.isFinite(score) || !Number.isFinite(total) || total <= 0) return null;
  return round2((score / total) * 100);
}

export function averagePercentages(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Monthly Score = (CA Average × 0.40) + (Quiz Average × 0.60)
 *
 * Missing CA or missing Quiz is NOT coerced to 0. A recorded Quiz of 0 is a
 * real zero and is used. Returns null when either component is absent so the
 * UI can show "Not recorded" instead of a fabricated score.
 */
export function calculateMonthlyScore(caAvg: number | null, quizAvg: number | null): number | null {
  if (caAvg == null || quizAvg == null) return null;
  return round2(caAvg * (MONTHLY_CA_WEIGHT / 100) + quizAvg * (MONTHLY_QUIZ_WEIGHT / 100));
}

export function monthlyGrade(score: number | null): string | null {
  if (score == null) return null;
  return getGrade(score);
}

export function monthlyRemark(score: number | null): string | null {
  const grade = monthlyGrade(score);
  if (grade == null) return null;
  if (grade === 'A') return 'Excellent';
  if (grade === 'B') return 'Very Good';
  if (grade === 'C') return 'Good';
  if (grade === 'D') return 'Satisfactory';
  return 'Needs Improvement';
}

export function formatReportPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return 'Not recorded';
  return `${value}%`;
}

export function overallMonthlyAverage(rows: Array<Pick<MonthlyScore, 'average'>>): number | null {
  const scores = rows.map(row => row.average).filter((value): value is number => value != null && !Number.isNaN(value));
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

function isEligibleMonthlyExam(exam: MonthlyExamInput): boolean {
  if (exam.status && exam.status !== 'approved') return false;
  if (exam.entryState && exam.entryState !== 'scored') return false;
  if (exam.score == null) return false;
  if (!isMonthlyCaExam(exam) && !isMonthlyQuizExam(exam)) return false;
  return true;
}

function toDetail(exam: MonthlyExamInput) {
  const percentage = examPercentage(exam.score, exam.total) ?? 0;
  return {
    type: exam.assessmentLabel && exam.assessmentLabel.trim() ? exam.assessmentLabel : exam.examType,
    examType: exam.examType,
    score: exam.score ?? 0,
    total: exam.total,
    percentage,
    date: exam.date || '',
    examId: exam.id,
  };
}

export function aggregateMonthlyReport(
  exams: MonthlyExamInput[],
  options?: { termMonths?: string[] },
): MonthlyScore[] {
  const groups = new Map<string, MonthlyExamInput[]>();
  for (const exam of exams.filter(isEligibleMonthlyExam)) {
    const key = `${exam.subject}\u0000${exam.month}`;
    const list = groups.get(key);
    if (list) list.push(exam);
    else groups.set(key, [exam]);
  }

  const rows: MonthlyScore[] = [];
  for (const [key, list] of groups) {
    const separator = key.indexOf('\u0000');
    const subject = key.slice(0, separator);
    const month = key.slice(separator + 1);
    const caExams = list.filter(isMonthlyCaExam);
    const quizExams = list.filter(isMonthlyQuizExam);
    const caPercents = caExams
      .map(exam => examPercentage(exam.score, exam.total))
      .filter((value): value is number => value != null);
    const quizPercents = quizExams
      .map(exam => examPercentage(exam.score, exam.total))
      .filter((value): value is number => value != null);
    const ca_avg = averagePercentages(caPercents);
    const quiz_avg = averagePercentages(quizPercents);
    const average = calculateMonthlyScore(ca_avg, quiz_avg);
    const ca_details = caExams.map(toDetail);
    const quiz_details = quizExams.map(toDetail);
    rows.push({
      subject,
      month,
      average,
      assessment_count: caExams.length + quizExams.length,
      details: [...ca_details, ...quiz_details],
      ca_avg,
      quiz_avg,
      ca_weight: MONTHLY_CA_WEIGHT,
      quiz_weight: MONTHLY_QUIZ_WEIGHT,
      ca_weighted: ca_avg == null ? null : round2(ca_avg * (MONTHLY_CA_WEIGHT / 100)),
      quiz_weighted: quiz_avg == null ? null : round2(quiz_avg * (MONTHLY_QUIZ_WEIGHT / 100)),
      grade: monthlyGrade(average),
      remark: monthlyRemark(average),
      ca_count: caExams.length,
      quiz_count: quizExams.length,
      ca_details,
      quiz_details,
    });
  }

  const monthOrder = options?.termMonths ?? [];
  rows.sort((a, b) => {
    const aMonth = monthOrder.indexOf(a.month);
    const bMonth = monthOrder.indexOf(b.month);
    const aRank = aMonth === -1 ? 999 : aMonth;
    const bRank = bMonth === -1 ? 999 : bMonth;
    if (aRank !== bRank) return aRank - bRank;
    return a.subject.localeCompare(b.subject);
  });
  return rows;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asDetails(value: unknown): MonthlyScore['details'] {
  if (!Array.isArray(value)) return [];
  return value.map((detail: any) => ({
    type: String(detail?.type ?? ''),
    examType: detail?.examType ?? detail?.exam_type,
    score: Number(detail?.score ?? 0),
    total: Number(detail?.total ?? 0),
    percentage: Number(detail?.percentage ?? 0),
    date: String(detail?.date ?? ''),
    examId: detail?.examId ?? detail?.exam_id,
  }));
}

/**
 * Normalize RPC JSON (new 40/60 shape or legacy averaged shape) into MonthlyScore[].
 * Legacy rows that still have mixed `details` are recomputed with CA 40 / Quiz 60
 * from those same assessment records — never from invented Quiz values.
 */
export function normalizeMonthlyReport(data: unknown): MonthlyScore[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row: any) => {
    const hasSplit = row && ('ca_avg' in row || 'quiz_avg' in row || 'ca_weight' in row);
    if (!hasSplit) {
      const details = asDetails(row?.details);
      const reconstructed = details.map(detail => ({
        subject: String(row?.subject ?? ''),
        month: String(row?.month ?? ''),
        examType: detail.examType || classifyLegacyDetailType(detail.type),
        assessmentLabel: detail.type,
        score: detail.score,
        total: detail.total,
        date: detail.date,
        id: detail.examId,
        status: 'approved',
        entryState: 'scored',
      } satisfies MonthlyExamInput));
      const aggregated = aggregateMonthlyReport(reconstructed)[0];
      if (aggregated) return aggregated;
    }

    const ca_avg = asNumber(row?.ca_avg);
    const quiz_avg = asNumber(row?.quiz_avg);
    const average = asNumber(row?.average) ?? calculateMonthlyScore(ca_avg, quiz_avg);
    const ca_details = asDetails(row?.ca_details);
    const quiz_details = asDetails(row?.quiz_details);
    const details = asDetails(row?.details);
    return {
      subject: String(row?.subject ?? ''),
      month: String(row?.month ?? ''),
      average,
      assessment_count: Number(row?.assessment_count ?? details.length ?? 0),
      details: details.length ? details : [...ca_details, ...quiz_details],
      ca_avg,
      quiz_avg,
      ca_weight: asNumber(row?.ca_weight) ?? MONTHLY_CA_WEIGHT,
      quiz_weight: asNumber(row?.quiz_weight) ?? MONTHLY_QUIZ_WEIGHT,
      ca_weighted: asNumber(row?.ca_weighted),
      quiz_weighted: asNumber(row?.quiz_weighted),
      grade: row?.grade ?? monthlyGrade(average),
      remark: row?.remark ?? monthlyRemark(average),
      ca_count: Number(row?.ca_count ?? ca_details.length ?? 0),
      quiz_count: Number(row?.quiz_count ?? quiz_details.length ?? 0),
      ca_details,
      quiz_details,
    };
  });
}

function classifyLegacyDetailType(type: string): string {
  const value = String(type || '').trim();
  const upper = value.toUpperCase();
  if (upper === 'QUIZ' || upper === 'MT') return 'Quiz';
  if (upper === 'CA') return 'CA';
  if (upper === 'HOMEWORK' || /^HW\d+$/i.test(value)) return 'Homework';
  if (upper === 'CLASSWORK' || /^CPW\d+$/i.test(value)) return 'Classwork';
  if (upper === 'ATTENDANCE' || upper === 'ATT') return 'Attendance';
  if (upper === 'MIDTERM') return 'Midterm';
  if (upper === 'FINAL') return 'Final';
  if (upper === 'DISCIPLINE' || upper === 'AKHLAAQ') return 'Discipline';
  return value;
}
