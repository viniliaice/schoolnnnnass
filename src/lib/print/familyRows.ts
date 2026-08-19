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
