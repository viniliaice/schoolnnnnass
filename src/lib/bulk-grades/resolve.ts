// Client-side resolution + validation for the class-specific bulk upload.
//
// This is a PURE function: it takes the parsed roster workbook plus the class
// context (authorized subjects, current roster, term/month/date, and any manual
// Needs-Review decisions) and produces
//   * the normalized BulkGradeRecord[] to send to submit_bulk_grades
//   * per-category counts (valid / errors / needs review / excluded)
//   * human-readable problems and actionable review items
//
// It mirrors the server's authorization checks so the teacher gets fast,
// specific feedback — but the server (submit_bulk_grades) remains authoritative
// and re-checks everything. Nothing here is trusted by the database.
//
// Resolution categories (mirrors the Student Class Update & Import experience):
//   VALID        — Student ID (or a manually chosen student) resolves to a
//                  student currently in the selected class, with an authorized
//                  subject and a valid score.
//   NEEDS REVIEW — a legacy / name-only row that has at least one plausible
//                  roster candidate but cannot be matched automatically. The
//                  reviewer must choose a student ("Use this student") or
//                  exclude the row. NEVER auto-selected.
//   ERROR        — definitively invalid and not human-resolvable by choosing a
//                  student: no roster candidate for a legacy name, unauthorized
//                  subject, student not in the current class (stale/wrong class),
//                  duplicate workbook identity, invalid assessment/score.
//   EXCLUDED     — no score entered, or the reviewer excluded the row.

import type { BulkGradeRecord } from '../db/bulkGrades';
import type { WorkbookParseResult, WorkbookStudentRow } from './workbook';
import { blockDisplayName } from './assessments';
import type { Student, Subject } from '../../types';

/** A student the reviewer may pick for a Needs-Review row. */
export interface ResolveCandidate {
  id: string;
  name: string;
  className: string;
}

/** A reviewer's manual decision for a Needs-Review row, keyed by workbook row. */
export type ReviewDecision =
  | { action: 'exclude' }
  | { action: 'use'; studentId: string };

export interface ResolveContext {
  /** The single class the teacher selected. */
  className: string;
  /** Subjects the teacher is authorized to upload for this class. */
  authorizedSubjects: Subject[];
  /** Current roster for the class (students currently in `className`). */
  roster: Student[];
  termId: string;
  termName?: string;
  month: string;
  date: string;
  /**
   * Manual Needs-Review decisions keyed by workbook rowNumber. When present,
   * "use" re-runs the SAME validation pipeline with the chosen student, and
   * "exclude" moves the row to Excluded. Absent rows stay in Needs Review.
   */
  decisions?: Record<number, ReviewDecision>;
}

export interface ResolveProblem {
  severity: 'error';
  message: string;
  studentId?: string;
  studentName?: string;
  subjectName?: string;
  rowNumber?: number;
  /**
   * When set, this error belongs to a specific workbook row that the reviewer
   * may drop directly from the UI (via a `{ action: 'exclude' }` decision)
   * without editing the source spreadsheet — e.g. a legacy name that matches no
   * roster student. Excluding moves the row to Excluded and clears the error.
   */
  removableRow?: number;
}

/** An actionable Needs-Review item: a plausible-but-unsafe automatic match. */
export interface ResolveReview {
  rowNumber: number;
  /** The legacy name as written in the workbook. */
  studentName: string;
  reason: string;
  message: string;
  /** Roster students the reviewer may choose. Never pre-selected. */
  candidates: ResolveCandidate[];
  /** Number of scored cells this row would contribute once resolved. */
  scoreCount: number;
}

export interface ResolveResult {
  records: BulkGradeRecord[];
  /** Records that passed every client check. */
  validCount: number;
  /** Number of distinct students contributing valid records. */
  validStudentCount: number;
  errors: ResolveProblem[];
  /**
   * Rows that are plausible but require a human decision (legacy name-only,
   * missing ID with candidates, ambiguous identity). The Review/Confirm step is
   * blocked until this list is empty (every item chosen or excluded).
   */
  reviews: ResolveReview[];
  /** Convenience: reviews.length — the number of unresolved review items. */
  reviewCount: number;
  /** Rows/cells intentionally excluded (no scores, or reviewer-excluded). */
  excludedCount: number;
  /** Subjects present in the workbook that the teacher is not authorized for. */
  unauthorizedSubjects: string[];
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function subjectAliases(name: string): string[] {
  const canonical = normalizeName(name);
  const aliases: Record<string, string[]> = {
    math: ['mathematics'],
    mathematics: ['math'],
    social: ['social studies'],
    'social studies': ['social'],
    tarabiya: ['tarbiya', 'tarbiyah'],
    tarbiya: ['tarabiya', 'tarbiyah'],
    tarbiyah: ['tarbiya', 'tarabiya'],
  };
  return [canonical, ...(aliases[canonical] || [])];
}

/**
 * Resolves a parsed roster workbook against the class context. Student identity
 * is taken from Student ID (authoritative), matched against the current roster.
 * Legacy / name-only rows (no Student ID) are matched by name and routed to
 * Needs Review when a plausible roster candidate exists, or to Errors when none
 * does — never silently accepted.
 */
export function resolveWorkbook(parsed: WorkbookParseResult, context: ResolveContext): ResolveResult {
  const decisions = context.decisions ?? {};
  const errors: ResolveProblem[] = [];
  const records: BulkGradeRecord[] = [];
  const reviews: ResolveReview[] = [];
  const validStudents = new Set<string>();
  let excludedCount = 0;

  // Build subject binding: workbook subject name -> authorized Subject.
  const authorizedByAlias = new Map<string, Subject>();
  for (const subject of context.authorizedSubjects) {
    for (const alias of subjectAliases(subject.name)) authorizedByAlias.set(alias, subject);
  }
  const subjectBinding = new Map<string, Subject | null>();
  const unauthorizedSubjects: string[] = [];
  for (const subjectName of parsed.subjects) {
    let bound: Subject | null = null;
    for (const alias of subjectAliases(subjectName)) {
      const match = authorizedByAlias.get(alias);
      if (match) { bound = match; break; }
    }
    subjectBinding.set(subjectName.toLowerCase(), bound);
    if (!bound) unauthorizedSubjects.push(subjectName);
  }

  // Roster lookups: by exact trimmed Student ID, and by normalized name.
  const rosterById = new Map<string, Student>();
  const rosterByName = new Map<string, Student[]>();
  for (const student of context.roster) {
    rosterById.set(student.id.trim(), student);
    const key = normalizeName(student.name);
    const bucket = rosterByName.get(key);
    if (bucket) bucket.push(student); else rosterByName.set(key, [student]);
  }

  // Emit the normalized records for one resolved student + workbook row. Pushes
  // a subject-authorization error for any unauthorized column. Returns true if
  // the row contributed at least one record.
  function emitRecordsFor(student: Student, row: WorkbookStudentRow): boolean {
    let contributed = false;
    for (const score of row.scores) {
      const subject = subjectBinding.get(score.subjectName.toLowerCase()) ?? null;
      if (!subject) {
        errors.push({
          severity: 'error',
          studentId: student.id,
          studentName: student.name,
          subjectName: score.subjectName,
          rowNumber: row.rowNumber,
          message: `You are not authorized to upload "${score.subjectName}" for ${context.className}.`,
        });
        continue;
      }
      records.push({
        studentId: student.id,
        subjectId: subject.id,
        assessmentLabel: score.assessmentLabel,
        examType: score.examType,
        score: score.score,
        total: score.total,
        entryState: score.entryState,
        month: context.month,
        date: context.date,
        termId: context.termId,
      });
      contributed = true;
    }
    if (contributed) validStudents.add(student.id);
    return contributed;
  }

  for (const row of parsed.students) {
    resolveRow(row);
  }

  function resolveRow(row: WorkbookStudentRow): void {
    if (row.scores.length === 0) {
      excludedCount += 1;
      return;
    }

    // A blank Student ID arrives as null (explicit "identity not resolved").
    // An empty/whitespace string is treated identically. It is NEVER an identity.
    const studentIdRaw = (row.studentId ?? '').trim();

    // ── Rows WITH a Student ID: authoritative identity. ─────────────────────
    if (studentIdRaw) {
      const student = rosterById.get(studentIdRaw) || null;
      if (!student) {
        // Wrong-class / stale-roster / tampering protection (client mirror).
        errors.push({
          severity: 'error',
          studentId: studentIdRaw,
          studentName: row.studentName,
          rowNumber: row.rowNumber,
          message: `Student ID "${studentIdRaw}" (${row.studentName || 'unknown'}) is not currently in ${context.className}. The roster may have changed — re-download the template for this class.`,
        });
        return;
      }
      emitRecordsFor(student, row);
      return;
    }

    // ── Legacy / name-only rows: no Student ID. ─────────────────────────────
    const decision = decisions[row.rowNumber];

    if (decision?.action === 'exclude') {
      excludedCount += 1;
      return;
    }

    if (decision?.action === 'use') {
      const student = rosterById.get(decision.studentId.trim()) || null;
      if (!student) {
        // The chosen student is no longer in the current class (e.g. moved out
        // after selection). Re-running the pipeline turns this into an error;
        // the server would also reject it.
        errors.push({
          severity: 'error',
          studentId: decision.studentId,
          studentName: row.studentName,
          rowNumber: row.rowNumber,
          message: `Row ${row.rowNumber}: the selected student is no longer in ${context.className}. Re-download the template and review again.`,
        });
        return;
      }
      emitRecordsFor(student, row);
      return;
    }

    // No decision yet → attempt a name match to build candidates.
    const candidates = rosterByName.get(normalizeName(row.studentName)) ?? [];
    if (candidates.length === 0) {
      // Definitively unresolvable: no safe candidate to choose. Stays an ERROR.
      errors.push({
        severity: 'error',
        studentName: row.studentName,
        rowNumber: row.rowNumber,
        removableRow: row.rowNumber,
        message: `Row ${row.rowNumber}: No roster student matches legacy name "${row.studentName}". Correct the student name/identity or remove the row.`,
      });
      return;
    }

    const reason = candidates.length === 1
      ? 'could not be safely matched automatically (name-only match)'
      : `could not be safely matched — ${candidates.length} possible students`;
    reviews.push({
      rowNumber: row.rowNumber,
      studentName: row.studentName,
      reason,
      message: `Row ${row.rowNumber}: Student ${row.studentName || '(no name)'} ${reason}. Choose the correct student or exclude the row.`,
      candidates: candidates.map(c => ({ id: c.id, name: c.name, className: c.className })),
      scoreCount: row.scores.length,
    });
  }

  // Duplicate assessment identity within the upload (student+subject+type+label+term).
  // A manually chosen student that collides with another row is caught here too.
  const seen = new Map<string, number>();
  const dedupErrors: ResolveProblem[] = [];
  for (const record of records) {
    // Defensive: `records` only ever contains rows with a concrete, resolved
    // studentId (emitRecordsFor uses student.id). A blank/unresolved identity
    // must never reach dedup — skip it so two name-only rows can never collide
    // on an empty key.
    const resolvedId = (record.studentId ?? '').trim();
    if (!resolvedId) continue;
    const key = [resolvedId, record.subjectId, record.examType, record.assessmentLabel, record.termId].join('|');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const [studentId, , , label] = key.split('|');
      const student = rosterById.get(studentId);
      dedupErrors.push({
        severity: 'error',
        studentId,
        studentName: student?.name,
        message: `Duplicate ${blockDisplayName(label as never)} for ${student?.name || studentId}. Keep one row or correct the student identity; duplicate rows are not automatically chosen.`,
      });
    }
  }

  return {
    records,
    validCount: records.length,
    validStudentCount: validStudents.size,
    errors: [...errors, ...dedupErrors],
    reviews,
    reviewCount: reviews.length,
    excludedCount,
    unauthorizedSubjects,
  };
}
