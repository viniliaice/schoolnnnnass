// Roster-prefilled, class-specific grade workbook.
//
// The workbook generated here is the main improvement of the redesign:
//   * exactly ONE class worksheet, prefilled with that class's current roster
//   * only the subjects the teacher selected (which are only the subjects the
//     teacher is authorized to teach in that class)
//   * only the assessment blocks the teacher selected
//   * Student ID / Student Name prefilled so the teacher never types an ID
//
// The workbook is SELF-DESCRIBING: every grade column header is
// "<Subject> <Block>" (e.g. "Arabic HW1", "Tarbiya Akhlaaq"), so Akhlaaq stays
// tied to its subject and the parser never infers a column from its position.
//
// The workbook is NEVER trusted. The server (submit_bulk_grades) independently
// re-validates the student's current class, teacher/class/subject assignment,
// score ranges, term, month, and date. This file is a convenience layer only.

import * as XLSX from 'xlsx';
import {
  ASSESSMENT_BLOCKS,
  blockDisplayName,
  orderBlocks,
  type AssessmentBlock,
} from './assessments';
import { interpretScoreCell, type AssessmentLabel } from '../excel-parser';
import type { Student, Subject } from '../../types';

export const GRADES_SHEET_NAME = 'Grades';
export const INSTRUCTIONS_SHEET_NAME = 'Instructions';

const STUDENT_ID_HEADER = 'Student ID';
const STUDENT_NAME_HEADER = 'Student Name';

// Header token → canonical assessment label. Tokens are matched
// case-insensitively after collapsing whitespace, so "attendance", "att",
// "Akhlaaq", "MT" all resolve.
const BLOCK_TOKEN_TO_LABEL = new Map<string, AssessmentLabel>();
for (const block of ASSESSMENT_BLOCKS) {
  BLOCK_TOKEN_TO_LABEL.set(block.label.toLowerCase(), block.label);
  BLOCK_TOKEN_TO_LABEL.set(blockDisplayName(block.label).toLowerCase(), block.label);
}
BLOCK_TOKEN_TO_LABEL.set('att', 'ATTENDANCE');

export interface BuildWorkbookOptions {
  className: string;
  /** Subjects to include, in the order they should appear. */
  subjects: Subject[];
  /** Assessment blocks to include (any order — normalized to sheet order). */
  blocks: AssessmentLabel[];
  /** Current roster for the class, already authorized/filtered by the caller. */
  roster: Student[];
  /** Context echoed into the Instructions sheet (never trusted at upload). */
  termName?: string;
  month?: string;
  assessmentDate?: string;
}

export interface GradeColumn {
  subjectName: string;
  block: AssessmentBlock;
  /** Column header text, e.g. "Arabic HW1". */
  header: string;
}

/** Builds the "<Subject> <Block>" column list for the selected subjects/blocks. */
export function buildGradeColumns(subjectNames: string[], blocks: AssessmentLabel[]): GradeColumn[] {
  const orderedBlocks = orderBlocks(blocks);
  const columns: GradeColumn[] = [];
  for (const subjectName of subjectNames) {
    for (const block of orderedBlocks) {
      columns.push({
        subjectName,
        block,
        header: `${subjectName} ${blockDisplayName(block.label)}`,
      });
    }
  }
  return columns;
}

export function safeFileSegment(value: string): string {
  // Spaces become underscores; existing hyphens (e.g. "5-A") are preserved.
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]+/gi, '')
    .replace(/^[_-]+|[_-]+$/g, '') || 'class';
}

/** e.g. "Grade_5-A_Arabic_Tarbiya_Grades.xlsx" */
export function workbookFileName(className: string, subjectNames: string[]): string {
  const classSegment = safeFileSegment(className);
  const subjectSegment = subjectNames.map(safeFileSegment).join('_') || 'Subjects';
  return `${classSegment}_${subjectSegment}_Grades.xlsx`;
}

function buildInstructionsSheet(options: BuildWorkbookOptions, columns: GradeColumn[]): XLSX.WorkSheet {
  const blockList = orderBlocks(options.blocks);
  const lines: string[][] = [
    ['MBK International School — Bulk Grade Upload'],
    [''],
    ['Class', options.className],
    ['Subjects', options.subjects.map(s => s.name).join(', ')],
    ['Assessment blocks', blockList.map(b => `${blockDisplayName(b.label)} (max ${b.total})`).join(', ')],
    ['Term', options.termName || '—'],
    ['Month', options.month || '—'],
    ['Assessment date', options.assessmentDate || '—'],
    ['Students in roster', String(options.roster.length)],
    [''],
    ['Maximum scores'],
    ...blockList.map(b => [`  ${blockDisplayName(b.label)}`, `/ ${b.total}`]),
    [''],
    ['How to enter grades'],
    ['  1. Open the "Grades" sheet.'],
    ['  2. Each student already has a Student ID and Student Name. Do NOT edit them.'],
    ['  3. Enter a whole number in each grade cell, within the maximum shown in the header.'],
    ['  4. Leave a cell BLANK if there is no grade yet — blank is never treated as zero.'],
    ['  5. Type "Absent" if the student was absent, or "N/A" if the assessment does not apply.'],
    ['  6. Do not add, remove, rename, or reorder columns.'],
    ['  7. Do not add students or rows — the roster is fixed for this class.'],
    [''],
    ['What you must NOT change'],
    ['  • Student ID and Student Name columns'],
    ['  • Column headers (subject + assessment)'],
    ['  • The sheet name'],
    ['  Any tampering is detected and rejected by the server at upload time.'],
    [''],
    ['How to upload'],
    ['  Return to Bulk Upload Grades → step 4 (Upload) and select this file.'],
    ['  Your grades are validated before anything is saved, and you confirm the'],
    ['  summary before any grade is written.'],
    [''],
    [`Columns in this workbook: ${columns.length} grade column(s).`],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(lines);
  sheet['!cols'] = [{ wch: 28 }, { wch: 48 }];
  return sheet;
}

/**
 * Generates the workbook bytes. Pure — returns an ArrayBuffer so the same code
 * can be unit-tested and reused by the browser (which triggers the download).
 */
export function buildRosterWorkbook(options: BuildWorkbookOptions): ArrayBuffer {
  const subjectNames = options.subjects.map(s => s.name);
  const columns = buildGradeColumns(subjectNames, options.blocks);
  if (columns.length === 0) throw new Error('Select at least one subject and one assessment block.');

  const headerRow = [STUDENT_ID_HEADER, STUDENT_NAME_HEADER, ...columns.map(c => c.header)];
  const dataRows = options.roster.map(student => {
    const row: (string | number)[] = [student.id, student.name];
    for (let i = 0; i < columns.length; i++) row.push('');
    return row;
  });

  const gradesSheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  gradesSheet['!cols'] = [
    { wch: 14 },
    { wch: 26 },
    ...columns.map(() => ({ wch: Math.max(10, 0) + 12 })),
  ];

  // Advisory read-only protection for the identity columns. The community xlsx
  // build does not always persist cell protection, so this is a hint only —
  // the SERVER is the authoritative guard against edited IDs/rosters.
  gradesSheet['!protect'] = { selectLockedCells: true, selectUnlockedCells: true } as XLSX.WorkSheet['!protect'];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildInstructionsSheet(options, columns), INSTRUCTIONS_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, gradesSheet, GRADES_SHEET_NAME);

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Parser for the self-describing roster workbook.
// ---------------------------------------------------------------------------

export type WorkbookIssueCode =
  | 'EMPTY_WORKBOOK'
  | 'MISSING_HEADER'
  | 'NO_GRADE_COLUMNS'
  | 'UNKNOWN_COLUMN'
  | 'DUPLICATE_STUDENT_ROW'
  | 'MISSING_STUDENT_ID'
  | 'INVALID_SCORE';

export interface WorkbookIssue {
  severity: 'error' | 'warning';
  code: WorkbookIssueCode;
  message: string;
  cell?: string;
  row?: number;
}

export interface WorkbookScore {
  subjectName: string;
  assessmentLabel: AssessmentLabel;
  examType: AssessmentBlock['examType'];
  total: number;
  score: number | null;
  entryState: 'scored' | 'absent' | 'not_applicable';
  cell: string;
}

export interface WorkbookStudentRow {
  rowNumber: number;
  studentId: string;
  studentName: string;
  scores: WorkbookScore[];
}

export interface WorkbookParseColumn {
  subjectName: string;
  block: AssessmentBlock;
  columnIndex: number;
}

export interface WorkbookParseResult {
  className?: string;
  subjects: string[];
  columns: WorkbookParseColumn[];
  students: WorkbookStudentRow[];
  studentCount: number;
  totalEntered: number;
  issues: WorkbookIssue[];
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function normalizeHeader(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parses a "<Subject> <Block>" header into subject name + assessment block.
 * The block token is always the LAST whitespace-delimited token, so multi-word
 * subject names ("Social Studies") are preserved.
 */
export function parseGradeColumnHeader(header: unknown): { subjectName: string; block: AssessmentBlock } | null {
  const raw = text(header);
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return null;
  const token = parts[parts.length - 1].toLowerCase();
  const label = BLOCK_TOKEN_TO_LABEL.get(token);
  if (!label) return null;
  const block = ASSESSMENT_BLOCKS.find(b => b.label === label);
  if (!block) return null;
  const subjectName = parts.slice(0, -1).join(' ').trim();
  if (!subjectName) return null;
  return { subjectName, block };
}

function isStudentIdHeader(value: unknown): boolean {
  const v = normalizeHeader(value);
  return v === 'student id' || v === 'studentid';
}

function isStudentNameHeader(value: unknown): boolean {
  const v = normalizeHeader(value);
  return v === 'student name' || v === 'studentname' || v === 'name';
}

function cellAddress(rowIndex: number, columnIndex: number): string {
  return XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
}

/**
 * Detects whether the workbook is in the new self-describing roster format.
 * Used by the UI to choose between this parser and the legacy fixed-block
 * parser without guessing.
 */
export function isRosterWorkbook(file: ArrayBuffer): boolean {
  try {
    const wb = XLSX.read(file, { type: 'array', cellDates: false });
    const sheetName = wb.SheetNames.includes(GRADES_SHEET_NAME)
      ? GRADES_SHEET_NAME
      : wb.SheetNames.find(name => name !== INSTRUCTIONS_SHEET_NAME) || wb.SheetNames[0];
    if (!sheetName) return false;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const headerIdx = rows.findIndex(row => row.some(isStudentNameHeader) && row.some(isStudentIdHeader));
    if (headerIdx < 0) return false;
    const headerRow = rows[headerIdx];
    return headerRow.some(cell => parseGradeColumnHeader(cell) != null);
  } catch {
    return false;
  }
}

export function parseRosterWorkbook(file: ArrayBuffer): WorkbookParseResult {
  const issues: WorkbookIssue[] = [];
  const empty: WorkbookParseResult = { subjects: [], columns: [], students: [], studentCount: 0, totalEntered: 0, issues };

  const wb = XLSX.read(file, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames.includes(GRADES_SHEET_NAME)
    ? GRADES_SHEET_NAME
    : wb.SheetNames.find(name => name !== INSTRUCTIONS_SHEET_NAME) || wb.SheetNames[0];
  if (!sheetName) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'This workbook has no worksheets.' });
    return empty;
  }
  const className = sheetName === GRADES_SHEET_NAME ? undefined : sheetName;

  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  if (rows.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'This workbook is empty.' });
    return empty;
  }

  const headerIdx = rows.findIndex(row => row.some(isStudentNameHeader));
  if (headerIdx < 0) {
    issues.push({ severity: 'error', code: 'MISSING_HEADER', message: 'Could not find the required "Student Name" header row.' });
    return empty;
  }
  const headerRow = rows[headerIdx] || [];
  const idColumn = headerRow.findIndex(isStudentIdHeader);
  const nameColumn = headerRow.findIndex(isStudentNameHeader);
  if (idColumn < 0) {
    issues.push({ severity: 'error', code: 'MISSING_HEADER', message: 'The workbook must contain a "Student ID" column. Please re-download the template for this class.' });
    return empty;
  }

  const columns: WorkbookParseColumn[] = [];
  const subjects: string[] = [];
  const seenColumnKeys = new Set<string>();
  for (let c = 0; c < headerRow.length; c++) {
    if (c === idColumn || c === nameColumn) continue;
    const value = headerRow[c];
    if (text(value) === '') continue;
    const parsed = parseGradeColumnHeader(value);
    if (!parsed) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_COLUMN',
        message: `Column header "${text(value)}" is not a recognized "<Subject> <Assessment>" column. Do not rename or add columns.`,
        cell: cellAddress(headerIdx, c),
        row: headerIdx + 1,
      });
      continue;
    }
    const key = `${parsed.subjectName.toLowerCase()}|${parsed.block.label}`;
    if (seenColumnKeys.has(key)) {
      issues.push({
        severity: 'error',
        code: 'UNKNOWN_COLUMN',
        message: `Duplicate column "${text(value)}". Each subject/assessment may appear only once.`,
        cell: cellAddress(headerIdx, c),
        row: headerIdx + 1,
      });
      continue;
    }
    seenColumnKeys.add(key);
    columns.push({ subjectName: parsed.subjectName, block: parsed.block, columnIndex: c });
    if (!subjects.some(s => s.toLowerCase() === parsed.subjectName.toLowerCase())) subjects.push(parsed.subjectName);
  }

  if (columns.length === 0) {
    issues.push({ severity: 'error', code: 'NO_GRADE_COLUMNS', message: 'No valid subject/assessment columns were found.' });
    return { ...empty, columns, subjects };
  }

  const students: WorkbookStudentRow[] = [];
  const seenIds = new Map<string, number>();
  let totalEntered = 0;

  // Collect the scored cells for one worksheet row (shared by ID rows and
  // legacy name-only rows). Invalid cells still surface a blocking parse error.
  const collectScores = (r: number, row: unknown[]): WorkbookScore[] => {
    const scores: WorkbookScore[] = [];
    for (const column of columns) {
      const outcome = interpretScoreCell(row[column.columnIndex], column.block.total);
      const cell = cellAddress(r, column.columnIndex);
      if (outcome.kind === 'blank') continue;
      if (outcome.kind === 'invalid') {
        issues.push({
          severity: 'error',
          code: 'INVALID_SCORE',
          message: outcome.reason === 'not_integer'
            ? `${column.subjectName} ${blockDisplayName(column.block.label)} must be a whole number from 0 to ${column.block.total}, Absent, N/A, or blank.`
            : `${column.subjectName} ${blockDisplayName(column.block.label)} cannot exceed ${column.block.total}.`,
          cell,
          row: r + 1,
        });
        continue;
      }
      scores.push({
        subjectName: column.subjectName,
        assessmentLabel: column.block.label,
        examType: column.block.examType,
        total: column.block.total,
        score: outcome.kind === 'scored' ? outcome.score : null,
        entryState: outcome.kind === 'scored' ? 'scored' : outcome.kind,
        cell,
      });
      totalEntered += 1;
    }
    return scores;
  };

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const studentId = text(row[idColumn]);
    const studentName = text(row[nameColumn]);
    if (!studentId && !studentName) continue;
    if (!studentId) {
      // A row with a name but no Student ID is a legacy / manually-edited
      // identity. Rather than silently dropping its scores, surface it to the
      // resolver (studentId = '') so it can attempt a name match and route the
      // row to Needs Review (human-resolvable) or Errors (no candidate). This
      // is a warning, not a blocking parse error: the roster-prefilled template
      // always includes IDs, so this only fires for legacy/edited workbooks.
      issues.push({
        severity: 'warning',
        code: 'MISSING_STUDENT_ID',
        message: `Row ${r + 1} ("${studentName}") has no Student ID and needs manual review to match a student.`,
        cell: cellAddress(r, idColumn),
        row: r + 1,
      });
      const scores = collectScores(r, row);
      students.push({ rowNumber: r + 1, studentId: '', studentName, scores });
      continue;
    }
    const previous = seenIds.get(studentId);
    if (previous != null) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_STUDENT_ROW',
        message: `Student ID "${studentId}" appears more than once (rows ${previous + 1} and ${r + 1}).`,
        cell: cellAddress(r, idColumn),
        row: r + 1,
      });
      continue;
    }
    seenIds.set(studentId, r);

    const scores = collectScores(r, row);
    students.push({ rowNumber: r + 1, studentId, studentName, scores });
  }

  return { className, subjects, columns, students, studentCount: students.length, totalEntered, issues };
}
