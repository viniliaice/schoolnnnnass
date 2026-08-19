// Transport-sheet import for the family-ID feature.
//
// Parses the Google Sheets student export (CSV text or .xlsx) using the
// already-installed `xlsx` library — same approach as src/lib/excel-parser.ts
// (header-name mapping + ParseIssue-style flags), tuned for the real MBK sheet:
//
//   number | Gov-id | Bus | Grade | Name | SECOND NUMBER | STATUS | books |
//   August..May (fees) | D-Left | Bsd | NBSD | Column 22 | Column 23 | new | NB ...
//
// Tolerances built in:
//   - Gov-id may be quoted ("22-992343"), prefixed (15-015405), or empty
//   - Bus values: NB / nb / 0 / empty → WALKER; numbers → bus; LEFT → left;
//     anything else → unknown (flagged)
//   - Summary/noise rows like "0 students, 0 free" are skipped
//   - Column order and extra columns are ignored — mapping is by header name
//
// Matching against existing students is name-first (normalized), with the
// mapped class code as a secondary disambiguator; ambiguity is flagged, never
// silently resolved.

import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import { mapSheetClassCode, normalizeName, normalizePhone, normalizeTransport, parseTransportCell, type ParsedTransport } from '../transport';

const LOG = '[family-ids]';

export type ImportMatchStatus = 'matched' | 'ambiguous' | 'unmatched';

/** Which sheet-bucket a row's Bus cell belongs to (drives apply filters). */
export type ImportBucket = 'nb' | 'empty' | 'bus' | 'other';

const NB_MARKERS = new Set(['nb', 'n/b', 'no bus', '0', '-']);

/** Classify the raw Bus cell so the admin can apply only a subset of rows. */
export function bucketOf(raw: string): ImportBucket {
  const v = raw.trim().toLowerCase();
  if (v === '') return 'empty';
  if (NB_MARKERS.has(v)) return 'nb';
  if (/^\d+$/.test(v)) return 'bus';
  return 'other';
}

export interface TransportImportRow {
  rowNumber: number;
  name: string;
  gradeCode: string;
  appClass: string | null;
  govId: string;
  secondNumber: string;
  status: string;
  transport: ParsedTransport;
  /** Raw Bus cell text, kept for bucket filtering (NB vs empty vs number). */
  busRaw: string;
  issues: ImportIssue[];
  /** Set by matchImportRows. */
  match: ImportMatchStatus;
  studentId: string | null;
  /**
   * The transport currently stored for the matched student, so the preview can
   * warn before a re-import overwrites a manual correction. Normalized, so a
   * blank stored value compares as WALKER rather than looking like a change.
   */
  currentTransport?: string | null;
  classMismatch: boolean;
}

export interface ImportIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  row: number;
}

export interface TransportImportResult {
  rows: TransportImportRow[];
  issues: ImportIssue[];
  /** Header names found (for debugging/verification). */
  headers: string[];
  /** Headers we mapped to known fields. */
  mappedHeaders: string[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  govId: ['gov-id', 'govid', 'gov id', 'gov', 'govid', 'id', 'admission number', 'admission no'],
  bus: ['bus', 'bus no', 'busno', 'bus number', 'transport'],
  grade: ['grade', 'class', 'form', 'section'],
  name: ['name', 'student name', 'studentname', 'student'],
  secondNumber: ['second number', 'secondnumber', 'second', 'second no', 'phone', 'phone 2', 'contact'],
  status: ['status'],
};

const NOISE_NAME_PATTERN = /^\d+\s*students?,?\s*\d+\s*free/i;

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function headerKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findHeaderColumn(headerRow: unknown[], aliases: string[]): number {
  const aliasSet = new Set(aliases.map(a => a.replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()));
  for (let c = 0; c < headerRow.length; c++) {
    const key = headerKey(headerRow[c]);
    if (key && aliasSet.has(key)) return c;
  }
  return -1;
}

function isNoiseRow(row: unknown[]): boolean {
  const name = text(row[0]);
  if (!name) return true;
  if (NOISE_NAME_PATTERN.test(name)) return true;
  // Rows where the Name cell contains a summary like "0 students, 0 free" in
  // later columns (the real sheet has these in merged footer cells).
  return row.some(cell => typeof cell === 'string' && NOISE_NAME_PATTERN.test(cell));
}

/**
 * Parse a CSV string or .xlsx ArrayBuffer. CSV text goes through the same
 * XLSX engine, so quoted fields, embedded commas, and tabs are handled by the
 * library rather than a hand-rolled split.
 */
export function parseTransportImport(input: string | ArrayBuffer): TransportImportResult {
  const workbook = typeof input === 'string'
    ? XLSX.read(input, { type: 'string' })
    : XLSX.read(input, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], issues: [], headers: [], mappedHeaders: [] };

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });

  const issues: ImportIssue[] = [];
  if (rows.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_SHEET', message: 'The file has no rows.', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [] };
  }

  // Header row: first row that contains a recognizable header name.
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    if (row.some(cell => headerKey(cell) === 'name' || headerKey(cell) === 'gov-id' || headerKey(cell) === 'bus' || headerKey(cell) === 'second number')) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    issues.push({ severity: 'error', code: 'NO_HEADER', message: 'No header row found (expected Name, Bus, Grade, Gov-id, SECOND NUMBER columns).', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [] };
  }

  const headerRow = rows[headerIndex];
  const headers = headerRow.map(h => text(h)).filter(Boolean);
  const cols = {
    govId: findHeaderColumn(headerRow, HEADER_ALIASES.govId),
    bus: findHeaderColumn(headerRow, HEADER_ALIASES.bus),
    grade: findHeaderColumn(headerRow, HEADER_ALIASES.grade),
    name: findHeaderColumn(headerRow, HEADER_ALIASES.name),
    secondNumber: findHeaderColumn(headerRow, HEADER_ALIASES.secondNumber),
    status: findHeaderColumn(headerRow, HEADER_ALIASES.status),
  };
  const mappedHeaders = [
    cols.govId >= 0 && 'govId', cols.bus >= 0 && 'bus', cols.grade >= 0 && 'grade',
    cols.name >= 0 && 'name', cols.secondNumber >= 0 && 'secondNumber', cols.status >= 0 && 'status',
  ].filter(Boolean) as string[];

  if (cols.name === -1) {
    issues.push({ severity: 'error', code: 'NO_NAME_COLUMN', message: 'Could not find a Name column in the header row.', row: headerIndex + 1 });
    return { rows: [], issues, headers, mappedHeaders };
  }

  const out: TransportImportRow[] = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const rawRow = rows[r];
    const name = text(rawRow[cols.name]);
    if (!name || isNoiseRow(rawRow)) continue;

    const gradeCode = cols.grade >= 0 ? text(rawRow[cols.grade]) : '';
    const govId = cols.govId >= 0 ? text(rawRow[cols.govId]).replace(/^"|"$/g, '') : '';
    const busRaw = cols.bus >= 0 ? text(rawRow[cols.bus]) : '';
    const secondNumber = cols.secondNumber >= 0 ? text(rawRow[cols.secondNumber]) : '';
    const status = cols.status >= 0 ? text(rawRow[cols.status]) : '';
    const transport = parseTransportCell(busRaw);
    const appClass = gradeCode ? mapSheetClassCode(gradeCode) : null;

    const rowIssues: ImportIssue[] = [];
    if (transport.kind === 'unknown') {
      rowIssues.push({ severity: 'warning', code: 'UNKNOWN_TRANSPORT', message: `Bus value "${busRaw}" is not recognized (expected a bus number, NB, or empty).`, row: r + 1 });
    }
    if (transport.kind === 'left') {
      rowIssues.push({ severity: 'warning', code: 'STUDENT_LEFT', message: 'STATUS/Bus says LEFT — this student may have left the school. Review before assigning an ID.', row: r + 1 });
    }
    if (gradeCode && !appClass) {
      rowIssues.push({ severity: 'warning', code: 'UNMAPPED_CLASS', message: `Grade code "${gradeCode}" is not mapped to an app class yet — matching uses name only.`, row: r + 1 });
    }

    out.push({
      rowNumber: r + 1,
      name,
      gradeCode,
      appClass,
      govId,
      secondNumber,
      status,
      transport,
      busRaw,
      issues: rowIssues,
      match: 'unmatched',
      studentId: null,
      classMismatch: false,
    });
  }

  issues.push(...out.flatMap(row => row.issues));
  console.log(`${LOG} parsed sheet`, {
    sheet: sheetName,
    headers,
    mappedHeaders,
    rowCount: out.length,
    issues: {
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
    },
  });
  return { rows: out, issues, headers, mappedHeaders };
}

/**
 * Match import rows to existing students. Name-first (normalized): exactly
 * one candidate → matched. Multiple candidates → disambiguate by mapped class
 * code; if that still doesn't narrow to one, flag ambiguous. None → unmatched.
 */
export function matchImportRows(rows: TransportImportRow[], students: Student[]): TransportImportRow[] {
  const byName = new Map<string, Student[]>();
  for (const student of students) {
    const key = normalizeName(student.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(student);
    byName.set(key, list);
  }

  for (const row of rows) {
    const candidates = byName.get(normalizeName(row.name)) ?? [];
    if (candidates.length === 0) {
      row.match = 'unmatched';
      console.log(`${LOG} match`, { row: row.rowNumber, name: row.name, match: 'unmatched', reason: 'no student with that name' });
      continue;
    }
    if (candidates.length === 1) {
      row.match = 'matched';
      row.studentId = candidates[0].id;
      row.currentTransport = candidates[0].transport ?? null;
      row.classMismatch = !!row.appClass && candidates[0].className !== row.appClass;
      console.log(`${LOG} match`, { row: row.rowNumber, name: row.name, match: 'matched', studentId: row.studentId, classMismatch: row.classMismatch });
      continue;
    }
    const byClass = row.appClass
      ? candidates.filter(c => c.className === row.appClass)
      : [];
    if (byClass.length === 1) {
      row.match = 'matched';
      row.studentId = byClass[0].id;
      row.currentTransport = byClass[0].transport ?? null;
      row.classMismatch = false;
      console.log(`${LOG} match`, { row: row.rowNumber, name: row.name, match: 'matched', studentId: row.studentId, via: 'class' });
      continue;
    }
    row.match = 'ambiguous';
    row.studentId = null;
    console.log(`${LOG} match`, { row: row.rowNumber, name: row.name, match: 'ambiguous', candidates: candidates.length, byClass: byClass.length });
  }
  return rows;
}

/** Summary counts for the import UI. */
/**
 * Rows where applying the sheet would CHANGE a value already stored.
 *
 * The import intentionally lets the sheet win (set_student_import_fields does
 * `transport = COALESCE(v_transport, transport)`), which means re-importing an
 * old sheet silently reverts a manual correction made in the app. Rather than
 * add an imported-vs-override column to the table, we surface the collisions
 * in the preview so staff can deselect the bucket before applying.
 *
 * Comparison is on NORMALIZED values, so blank-vs-WALKER is not a false alarm.
 */
export function transportOverwrites(rows: TransportImportRow[]): TransportImportRow[] {
  return rows.filter(row => {
    if (row.match !== 'matched') return false;
    if (row.transport.kind === 'left' || row.transport.kind === 'unknown') return false;
    if (row.currentTransport === undefined) return false;
    return normalizeTransport(row.currentTransport) !== normalizeTransport(row.transport.value);
  });
}

export function summarizeImport(rows: TransportImportRow[]) {
  const matched = rows.filter(r => r.match === 'matched');
  const ambiguous = rows.filter(r => r.match === 'ambiguous');
  const unmatched = rows.filter(r => r.match === 'unmatched');
  const walkers = matched.filter(r => r.transport.kind === 'walker');
  const bus = matched.filter(r => r.transport.kind === 'bus');
  return { matched: matched.length, ambiguous: ambiguous.length, unmatched: unmatched.length, walkers: walkers.length, bus: bus.length, total: rows.length };
}

export { normalizePhone, parseTransportCell };
