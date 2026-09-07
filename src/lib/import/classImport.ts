// Student Class Update & New Student Import — parse / match / classify.
//
// Workflow (see REPORT-student-class-import.md):
//   upload .xlsx → parse (no DB writes) → match & classify (no DB writes)
//   → preview → admin confirms → ONE atomic admin-gated RPC commit
//   (apply_student_class_import).
//
// Everything in this module is pure: it reads the existing students + the
// authoritative class list passed in by the caller and produces a fully
// classified preview. Nothing here touches the database.
//
// Matching hierarchy (deliberately conservative — never guess):
//   1. Student ID column  → students.id            (strongest, exact)
//   2. Gov/admission ID   → students.govId         (must be unique)
//   3. Controlled secondary: exact normalized name + matching parent phone.
//      Name ALONE is never auto-matched: 1 candidate → manual review,
//      >1 candidates → AMBIGUOUS.
//
// A row whose Student ID is not found is NEVER silently turned into a
// duplicate of an existing student: if the name collides with an existing
// student it goes to manual review; only rows with an unknown name become
// NEW STUDENT (carrying the sheet's own ID as their stable student ID).

import * as XLSX from 'xlsx';
import type { Role, Student } from '../../types';
import { mapSheetClassCode, normalizeName, normalizePhone, normalizeTransport } from '../transport';

/**
 * Client-side convenience guard for the import workflow. The real enforcement
 * point is SQL: apply_student_class_import() re-checks the role server-side,
 * so a non-admin can never commit even if this check is bypassed.
 */
export function assertCanImportClasses(role: Role | null | undefined): void {
  if (role !== 'admin') {
    throw new Error('Only administrators can import student class updates.');
  }
}

export type ClassImportIssueSeverity = 'error' | 'warning';

export type ClassImportIssueCode =
  | 'EMPTY_WORKBOOK'
  | 'NO_HEADER'
  | 'MISSING_NAME_COLUMN'
  | 'MISSING_CLASS_COLUMN'
  | 'MISSING_STUDENT_ID'
  | 'MISSING_NAME'
  | 'MISSING_CLASS'
  | 'STUDENT_ID_NOT_FOUND'
  | 'GOV_ID_NOT_UNIQUE'
  | 'NUMERIC_ID'
  | 'INVALID_BUS'
  | 'AMBIGUOUS_MATCH'
  | 'INVALID_CLASS'
  | 'DUPLICATE_STUDENT_ID'
  | 'DUPLICATE_GOV_ID'
  | 'DUPLICATE_ROW'
  | 'CONFLICTING_ROWS';

export interface ClassImportIssue {
  severity: ClassImportIssueSeverity;
  code: ClassImportIssueCode;
  message: string;
  /** 1-based spreadsheet row number (header included), 0 = whole file. */
  row: number;
}

/** A data row as read from the sheet, before any matching. */
export interface RawClassImportRow {
  rowNumber: number;
  studentId: string;
  govId: string;
  name: string;
  rawClass: string;
  /** Every non-blank class-like cell in the row, in column order (the school
   *  sheet can carry both a bare "Grade 3" column and a section "Grade 3-C"). */
  classCandidates: string[];
  parentPhone: string;
  /** Identity cells that Excel stored as a number (digits may be lost). */
  numericStudentId: boolean;
  numericGovId: boolean;
  /** Raw bus/transport cell text (e.g. '9', 'NB', 'WALKER', 'CAR'). */
  rawBus: string;
  /** Canonical transport parsed from the bus cell (bus number | WALKER | CAR | DRIVER); null when the cell was blank. */
  parsedTransport: string | null;
  /** True when the bus cell contains text that is not a valid transport value. */
  invalidBus: boolean;
}

export interface ClassImportParseResult {
  rows: RawClassImportRow[];
  issues: ClassImportIssue[];
  headers: string[];
  mappedHeaders: string[];
}

export type ClassImportStatus =
  | 'class_change' // matched, uploaded class differs from current
  | 'no_change'    // matched, already in the uploaded class
  | 'new_student'  // safely unmatched → will be created
  | 'ambiguous'    // could match >1 student (or a conflicting identifier) — manual review
  | 'unmatched'    // has identifiers but cannot be matched and cannot be safely created
  | 'invalid'      // blocking validation error (bad class, missing required field)
  | 'duplicate';   // duplicated inside the file — never processed twice

export type ClassImportMatchMethod = 'student_id' | 'gov_id' | 'name_phone' | 'manual';

export interface ClassImportCandidate {
  id: string;
  name: string;
  className: string;
}

export interface ClassImportRow extends RawClassImportRow {
  status: ClassImportStatus;
  matchMethod: ClassImportMatchMethod | null;
  /** Existing student this row resolves to (after matching or manual resolve). */
  matchedStudentId: string | null;
  /** Existing student's stored name (for display/duplicate review). */
  existingName: string | null;
  /** Existing student's CURRENT class (before the import). */
  fromClass: string | null;
  /** Resolved canonical target class, or null when unresolvable. */
  toClass: string | null;
  /** Existing student's stored transport (normalized; WALKER when unset). */
  fromTransport: string | null;
  /** Target transport from the sheet (normalized), or null when the bus cell was blank. */
  toTransport: string | null;
  /** For new students without a sheet ID: the generated stable ID. */
  assignedId: string | null;
  /** Admin toggle in the preview: keep this row out of the commit. */
  excluded: boolean;
  issues: ClassImportIssue[];
  candidates: ClassImportCandidate[];
}

export interface ClassImportSummary {
  totalRows: number;
  matched: number;
  classChanges: number;
  noChange: number;
  newStudents: number;
  unmatched: number;
  ambiguous: number;
  invalidRows: number;
  duplicates: number;
  excluded: number;
  /** Rows that will actually be applied on confirm. */
  applicableChanges: number;
  applicableCreates: number;
}

export interface ClassChangeCommit {
  studentId: string;
  toClass: string;
  /** Present only when the sheet provides a bus value that differs from the stored one. */
  transport?: string | null;
}

export interface NewStudentCommit {
  id: string;
  name: string;
  className: string;
  govId: string | null;
  parentPhone: string | null;
  /** Canonical transport (bus number | WALKER | CAR); undefined/null defaults to walker on create. */
  transport?: string | null;
}

export interface ClassImportCommitPayload {
  changes: ClassChangeCommit[];
  newStudents: NewStudentCommit[];
}

// ─── Header mapping ─────────────────────────────────────────────────────────

const HEADER_ALIASES: Record<'studentId' | 'govId' | 'name' | 'class' | 'parentPhone' | 'bus', string[]> = {
  studentId: [
    'student id', 'studentid', 'student code', 'student no', 'student number',
    'admission number', 'admission no', 'admission no.', 'adm no', 'adm number',
  ],
  govId: ['gov id', 'gov-id', 'govid', 'government id', 'govt id', 'national id', 'id'],
  name: ['student name', 'studentname', 'name', 'full name'],
  class: ['current class', 'class', 'class name', 'classname', 'grade', 'section', 'form'],
  parentPhone: ['parent phone', 'parent number', 'phone', 'second number', 'contact'],
  bus: ['bus', 'bus no', 'busno', 'bus number', 'transport'],
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/** Safety limits for the client parse and the server RPC (kept in sync with SQL). */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMPORT_ROWS = 7000; // SQL rejects >5,000 changes / >2,000 creates

function headerKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Canonical transport for a Bus-column cell. Returns:
 *  - null for a BLANK cell (the import must NOT touch stored transport —
 *    blank never means "make them a walker");
 *  - a canonical value for bus number ('9' → '9'), WALKER / CAR / DRIVER,
 *    and the non-bus markers used by the transport sheet ('nb', '0', '-');
 *  - { invalid: true } for free text the DB CHECK would reject (e.g. a route
 *    name). 'LEFT' is not settable from the import — it is a status, not a
 *    mode — so it is reported as invalid rather than marking a student gone.
 */
function parseBusCell(raw: unknown): { value: string | null; invalid: boolean } {
  const rawText = text(raw);
  if (!rawText) return { value: null, invalid: false };

  const upper = rawText.toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper === 'NB' || upper === 'N/B' || upper === 'NO BUS' || upper === 'WALKING'
      || upper === 'WALKER' || upper === '0' || upper === '-') {
    return { value: 'WALKER', invalid: false };
  }
  if (upper === 'CAR') return { value: 'CAR', invalid: false };
  if (upper === 'DRIVER') return { value: 'DRIVER', invalid: false };
  if (/^\d+$/.test(rawText.replace(/\s+/g, ''))) {
    return { value: String(Number(rawText.replace(/\D/g, ''))), invalid: false };
  }
  return { value: null, invalid: true };
}

function findHeaderColumn(headerRow: unknown[], aliases: string[]): number {
  return findHeaderColumns(headerRow, aliases)[0] ?? -1;
}

/** Every column index whose header matches the alias set (in column order). */
function findHeaderColumns(headerRow: unknown[], aliases: string[]): number[] {
  const aliasSet = new Set(aliases.map(a => headerKey(a)));
  const cols: number[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    const key = headerKey(headerRow[c]);
    if (key && aliasSet.has(key)) cols.push(c);
  }
  return cols;
}

/**
 * Parse the uploaded workbook (Google Sheet exported as .xlsx). Mapping is by
 * header name, so column order and extra columns do not matter. Only the
 * first worksheet is read.
 */
export function parseClassImportFile(input: ArrayBuffer): ClassImportParseResult {
  const workbook = XLSX.read(input, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const issues: ClassImportIssue[] = [];
  if (!sheetName) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'The workbook has no worksheets.', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
  if (rows.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'The file has no rows.', row: 0 });
    return { rows: [], issues, headers: [], mappedHeaders: [] };
  }

  // Header row: the first of the top 5 rows containing a known header name.
  const KNOWN = new Set<string>([
    ...HEADER_ALIASES.studentId, ...HEADER_ALIASES.govId,
    ...HEADER_ALIASES.name, ...HEADER_ALIASES.class, ...HEADER_ALIASES.parentPhone,
    ...HEADER_ALIASES.bus,
  ].map(headerKey));
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if ((rows[i] || []).some(cell => KNOWN.has(headerKey(cell)))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) {
    issues.push({
      severity: 'error', code: 'NO_HEADER', row: 0,
      message: 'No header row found. The sheet needs at least a Student Name and a Current Class column (Student ID strongly recommended).',
    });
    return { rows: [], issues, headers: [], mappedHeaders: [] };
  }

  const headerRow = rows[headerIndex] || [];
  const headers = headerRow.map(h => text(h)).filter(Boolean);
  const classCols = findHeaderColumns(headerRow, HEADER_ALIASES.class);
  const cols = {
    studentId: findHeaderColumn(headerRow, HEADER_ALIASES.studentId),
    govId: findHeaderColumn(headerRow, HEADER_ALIASES.govId),
    name: findHeaderColumn(headerRow, HEADER_ALIASES.name),
    class: classCols[0] ?? -1,
    parentPhone: findHeaderColumn(headerRow, HEADER_ALIASES.parentPhone),
    bus: findHeaderColumn(headerRow, HEADER_ALIASES.bus),
  };
  const mappedHeaders = (Object.keys(cols) as Array<keyof typeof cols>)
    .filter(k => cols[k] >= 0);

  if (cols.name === -1) {
    issues.push({ severity: 'error', code: 'MISSING_NAME_COLUMN', row: headerIndex + 1, message: 'Could not find a Student Name column in the header row.' });
  }
  if (cols.class === -1) {
    issues.push({ severity: 'error', code: 'MISSING_CLASS_COLUMN', row: headerIndex + 1, message: 'Could not find a Current Class / Grade column in the header row.' });
  }
  if (cols.studentId === -1 && cols.govId === -1) {
    issues.push({
      severity: 'warning', code: 'MISSING_STUDENT_ID', row: headerIndex + 1,
      message: 'No Student ID or Gov ID column found. Rows can only be matched by name + parent phone; everything else goes to manual review.',
    });
  }
  if (cols.name === -1 || cols.class === -1) {
    return { rows: [], issues, headers, mappedHeaders };
  }

  const out: RawClassImportRow[] = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const raw = rows[r] || [];
    // Detect identity cells Excel stored as numbers. String(number) silently
    // loses precision past 15 digits and drops leading zeros, which can turn a
    // real student into a false "new student" — so we flag the row and require
    // the official, text-formatted template instead of guessing.
    const rawStudentId = cols.studentId >= 0 ? raw[cols.studentId] : '';
    const rawGovId = cols.govId >= 0 ? raw[cols.govId] : '';
    const numericStudentId = typeof rawStudentId === 'number' && Number.isFinite(rawStudentId);
    const numericGovId = typeof rawGovId === 'number' && Number.isFinite(rawGovId);

    const studentId = cols.studentId >= 0 ? text(rawStudentId) : '';
    const govId = cols.govId >= 0 ? text(rawGovId).replace(/^"|"$/g, '') : '';
    const name = cols.name >= 0 ? text(raw[cols.name]) : '';
    // Collect every class-like cell (the school sheet can have a bare "Grade 3"
    // column AND a section "Grade 3-C" column). The matcher resolves against
    // known classes and prefers the section-specific value.
    const classCandidates = Array.from(new Set(
      classCols.map(c => text(raw[c])).filter(v => v),
    ));
    const rawClass = classCandidates[0] ?? '';
    const parentPhone = cols.parentPhone >= 0 ? text(raw[cols.parentPhone]) : '';
    const rawBus = cols.bus >= 0 ? text(raw[cols.bus]) : '';
    const bus = parseBusCell(cols.bus >= 0 ? raw[cols.bus] : '');

    // Fully blank / summary-noise rows are skipped silently.
    if (!studentId && !govId && !name && !rawClass && !parentPhone && !rawBus) continue;
    if (/^\d+\s*students?,?\s*\d*\s*free/i.test(name)) continue;

    if (numericStudentId) {
      issues.push({
        severity: 'error', code: 'NUMERIC_ID', row: r + 1,
        message: `Row ${r + 1}: the Student ID was read as a number by Excel and may have lost digits or leading zeros. Use the app-generated "Export current students" template (IDs are text) or format the ID column as text.`,
      });
    }
    if (numericGovId) {
      issues.push({
        severity: 'error', code: 'NUMERIC_ID', row: r + 1,
        message: `Row ${r + 1}: the Gov ID was read as a number by Excel (Excel corrupts numbers longer than 15 digits and drops leading zeros). Format the Gov ID column as Text or use the app-generated template; this row will not be auto-processed.`,
      });
    }

    if (bus.invalid) {
      issues.push({
        severity: 'error', code: 'INVALID_BUS', row: r + 1,
        message: `Row ${r + 1}: the Bus value "${rawBus}" is not a bus number, WALKER, CAR, or DRIVER. Use a route number (e.g. 9) or NB for not on the bus; this row will not be processed.`,
      });
    }

    out.push({
      rowNumber: r + 1, studentId, govId, name, rawClass, classCandidates, parentPhone,
      numericStudentId, numericGovId,
      rawBus, parsedTransport: bus.value, invalidBus: bus.invalid,
    });
  }

  if (out.length === 0) {
    issues.push({ severity: 'error', code: 'EMPTY_WORKBOOK', message: 'No student rows were found below the header.', row: 0 });
  }

  return { rows: out, issues, headers, mappedHeaders };
}

// ─── Class resolution & validation ──────────────────────────────────────────

const GRADE_SECTION_PATTERN = /^(?:grade|year|g)?\s*(\d{1,2})\s*[-\s]?\s*([a-z])$/i;
const KG_PATTERN = /^(?:kg)\s*[-\s]?\s*([a-z])$/i;
const FOUNDATION_PATTERN = /^foundation\s*[-\s]?\s*([a-z])$/i;

/**
 * Resolve an uploaded class value to an EXISTING canonical class name.
 *
 * Accepted shapes: the exact canonical name ('Grade 7-A', case/whitespace
 * tolerant), known sheet codes ('G7A', via the transport sheet map), and
 * unambiguous grade+section shorthand ('7A', '7-A', 'Grade 7A'). The result
 * MUST be present in `knownClasses` — unknown classes are rejected, never
 * silently converted or invented.
 */
export function resolveUploadedClass(rawClass: string, knownClasses: readonly string[]): string | null {
  const value = text(rawClass);
  if (!value) return null;

  const byLower = new Map<string, string>();
  for (const c of knownClasses) byLower.set(normalizeName(c), c);

  // 1. Exact canonical match (case/whitespace tolerant).
  const exact = byLower.get(normalizeName(value));
  if (exact) return exact;
  if (normalizeName(value) === normalizeName('Graduated')) {
    return knownClasses.includes('Graduated') ? 'Graduated' : null;
  }

  // 2. Known sheet code ('G7A', 'KG', ...).
  const coded = mapSheetClassCode(value);
  if (coded && byLower.has(normalizeName(coded))) return byLower.get(normalizeName(coded))!;

  // 3. Grade + section shorthand — only accepted when the constructed class
  //    actually exists. Anything else is rejected by the caller.
  const compact = value.replace(/\s+/g, '').toUpperCase();
  const gradeMatch = compact.match(GRADE_SECTION_PATTERN);
  if (gradeMatch) {
    const candidate = `Grade ${Number(gradeMatch[1])}-${gradeMatch[2].toUpperCase()}`;
    const hit = byLower.get(normalizeName(candidate));
    if (hit) return hit;
    return null;
  }
  const kgMatch = value.match(KG_PATTERN);
  if (kgMatch) {
    const hit = byLower.get(normalizeName(`KG-${kgMatch[1].toUpperCase()}`));
    if (hit) return hit;
    return null;
  }
  const foundationMatch = value.match(FOUNDATION_PATTERN);
  if (foundationMatch) {
    const hit = byLower.get(normalizeName(`Foundation ${foundationMatch[1].toUpperCase()}`));
    if (hit) return hit;
    return null;
  }
  return null;
}

/**
 * A class value that carries a SECTION (e.g. "Grade 3-C", "G3C", "KG-B",
 * "Foundation A") — these are concrete classes. A bare grade like "Grade 3"
 * has no section and is never by itself a class.
 */
export function classHasSection(raw: string): boolean {
  const v = text(raw);
  if (!v) return false;
  const compact = v.replace(/[\s-]+/g, '').toUpperCase();
  if (/^(?:GRADE|YEAR|G|FORM)?\d{1,2}[A-Z]$/.test(compact)) return true; // Grade3C, G9B, 9B
  if (/^KG[A-Z]$/.test(compact)) return true;                            // KGB
  if (/^FOUNDATION[A-Z]$/.test(compact)) return true;                    // FOUNDATIONA
  return false;
}

/**
 * Resolve a row's class from ALL its class-like cells. The school sheet can
 * contain both a bare "Grade 3" column and a section "Grade 3-C" column. We
 * return the first value that resolves to an EXISTING canonical class. If
 * none resolve, prefer the most section-specific raw value (so the error
 * references "Grade 3-C", not the bare grade) and return null for resolution.
 */
export function resolveUploadedClassCandidates(
  candidates: string[],
  knownClasses: readonly string[],
): { resolved: string | null; bestRaw: string } {
  const vals = candidates.map(c => c?.trim()).filter(Boolean) as string[];
  // Prefer section-specific cells (the last one wins when the sheet has both a
  // bare "Grade" column and a section "Current Class" column), then any cell.
  const ordered = [...vals].sort((a, b) => {
    const as = classHasSection(a) ? 1 : 0;
    const bs = classHasSection(b) ? 1 : 0;
    return as - bs; // non-section first → section last; iteration below uses section first
  });
  const priority = [...ordered.reverse()];
  // 1. Any value that resolves to a real class (section value first).
  for (const v of priority) {
    const hit = resolveUploadedClass(v, knownClasses);
    if (hit) return { resolved: hit, bestRaw: v };
  }
  // 2. Nothing resolved — surface the most specific cell for the error.
  const bestRaw = priority[0] ?? '';
  return { resolved: null, bestRaw };
}

/**
 * A value that names a grade/level but is missing the SECTION letter, e.g.
 * "Grade 3", "Grade9", "KG", "Foundation". These are not complete classes —
 * the school's classes are sectioned ("Grade 3-C", "KG-B"). Used to give a
 * helpful error instead of a bare "does not exist".
 */
export function classMissingSection(raw: string): boolean {
  const compact = text(raw).replace(/\s+/g, '').toUpperCase();
  if (!compact) return false;
  if (/^(?:GRADE|YEAR|FORM|G)?\d{1,2}$/.test(compact)) return true; // Grade 3, G3, 3
  if (compact === 'KG') return true;
  if (compact === 'FOUNDATION') return true;
  return false;
}

function invalidClassMessage(bestRaw: string): string {
  if (classMissingSection(bestRaw)) {
    return `Class "${bestRaw}" is missing its section letter — classes need A/B/C, e.g. "${bestRaw.trim()}-A". Check the class column (a bare "${bestRaw.trim()}" without a letter is not a class).`;
  }
  return `Class ${bestRaw} does not exist.`;
}

// ─── Matching & classification ──────────────────────────────────────────────

/** Stable ID for genuinely new students, matching the app's ID convention. */
export function generateNewStudentId(): string {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  return `student-${timestamp}-${rand}`;
}

function normId(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Robust Gov/admission ID normalization for MATCHING. The school's gov id is
 * the authoritative external identifier (e.g. "16-005772", "23-920729") and
 * may appear with differing spaces, quotes, or dashes across the sheet and the
 * database. We keep only alphanumeric characters and uppercase, so
 * "16-005772", " 16 005772 ", and "16005772" all compare equal.
 */
export function normalizeGovId(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Normalize a Gov/admission ID (kept for identity-key sets). */
function normGovId(value: string): string {
  return normalizeGovId(value);
}

/**
 * The identity keys a row would "claim" if treated as a new student: the
 * normalized Student ID (when it is the app-generated id, it is ignored) and
 * the normalized Gov ID. Used to guarantee a new-student row never collides
 * with an existing student's identity — the single most important invariant
 * of the import (no duplicate inserts).
 */
export interface ClassImportIdentityKeys {
  studentIds: string[];
  govIds: string[];
}

function isAppGeneratedId(id: string): boolean {
  return /^student-\d{10,}-/i.test(id.trim());
}

export function rowIdentityKeys(row: { studentId: string; govId: string }): ClassImportIdentityKeys {
  const studentIds: string[] = [];
  const govIds: string[] = [];
  const sid = row.studentId.trim();
  if (sid && !isAppGeneratedId(sid)) studentIds.push(normId(sid));
  const gov = normalizeGovId(row.govId);
  if (gov) govIds.push(gov);
  return { studentIds, govIds };
}

/** Build the sets of identity keys already held by existing students. */
export function existingIdentityKeys(students: Student[]): {
  studentIds: Set<string>; govIds: Set<string>;
} {
  const studentIds = new Set<string>();
  const govIds = new Set<string>();
  for (const s of students) {
    if (s.id && !isAppGeneratedId(s.id)) studentIds.add(normId(s.id));
    const g = normalizeGovId(s.govId);
    if (g) govIds.add(g);
  }
  return { studentIds, govIds };
}

/**
 * Final classification audit that runs BEFORE the payload is sent. It enforces
 * the invariant the database relies on:
 *   classChanges → existing student ids only
 *   newStudents  → identities not present on any existing student
 * Returns a list of human-readable problems. Empty = safe to commit. This is a
 * pure function so it can run in the UI (blocking confirmation) and in tests.
 */
export function auditCommitPayload(
  payload: ClassImportCommitPayload,
  existing: { studentIds: Set<string>; govIds: Set<string> },
): string[] {
  const problems: string[] = [];
  const newIdSet = new Set<string>();
  const newGovSet = new Set<string>();

  for (const ns of payload.newStudents) {
    const sid = ns.id.trim();
    const gov = ns.govId ? normGovId(ns.govId) : '';
    // A new student must not reuse an existing student's id.
    if (sid && existing.studentIds.has(normId(sid))) {
      problems.push(`"${ns.name}" (${sid}) already exists as a student — it was misclassified as new and will not be created.`);
    }
    // A new student must not reuse an existing student's gov id.
    if (gov && existing.govIds.has(gov)) {
      problems.push(`"${ns.name}" uses Gov ID ${gov}, which is already assigned to an existing student — it was misclassified as new and will not be created.`);
    }
    // No two new students may share an identity either.
    if (sid && newIdSet.has(normId(sid))) problems.push(`Student ID ${sid} is used by more than one new student in this file.`);
    if (gov && newGovSet.has(gov)) problems.push(`Gov ID ${gov} is used by more than one new student in this file.`);
    if (sid) newIdSet.add(normId(sid));
    if (gov) newGovSet.add(gov);
  }
  return problems;
}

/**
 * Classify every uploaded row against the existing students.
 *
 * `knownClasses` is the authoritative class list (classes with subject
 * assignments or enrolled students, plus the app's class catalogue) — the
 * same list the preview UI offers, so a class that passes here also passes
 * the server-side commit check.
 */
export function matchClassImportRows(
  rawRows: RawClassImportRow[],
  students: Student[],
  knownClasses: readonly string[],
): ClassImportRow[] {
  const byId = new Map<string, Student>();
  const byGovId = new Map<string, Student[]>();
  const byName = new Map<string, Student[]>();
  for (const s of students) {
    byId.set(normId(s.id), s);
    if (s.govId && s.govId.trim()) {
      const key = normalizeGovId(s.govId);
      if (key) byGovId.set(key, [...(byGovId.get(key) ?? []), s]);
    }
    const nameKey = normalizeName(s.name);
    if (nameKey) byName.set(nameKey, [...(byName.get(nameKey) ?? []), s]);
  }
  // Identity keys that already exist — a row claiming one of these must never
  // be created as a new student even if the normal matching did not resolve it.
  const existingKeys = existingIdentityKeys(students);

  const rows: ClassImportRow[] = rawRows.map(raw => ({
    ...raw,
    status: 'unmatched',
    matchMethod: null,
    matchedStudentId: null,
    existingName: null,
    fromClass: null,
    toClass: null,
    fromTransport: null,
    toTransport: null,
    assignedId: null,
    excluded: false,
    issues: [],
    candidates: [],
  }));

  const issue = (row: ClassImportRow, severity: ClassImportIssueSeverity, code: ClassImportIssueCode, message: string) => {
    row.issues.push({ severity, code, message, row: row.rowNumber });
  };

  // ── In-file duplicate detection ───────────────────────────────────────────
  const idRows = new Map<string, ClassImportRow[]>();
  const govRows = new Map<string, ClassImportRow[]>();
  const fullRows = new Map<string, ClassImportRow[]>();
  for (const row of rows) {
    if (row.studentId.trim()) {
      idRows.set(normId(row.studentId), [...(idRows.get(normId(row.studentId)) ?? []), row]);
    }
    if (row.govId.trim()) {
      const key = row.govId.trim().toUpperCase();
      govRows.set(key, [...(govRows.get(key) ?? []), row]);
    }
    const key = [row.studentId, row.govId, row.name, row.rawClass].map(v => normalizeName(v)).join('|');
    fullRows.set(key, [...(fullRows.get(key) ?? []), row]);
  }
  for (const [id, group] of idRows) {
    if (group.length < 2) continue;
    const rowList = group.map(r => r.rowNumber).join(' and ');
    for (const r of group.slice(1)) {
      r.status = 'duplicate';
      r.excluded = true;
      issue(r, 'error', 'DUPLICATE_STUDENT_ID', `Rows ${rowList} contain the same Student ID ${id}. Only the first occurrence is processed.`);
    }
  }
  for (const [gov, group] of govRows) {
    if (group.length < 2) continue;
    const rowList = group.map(r => r.rowNumber).join(' and ');
    for (const r of group) {
      if (r.status === 'duplicate') continue;
      if (r === group[0]) {
        issue(r, 'warning', 'DUPLICATE_GOV_ID', `Gov ID ${gov} appears on rows ${rowList} — review these rows.`);
        continue;
      }
      r.status = 'duplicate';
      r.excluded = true;
      issue(r, 'error', 'DUPLICATE_GOV_ID', `Rows ${rowList} contain the same Gov ID ${gov}. Only the first occurrence is processed.`);
    }
  }
  for (const [, group] of fullRows) {
    if (group.length < 2) continue;
    for (const r of group.slice(1)) {
      if (r.status === 'duplicate') continue;
      r.status = 'duplicate';
      r.excluded = true;
      issue(r, 'error', 'DUPLICATE_ROW', `Row ${r.rowNumber} is a duplicate of row ${group[0].rowNumber} and will not be processed twice.`);
    }
  }
  // Duplicate NAMES among rows that carry no identifier at all: without an ID
  // these would each create a new student record, so hold back the later ones.
  const nameOnlyRows = new Map<string, ClassImportRow[]>();
  for (const row of rows) {
    if (row.status === 'duplicate' || row.studentId.trim() || row.govId.trim() || !row.name.trim()) continue;
    const key = normalizeName(row.name);
    nameOnlyRows.set(key, [...(nameOnlyRows.get(key) ?? []), row]);
  }
  for (const [, group] of nameOnlyRows) {
    if (group.length < 2) continue;
    for (const r of group.slice(1)) {
      r.status = 'duplicate';
      r.excluded = true;
      issue(r, 'error', 'DUPLICATE_ROW', `Row ${r.rowNumber}: "${r.name}" also appears on row ${group[0].rowNumber} with no identifier — a second student record is not created automatically.`);
    }
  }

  // ── Per-row matching ──────────────────────────────────────────────────────
  const claimedStudents = new Map<string, ClassImportRow>(); // studentId → first row that matched it

  for (const row of rows) {
    if (row.status === 'duplicate') continue;

    // Excel stored an identity cell as a number — digits/leading zeros may be
    // lost, so matching it would risk a wrong match or a false new student.
    // Hold the row for correction rather than guessing.
    if (row.numericStudentId || row.numericGovId) {
      row.status = 'invalid';
      row.excluded = true;
      const which = [row.numericStudentId ? 'Student ID' : null, row.numericGovId ? 'Gov ID' : null]
        .filter(Boolean).join(' / ');
      issue(row, 'error', 'NUMERIC_ID',
        `Row ${row.rowNumber}: ${which} was read as a number by Excel and may be corrupted (lost digits/leading zeros). Re-export using the app template or format the column as Text, then re-upload.`);
      continue;
    }

    // An unrecognizable bus value would violate the DB transport CHECK — block
    // the row rather than silently dropping the student's transport.
    if (row.invalidBus) {
      row.status = 'invalid';
      row.excluded = true;
      issue(row, 'error', 'INVALID_BUS',
        `Row ${row.rowNumber}: the Bus value "${row.rawBus}" is not a valid transport (use a route number like 9, NB for walker, or CAR/DRIVER). Fix the cell or leave it blank, then re-upload.`);
      continue;
    }

    // Required identifiers.
    if (!row.name.trim() && !row.studentId.trim() && !row.govId.trim()) {
      row.status = 'invalid';
      issue(row, 'error', 'MISSING_NAME', `Row ${row.rowNumber}: Student name is required.`);
      continue;
    }

    let matched: Student | null = null;
    let method: ClassImportMatchMethod | null = null;
    let candidates: Student[] = [];
    let idNotFound = false;

    // Priority 1 — Student ID.
    if (row.studentId.trim()) {
      const found = byId.get(normId(row.studentId));
      if (found) {
        matched = found;
        method = 'student_id';
      } else {
        idNotFound = true;
      }
    }

    // Priority 2 — Gov/admission ID (must be unique). Gov ID is the school's
    // authoritative external identifier; a missing internal Student ID column
    // does NOT make a student new — a unique gov id matches them directly.
    if (!matched && row.govId.trim()) {
      const list = byGovId.get(normalizeGovId(row.govId)) ?? [];
      if (list.length === 1) {
        matched = list[0];
        method = 'gov_id';
      } else if (list.length > 1) {
        candidates = list;
        issue(row, 'error', 'GOV_ID_NOT_UNIQUE', `Row ${row.rowNumber}: Gov ID ${row.govId} matches ${list.length} students — manual review required.`);
      }
    }

    // Priority 3 — controlled secondary matching: exact name + parent phone.
    // Name alone NEVER auto-matches.
    if (!matched && candidates.length === 0 && row.name.trim()) {
      const nameCandidates = byName.get(normalizeName(row.name)) ?? [];
      if (nameCandidates.length > 0) {
        const rowPhone = normalizePhone(row.parentPhone);
        if (rowPhone) {
          const phoneMatches = nameCandidates.filter(s => normalizePhone(s.parentPhone ?? '') === rowPhone);
          if (phoneMatches.length === 1) {
            matched = phoneMatches[0];
            method = 'name_phone';
          } else {
            candidates = phoneMatches.length > 0 ? phoneMatches : nameCandidates;
          }
        } else {
          candidates = nameCandidates;
        }
      }
    }

    // An unknown sheet Student ID is a WARNING, not a blocker, when a stronger
    // secondary key still resolves the row to exactly one existing student:
    //   • Gov ID matches exactly one student, OR
    //   • exact name + parent phone matches exactly one student.
    // In the school's data the Student ID and Gov ID are frequently the SAME
    // value stored in two columns, and legacy students carry generated ids —
    // so a "Student ID not found" must never demote a confident gov/name+phone
    // match into manual review (which previously could leak the row toward a
    // false new student). We still keep the warning so the admin can see it.
    // Only when there is NO confident secondary match do we hold for review.
    const confidentSecondary = matched !== null && (method === 'gov_id' || method === 'name_phone');

    if (matched && idNotFound && method !== 'student_id' && !confidentSecondary) {
      issue(row, 'error', 'STUDENT_ID_NOT_FOUND', `Row ${row.rowNumber}: Student ID ${row.studentId} does not exist, but the row resembles ${matched.name} (${matched.className}). Review the ID before applying.`);
      row.status = 'ambiguous';
      row.candidates = [{ id: matched.id, name: matched.name, className: matched.className }];
      continue;
    }

    if (matched && method) {
      // Two uploaded rows resolving to the same student contradict each
      // other — the later one is held back for review.
      const earlier = claimedStudents.get(matched.id);
      if (earlier) {
        row.status = 'duplicate';
        row.excluded = true;
        row.matchedStudentId = matched.id;
        row.existingName = matched.name;
        row.fromClass = matched.className;
        issue(row, 'error', 'CONFLICTING_ROWS', `Row ${row.rowNumber}: conflicts with row ${earlier.rowNumber} — both resolve to ${matched.name} (${matched.id}).`);
        continue;
      }
      claimedStudents.set(matched.id, row);

      row.matchMethod = method;
      row.matchedStudentId = matched.id;
      row.existingName = matched.name;
      row.fromClass = matched.className;
      row.fromTransport = normalizeTransport(matched.transport);
      row.toTransport = row.parsedTransport;

      if (idNotFound && row.govId.trim()) {
        issue(row, 'warning', 'STUDENT_ID_NOT_FOUND', `Row ${row.rowNumber}: Student ID ${row.studentId} was not found; matched via Gov ID ${row.govId}.`);
      }

      const classChoice = resolveUploadedClassCandidates(row.classCandidates, knownClasses);
      if (classChoice.bestRaw === '') {
        row.status = 'invalid';
        issue(row, 'error', 'MISSING_CLASS', `Row ${row.rowNumber}: Class is required.`);
        continue;
      }
      if (!classChoice.resolved) {
        row.status = 'invalid';
        issue(row, 'error', 'INVALID_CLASS', `Row ${row.rowNumber}: ${invalidClassMessage(classChoice.bestRaw)}`);
        continue;
      }
      const resolved = classChoice.resolved;
      row.toClass = resolved;
      const classChanged = resolved !== matched.className;
      const transportChanged = row.parsedTransport !== null
        && normalizeTransport(row.parsedTransport) !== normalizeTransport(matched.transport);
      row.status = (classChanged || transportChanged) ? 'class_change' : 'no_change';
      continue;
    }

    if (candidates.length > 0) {
      row.status = 'ambiguous';
      row.candidates = candidates.map(c => ({ id: c.id, name: c.name, className: c.className }));
      if (idNotFound) {
        issue(row, 'error', 'STUDENT_ID_NOT_FOUND', `Row ${row.rowNumber}: Student ID ${row.studentId} does not exist — a duplicate student is NOT created automatically.`);
      }
      const reason = candidates.length === 1
        ? 'could not be safely matched automatically (name-only match)'
        : `could not be safely matched — ${candidates.length} possible students`;
      issue(row, 'error', 'AMBIGUOUS_MATCH', `Row ${row.rowNumber}: Student ${row.name || row.studentId || row.govId} ${reason}. Choose the correct student or exclude the row.`);
      continue;
    }

    // ── Not matched: new student or hard failure ────────────────────────────
    if (!row.name.trim()) {
      // An ID with no name cannot be matched and cannot be created.
      row.status = row.studentId.trim() ? 'unmatched' : 'invalid';
      issue(row, 'error', row.studentId.trim() ? 'STUDENT_ID_NOT_FOUND' : 'MISSING_NAME',
        row.studentId.trim()
          ? `Row ${row.rowNumber}: Student ID ${row.studentId} does not exist.`
          : `Row ${row.rowNumber}: Student name is required.`);
      continue;
    }
    const newClassChoice = resolveUploadedClassCandidates(row.classCandidates, knownClasses);
    if (newClassChoice.bestRaw === '') {
      row.status = 'invalid';
      issue(row, 'error', 'MISSING_CLASS', `Row ${row.rowNumber}: Class is required for a new student.`);
      continue;
    }
    const resolved = newClassChoice.resolved;
    if (!resolved) {
      row.status = 'invalid';
      issue(row, 'error', 'INVALID_CLASS', `Row ${row.rowNumber}: ${invalidClassMessage(newClassChoice.bestRaw)}`);
      continue;
    }

    // ── Identity collision guard ──────────────────────────────────────────
    // Even though normal matching did not bind this row, it claims a Student
    // ID or Gov ID that already belongs to an existing student (this happens
    // when the preview roster is incomplete). Creating it would be a duplicate
    // INSERT and the server would reject the whole batch. Hold for manual
    // review instead — NEVER auto-create.
    const keys = rowIdentityKeys(row);
    const idCollision = keys.studentIds.find(k => existingKeys.studentIds.has(k));
    const govCollision = keys.govIds.find(k => existingKeys.govIds.has(k));
    if (idCollision || govCollision) {
      row.status = 'ambiguous';
      const which = [idCollision ? `Student ID ${idCollision}` : null, govCollision ? `Gov ID ${govCollision}` : null]
        .filter(Boolean).join(' / ');
      issue(row, 'error', 'STUDENT_ID_NOT_FOUND',
        `Row ${row.rowNumber}: ${which} already belongs to an existing student record, but the row could not be matched in the preview roster. It is held for manual review — a duplicate student is NOT created.`);
      continue;
    }

    row.status = 'new_student';
    row.toClass = resolved;
    row.toTransport = row.parsedTransport;
    if (!row.studentId.trim()) {
      row.assignedId = generateNewStudentId();
      issue(row, 'warning', 'MISSING_STUDENT_ID', `Row ${row.rowNumber}: no Student ID in the file — ${row.assignedId} will be assigned.`);
    }
  }

  return rows;
}

/**
 * Apply an admin's manual resolution of an ambiguous row: pick one of the
 * candidates as THE student. The uploaded class still has to resolve to an
 * existing class.
 */
export function resolveRowCandidate(
  row: ClassImportRow,
  candidate: ClassImportCandidate,
  existingStudent: { id: string; name: string; className: string; transport?: string | null },
  knownClasses: readonly string[],
): ClassImportRow {
  const updated: ClassImportRow = { ...row, candidates: row.candidates, issues: [...row.issues] };
  updated.matchMethod = 'manual';
  updated.matchedStudentId = existingStudent.id;
  updated.existingName = existingStudent.name;
  updated.fromClass = existingStudent.className;
  updated.fromTransport = normalizeTransport(existingStudent.transport ?? null);
  updated.toTransport = updated.parsedTransport;
  updated.candidates = [];

  const classChoice = resolveUploadedClassCandidates(
    updated.classCandidates?.length ? updated.classCandidates : [updated.rawClass],
    knownClasses,
  );
  if (classChoice.bestRaw === '') {
    updated.status = 'invalid';
    updated.issues = [{ severity: 'error', code: 'MISSING_CLASS', message: `Row ${updated.rowNumber}: Class is required.`, row: updated.rowNumber }];
    return updated;
  }
  if (!classChoice.resolved) {
    updated.status = 'invalid';
    updated.issues = [{ severity: 'error', code: 'INVALID_CLASS', message: `Row ${updated.rowNumber}: ${invalidClassMessage(classChoice.bestRaw)}`, row: updated.rowNumber }];
    return updated;
  }
  const resolved = classChoice.resolved;
  updated.toClass = resolved;
  const classChanged = resolved !== existingStudent.className;
  const transportChanged = updated.parsedTransport !== null
    && normalizeTransport(updated.parsedTransport) !== normalizeTransport(existingStudent.transport ?? null);
  updated.status = (classChanged || transportChanged) ? 'class_change' : 'no_change';
  return updated;
}

// ─── Bulk resolution of ambiguous (Needs Review) rows ───────────────────────

/** Result of the "accept all single suggestions" bulk action. */
export interface BulkResolveResult {
  rows: ClassImportRow[];
  /** How many ambiguous rows were auto-bound to their single candidate. */
  resolved: number;
  /** Rows left in review because they have 0 or >1 candidates. */
  stillAmbiguous: number;
  /** Rows skipped because their only candidate was already taken by another row. */
  conflicts: number;
}

/**
 * Bulk-apply the "use this student" action to every Needs-Review row that has
 * exactly ONE candidate. This mirrors clicking that button once per row, so it
 * stays conservative:
 *   - rows with 0 or >1 candidates are LEFT in manual review (a real choice
 *     must be made where two students share a name, or where there is no match);
 *   - a row whose sole candidate is already claimed by another uploaded row is
 *     skipped (we never bind two spreadsheet rows to the same student).
 * Resolved rows become class_change / no_change exactly like a manual pick, so
 * the existing commit path and invariants apply unchanged.
 */
export function bulkResolveSingleCandidates(
  rows: ClassImportRow[],
  studentsById: Map<string, Student>,
  knownClasses: readonly string[],
): BulkResolveResult {
  // Students already bound to a committed (non-ambiguous) row cannot be taken.
  const claimed = new Set<string>();
  for (const r of rows) {
    if (r.matchedStudentId && r.status !== 'ambiguous') claimed.add(r.matchedStudentId);
  }

  let resolved = 0;
  let stillAmbiguous = 0;
  let conflicts = 0;

  const out = rows.map(row => {
    if (row.status !== 'ambiguous') return row;

    // Only auto-accept rows with a single suggestion.
    if (row.candidates.length !== 1) {
      stillAmbiguous += 1;
      return row;
    }
    const candidate = row.candidates[0];
    if (claimed.has(candidate.id)) {
      conflicts += 1;
      return row;
    }
    // The candidate may come from the server resolver and be absent from the
    // browser roster — fall back to the candidate's own id/name/class.
    const existing = studentsById.get(candidate.id) ?? {
      id: candidate.id,
      name: candidate.name,
      className: candidate.className ?? '',
      transport: null,
    };

    const updated = resolveRowCandidate(
      row,
      candidate,
      existing,
      knownClasses,
    );
    // Only count/claim rows that resolved into a usable state. If the pick
    // produced an invalid row (e.g. bad class), leave it for manual handling.
    if (updated.status === 'class_change' || updated.status === 'no_change') {
      claimed.add(candidate.id);
      resolved += 1;
      // A resolved row is intended to apply — make sure it isn't still excluded.
      updated.excluded = false;
      return updated;
    }
    stillAmbiguous += 1;
    return updated;
  });

  return { rows: out, resolved, stillAmbiguous, conflicts };
}

// ─── Authoritative server identity resolution ───────────────────────────────

/** Minimal shape of the read-only server resolution (kept structural). */
export interface ServerResolution {
  index: number;
  status: 'matched' | 'ambiguous' | 'new';
  matchMethod?: 'student_id' | 'gov_id' | 'name_phone';
  matchedStudentId?: string;
  matchedName?: string;
  matchedClassName?: string;
  reason?: string;
  candidates?: { id: string; name: string; className: string }[];
}

/**
 * Apply authoritative server identity decisions on top of the local preview.
 * The server (full live database) wins for identity: an existing student found
 * by Gov ID — even with NO internal Student ID column — is bound as an existing
 * student (class_change / no_change), never created. Rows the server cannot
 * resolve but whose NAME exists are forced to manual review. Genuinely-new rows
 * are left as the local matcher classified them.
 *
 * Returns the updated rows (order preserved) plus counts for a summary toast.
 */
export function applyServerResolutions(
  rows: ClassImportRow[],
  resolutions: ServerResolution[],
  knownClasses: readonly string[],
): { rows: ClassImportRow[]; matched: number; toReview: number; newConfirmed: number } {
  let matched = 0;
  let toReview = 0;
  let newConfirmed = 0;

  // Resolutions arrive in the same order as rows; align by the server-provided
  // index (positional), falling back to position.
  const updated = rows.map((row, i) => {
    const res = resolutions[i];
    if (!res) return row;

    // Server says MATCHED to a concrete existing student.
    if (res.status === 'matched' && res.matchedStudentId) {
      // Already bound locally to the SAME student → nothing to do.
      if (row.matchedStudentId === res.matchedStudentId) return row;

      const existing = {
        id: res.matchedStudentId,
        name: res.matchedName ?? row.name,
        className: res.matchedClassName ?? '',
      };
      const candidate: ClassImportCandidate = {
        id: existing.id, name: existing.name, className: existing.className,
      };
      const bound = resolveRowCandidate(row, candidate, existing, knownClasses);
      // Preserve the real match method the server used (resolveRowCandidate
      // stamps 'manual'; reflect the authoritative key instead).
      bound.matchMethod = res.matchMethod ?? 'gov_id';
      bound.excluded = false;
      if (bound.status === 'class_change' || bound.status === 'no_change') {
        matched += 1;
        return bound;
      }
      // If binding produced invalid (e.g. bad class) leave as-is for review.
      return bound;
    }

    // Server says AMBIGUOUS (name exists / gov not unique) → force manual
    // review unless the row is already confidently bound.
    if (res.status === 'ambiguous') {
      if (row.matchedStudentId && (row.status === 'class_change' || row.status === 'no_change')) {
        return row; // already confident
      }
      const serverCandidates = res.candidates ?? [];
      const merged = new Map<string, ClassImportCandidate>();
      for (const c of row.candidates) merged.set(c.id, c);
      for (const c of serverCandidates) merged.set(c.id, c);
      const hasIssue = row.issues.some(is => is.code === 'AMBIGUOUS_MATCH' || is.code === 'STUDENT_ID_NOT_FOUND');
      const next: ClassImportRow = {
        ...row,
        status: 'ambiguous',
        candidates: Array.from(merged.values()),
        matchedStudentId: null,
        excluded: false,
        issues: hasIssue ? row.issues : [...row.issues, {
          severity: 'error' as const,
          code: 'AMBIGUOUS_MATCH' as const,
          row: row.rowNumber,
          message: `Row ${row.rowNumber}: an existing student matches this name/ID in the school database. Choose the correct student or exclude the row — a duplicate is never created.`,
        }],
      };
      toReview += 1;
      return next;
    }

    // Server says genuinely NEW → confirm the local new_student classification.
    if (res.status === 'new') {
      if (!row.matchedStudentId && row.status === 'new_student') newConfirmed += 1;
      return row;
    }
    return row;
  });

  return { rows: updated, matched, toReview, newConfirmed };
}

// ─── Summary & commit payload ───────────────────────────────────────────────

export function summarizeClassImport(rows: ClassImportRow[]): ClassImportSummary {
  const byStatus = (s: ClassImportStatus) => rows.filter(r => r.status === s);
  const classChanges = byStatus('class_change');
  const newStudents = byStatus('new_student');
  return {
    totalRows: rows.length,
    matched: rows.filter(r => r.matchedStudentId && r.status !== 'ambiguous').length,
    classChanges: classChanges.length,
    noChange: byStatus('no_change').length,
    newStudents: newStudents.length,
    unmatched: byStatus('unmatched').length,
    ambiguous: byStatus('ambiguous').length,
    invalidRows: byStatus('invalid').length,
    duplicates: byStatus('duplicate').length,
    excluded: rows.filter(r => r.excluded).length,
    applicableChanges: classChanges.filter(r => !r.excluded).length,
    applicableCreates: newStudents.filter(r => !r.excluded).length,
  };
}

/**
 * Build the payload for the atomic commit RPC from the preview state.
 * Only committable, non-excluded rows are included; ambiguous/invalid/
 * duplicate rows NEVER reach the database.
 */
export function buildCommitPayload(rows: ClassImportRow[]): ClassImportCommitPayload {
  const changes: ClassChangeCommit[] = [];
  const newStudents: NewStudentCommit[] = [];
  const claimedChangeIds = new Set<string>();

  for (const row of rows) {
    if (row.excluded) continue;
    // INVARIANT: only a row the matcher bound to an existing student may ever
    // produce a class change; only a row classified new_student (and never
    // bound to an existing student) may ever produce a new student.
    if (row.status === 'class_change' && row.matchedStudentId && row.toClass) {
      if (claimedChangeIds.has(row.matchedStudentId)) continue; // never twice
      claimedChangeIds.add(row.matchedStudentId);
      // Only attach a transport target when the sheet provided a bus value
      // that differs from the stored one; a blank cell leaves transport alone.
      const transportChanged = row.parsedTransport !== null
        && normalizeTransport(row.parsedTransport) !== normalizeTransport(row.fromTransport);
      changes.push({
        studentId: row.matchedStudentId,
        toClass: row.toClass,
        transport: transportChanged ? normalizeTransport(row.parsedTransport) : undefined,
      });
    } else if (row.status === 'new_student' && row.toClass && row.name.trim()) {
      // Defense in depth: a row bound to an existing student can NEVER be
      // created, no matter its status flag.
      if (row.matchedStudentId) continue;
      const normPhone = normalizePhone(row.parentPhone);
      newStudents.push({
        id: row.studentId.trim() || row.assignedId || generateNewStudentId(),
        name: row.name.trim(),
        className: row.toClass,
        govId: row.govId.trim() || null,
        // Normalized consistently with the rest of the app (digits, +252
        // stripped) so future name+phone matching and family grouping work.
        parentPhone: normPhone || null,
        // A blank bus cell leaves the DB default (interpreted as walker).
        transport: row.parsedTransport ? normalizeTransport(row.parsedTransport) : 'WALKER',
      });
    }
  }

  return { changes, newStudents };
}

/**
 * Roster derivation used by Bulk Upload Grades: teachers see the students
 * whose CURRENT class matches the selected class. Exposed here so tests can
 * prove that a student moved 7A → 7B appears in 7B after the import commit.
 */
export function rosterForClass(students: Student[], className: string): Student[] {
  return students.filter(s => s.className === className);
}

// ─── Template export ────────────────────────────────────────────────────────

/**
 * Build a ready-to-edit .xlsx of the CURRENT roster (the same shape the
 * Google Sheet uses), so the admin can export → edit classes in Sheets →
 * re-upload. Column order matches HEADER_ALIASES so it round-trips through
 * parseClassImportFile().
 */
/** Bus-cell value for the export template: route number for riders, NB for walkers. */
function templateBusValue(student: Student): string {
  const t = normalizeTransport(student.transport);
  if (/^\d+$/.test(t)) return t; // on bus N
  if (t === 'CAR') return 'CAR';
  if (t === 'DRIVER') return 'DRIVER';
  return 'NB'; // WALKER / unset / LEFT → not on the bus
}

export function buildClassImportTemplate(students: Student[]): Blob {
  const data = [...students]
    .sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    .map(s => ({
      'Student ID': s.id,
      'Gov ID': s.govId ?? '',
      'Student Name': s.name,
      'Current Class': s.className,
      'Bus': templateBusValue(s),
      'Parent Phone': s.parentPhone ?? '',
    }));
  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Students');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
