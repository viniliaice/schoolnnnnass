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
import { mapSheetClassCode, normalizeName, normalizePhone } from '../transport';

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
  parentPhone: string;
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
}

export interface NewStudentCommit {
  id: string;
  name: string;
  className: string;
  govId: string | null;
  parentPhone: string | null;
}

export interface ClassImportCommitPayload {
  changes: ClassChangeCommit[];
  newStudents: NewStudentCommit[];
}

// ─── Header mapping ─────────────────────────────────────────────────────────

const HEADER_ALIASES: Record<'studentId' | 'govId' | 'name' | 'class' | 'parentPhone', string[]> = {
  studentId: [
    'student id', 'studentid', 'student code', 'student no', 'student number',
    'admission number', 'admission no', 'admission no.', 'adm no', 'adm number',
  ],
  govId: ['gov id', 'gov-id', 'govid', 'government id', 'govt id', 'national id', 'id'],
  name: ['student name', 'studentname', 'name', 'full name'],
  class: ['current class', 'class', 'class name', 'classname', 'grade', 'section', 'form'],
  parentPhone: ['parent phone', 'parent number', 'phone', 'second number', 'contact'],
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function headerKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findHeaderColumn(headerRow: unknown[], aliases: string[]): number {
  const aliasSet = new Set(aliases.map(a => headerKey(a)));
  for (let c = 0; c < headerRow.length; c++) {
    const key = headerKey(headerRow[c]);
    if (key && aliasSet.has(key)) return c;
  }
  return -1;
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
  const cols = {
    studentId: findHeaderColumn(headerRow, HEADER_ALIASES.studentId),
    govId: findHeaderColumn(headerRow, HEADER_ALIASES.govId),
    name: findHeaderColumn(headerRow, HEADER_ALIASES.name),
    class: findHeaderColumn(headerRow, HEADER_ALIASES.class),
    parentPhone: findHeaderColumn(headerRow, HEADER_ALIASES.parentPhone),
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
    const studentId = cols.studentId >= 0 ? text(raw[cols.studentId]) : '';
    const govId = cols.govId >= 0 ? text(raw[cols.govId]).replace(/^"|"$/g, '') : '';
    const name = cols.name >= 0 ? text(raw[cols.name]) : '';
    const rawClass = cols.class >= 0 ? text(raw[cols.class]) : '';
    const parentPhone = cols.parentPhone >= 0 ? text(raw[cols.parentPhone]) : '';

    // Fully blank / summary-noise rows are skipped silently.
    if (!studentId && !govId && !name && !rawClass && !parentPhone) continue;
    if (/^\d+\s*students?,?\s*\d*\s*free/i.test(name)) continue;

    out.push({ rowNumber: r + 1, studentId, govId, name, rawClass, parentPhone });
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
      const key = s.govId.trim().toUpperCase();
      byGovId.set(key, [...(byGovId.get(key) ?? []), s]);
    }
    const nameKey = normalizeName(s.name);
    if (nameKey) byName.set(nameKey, [...(byName.get(nameKey) ?? []), s]);
  }

  const rows: ClassImportRow[] = rawRows.map(raw => ({
    ...raw,
    status: 'unmatched',
    matchMethod: null,
    matchedStudentId: null,
    existingName: null,
    fromClass: null,
    toClass: null,
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

    // Priority 2 — Gov/admission ID (must be unique).
    if (!matched && row.govId.trim()) {
      const list = byGovId.get(row.govId.trim().toUpperCase()) ?? [];
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

    // Identifier conflict: the sheet's Student ID does not exist, but the
    // row points at an existing student through a weaker key. Never guess —
    // send it to manual review instead of creating a duplicate.
    if (matched && idNotFound && method !== 'student_id') {
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

      if (idNotFound && row.govId.trim()) {
        issue(row, 'warning', 'STUDENT_ID_NOT_FOUND', `Row ${row.rowNumber}: Student ID ${row.studentId} was not found; matched via Gov ID ${row.govId}.`);
      }

      const resolved = resolveUploadedClass(row.rawClass, knownClasses);
      if (!row.rawClass.trim()) {
        row.status = 'invalid';
        issue(row, 'error', 'MISSING_CLASS', `Row ${row.rowNumber}: Class is required.`);
        continue;
      }
      if (!resolved) {
        row.status = 'invalid';
        issue(row, 'error', 'INVALID_CLASS', `Row ${row.rowNumber}: Class ${row.rawClass} does not exist.`);
        continue;
      }
      row.toClass = resolved;
      row.status = resolved === matched.className ? 'no_change' : 'class_change';
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
    if (!row.rawClass.trim()) {
      row.status = 'invalid';
      issue(row, 'error', 'MISSING_CLASS', `Row ${row.rowNumber}: Class is required for a new student.`);
      continue;
    }
    const resolved = resolveUploadedClass(row.rawClass, knownClasses);
    if (!resolved) {
      row.status = 'invalid';
      issue(row, 'error', 'INVALID_CLASS', `Row ${row.rowNumber}: Class ${row.rawClass} does not exist.`);
      continue;
    }

    row.status = 'new_student';
    row.toClass = resolved;
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
  existingStudent: { id: string; name: string; className: string },
  knownClasses: readonly string[],
): ClassImportRow {
  const updated: ClassImportRow = { ...row, candidates: row.candidates, issues: [...row.issues] };
  updated.matchMethod = 'manual';
  updated.matchedStudentId = existingStudent.id;
  updated.existingName = existingStudent.name;
  updated.fromClass = existingStudent.className;
  updated.candidates = [];

  const resolved = resolveUploadedClass(updated.rawClass, knownClasses);
  if (!updated.rawClass.trim()) {
    updated.status = 'invalid';
    updated.issues = [{ severity: 'error', code: 'MISSING_CLASS', message: `Row ${updated.rowNumber}: Class is required.`, row: updated.rowNumber }];
    return updated;
  }
  if (!resolved) {
    updated.status = 'invalid';
    updated.issues = [{ severity: 'error', code: 'INVALID_CLASS', message: `Row ${updated.rowNumber}: Class ${updated.rawClass} does not exist.`, row: updated.rowNumber }];
    return updated;
  }
  updated.toClass = resolved;
  updated.status = resolved === existingStudent.className ? 'no_change' : 'class_change';
  return updated;
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

  for (const row of rows) {
    if (row.excluded) continue;
    if (row.status === 'class_change' && row.matchedStudentId && row.toClass) {
      changes.push({ studentId: row.matchedStudentId, toClass: row.toClass });
    } else if (row.status === 'new_student' && row.toClass && row.name.trim()) {
      newStudents.push({
        id: row.studentId.trim() || row.assignedId || generateNewStudentId(),
        name: row.name.trim(),
        className: row.toClass,
        govId: row.govId.trim() || null,
        parentPhone: row.parentPhone.trim() || null,
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
export function buildClassImportTemplate(students: Student[]): Blob {
  const data = [...students]
    .sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    .map(s => ({
      'Student ID': s.id,
      'Gov ID': s.govId ?? '',
      'Student Name': s.name,
      'Current Class': s.className,
      'Parent Phone': s.parentPhone ?? '',
    }));
  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Students');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
