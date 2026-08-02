import * as XLSX from 'xlsx';
import type { ExamType } from '../types';

/**
 * The production grade sheet has one fixed, validated 11-column assessment
 * block for every subject. A score is identified by its slot, not just by the
 * broad exam type: HW1 and HW2 are distinct records.
 */
export const ASSESSMENT_DEFINITIONS = [
  { assessmentLabel: 'HW1', examType: 'Homework', total: 5, aliases: ['hw1', 'hw1 5'] },
  { assessmentLabel: 'HW2', examType: 'Homework', total: 5, aliases: ['hw2', 'hw2 5'] },
  { assessmentLabel: 'HW3', examType: 'Homework', total: 5, aliases: ['hw3', 'hw3 5'] },
  { assessmentLabel: 'HW4', examType: 'Homework', total: 5, aliases: ['hw4', 'hw4 5'] },
  { assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, aliases: ['cpw1', 'cpw1 15'] },
  { assessmentLabel: 'CPW2', examType: 'Classwork', total: 15, aliases: ['cpw2', 'cpw2 15'] },
  { assessmentLabel: 'CPW3', examType: 'Classwork', total: 15, aliases: ['cpw3', 'cpw3 15'] },
  { assessmentLabel: 'CPW4', examType: 'Classwork', total: 15, aliases: ['cpw4', 'cpw4 15'] },
  { assessmentLabel: 'ATTENDANCE', examType: 'Attendance', total: 20, aliases: ['att', 'att 20', 'attendance', 'attendance 20'] },
  { assessmentLabel: 'MT', examType: 'Quiz', total: 20, aliases: ['mt', 'mt 20', 'quiz', 'quiz 20', 'monthly test', 'monthly test 20', '20'] },
  { assessmentLabel: 'AKHLAAQ', examType: 'Discipline', total: 10, aliases: ['akhlaaq', 'akhlaaq 10', 'discipline', 'discipline 10', '10'] },
] as const satisfies ReadonlyArray<{
  assessmentLabel: string;
  examType: ExamType;
  total: number;
  aliases: readonly string[];
}>;

export type AssessmentLabel = typeof ASSESSMENT_DEFINITIONS[number]['assessmentLabel'];
export type EntryState = 'scored' | 'absent' | 'not_applicable';
export type ParseIssueSeverity = 'error' | 'warning';

export interface ParseIssue {
  severity: ParseIssueSeverity;
  code:
    | 'EMPTY_WORKBOOK'
    | 'MISSING_HEADER'
    | 'INVALID_TEMPLATE'
    | 'UNKNOWN_COLUMN'
    | 'MISSING_SUBJECT'
    | 'DUPLICATE_SUBJECT'
    | 'INVALID_SCORE'
    | 'EMPTY_SUBJECT_BLOCK'
    | 'MISSING_STUDENT_ID';
  message: string;
  cell?: string;
  row?: number;
  column?: number;
  subjectName?: string;
}

export interface ParsedAssessmentColumn {
  subjectName: string;
  assessmentLabel: AssessmentLabel;
  examType: ExamType;
  total: number;
  columnIndex: number;
  columnLetter: string;
}

export interface ParsedScore {
  subjectName: string;
  assessmentLabel: AssessmentLabel;
  examType: ExamType;
  score: number | null;
  total: number;
  entryState: EntryState;
  cell: string;
}

export interface ParsedStudentRow {
  rowNumber: number;
  studentId: string | null;
  studentName: string;
  scores: ParsedScore[];
}

export interface ParseResult {
  subjects: string[];
  columns: ParsedAssessmentColumn[];
  students: ParsedStudentRow[];
  studentCount: number;
  totalExams: number;
  issues: ParseIssue[];
  usesLegacyNameIdentity: boolean;
}

const BLOCK_SIZE = ASSESSMENT_DEFINITIONS.length;
const ABSENT_MARKERS = new Set(['absent']);
const NOT_APPLICABLE_MARKERS = new Set(['n/a', 'na', 'not applicable']);
const LEGACY_EMPTY_MARKERS = new Set(['', '-']);

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function normalize(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function cellAddress(rowIndex: number, columnIndex: number): string {
  return XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
}

function expandMergedCells(sheet: XLSX.WorkSheet, rows: unknown[][]): unknown[][] {
  const expanded = rows.map(row => [...row]);
  for (const merge of sheet['!merges'] || []) {
    const value = expanded[merge.s.r]?.[merge.s.c];
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      expanded[r] = expanded[r] || [];
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (expanded[r][c] == null || text(expanded[r][c]) === '') expanded[r][c] = value;
      }
    }
  }
  return expanded;
}

function isStudentIdHeader(value: unknown): boolean {
  const v = normalize(value);
  return v === 'student id' || v === 'studentid' || v === 'admission number' || v === 'admission no' || v === 'admission no.';
}

function isStudentNameHeader(value: unknown): boolean {
  const v = normalize(value);
  return v === 'student name' || v === 'studentname' || v === 'name';
}

function isAssessmentAlias(value: unknown, definition: typeof ASSESSMENT_DEFINITIONS[number]): boolean {
  const normalized = normalize(value);
  if (definition.aliases.some(alias => alias === normalized)) return true;

  // A legacy production header may place only the maximum (20 / 10) in the
  // MT/Akhlaaq row-two cells. Numeric-only labels are valid only for those
  // two exact positions and are still checked against their hard cap.
  if ((definition.assessmentLabel === 'MT' || definition.assessmentLabel === 'AKHLAAQ') && normalized === String(definition.total)) {
    return true;
  }

  return false;
}

function headerMentionsWrongMaximum(value: unknown, definition: typeof ASSESSMENT_DEFINITIONS[number]): boolean {
  const normalized = normalize(value);

  // HW1/CPW1 contain their ordinal as a number, so only a trailing numeric
  // maximum after whitespace is interpreted as an explicit maximum.
  const explicitMax = normalized.match(/(?:^|\s)(\d+)$/)?.[1];
  if (!explicitMax) return false;
  const max = Number(explicitMax);
  if (definition.assessmentLabel === 'MT' || definition.assessmentLabel === 'AKHLAAQ') return max !== definition.total;
  return max !== Number(definition.assessmentLabel.replace(/\D/g, '')) && max !== definition.total;
}

function isSubjectMetadata(value: unknown): boolean {
  const v = normalize(value);
  return !v || v === 'mt' || v === 'akhlaaq' || v === 'discipline' || v === '20' || v === '10' || v.includes('=') || v.includes('homework') || v.includes('class participation');
}

function findSubjectSequenceStart(subjectRow: unknown[]): number {
  for (let c = 0; c < subjectRow.length; c++) {
    if (!isSubjectMetadata(subjectRow[c])) return c;
  }
  return -1;
}

function parseScore(raw: unknown, column: ParsedAssessmentColumn, rowIndex: number, issues: ParseIssue[]): ParsedScore | null {
  const value = text(raw);
  if (LEGACY_EMPTY_MARKERS.has(normalize(value))) return null;

  const normalized = normalize(value);
  if (ABSENT_MARKERS.has(normalized)) {
    return { ...column, score: null, entryState: 'absent', cell: cellAddress(rowIndex, column.columnIndex) };
  }
  if (NOT_APPLICABLE_MARKERS.has(normalized)) {
    return { ...column, score: null, entryState: 'not_applicable', cell: cellAddress(rowIndex, column.columnIndex) };
  }

  // Scores are stored as INTEGER. Full-string validation intentionally rejects
  // decimal values and parseFloat-style partial values such as "5oops".
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_SCORE',
      message: `${column.subjectName} ${column.assessmentLabel} must be a whole number from 0 to ${column.total}, Absent, N/A, or blank.`,
      cell: cellAddress(rowIndex, column.columnIndex),
      row: rowIndex + 1,
      column: column.columnIndex + 1,
      subjectName: column.subjectName,
    });
    return null;
  }

  const score = Number(value);
  if (!Number.isSafeInteger(score) || score < 0 || score > column.total) {
    issues.push({
      severity: 'error',
      code: 'INVALID_SCORE',
      message: `${column.subjectName} ${column.assessmentLabel} cannot exceed ${column.total}.`,
      cell: cellAddress(rowIndex, column.columnIndex),
      row: rowIndex + 1,
      column: column.columnIndex + 1,
      subjectName: column.subjectName,
    });
    return null;
  }

  return { ...column, score, entryState: 'scored', cell: cellAddress(rowIndex, column.columnIndex) };
}

/**
 * Parses the school's fixed 11-column-per-subject production sheet. The
 * assessment header is validated at every position; the parser never infers
 * an exam type from an unchecked column offset.
 */
export function parseExcel(file: ArrayBuffer): ParseResult {
  const wb = XLSX.read(file, { type: 'array', cellDates: false });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) throw new Error('This workbook has no worksheets.');

  const sheet = wb.Sheets[firstSheetName];
  const sourceRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  if (sourceRows.length === 0) {
    return { subjects: [], columns: [], students: [], studentCount: 0, totalExams: 0, issues: [{ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'This workbook is empty.' }], usesLegacyNameIdentity: false };
  }

  const rows = expandMergedCells(sheet, sourceRows);
  const issues: ParseIssue[] = [];
  const headerIdx = rows.findIndex(row => row.some(isStudentNameHeader));
  if (headerIdx < 1) {
    return {
      subjects: [], columns: [], students: [], studentCount: 0, totalExams: 0,
      issues: [{ severity: 'error', code: 'MISSING_HEADER', message: 'Could not find the required "Student Name" header row.' }],
      usesLegacyNameIdentity: false,
    };
  }

  const headerRow = rows[headerIdx] || [];
  const subjectRow = rows[headerIdx - 1] || [];
  const studentNameColumn = headerRow.findIndex(isStudentNameHeader);
  const studentIdColumn = headerRow.findIndex(isStudentIdHeader);
  const gradeStart = Math.max(studentNameColumn, studentIdColumn) + 1;
  const lastHeaderColumn = Math.max(
    headerRow.map((v, index) => text(v) ? index : -1).reduce((a, b) => Math.max(a, b), -1),
    gradeStart - 1,
  );

  if (studentNameColumn < 0 || gradeStart <= 0 || lastHeaderColumn < gradeStart) {
    issues.push({ severity: 'error', code: 'INVALID_TEMPLATE', message: 'The template must contain Student ID (recommended), Student Name, and at least one complete subject block.' });
    return { subjects: [], columns: [], students: [], studentCount: 0, totalExams: 0, issues, usesLegacyNameIdentity: studentIdColumn < 0 };
  }

  const gradeColumnCount = lastHeaderColumn - gradeStart + 1;
  if (gradeColumnCount % BLOCK_SIZE !== 0) {
    issues.push({
      severity: 'error',
      code: 'INVALID_TEMPLATE',
      message: `Expected complete ${BLOCK_SIZE}-column subject blocks after Student Name, but found ${gradeColumnCount} grade columns.`,
      cell: cellAddress(headerIdx, lastHeaderColumn),
      row: headerIdx + 1,
      column: lastHeaderColumn + 1,
    });
  }

  const blockCount = Math.floor(gradeColumnCount / BLOCK_SIZE);
  const subjectSequenceStart = findSubjectSequenceStart(subjectRow);
  if (subjectSequenceStart < 0) {
    issues.push({ severity: 'error', code: 'MISSING_SUBJECT', message: 'Could not identify subject names in the row above the assessment headers.' });
  }

  const columns: ParsedAssessmentColumn[] = [];
  const subjects: string[] = [];
  for (let block = 0; block < blockCount; block++) {
    const baseColumn = gradeStart + block * BLOCK_SIZE;
    const subjectName = text(subjectRow[subjectSequenceStart + block * BLOCK_SIZE]);
    if (!subjectName || isSubjectMetadata(subjectName)) {
      issues.push({
        severity: 'error', code: 'MISSING_SUBJECT',
        message: `Could not identify the subject for assessment block ${block + 1}.`,
        cell: cellAddress(headerIdx - 1, baseColumn), row: headerIdx, column: baseColumn + 1,
      });
      continue;
    }
    if (subjects.some(existing => normalize(existing) === normalize(subjectName))) {
      issues.push({ severity: 'error', code: 'DUPLICATE_SUBJECT', message: `The subject "${subjectName}" appears more than once in the upload template.`, cell: cellAddress(headerIdx - 1, baseColumn), row: headerIdx, column: baseColumn + 1, subjectName });
      continue;
    }
    subjects.push(subjectName);

    ASSESSMENT_DEFINITIONS.forEach((definition, offset) => {
      const columnIndex = baseColumn + offset;
      const headerValue = headerRow[columnIndex];
      if (!isAssessmentAlias(headerValue, definition) || headerMentionsWrongMaximum(headerValue, definition)) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_COLUMN',
          message: `Expected ${definition.assessmentLabel} (maximum ${definition.total}) for ${subjectName}, but found "${text(headerValue) || 'blank'}".`,
          cell: cellAddress(headerIdx, columnIndex), row: headerIdx + 1, column: columnIndex + 1, subjectName,
        });
      }
      columns.push({ subjectName, assessmentLabel: definition.assessmentLabel, examType: definition.examType, total: definition.total, columnIndex, columnLetter: XLSX.utils.encode_col(columnIndex) });
    });
  }

  const usesLegacyNameIdentity = studentIdColumn < 0;
  if (usesLegacyNameIdentity) {
    issues.push({ severity: 'warning', code: 'MISSING_STUDENT_ID', message: 'This legacy file has no Student ID column. Exact unique names may be matched automatically; any non-exact match requires manual confirmation.' });
  }

  const students: ParsedStudentRow[] = [];
  const seenStudentIds = new Map<string, number>();
  for (let rowIndex = headerIdx + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const studentId = studentIdColumn >= 0 ? text(row[studentIdColumn]) || null : null;
    const studentName = text(row[studentNameColumn]);
    if (!studentId && !studentName) continue;

    if (studentId) {
      const originalRow = seenStudentIds.get(studentId);
      if (originalRow != null) {
        issues.push({ severity: 'error', code: 'INVALID_TEMPLATE', message: `Student ID "${studentId}" is duplicated (also used on row ${originalRow + 1}).`, cell: cellAddress(rowIndex, studentIdColumn), row: rowIndex + 1, column: studentIdColumn + 1 });
      } else {
        seenStudentIds.set(studentId, rowIndex);
      }
    }

    const scores = columns
      .map(column => parseScore(row[column.columnIndex], column, rowIndex, issues))
      .filter((score): score is ParsedScore => score !== null);
    students.push({ rowNumber: rowIndex + 1, studentId, studentName, scores });
  }

  if (students.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'No student rows were found below the header.' });
  }

  for (const subjectName of subjects) {
    if (students.length > 0 && !students.some(student => student.scores.some(score => normalize(score.subjectName) === normalize(subjectName)))) {
      issues.push({
        severity: 'error',
        code: 'EMPTY_SUBJECT_BLOCK',
        message: `${subjectName} has an entirely blank subject block. It is treated as incomplete; remove the subject block if it does not apply, or enter/mark the assessments before submission.`,
        subjectName,
      });
    }
  }

  const totalExams = students.reduce((sum, student) => sum + student.scores.length, 0);
  return { subjects, columns, students, studentCount: students.length, totalExams, issues, usesLegacyNameIdentity };
}
