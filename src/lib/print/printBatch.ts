// Print-batch resolution — the single place where "what the staff selected"
// becomes "which cards get printed".
//
// TWO PRINT MODES, and the distinction is mandatory:
//
//   kind: 'families'  → FAMILY PRINT. Print the COMPLETE active family. Used
//                       by the row Print button and "print all" when no
//                       student-level filter narrows the roster.
//
//   kind: 'students'  → STUDENT / TRANSPORT PRINT. Print ONLY the selected
//                       students. Siblings that were not selected must NOT be
//                       added back. A card still groups by family (that is
//                       the physical artifact), but it lists only the members
//                       that were actually selected.
//
// Why this matters: filtering to WALKER and pressing Print must not print the
// bus-riding siblings. Collapsing student selection into familyIds[] loses
// exactly that distinction, so the two modes never share a code path here.
//
// This module is deliberately pure: no Supabase, no React, no I/O. It cannot
// allocate a family ID, and it only ever returns IDs that already exist on
// the roster it was handed.

import type { Student } from '../../types';

/**
 * Where a print request came from — and therefore which mode applies.
 * 'families' expands to the full roster; 'students' never does.
 */
export type PrintSource =
  | { kind: 'families'; familyIds: string[] }
  | { kind: 'students'; studentIds: string[] };

/** One card that will be printed. */
export interface ResolvedFamily {
  familyId: string;
  /**
   * The students to RENDER on this card.
   * - family mode: the complete active roster
   * - student mode: only the selected students
   */
  students: Student[];
  /**
   * Active siblings deliberately left off this card because they were not
   * selected (student mode only; always 0 in family mode). Surfaced so the
   * dialog can say so out loud instead of silently printing a partial family.
   */
  omittedSiblings: number;
}

export interface PrintBatch {
  /** Deduped, sorted by familyId — exactly one entry per card. */
  families: ResolvedFamily[];
  /** Number of cards that will print (=== families.length). */
  cardCount: number;
  /** Total students rendered across all cards — the real output unit. */
  studentCount: number;
  /** True when siblings were intentionally excluded (student/transport mode). */
  partialFamilies: boolean;
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
 * Resolve a print request to the exact set of cards to render.
 *
 * Shared rules:
 *   1. students who left are excluded
 *   2. students with no family ID are excluded and reported
 *   3. family IDs are normalized, then deduplicated
 *   4. cards sorted by familyId, students within a card by name
 *
 * MODE-SPECIFIC rule 5 — the important one:
 *   'families' → each card carries the FULL active roster, siblings included.
 *   'students' → each card carries ONLY the selected students. Unselected
 *                siblings are counted in `omittedSiblings`, never rendered.
 *
 * Example (family MBK-0003: Axmed BUS 17, Cabdale WALKER, Maxamed BUS 17):
 *   {kind:'families', familyIds:['0003']}            → 1 card, 3 students
 *   {kind:'students', studentIds:['cabdale']}        → 1 card, 1 student
 *                                                      (Axmed/Maxamed omitted)
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

  // Student mode only: which students the user actually chose, per family.
  const selectedByFamily = new Map<string, Student[]>();

  if (source.kind === 'students') {
    const byId = new Map(roster.map(s => [s.id, s]));
    const usedIds = new Set<string>();
    for (const studentId of source.studentIds) {
      const student = byId.get(studentId);
      if (!student) continue;
      if (usedIds.has(student.id)) continue;   // same student listed twice
      usedIds.add(student.id);
      if (hasLeft(student)) { skippedLeft.push(student); continue; }
      const key = normalizeFamilyKey(student.familyId);
      if (!key) { skippedNoFamilyId.push(student); continue; }

      const chosen = selectedByFamily.get(key);
      if (chosen) {
        // A SIBLING of an already-selected student: they share one card, so
        // this merges rather than adding a card. It does NOT pull in
        // unselected siblings.
        chosen.push(student);
        duplicatesMerged += 1;
      } else {
        selectedByFamily.set(key, [student]);
        seen.add(key);
        ordered.push(key);
      }
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
    const active = byFamily.get(key);
    // A family whose every member left (or which isn't on this roster) has
    // nothing printable. Selecting it is a no-op rather than a blank card.
    if (!active || active.length === 0) continue;

    // THE MODE SPLIT. Student mode renders the selection; family mode renders
    // the roster. Never let the former silently become the latter.
    const render = source.kind === 'students' ? (selectedByFamily.get(key) ?? []) : active;
    if (render.length === 0) continue;

    families.push({
      familyId: key,
      students: [...render].sort((a, b) => a.name.localeCompare(b.name)),
      omittedSiblings: source.kind === 'students' ? active.length - render.length : 0,
    });
  }
  families.sort((a, b) => a.familyId.localeCompare(b.familyId));

  return {
    families,
    cardCount: families.length,
    studentCount: families.reduce((n, f) => n + f.students.length, 0),
    partialFamilies: families.some(f => f.omittedSiblings > 0),
    duplicatesMerged,
    skippedNoFamilyId,
    skippedLeft,
  };
}

/** Human summary for the print dialog: "3 students → 2 cards · 1 merged". */
export function describePrintBatch(batch: PrintBatch, source: PrintSource): string {
  const parts: string[] = [];
  const cards = `${batch.cardCount} card${batch.cardCount === 1 ? '' : 's'}`;
  if (source.kind === 'students') {
    // Student mode counts STUDENTS: that is what the user picked, and with
    // partial families it no longer equals the card count.
    const n = batch.studentCount;
    parts.push(`${n} student${n === 1 ? '' : 's'} → ${cards}`);
  } else {
    parts.push(cards);
  }
  if (batch.duplicatesMerged > 0) {
    parts.push(
      batch.duplicatesMerged === 1
        ? '1 sibling shares a card'
        : `${batch.duplicatesMerged} siblings share a card`,
    );
  }
  if (batch.partialFamilies) {
    const omitted = batch.families.reduce((n, f) => n + f.omittedSiblings, 0);
    parts.push(`${omitted} unselected sibling${omitted === 1 ? '' : 's'} not printed`);
  }
  const skipped = batch.skippedNoFamilyId.length + batch.skippedLeft.length;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}
