// Former Students / Student Cleanup — file parsing + the matching contract.
//
// Workflow (mirrors the Student Class Import): upload .csv/.xlsx/.xls → parse
// (no database writes) → the DATABASE matches every row by System ID
// (preview_former_student_import) → admin reviews → explicit confirmation →
// ONE atomic admin-gated RPC (apply_former_student_import).
//
// Everything in this module is pure. Nothing here touches the database, and
// nothing here can decide that a student leaves the school:
//
//   * parseFormerStudentFile()  — reads the uploaded file into rows + issues
//   * evaluateFormerStudentRows() — the SAME contract the SQL implements, used
//     by the no-backend preview client (src/lib/supabase.ts) and by the unit
//     tests. In production the server's answer is authoritative and this is
//     never consulted for a write.
//
// Matching hierarchy (deliberately conservative — never guess):
//   1. System ID  → students.id  (the ONLY match key; exact, case-insensitive)
//   2. Name       → compared for agreement ONLY. A name can never identify a
//                   student and a name match can never deactivate anyone.

import * as XLSX from 'xlsx';
import type { Student } from '../../types';

export const MAX_FORMER_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
/** Matches former_students_policy()->>'maxRows' (the SQL rejects anything larger). */
export const MAX_FORMER_IMPORT_ROWS = 5000;

export type FormerStudentIssueSeverity = 'error' | 'warning';

export type FormerStudentIssueCode =
  | 'EMPTY_FILE'
  | 'NO_HEADER'
  | 'MISSING_NAME_COLUMN'
  | 'MISSING_SYSTEM_ID_COLUMN'
  | 'MISSING_NAME'
  | 'MISSING_SYSTEM_ID'
  | 'NUMERIC_SYSTEM_ID'
  | 'DUPLICATE_SYSTEM_ID'
  | 'DUPLICATE_NAME'
  | 'TOO_MANY_ROWS'
  | 'UNSUPPORTED_FILE';

export interface FormerStudentIssue {
  severity: FormerStudentIssueSeverity;
  code: FormerStudentIssueCode;
  message: string;
  /** 1-based spreadsheet row number (header included); 0 = whole file. */
  row: number;
}

/** One uploaded row, before any database lookup. */
export interface FormerStudentRow {
  rowNumber: number;
  /** Raw cell text, exactly as the file had it. */
  rawName: string;
  rawSystemId: string;
  /** Trimmed values used for matching and display. */
  name: string;
  systemId: string;
  /** Excel stored the System ID as a number — digits may have been lost. */
  numericSystemId: boolean;
}

export interface FormerStudentParseResult {
  rows: FormerStudentRow[];
  issues: FormerStudentIssue[];
  headers: string[];
  mappedHeaders: string[];
  /** Delimiter detected for a CSV file (undefined for workbooks). */
  delimiter?: ',' | ';' | '|' | '\t';
  fileName?: string;
}

const NAME_HEADER_ALIASES = [
  'student name', 'studentname', 'name', 'full name', 'fullname', 'student',
  'student full name', 'names', 'student s name',
];

const SYSTEM_ID_HEADER_ALIASES = [
  'system id', 'systemid', 'system id ', 'student system id', 'student id',
  'studentid', 'id', 'student code', 'studentcode', 'system_id', 'student_id',
];

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Header cells are compared with punctuation/case/whitespace removed. */
function headerKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Escape a header alias for use inside a whole-word RegExp. */
function aliasPattern(alias: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${alias.replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '[^a-z0-9]+')}([^a-z0-9]|$)`);
}

/**
 * Find the column whose header names this field.
 *
 * `exact` matches the normalized header text ("Student Name", "system_id",
 * "SYSTEM ID"). `loose` additionally accepts a decorated header ("Student Name
 * (leavers)") but only on WHOLE words, so a data cell such as "Example Student"
 * or a title line such as "students who left" is never mistaken for a header.
 */
function findHeaderColumn(headerRow: unknown[], aliases: string[], loose = false): number {
  const wanted = aliases.map(a => headerKey(a)).filter(Boolean);
  for (let c = 0; c < headerRow.length; c++) {
    const key = headerKey(headerRow[c]);
    if (key && wanted.includes(key)) return c;
  }
  if (!loose) return -1;
  for (let c = 0; c < headerRow.length; c++) {
    const key = headerKey(headerRow[c]);
    if (!key) continue;
    if (wanted.some(alias => aliasPattern(alias).test(key))) return c;
  }
  return -1;
}

/** Locate the header row: both columns exactly, then both loosely, then one. */
function locateHeaderRow(grid: unknown[][]): { index: number; nameCol: number; idCol: number } | null {
  const limit = Math.min(grid.length, 5);
  for (const loose of [false, true]) {
    for (let i = 0; i < limit; i++) {
      const nameCol = findHeaderColumn(grid[i], NAME_HEADER_ALIASES, loose);
      const idCol = findHeaderColumn(grid[i], SYSTEM_ID_HEADER_ALIASES, loose);
      if (nameCol >= 0 && idCol >= 0) return { index: i, nameCol, idCol };
    }
  }
  // A partial header still counts — but only on an EXACT header spelling, so a
  // data row that merely contains the word "student" is never mistaken for one.
  // This produces a precise column-level error ("no System ID column") instead
  // of silently reading the wrong column positionally.
  for (let i = 0; i < limit; i++) {
    const nameCol = findHeaderColumn(grid[i], NAME_HEADER_ALIASES);
    const idCol = findHeaderColumn(grid[i], SYSTEM_ID_HEADER_ALIASES);
    if (nameCol >= 0 || idCol >= 0) return { index: i, nameCol, idCol };
  }
  return null;
}

/**
 * CSV delimiter sniffing. The school's leaver lists arrive as comma, semicolon
 * or pipe separated text (the feature request itself uses `Name|System ID`), so
 * the delimiter is detected from the header line instead of assumed.
 */
export function detectCsvDelimiter(sample: string): ',' | ';' | '|' | '\t' {
  const line = sample.split(/\r?\n/).find(l => l.trim() !== '') ?? '';
  const candidates: Array<',' | ';' | '|' | '\t'> = [',', ';', '|', '\t'];
  let best: ',' | ';' | '|' | '\t' = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = line.split(c).length - 1;
    if (count > bestCount) { best = c; bestCount = count; }
  }
  return best;
}

/**
 * Parse an uploaded leaver list. Accepts CSV text (any of , ; | tab) or an
 * .xlsx/.xls ArrayBuffer. CSV goes through the same XLSX engine as the
 * transport import, so quoted fields and embedded delimiters are handled by the
 * library rather than a hand-rolled split.
 */
export function parseFormerStudentFile(
  input: string | ArrayBuffer | Uint8Array,
  fileName?: string,
): FormerStudentParseResult {
  const issues: FormerStudentIssue[] = [];
  const isText = typeof input === 'string';

  let workbook: XLSX.WorkBook;
  let delimiter: ',' | ';' | '|' | '\t' | undefined;
  try {
    if (isText) {
      delimiter = detectCsvDelimiter(input);
      workbook = XLSX.read(input, { type: 'string', FS: delimiter, raw: true });
    } else {
      workbook = XLSX.read(input, { type: 'array', raw: true, cellDates: false });
    }
  } catch (err) {
    return {
      rows: [],
      issues: [{
        severity: 'error',
        code: 'UNSUPPORTED_FILE',
        message: err instanceof Error ? err.message : 'This file could not be read. Export it as .csv or .xlsx and try again.',
        row: 0,
      }],
      headers: [],
      mappedHeaders: [],
      delimiter,
      fileName,
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    issues.push({ severity: 'error', code: 'EMPTY_FILE', message: 'The file has no sheets.', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [], delimiter, fileName };
  }
  // blankrows: true keeps the row numbers we report aligned with the
  // spreadsheet the administrator is looking at.
  const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
  const grid = raw.filter(r => Array.isArray(r));
  if (grid.length === 0 || grid.every(r => r.every(cell => text(cell).trim() === ''))) {
    issues.push({ severity: 'error', code: 'EMPTY_FILE', message: 'The file has no rows.', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [], delimiter, fileName };
  }

  // Header row: the first of the first five rows that names BOTH columns
  // (then one that names both loosely, then one that names either).
  const located = locateHeaderRow(grid);

  let nameCol = -1;
  let idCol = -1;
  let headers: string[] = [];
  let firstDataRow = 0;

  if (located) {
    headers = grid[located.index].map(h => text(h)).filter(Boolean);
    nameCol = located.nameCol;
    idCol = located.idCol;
    firstDataRow = located.index + 1;
    if (idCol === -1) {
      // Without a System ID there is nothing this feature may ever apply: a
      // name is never allowed to identify a student. Refuse the file instead of
      // letting the administrator review a list that cannot be committed.
      issues.push({
        severity: 'error', code: 'MISSING_SYSTEM_ID_COLUMN', row: located.index + 1,
        message: 'No "System ID" column was found in the header row. System ID is the only safe match key, so this file cannot be imported.',
      });
      return { rows: [], issues, headers, mappedHeaders: [], delimiter, fileName };
    }
    if (nameCol === -1) {
      // Usable but unverifiable: every row will need an individual review.
      issues.push({
        severity: 'warning', code: 'MISSING_NAME_COLUMN', row: located.index + 1,
        message: 'No "Student Name" column was found — every row will need an individual review because the name cannot be checked.',
      });
    }
  } else {
    // Headerless export: accept the documented column order (Name, System ID)
    // and say so loudly, rather than rejecting a file the school can use.
    nameCol = 0;
    idCol = 1;
    firstDataRow = 0;
    issues.push({
      severity: 'warning', code: 'NO_HEADER', row: 0,
      message: 'No header row was found — column 1 was read as Student Name and column 2 as System ID.',
    });
  }

  const mappedHeaders = [nameCol >= 0 && 'name', idCol >= 0 && 'systemId'].filter(Boolean) as string[];

  const rows: FormerStudentRow[] = [];
  for (let r = firstDataRow; r < grid.length; r++) {
    const rawRow = grid[r];
    const rawName = nameCol >= 0 ? text(rawRow[nameCol]) : '';
    const rawId = idCol >= 0 ? text(rawRow[idCol]) : '';
    const name = rawName.replace(/\s+/g, ' ').trim();
    const systemId = rawId.replace(/\s+/g, ' ').trim();
    // Fully blank line (spreadsheet padding) — skip silently.
    if (name === '' && systemId === '' && rawRow.every(cell => text(cell).trim() === '')) continue;

    const numericSystemId = idCol >= 0 && typeof rawRow[idCol] === 'number';
    if (numericSystemId && systemId !== '') {
      issues.push({
        severity: 'warning', code: 'NUMERIC_SYSTEM_ID', row: r + 1,
        message: `System ID "${systemId}" was stored as a number by Excel — check that no digits were lost.`,
      });
    }
    if (name === '' && systemId !== '') {
      issues.push({ severity: 'warning', code: 'MISSING_NAME', row: r + 1, message: 'This row has a System ID but no student name — it cannot be verified and will not be applied automatically.' });
    }
    if (systemId === '' && name !== '') {
      issues.push({ severity: 'warning', code: 'MISSING_SYSTEM_ID', row: r + 1, message: 'This row has a name but no System ID — names are never used to identify a student, so it will not be applied.' });
    }
    if (name === '' && systemId === '') continue;

    rows.push({ rowNumber: r + 1, rawName, rawSystemId: rawId, name, systemId, numericSystemId });
  }

  // File-level duplicates: reported per row so the admin can see which lines
  // collide. Duplicates never auto-apply (see the SQL contract).
  const idCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  for (const r of rows) {
    if (r.systemId) idCount.set(r.systemId, (idCount.get(r.systemId) ?? 0) + 1);
    const key = normalizeNameKey(r.name);
    if (key) nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  for (const r of rows) {
    if (r.systemId && (idCount.get(r.systemId) ?? 0) > 1) {
      issues.push({
        severity: 'warning', code: 'DUPLICATE_SYSTEM_ID', row: r.rowNumber,
        message: `System ID "${r.systemId}" appears more than once in this file — review before applying.`,
      });
    }
    const key = normalizeNameKey(r.name);
    if (key && (nameCount.get(key) ?? 0) > 1) {
      issues.push({
        severity: 'warning', code: 'DUPLICATE_NAME', row: r.rowNumber,
        message: `The name "${r.name}" appears more than once in this file with different System IDs — review before applying.`,
      });
    }
  }

  if (rows.length > MAX_FORMER_IMPORT_ROWS) {
    issues.push({
      severity: 'error', code: 'TOO_MANY_ROWS', row: 0,
      message: `This file has ${rows.length} rows; the safe limit is ${MAX_FORMER_IMPORT_ROWS} per import. Split it into smaller files.`,
    });
  }

  return { rows, issues, headers, mappedHeaders, delimiter, fileName };
}

/** File-quality statistics shown on the preview screen (no database involved). */
export interface FormerStudentFileSummary {
  totalUploaded: number;
  validRecords: number;
  missingNames: number;
  missingSystemIds: number;
  duplicateSystemIds: number;
  duplicateNames: number;
  errors: number;
  warnings: number;
}

export function summarizeFormerStudentFile(
  rows: FormerStudentRow[],
  issues: FormerStudentIssue[],
): FormerStudentFileSummary {
  const idCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  for (const r of rows) {
    if (r.systemId) idCount.set(r.systemId, (idCount.get(r.systemId) ?? 0) + 1);
    const key = normalizeNameKey(r.name);
    if (key) nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  let duplicateSystemIds = 0;
  let duplicateNames = 0;
  let missingNames = 0;
  let missingSystemIds = 0;
  let validRecords = 0;
  for (const r of rows) {
    if (!r.name) missingNames += 1;
    if (!r.systemId) missingSystemIds += 1;
    if (r.systemId && (idCount.get(r.systemId) ?? 0) > 1) duplicateSystemIds += 1;
    const key = normalizeNameKey(r.name);
    if (key && (nameCount.get(key) ?? 0) > 1) duplicateNames += 1;
    if (r.name && r.systemId) validRecords += 1;
  }
  return {
    totalUploaded: rows.length,
    validRecords,
    missingNames,
    missingSystemIds,
    duplicateSystemIds,
    duplicateNames,
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
  };
}

// ── The matching contract (pure mirror of _former_evaluate_rows in SQL) ─────

export type FormerStudentMatchStatus =
  | 'exact_match'
  | 'id_match_name_conflict'
  | 'possible_duplicate'
  | 'requires_review'
  | 'not_found'
  | 'already_former';

export type FormerStudentNameMatch = 'exact' | 'normalized' | 'different' | 'missing' | null;

export type FormerStudentReasonCode =
  | 'missing_system_id'
  | 'missing_name'
  | 'duplicate_system_id_in_file'
  | 'duplicate_name_in_file'
  | 'system_id_not_found'
  | 'multiple_database_matches'
  | 'name_unverified'
  | 'name_case_or_space_difference'
  | 'name_differs'
  | 'name_very_different'
  | 'already_former';

export interface FormerStudentEvaluation {
  rowNumber: number;
  uploadedName: string;
  uploadedSystemId: string;
  matchedStudentId: string | null;
  databaseName: string | null;
  databaseSystemId: string | null;
  className: string | null;
  databaseStatus: 'active' | 'former' | null;
  databaseTransport: string | null;
  matchStatus: FormerStudentMatchStatus;
  nameMatch: FormerStudentNameMatch;
  nameSimilarity: number | null;
  reasons: FormerStudentReasonCode[];
  autoSafe: boolean;
  requiresReview: boolean;
  blocked: boolean;
  defaultAction: 'deactivate' | 'review' | 'none';
  requestedAction: 'deactivate' | 'keep_active' | 'review';
  adminConfirmed: boolean;
}

export interface FormerStudentEvaluationResult {
  summary: {
    totalUploaded: number;
    validRecords: number;
    missingNames: number;
    missingSystemIds: number;
    duplicateSystemIds: number;
    duplicateNames: number;
    foundInDatabase: number;
    notFoundInDatabase: number;
    exactMatches: number;
    nameConflicts: number;
    possibleDuplicates: number;
    requiresReviewStatus: number;
    alreadyFormer: number;
    requiresReview: number;
    readyToDeactivate: number;
    noAction: number;
    blocked: number;
  };
  rows: FormerStudentEvaluation[];
}

/** Case/space normalization — comparison only, never a match key. */
export function normalizeNameKey(name: unknown): string {
  return String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Formatting-insensitive variant of normalizeNameKey: punctuation AND spacing
 * are ignored, so "Cabdi-raxmaan" and "Cabdi raxmaan" agree. It is only ever
 * used to compare two names for a student the System ID already identified.
 */
export function normalizeNameKeyLoose(name: unknown): string {
  return normalizeNameKey(name).replace(/[^a-z0-9]/g, '');
}

/**
 * Token Jaccard similarity in [0,1]. Used ONLY to size the warning shown to the
 * admin ("very different" vs "slightly different"); it can never make a match.
 * Mirrors public._former_name_similarity() in SQL.
 */
export function nameSimilarity(a: unknown, b: unknown): number {
  const tokensA = new Set(normalizeNameKey(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeNameKey(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection += 1;
  const union = new Set([...tokensA, ...tokensB]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 1000) / 1000;
}

/** System IDs are matched exactly, ignoring case and surrounding spaces. */
export function systemIdKey(systemId: unknown): string {
  return String(systemId ?? '').trim().toUpperCase();
}

/** A row an admin can select without reading a warning. */
export function isAutoSafeEvaluation(row: FormerStudentEvaluation): boolean {
  return row.autoSafe;
}

/**
 * The pure evaluation contract. Identical rules to
 * public._former_evaluate_rows() in 20261008_former_students_cleanup.sql:
 * the SQL function is what production runs, this is what the no-backend preview
 * client runs and what the unit tests assert against.
 */
export function evaluateFormerStudentRows(
  rows: Array<{ rowNumber?: number; name: string; systemId: string; action?: string; adminConfirmed?: boolean }>,
  students: Pick<Student, 'id' | 'name' | 'className' | 'status' | 'transport'>[],
): FormerStudentEvaluationResult {
  const byId = new Map<string, typeof students>();
  for (const s of students) {
    const key = systemIdKey(s.id);
    if (!key) continue;
    byId.set(key, [...(byId.get(key) ?? []), s]);
  }

  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const r of rows) {
    const id = String(r.systemId ?? '').trim();
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    const key = normalizeNameKey(r.name);
    if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const summary = {
    totalUploaded: 0, validRecords: 0, missingNames: 0, missingSystemIds: 0,
    duplicateSystemIds: 0, duplicateNames: 0, foundInDatabase: 0, notFoundInDatabase: 0,
    exactMatches: 0, nameConflicts: 0, possibleDuplicates: 0, requiresReviewStatus: 0,
    alreadyFormer: 0, requiresReview: 0, readyToDeactivate: 0, noAction: 0, blocked: 0,
  };
  const out: FormerStudentEvaluation[] = [];

  for (const r of rows) {
    summary.totalUploaded += 1;
    const name = String(r.name ?? '').trim();
    const systemId = String(r.systemId ?? '').trim();
    const requested = (['deactivate', 'keep_active', 'review'].includes(String(r.action ?? ''))
      ? String(r.action) : 'review') as FormerStudentEvaluation['requestedAction'];
    const adminConfirmed = Boolean(r.adminConfirmed);
    const reasons: FormerStudentReasonCode[] = [];
    let needsReview = false;
    let blocked = false;
    let matchStatus: FormerStudentMatchStatus = 'requires_review';
    let nameMatch: FormerStudentNameMatch = null;
    let similarity: number | null = null;
    let matched: (typeof students)[number] | null = null;

    if (systemId === '') {
      summary.missingSystemIds += 1;
      reasons.push('missing_system_id');
      blocked = true;
      matchStatus = 'requires_review';
    }
    if (name === '') {
      summary.missingNames += 1;
      reasons.push('missing_name');
      needsReview = true;
    }

    const idDupe = systemId !== '' && (idCounts.get(systemId) ?? 0) > 1;
    const nameKey = normalizeNameKey(name);
    const nameDupe = nameKey !== '' && (nameCounts.get(nameKey) ?? 0) > 1;
    if (idDupe) {
      summary.duplicateSystemIds += 1;
      reasons.push('duplicate_system_id_in_file');
      needsReview = true;
    }
    if (nameDupe) {
      summary.duplicateNames += 1;
      reasons.push('duplicate_name_in_file');
      needsReview = true;
    }

    if (systemId !== '') {
      const candidates = byId.get(systemIdKey(systemId)) ?? [];
      if (candidates.length === 0) {
        summary.notFoundInDatabase += 1;
        reasons.push('system_id_not_found');
        matchStatus = 'not_found';
        blocked = true;
      } else if (candidates.length > 1) {
        reasons.push('multiple_database_matches');
        matchStatus = 'requires_review';
        blocked = true;
      } else {
        matched = candidates[0];
        summary.foundInDatabase += 1;
        const dbName = String(matched.name ?? '');
        const dbStatus = (matched.status ?? 'active') as 'active' | 'former';
        similarity = nameSimilarity(name, dbName);
        if (name === '' || dbName.trim() === '') {
          nameMatch = 'missing';
          reasons.push('name_unverified');
          needsReview = true;
          matchStatus = 'requires_review';
        } else if (name === dbName) {
          nameMatch = 'exact';
          matchStatus = 'exact_match';
        } else if (
          normalizeNameKey(name) === normalizeNameKey(dbName)
          || normalizeNameKeyLoose(name) === normalizeNameKeyLoose(dbName)
        ) {
          nameMatch = 'normalized';
          reasons.push('name_case_or_space_difference');
          matchStatus = 'exact_match';
        } else {
          nameMatch = 'different';
          reasons.push('name_differs');
          if ((similarity ?? 0) < 0.5) reasons.push('name_very_different');
          needsReview = true;
          matchStatus = 'id_match_name_conflict';
        }

        if (dbStatus === 'former') {
          matchStatus = 'already_former';
          reasons.push('already_former');
        }
      }
    }

    if ((idDupe || nameDupe) && (matchStatus === 'exact_match' || matchStatus === 'id_match_name_conflict')) {
      matchStatus = 'possible_duplicate';
      needsReview = true;
    }

    const autoSafe = matchStatus === 'exact_match' && !needsReview && !blocked;
    const defaultAction: FormerStudentEvaluation['defaultAction'] = blocked || matchStatus === 'already_former'
      ? 'none'
      : autoSafe ? 'deactivate' : 'review';

    switch (matchStatus) {
      case 'exact_match': summary.exactMatches += 1; break;
      case 'id_match_name_conflict': summary.nameConflicts += 1; break;
      case 'possible_duplicate': summary.possibleDuplicates += 1; break;
      case 'already_former': summary.alreadyFormer += 1; break;
      case 'requires_review': summary.requiresReviewStatus += 1; break;
      default: break;
    }
    if (defaultAction === 'deactivate') summary.readyToDeactivate += 1;
    if (defaultAction === 'review') summary.requiresReview += 1;
    if (defaultAction === 'none') summary.noAction += 1;
    if (blocked) summary.blocked += 1;
    if (name !== '' && systemId !== '') summary.validRecords += 1;

    out.push({
      rowNumber: Number(r.rowNumber ?? 0),
      uploadedName: name,
      uploadedSystemId: systemId,
      matchedStudentId: matched?.id ?? null,
      databaseName: matched?.name ?? null,
      databaseSystemId: matched?.id ?? null,
      className: matched?.className ?? null,
      databaseStatus: matched ? ((matched.status ?? 'active') as 'active' | 'former') : null,
      databaseTransport: matched?.transport ?? null,
      matchStatus,
      nameMatch,
      nameSimilarity: similarity,
      reasons,
      autoSafe,
      requiresReview: needsReview,
      blocked,
      defaultAction,
      requestedAction: requested,
      adminConfirmed,
    });
  }

  return { summary, rows: out };
}

/** The rows "Select All Safe Matches" is allowed to select — never more. */
export function selectAllSafeRowNumbers(rows: FormerStudentEvaluation[]): number[] {
  return rows.filter(r => r.autoSafe && r.databaseStatus !== 'former').map(r => r.rowNumber);
}

/**
 * Can this row be applied at all? The server enforces the same rule; the client
 * uses it to keep a checkbox from offering something that will be refused.
 */
export function canRequestDeactivation(row: FormerStudentEvaluation): boolean {
  if (row.blocked) return false;
  if (row.matchStatus === 'not_found' || row.matchStatus === 'already_former') return false;
  if (!row.matchedStudentId) return false;
  // A review row may still be deactivated, but only with an explicit
  // per-row confirmation from the administrator.
  return true;
}

/** Rows that need a typed, per-row confirmation before they can be applied. */
export function requiresExplicitConfirmation(row: FormerStudentEvaluation): boolean {
  return row.requiresReview && !row.blocked && row.matchStatus !== 'already_former';
}

// ── Template ────────────────────────────────────────────────────────────────
export const FORMER_STUDENT_TEMPLATE_COLUMNS = ['Student Name', 'System ID'] as const;

/** Downloadable .xlsx starter so the school never has to guess the columns. */
export function buildFormerStudentTemplate(students: Pick<Student, 'id' | 'name'>[] = []): Blob {
  const data: Array<Record<string, string>> = students.length > 0
    ? students.map(s => ({ 'Student Name': s.name, 'System ID': s.id }))
    : [
        { 'Student Name': 'Example Student', 'System ID': 'student-123456' },
        { 'Student Name': 'Another Student', 'System ID': 'student-789012' },
      ];
  const sheet = XLSX.utils.json_to_sheet(data, { header: [...FORMER_STUDENT_TEMPLATE_COLUMNS] });
  sheet['!cols'] = [{ wch: 34 }, { wch: 30 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Former Students');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** The same template as CSV text (for "copy this into Excel" instructions). */
export function buildFormerStudentCsvExample(): string {
  return [
    'Student Name,System ID',
    'Example Student,student-123456',
    'Another Student,student-789012',
  ].join('\n');
}

/** True when the browser should send the file as text (CSV) rather than bytes. */
export function isCsvFileName(fileName: string): boolean {
  return /\.(csv|txt|tsv)$/i.test(fileName);
}

export function isSupportedFormerStudentFile(fileName: string): boolean {
  return /\.(csv|txt|tsv|xlsx|xlsm|xls)$/i.test(fileName);
}
