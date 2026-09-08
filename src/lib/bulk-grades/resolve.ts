// Client-side resolution + validation for the class-specific bulk upload.
//
// This is a PURE function: it takes the parsed roster workbook plus the class
// context (authorized subjects, current roster, term/month/date) and produces
//   * the normalized BulkGradeRecord[] to send to submit_bulk_grades
//   * per-category counts (valid / errors / needs review / excluded)
//   * human-readable problems
//
// It mirrors the server's authorization checks so the teacher gets fast,
// specific feedback — but the server (submit_bulk_grades) remains authoritative
// and re-checks everything. Nothing here is trusted by the database.

import type { BulkGradeRecord } from '../db/bulkGrades';
import type { WorkbookParseResult, WorkbookStudentRow } from './workbook';
import { blockDisplayName } from './assessments';
import type { Student, Subject } from '../../types';

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
}

export interface ResolveProblem {
  severity: 'error';
  message: string;
  studentId?: string;
  studentName?: string;
  subjectName?: string;
  rowNumber?: number;
}

export interface ResolveResult {
  records: BulkGradeRecord[];
  /** Records that passed every client check. */
  validCount: number;
  /** Number of distinct students contributing valid records. */
  validStudentCount: number;
  // Note: there is intentionally no separate "needs review" category. Every
  // uncertain record in this architecture is either a hard error (unauthorized
  // subject, student not in the current roster, duplicate identity) or is
  // excluded (no scores entered). A permanently-empty category would be
  // misleading, so it was removed rather than left dead.
  errors: ResolveProblem[];
  /** Rows/cells intentionally excluded (e.g. no scores entered). */
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
 * is taken ONLY from Student ID (never name/row/position), matched against the
 * current roster — so a stale workbook whose student has since moved classes is
 * flagged rather than silently accepted.
 */
export function resolveWorkbook(parsed: WorkbookParseResult, context: ResolveContext): ResolveResult {
  const errors: ResolveProblem[] = [];
  const records: BulkGradeRecord[] = [];
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

  // Roster lookup by exact trimmed Student ID (authoritative identity).
  const rosterById = new Map<string, Student>();
  for (const student of context.roster) rosterById.set(student.id.trim(), student);

  for (const row of parsed.students) {
    resolveRow(row);
  }

  function resolveRow(row: WorkbookStudentRow): void {
    const studentIdRaw = row.studentId.trim();
    const student = rosterById.get(studentIdRaw) || null;

    if (row.scores.length === 0) {
      excludedCount += 1;
      return;
    }

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

    let rowContributed = false;
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
      rowContributed = true;
    }
    if (rowContributed) validStudents.add(student.id);
  }

  // Duplicate assessment identity within the upload (student+subject+type+label+term).
  const seen = new Map<string, number>();
  const dedupErrors: ResolveProblem[] = [];
  for (const record of records) {
    const key = [record.studentId, record.subjectId, record.examType, record.assessmentLabel, record.termId].join('|');
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
        message: `Duplicate ${blockDisplayName(label as never)} for ${student?.name || studentId}. Keep one value per assessment.`,
      });
    }
  }

  return {
    records,
    validCount: records.length,
    validStudentCount: validStudents.size,
    errors: [...errors, ...dedupErrors],
    excludedCount,
    unauthorizedSubjects,
  };
}
