// Class-specific Bulk Upload Grades workbook.
//
// The generated workbook is intentionally SIMPLE for teachers:
//   * exactly ONE flat header row on the Grades sheet
//   * visible columns are "Student Name" + "<UPPERCASE SUBJECT> <Assessment>"
//   * only the subjects the teacher is authorized to upload for that class
//   * only the assessment blocks the teacher selected
//   * score cells stay blank until the teacher enters values
//
// A hidden metadata sheet preserves roster Student IDs for the downloaded
// example so unchanged rows still resolve immediately, even though the visible
// sheet shows only "Student Name". If a teacher pastes a different roster or
// uploads a workbook with no metadata, parsing safely falls back to the
// existing name-based Needs-Review workflow.
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
import { orderSubjectNames, workbookSubjectHeader, workbookSubjectName } from './subjectOrder';
import { interpretScoreCell, type AssessmentLabel } from '../excel-parser';
import type { Student, Subject } from '../../types';

export const GRADES_SHEET_NAME = 'Grades';
export const INSTRUCTIONS_SHEET_NAME = 'Instructions';
export const ROSTER_METADATA_SHEET_NAME = '__RosterMetadata';

const STUDENT_ID_HEADER = 'Student ID';
const STUDENT_NAME_HEADER = 'Student Name';
const METADATA_HEADER = ['Visible Row', STUDENT_ID_HEADER, STUDENT_NAME_HEADER] as const;

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
  /** Canonical/internal subject name, e.g. "English", "Math", "Tarabiya". */
  subjectName: string;
  block: AssessmentBlock;
  /** Column header text, e.g. "ENGLISH HW1". */
  header: string;
}

interface HiddenRosterMetadata {
  rowNumber: number;
  studentId: string;
  studentName: string;
}

/**
 * Builds the flat "<UPPERCASE SUBJECT> <Assessment>" column list for the
 * selected subjects/blocks.
 *
 * This is the single authoritative visible column definition. Both the master
 * SUBJECT order (English → Math → Science → Social → Somali → Arabic →
 * Tarabiya) and the master ASSESSMENT order (HW1..HW4 → CPW1..CPW4 →
 * Attendance → MT → Akhlaaq) are enforced here, so the generated workbook and
 * parser stay aligned no matter what order the caller/database provided the
 * subjects or blocks in.
 *
 * Only the subjects passed in are included: the master order controls
 * PLACEMENT, while the caller's authorization/selection controls MEMBERSHIP.
 */
export function buildGradeColumns(subjectNames: string[], blocks: AssessmentLabel[]): GradeColumn[] {
  const orderedBlocks = orderBlocks(blocks);
  const orderedSubjectNames = orderSubjectNames(subjectNames);
  const columns: GradeColumn[] = [];
  for (const rawSubjectName of orderedSubjectNames) {
    const subjectName = workbookSubjectName(rawSubjectName);
    const visibleSubject = workbookSubjectHeader(rawSubjectName);
    for (const block of orderedBlocks) {
      columns.push({
        subjectName,
        block,
        header: `${visibleSubject} ${blockDisplayName(block.label)}`,
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
  const subjectSegment = orderSubjectNames(subjectNames).map(name => safeFileSegment(workbookSubjectName(name))).join('_') || 'Subjects';
  return `${classSegment}_${subjectSegment}_Grades.xlsx`;
}

function buildInstructionsSheet(options: BuildWorkbookOptions, columns: GradeColumn[]): XLSX.WorkSheet {
  const blockList = orderBlocks(options.blocks);
  const lines: string[][] = [
    ['MBK International School — Bulk Grade Upload'],
    [''],
    ['Class', options.className],
    ['Subjects', orderSubjectNames(options.subjects.map(s => workbookSubjectName(s.name))).join(', ')],
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
    ['  2. Use the single header row: Student Name, then SUBJECT ASSESSMENT columns (for example ENGLISH HW1).'],
    ['  3. Enter a number within the configured maximum for that assessment. Whole numbers and half points are allowed (for example 4, 4.5, 12, 12.5).'],
    ['  4. Leave a cell BLANK if there is no grade yet — blank is never treated as zero.'],
    ['  5. Type "Absent" if the student was absent, or "N/A" if the assessment does not apply.'],
    ['  6. Do not add, remove, rename, or reorder grade columns.'],
    ['  7. Student IDs are not shown on the visible sheet. The downloaded example keeps hidden roster metadata for unchanged rows; a pasted/edited roster is still supported through the existing name-matching review flow.'],
    [''],
    ['What you must NOT change'],
    ['  • The Student Name header'],
    ['  • Grade column headers (subject + assessment only)'],
    ['  • The Grades sheet name'],
    ['  Any tampering is detected and rejected by the server at upload time.'],
    [''],
    ['How to upload'],
    ['  Return to Bulk Upload Grades → step 3 (Upload) and select this file.'],
    ['  Your grades are validated before anything is saved, and you confirm the'],
    ['  summary before any grade is written.'],
    [''],
    [`Columns in this workbook: ${columns.length} grade column(s).`],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(lines);
  sheet['!cols'] = [{ wch: 28 }, { wch: 84 }];
  return sheet;
}

function buildHiddenRosterMetadataSheet(roster: Student[]): XLSX.WorkSheet {
  const rows: (string | number)[][] = [Array.from(METADATA_HEADER)];
  roster.forEach((student, index) => {
    rows.push([index + 2, student.id, student.name]);
  });
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 32 }];
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

  const headerRow = [STUDENT_NAME_HEADER, ...columns.map(c => c.header)];
  const dataRows = options.roster.map(student => {
    const row: (string | number)[] = [student.name];
    for (let i = 0; i < columns.length; i++) row.push('');
    return row;
  });

  const gradesSheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  gradesSheet['!cols'] = [
    { wch: 32 },
    ...columns.map(() => ({ wch: 18 })),
  ];

  // The sheet is intentionally left FULLY EDITABLE (no '!protect'): teachers
  // need to freely copy/paste grades from their own spreadsheets, and sheet
  // protection made Excel open the file in read-only/protected mode. The SERVER
  // remains the authoritative guard against edited rosters at upload time.

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildInstructionsSheet(options, columns), INSTRUCTIONS_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, gradesSheet, GRADES_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, buildHiddenRosterMetadataSheet(options.roster), ROSTER_METADATA_SHEET_NAME);
  workbook.Workbook = workbook.Workbook || {};
  workbook.Workbook.Sheets = workbook.SheetNames.map(name => ({
    name,
    Hidden: name === ROSTER_METADATA_SHEET_NAME ? 2 : 0,
  }));

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Parser for the flat-header roster workbook.
// ---------------------------------------------------------------------------

export type WorkbookIssueCode =
  | 'EMPTY_WORKBOOK'
  | 'MISSING_HEADER'
  | 'NO_GRADE_COLUMNS'
  | 'UNKNOWN_COLUMN'
  | 'UNEXPECTED_COLUMN'
  | 'MISSING_EXPECTED_COLUMN'
  | 'DUPLICATE_COLUMN'
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
  /**
   * Authoritative student identity from a visible Student ID cell, from the
   * hidden roster metadata, or `null` when the workbook carries no safe ID for
   * this row. `null` explicitly means "identity not yet resolved" — it is NEVER
   * a valid identity and must never be used as a duplicate/identity key.
   */
  studentId: string | null;
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

export interface ParseRosterWorkbookOptions {
  expectedSubjects?: string[];
  expectedBlocks?: AssessmentLabel[];
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function normalizeHeader(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function canonicalExpectedHeaders(subjects: string[] | undefined, blocks: AssessmentLabel[] | undefined): string[] {
  if (!subjects?.length || !blocks?.length) return [];
  return buildGradeColumns(subjects, blocks).map(column => column.header);
}

function detectExpectedColumnIssues(
  headerRow: unknown[],
  headerIdx: number,
  idColumn: number,
  nameColumn: number,
  expectedHeaders: string[],
): WorkbookIssue[] {
  if (expectedHeaders.length === 0) return [];

  const issues: WorkbookIssue[] = [];
  const expectedByKey = new Map(expectedHeaders.map(header => [normalizeHeader(header), header]));
  const actualByKey = new Map<string, { header: string; columnIndex: number }>();

  for (let c = 0; c < headerRow.length; c++) {
    if (c === idColumn || c === nameColumn) continue;
    const header = text(headerRow[c]);
    if (!header) continue;
    actualByKey.set(normalizeHeader(header), { header, columnIndex: c });
  }

  for (const expectedHeader of expectedHeaders) {
    if (actualByKey.has(normalizeHeader(expectedHeader))) continue;
    issues.push({
      severity: 'error',
      code: 'MISSING_EXPECTED_COLUMN',
      message: `Missing required grade column "${expectedHeader}". Restore the original template columns or download a fresh Example workbook.`,
      row: headerIdx + 1,
    });
  }

  for (const [key, actual] of actualByKey.entries()) {
    if (expectedByKey.has(key)) continue;
    const parsed = parseGradeColumnHeader(actual.header);
    if (!parsed) continue;
    issues.push({
      severity: 'error',
      code: 'UNEXPECTED_COLUMN',
      message: `Unexpected grade column "${actual.header}" for this upload. Remove added or unauthorized subject/assessment columns and use the exact downloaded template.`,
      cell: cellAddress(headerIdx, actual.columnIndex),
      row: headerIdx + 1,
    });
  }

  return issues;
}

function dataSheetName(workbook: XLSX.WorkBook): string | undefined {
  return workbook.SheetNames.includes(GRADES_SHEET_NAME)
    ? GRADES_SHEET_NAME
    : workbook.SheetNames.find(name => name !== INSTRUCTIONS_SHEET_NAME && name !== ROSTER_METADATA_SHEET_NAME)
      || workbook.SheetNames[0];
}

function readHiddenRosterMetadata(workbook: XLSX.WorkBook): Map<number, HiddenRosterMetadata> {
  const result = new Map<number, HiddenRosterMetadata>();
  const sheet = workbook.Sheets[ROSTER_METADATA_SHEET_NAME];
  if (!sheet) return result;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rowNumber = Number(row[0]);
    const studentId = text(row[1]);
    const studentName = text(row[2]);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || !studentId || !studentName) continue;
    result.set(rowNumber, { rowNumber, studentId, studentName });
  }
  return result;
}

/**
 * Parses a "<Subject> <Block>" header into subject name + assessment block.
 * The block token is always the LAST whitespace-delimited token, so multi-word
 * subject names remain supported.
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
  const subjectName = workbookSubjectName(parts.slice(0, -1).join(' ').trim());
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
 * Detects whether the workbook is in the flat roster format. Used by the UI to
 * choose this parser without guessing.
 */
export function isRosterWorkbook(file: ArrayBuffer): boolean {
  try {
    const wb = XLSX.read(file, { type: 'array', cellDates: false });
    const sheetName = dataSheetName(wb);
    if (!sheetName) return false;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const headerIdx = rows.findIndex(row => row.some(isStudentNameHeader));
    if (headerIdx < 0) return false;
    const headerRow = rows[headerIdx] || [];
    return headerRow.some(cell => parseGradeColumnHeader(cell) != null);
  } catch {
    return false;
  }
}

export function parseRosterWorkbook(file: ArrayBuffer, options: ParseRosterWorkbookOptions = {}): WorkbookParseResult {
  const issues: WorkbookIssue[] = [];
  const empty: WorkbookParseResult = { subjects: [], columns: [], students: [], studentCount: 0, totalEntered: 0, issues };

  const wb = XLSX.read(file, { type: 'array', cellDates: false });
  const sheetName = dataSheetName(wb);
  if (!sheetName) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'This workbook has no worksheets.' });
    return empty;
  }
  const className = sheetName === GRADES_SHEET_NAME ? undefined : sheetName;
  const metadataByRow = readHiddenRosterMetadata(wb);

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
  if (nameColumn < 0) {
    issues.push({ severity: 'error', code: 'MISSING_HEADER', message: 'The workbook must contain a "Student Name" column.' });
    return empty;
  }

  const expectedHeaders = canonicalExpectedHeaders(options.expectedSubjects, options.expectedBlocks);
  issues.push(...detectExpectedColumnIssues(headerRow, headerIdx, idColumn, nameColumn, expectedHeaders));

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
        code: 'DUPLICATE_COLUMN',
        message: `Duplicate grade column "${text(value)}". Each subject/assessment may appear only once.`,
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
          message: outcome.reason === 'not_half_step'
            ? `${column.subjectName} ${blockDisplayName(column.block.label)} must be a number from 0 to ${column.block.total} in whole or half points (e.g. 4 or 4.5), Absent, N/A, or blank.`
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
    const visibleStudentId = idColumn >= 0 ? text(row[idColumn]) : '';
    const studentName = text(row[nameColumn]);
    if (!visibleStudentId && !studentName) continue;

    const metadata = metadataByRow.get(r + 1);
    const metadataMatchesName = Boolean(
      metadata
      && studentName
      && normalizeHeader(metadata.studentName) === normalizeHeader(studentName)
      && metadata.studentId,
    );
    const studentId = visibleStudentId || (metadataMatchesName ? metadata!.studentId : '');

    if (!studentId) {
      issues.push({
        severity: 'warning',
        code: 'MISSING_STUDENT_ID',
        message: `Row ${r + 1} ("${studentName}") has no Student ID and needs manual review to match a student.`,
        cell: cellAddress(r, idColumn >= 0 ? idColumn : nameColumn),
        row: r + 1,
      });
    }

    const concreteStudentId = studentId || null;
    if (concreteStudentId) {
      const previous = seenIds.get(concreteStudentId);
      if (previous != null) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_STUDENT_ROW',
          message: `Student ID "${concreteStudentId}" appears more than once (rows ${previous + 1} and ${r + 1}).`,
          cell: cellAddress(r, idColumn >= 0 ? idColumn : nameColumn),
          row: r + 1,
        });
        continue;
      }
      seenIds.set(concreteStudentId, r);
    }

    const scores = collectScores(r, row);
    students.push({ rowNumber: r + 1, studentId: concreteStudentId, studentName, scores });
  }

  return { className, subjects, columns, students, studentCount: students.length, totalEntered, issues };
}
