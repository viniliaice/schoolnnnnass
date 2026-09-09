// Canonical subject ordering and header naming for Bulk Upload Grades.
//
// The Example Download must present subjects in a FIXED, predictable order so a
// teacher can copy/paste straight from their Google Sheet without hunting for
// columns. The order is deterministic and must NEVER be driven by:
//   * the database return order
//   * alphabetical sorting
//   * database id
//   * teacher assignment order
//   * the order the teacher clicked the subject checkboxes
//
// This module is the single source of truth for subject order and visible
// subject labels. `buildGradeColumns` (in ./workbook) applies it, so the
// generated workbook, filename ordering, and parser all agree.
//
// The master order determines PLACEMENT only. Which subjects are actually
// included is still decided entirely by the existing subject
// selection/authorization model; unauthorized/unselected subjects are never
// added just because they appear here.

/** The fixed school subject order for the example workbook. */
export const EXAMPLE_SUBJECT_ORDER = [
  'English',
  'Math',
  'Science',
  'Social',
  'Somali',
  'Arabic',
  'Tarabiya',
] as const;

export type CanonicalSubject = (typeof EXAMPLE_SUBJECT_ORDER)[number];

// Normalization aliases → canonical subject. Matching is done on a lowercased,
// whitespace-collapsed, punctuation-stripped form so harmless database naming
// differences ("Mathematics", "Social Studies", "Tarbiya") do not randomly
// change the order or the visible workbook header. Keys are already normalized.
const SUBJECT_ALIASES: Record<string, CanonicalSubject> = {
  english: 'English',
  eng: 'English',

  math: 'Math',
  maths: 'Math',
  mathematics: 'Math',

  science: 'Science',
  sciences: 'Science',

  social: 'Social',
  socialstudies: 'Social',
  socialstudy: 'Social',
  socialscience: 'Social',
  socialsciences: 'Social',

  somali: 'Somali',

  arabic: 'Arabic',

  tarabiya: 'Tarabiya',
  tarbiya: 'Tarabiya',
  tarbiyah: 'Tarabiya',
  tarabiyah: 'Tarabiya',
  tarbia: 'Tarabiya',
};

/** Lowercase, collapse whitespace, and strip non-alphanumeric characters. */
function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Collapses internal whitespace while preserving the original words. */
function trimAndCollapse(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Maps a raw subject name to its canonical form, or `null` when it is not one
 * of the seven master subjects. Unknown subjects are still valid — they are
 * simply placed after all known subjects, preserving their relative order.
 */
export function canonicalSubjectName(name: string): CanonicalSubject | null {
  return SUBJECT_ALIASES[normalizeKey(name)] ?? null;
}

/**
 * Internal/canonical display name used by parsing and validation. Known school
 * subjects normalize to the canonical title-cased name (e.g. Mathematics →
 * Math, Social Studies → Social). Unknown names keep their original wording.
 */
export function workbookSubjectName(name: string): string {
  return canonicalSubjectName(name) ?? trimAndCollapse(name);
}

/**
 * Visible worksheet label for a subject. Known school subjects use the exact
 * required uppercase canonical names (ENGLISH, MATH, ... TARABIYA). Unknown
 * subjects are uppercased as written after collapsing whitespace.
 */
export function workbookSubjectHeader(name: string): string {
  return workbookSubjectName(name).toUpperCase();
}

/** The rank of a subject in the master order; unknown subjects rank last. */
function subjectRank(name: string): number {
  const canonical = canonicalSubjectName(name);
  if (!canonical) return EXAMPLE_SUBJECT_ORDER.length;
  return EXAMPLE_SUBJECT_ORDER.indexOf(canonical);
}

/**
 * Returns the given items reordered into the canonical master order. Items whose
 * subject name is not in the master list keep their original relative order and
 * are appended after all recognized subjects. The sort is STABLE, so two items
 * that map to the same rank preserve their input order.
 *
 * This is generic over the item shape so it can reorder `Subject[]`, plain name
 * strings, or column groups with one implementation.
 */
export function orderByCanonicalSubjects<T>(items: T[], getName: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: subjectRank(getName(item)) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map(entry => entry.item);
}

/** Convenience overload for plain subject-name arrays. */
export function orderSubjectNames(names: string[]): string[] {
  return orderByCanonicalSubjects(names, name => name);
}
