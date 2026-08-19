// Print-batch resolution — the single place where "what the staff selected"
// becomes "which cards get printed".
//
// The physical artifact is always a FAMILY card: one MBK-#### per card, with
// the whole sibling roster on it. Selecting students is only an INPUT method
// (staff often think class-by-class), never an output unit — so student
// selection is resolved to unique families here, before anything renders.
//
// This module is deliberately pure: no Supabase, no React, no I/O. It cannot
// allocate a family ID, and it only ever returns IDs that already exist on
// the roster it was handed.

import type { Student } from '../../types';

/** Where a print request came from. */
export type PrintSource =
  | { kind: 'families'; familyIds: string[] }
  | { kind: 'students'; studentIds: string[] };

/** One family that will be printed: its ID plus its COMPLETE active roster. */
export interface ResolvedFamily {
  familyId: string;
  students: Student[];
}

export interface PrintBatch {
  /** Deduped, sorted by familyId — exactly one entry per card. */
  families: ResolvedFamily[];
  /** Number of cards that will print (=== families.length). */
  cardCount: number;
  /** Students that collapsed into a family already in the batch. */
  duplicatesMerged: number;
  /** Selected students with no family ID — reported, never silently dropped. */
  skippedNoFamilyId: Student[];
  /** Selected students who left the school. */
  skippedLeft: Student[];
}

/** Canonical stored form of a family ID: digits, zero-padded to 4. */
export function normalizeFamilyKey(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(4, '0') : '';
}

/** A student who left keeps their familyId but never appears on a card. */
function hasLeft(student: Student): boolean {
  return student.transport === 'LEFT';
}

/**
 * Resolve a print request to the exact set of family cards to render.
 *
 * Rules (identical for both source kinds):
 *   1. students who left are excluded
 *   2. students with no family ID are excluded and reported
 *   3. family IDs are normalized, then deduplicated
 *   4. every resulting family expands to its FULL active roster from
 *      `roster` — including siblings the user did not select
 *   5. families are sorted by familyId, students within a family by name
 *
 * Example: A→0015, B→0015, C→0021 yields 2 cards, not 3.
 */
export function resolvePrintBatch(source: PrintSource, roster: Student[]): PrintBatch {
  // Index the roster once: familyId -> all active students in that family.
  const byFamily = new Map<string, Student[]>();
  for (const student of roster) {
    if (hasLeft(student)) continue;
    const key = normalizeFamilyKey(student.familyId);
    if (!key) continue;
    const list = byFamily.get(key);
    if (list) list.push(student);
    else byFamily.set(key, [student]);
  }

  const skippedNoFamilyId: Student[] = [];
  const skippedLeft: Student[] = [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  let duplicatesMerged = 0;

  if (source.kind === 'students') {
    const byId = new Map(roster.map(s => [s.id, s]));
    for (const studentId of source.studentIds) {
      const student = byId.get(studentId);
      if (!student) continue;
      if (hasLeft(student)) { skippedLeft.push(student); continue; }
      const key = normalizeFamilyKey(student.familyId);
      if (!key) { skippedNoFamilyId.push(student); continue; }
      if (seen.has(key)) { duplicatesMerged += 1; continue; }
      seen.add(key);
      ordered.push(key);
    }
  } else {
    for (const familyId of source.familyIds) {
      const key = normalizeFamilyKey(familyId);
      if (!key) continue;
      if (seen.has(key)) { duplicatesMerged += 1; continue; }
      seen.add(key);
      ordered.push(key);
    }
  }

  const families: ResolvedFamily[] = [];
  for (const key of ordered) {
    const students = byFamily.get(key);
    // A family whose every member left (or which isn't on this roster) has
    // nothing printable. Selecting it is a no-op rather than a blank card.
    if (!students || students.length === 0) continue;
    families.push({
      familyId: key,
      students: [...students].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  families.sort((a, b) => a.familyId.localeCompare(b.familyId));

  return {
    families,
    cardCount: families.length,
    duplicatesMerged,
    skippedNoFamilyId,
    skippedLeft,
  };
}

/** Human summary for the print dialog: "3 students → 2 cards · 1 merged". */
export function describePrintBatch(batch: PrintBatch, source: PrintSource): string {
  const parts: string[] = [];
  if (source.kind === 'students') {
    const n = source.studentIds.length;
    parts.push(`${n} student${n === 1 ? '' : 's'} → ${batch.cardCount} card${batch.cardCount === 1 ? '' : 's'}`);
  } else {
    parts.push(`${batch.cardCount} card${batch.cardCount === 1 ? '' : 's'}`);
  }
  if (batch.duplicatesMerged > 0) {
    parts.push(`${batch.duplicatesMerged} duplicate famil${batch.duplicatesMerged === 1 ? 'y' : 'ies'} merged`);
  }
  const skipped = batch.skippedNoFamilyId.length + batch.skippedLeft.length;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}
