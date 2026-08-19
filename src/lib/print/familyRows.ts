// Row model for the Family IDs table (Phase 2).
//
// Turns the flat student roster into one row per family, and provides the
// search/filter predicates the table uses. Kept pure (no React, no Supabase)
// so the matching rules are unit-testable and identical everywhere.

import { displayFamilyId, normalizeName, normalizeTransport, transportLabel } from '../transport';
import type { Student } from '../../types';

export interface FamilyRow {
  /** Stable row id — the canonical 4-digit family id ('0042'). */
  familyId: string;
  /** 'MBK-0042' for display and search. */
  displayId: string;
  /** Parent/family name, when a linked profile supplied one. */
  parentName: string;
  parentPhone: string;
  /** Active students only (never anyone marked LEFT), sorted by name. */
  students: Student[];
  studentCount: number;
  /** Distinct transport modes across the family, e.g. ['Bus 9', 'WALKER']. */
  transports: string[];
  /** Distinct classes, for the class/grade filter. */
  classNames: string[];
  /**
   * Siblings hidden because they do not match the active transport filter.
   * 0 / undefined when the row is complete.
   */
  hiddenByFilter?: number;
}

/**
 * Build one row per family from the roster.
 *
 * Students marked LEFT keep their familyId (so restoring rejoins the same
 * family) but never appear here — a family whose members have all left is
 * omitted entirely rather than rendered as an empty row.
 */
export function buildFamilyRows(
  students: Student[],
  parentNames?: Map<string, string>,
): FamilyRow[] {
  const groups = new Map<string, Student[]>();
  for (const student of students) {
    if (!student.familyId) continue;
    if (student.transport === 'LEFT') continue;
    const key = student.familyId.replace(/\D/g, '').padStart(4, '0');
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(student);
    else groups.set(key, [student]);
  }

  const rows: FamilyRow[] = [];
  for (const [familyId, kids] of groups) {
    const sorted = [...kids].sort((a, b) => a.name.localeCompare(b.name));
    const transports: string[] = [];
    const classNames: string[] = [];
    for (const s of sorted) {
      // Empty transport is WALKER, never a blank cell.
      const label = transportLabel(s.transport);
      if (label && !transports.includes(label)) transports.push(label);
      if (s.className && !classNames.includes(s.className)) classNames.push(s.className);
    }
    const parentId = sorted.map(s => s.parentId).find(Boolean) ?? null;
    rows.push({
      familyId,
      displayId: displayFamilyId(familyId),
      parentName: (parentId && parentNames?.get(parentId)) || '',
      parentPhone: sorted.map(s => s.parentPhone ?? '').find(p => p.trim() !== '') ?? '',
      students: sorted,
      studentCount: sorted.length,
      transports,
      classNames,
    });
  }
  return rows.sort((a, b) => a.familyId.localeCompare(b.familyId));
}

/**
 * One search box, four search targets (the staff don't know or care which
 * field they're typing): family ID in any form, student name, parent name,
 * or phone. Digit-only queries also match the family id so '42', '0042' and
 * 'MBK-0042' all find the same row.
 */
export function familyRowMatches(row: FamilyRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (row.displayId.toLowerCase().includes(q)) return true;
  if (row.familyId.includes(q)) return true;

  const digits = q.replace(/\D/g, '');
  if (digits && row.familyId.includes(digits)) return true;
  if (digits && row.parentPhone.replace(/\D/g, '').includes(digits)) return true;

  const name = normalizeName(q);
  if (name) {
    if (normalizeName(row.parentName).includes(name)) return true;
    if (row.students.some(s => normalizeName(s.name).includes(name))) return true;
    if (row.students.some(s => normalizeName(s.className).includes(name))) return true;
  }
  return false;
}

export type TransportFilter = 'all' | 'bus' | 'walker' | 'car';

/**
 * Transport filter over the WHOLE family: a mixed family (one walker, one bus
 * rider) matches BOTH 'walker' and 'bus'. The old page tested students[0]
 * only, so a mixed family landed in whichever bucket the first child hit.
 */
export function familyRowMatchesTransport(row: FamilyRow, filter: TransportFilter): boolean {
  if (filter === 'all') return true;
  return row.students.some(s => {
    // Normalized: a student with no transport counts as a WALKER here too.
    const t = normalizeTransport(s.transport);
    if (filter === 'bus') return /^\d+$/.test(t);
    if (filter === 'walker') return t === 'WALKER';
    if (filter === 'car') return t === 'CAR';
    return true;
  });
}

/** Class/grade filter — matches if ANY child is in the selected class. */
export function familyRowMatchesClass(row: FamilyRow, className: string): boolean {
  if (!className) return true;
  return row.classNames.includes(className);
}

/** Apply search + filters together, preserving family-id order. */
export function filterFamilyRows(
  rows: FamilyRow[],
  opts: { query?: string; transport?: TransportFilter; className?: string },
): FamilyRow[] {
  const { query = '', transport = 'all', className = '' } = opts;
  return rows.filter(
    row =>
      familyRowMatches(row, query) &&
      familyRowMatchesTransport(row, transport) &&
      familyRowMatchesClass(row, className),
  );
}

/** Every class present across the given rows, sorted — for the filter list. */
export function classOptions(rows: FamilyRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const c of row.classNames) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ─── STUDENT-LEVEL transport selection ──────────────────────────────────────
//
// Transport belongs to the STUDENT, so the dropdown resolves to a set of
// students, not families. A family with Axmed (bus 17), Cabdale (walker) and
// Maxamed (bus 17) contributes 2 students under 'bus:17' and 1 under 'walker'.
// The family row stays visible so staff keep the family context, but every
// count, selection and print derives from these student ids.

/**
 * A transport selection: 'all', a mode, or one specific bus route.
 * Bus routes are encoded as `bus:17` so 'bus' (any bus) stays distinct from
 * 'bus:17' (that route only).
 */
export type TransportSelection = 'all' | 'walker' | 'car' | 'bus' | `bus:${string}`;

/** Does THIS STUDENT match the selection? Empty transport counts as WALKER. */
export function studentMatchesTransport(student: Student, selection: TransportSelection): boolean {
  if (selection === 'all') return true;
  const t = normalizeTransport(student.transport);
  if (t === 'LEFT') return false;
  if (selection === 'walker') return t === 'WALKER';
  if (selection === 'car') return t === 'CAR';
  if (selection === 'bus') return /^\d+$/.test(t);
  if (selection.startsWith('bus:')) return t === selection.slice(4);
  return true;
}

/** The students matching a transport selection, across the given rows. */
export function studentsMatchingTransport(
  rows: FamilyRow[],
  selection: TransportSelection,
): Student[] {
  const out: Student[] = [];
  for (const row of rows) {
    for (const student of row.students) {
      if (studentMatchesTransport(student, selection)) out.push(student);
    }
  }
  return out;
}

/** Every distinct bus route present, numerically sorted — for the dropdown. */
export function busRouteOptions(rows: FamilyRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    for (const student of row.students) {
      const t = normalizeTransport(student.transport);
      if (/^\d+$/.test(t)) set.add(t);
    }
  }
  return [...set].sort((a, b) => Number(a) - Number(b));
}

/**
 * The full dropdown: All students / Walkers / Car / Any bus / each route.
 * Built from the data, so a school with routes 17 and 18 sees exactly those.
 */
export function transportOptions(rows: FamilyRow[]): Array<[TransportSelection, string]> {
  const opts: Array<[TransportSelection, string]> = [
    ['all', 'All students'],
    ['walker', 'Walkers'],
    ['car', 'Car pickup'],
    ['bus', 'Any bus'],
  ];
  for (const route of busRouteOptions(rows)) {
    opts.push([`bus:${route}` as TransportSelection, `Bus ${route}`]);
  }
  return opts;
}

/** Does any student in this family match? Controls family-row visibility. */
export function familyRowMatchesSelection(row: FamilyRow, selection: TransportSelection): boolean {
  if (selection === 'all') return true;
  return row.students.some(s => studentMatchesTransport(s, selection));
}

/**
 * Rebuild a row so it contains ONLY the students matching the selection.
 *
 * Row visibility alone is not enough: a mixed family would still LIST every
 * sibling under a WALKER filter, which reads as though the bus riders are
 * walkers. When a transport is chosen the row must show the matching students
 * and nothing else — the student count, the transport column and the printed
 * output all follow from this narrowed set.
 *
 * Returns null when no student in the family matches (row is dropped).
 */
export function narrowRowToSelection(
  row: FamilyRow,
  selection: TransportSelection,
): FamilyRow | null {
  if (selection === 'all') return row;
  const students = row.students.filter(s => studentMatchesTransport(s, selection));
  if (students.length === 0) return null;
  if (students.length === row.students.length) return row;

  const transports: string[] = [];
  const classNames: string[] = [];
  for (const s of students) {
    const label = transportLabel(s.transport);
    if (label && !transports.includes(label)) transports.push(label);
    if (s.className && !classNames.includes(s.className)) classNames.push(s.className);
  }
  return {
    ...row,
    students,
    studentCount: students.length,
    transports,
    classNames,
    /** How many active siblings this filter is hiding, for the row hint. */
    hiddenByFilter: row.students.length - students.length,
  };
}

/** Narrow every row, dropping families with no matching student. */
export function narrowRowsToSelection(
  rows: FamilyRow[],
  selection: TransportSelection,
): FamilyRow[] {
  if (selection === 'all') return rows;
  const out: FamilyRow[] = [];
  for (const row of rows) {
    const narrowed = narrowRowToSelection(row, selection);
    if (narrowed) out.push(narrowed);
  }
  return out;
}
