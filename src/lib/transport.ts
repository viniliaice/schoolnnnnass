// Shared transport normalization for the family-ID feature.
// Single source of truth: import, admin quick-edit, and print all use these
// so 'nb', 'NB', '0', and '' are never interpreted differently in two places.

export type TransportKind = 'bus' | 'walker' | 'left' | 'unknown';

export interface ParsedTransport {
  kind: TransportKind;
  /** Bus number when kind === 'bus'; otherwise the canonical label. */
  value: string;
}

/** Values in the sheet's Bus column that mean "not on the bus". */
const NON_BUS_MARKERS = new Set(['nb', 'n/b', 'no bus', '0', '-', '']);

/** Values that mean the student left the school. */
const LEFT_MARKERS = new Set(['left', 'left school', 'dropped', 'withdrawn', 'transferred']);

/** Normalize a bus-cell value to a canonical transport string for storage. */
export function parseTransportCell(raw: unknown): ParsedTransport {
  const value = raw == null ? '' : String(raw).trim();
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();

  if (LEFT_MARKERS.has(normalized)) return { kind: 'left', value: 'LEFT' };
  if (NON_BUS_MARKERS.has(normalized)) return { kind: 'walker', value: 'WALKER' };
  if (/^\d+$/.test(normalized)) return { kind: 'bus', value: normalized };
  return { kind: 'unknown', value };
}

/**
 * Normalize a phone number for grouping: digits only; strip the +252 country
 * prefix (Somali numbers are 9 digits after 252). Returns '' when empty.
 */
export function normalizePhone(raw: unknown): string {
  const digits = (raw == null ? '' : String(raw)).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('252')) return digits.slice(3);
  return digits;
}

/**
 * Best-effort map from the Google Sheet's Grade codes to the app's CLASSES
 * names. Unmapped codes return null and are surfaced as import warnings so
 * the admin can extend this map — matching stays name-first, class is only a
 * secondary disambiguator, so an unmapped code never blocks an import.
 */
const SHEET_CLASS_CODE_MAP: Record<string, string> = {
  'KG': 'KG-A', 'KG-A': 'KG-A', 'KG-B': 'KG-B', 'KG-C': 'KG-C', 'KG-D': 'KG-D', 'KG-E': 'KG-E',
  'G1A': 'Grade 1-A', 'G1B': 'Grade 1-B', 'G1C': 'Grade 1-C',
  'G2A': 'Grade 2-A', 'G2B': 'Grade 2-B', 'G2C': 'Grade 2-C',
  'G3A': 'Grade 3-A', 'G3B': 'Grade 3-B', 'G3C': 'Grade 3-C',
  'G4A': 'Grade 4-A', 'G4B': 'Grade 4-B', 'G4C': 'Grade 4-C',
  'G5A': 'Grade 5-A', 'G5B': 'Grade 5-B', 'G5C': 'Grade 5-C',
  'G6A': 'Grade 6-A', 'G6B': 'Grade 6-B', 'G6C': 'Grade 6-C',
  'G7A': 'Grade 7-A', 'G7B': 'Grade 7-B', 'G7C': 'Grade 7-C',
  'G8A': 'Grade 8-A', 'G8B': 'Grade 8-B', 'G8C': 'Grade 8-C',
  'G9A': 'Grade 9-A', 'G9B': 'Grade 9-B', 'G9C': 'Grade 9-C',
  'G10A': 'Grade 10-A', 'G10B': 'Grade 10-B', 'G10C': 'Grade 10-C',
  'G11A': 'Grade 11-A', 'G11B': 'Grade 11-B', 'G11C': 'Grade 11-C',
  'G12A': 'Grade 12-A', 'G12B': 'Grade 12-B', 'G12C': 'Grade 12-C',
};

/** Map a sheet Grade code (e.g. 'G2A', 'KG') to an app CLASSES name, or null. */
export function mapSheetClassCode(code: string): string | null {
  const key = code.trim().toUpperCase().replace(/\s+/g, '');
  return SHEET_CLASS_CODE_MAP[key] ?? null;
}

/** Normalize a student name for matching: lowercase, collapse whitespace. */
export function normalizeName(name: unknown): string {
  return (name == null ? '' : String(name)).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The three choices staff pick from. There is deliberately no 'BUS' stored
 * value: the DB CHECK constraint is
 *   transport IS NULL OR transport IN ('WALKER','CAR','LEFT') OR transport ~ '^\d+$'
 * so a bus rider IS the bus number ('9'). 'BUS' exists only in the UI, where
 * it is paired with a route number and stored as those digits.
 */
export type TransportChoice = 'WALKER' | 'CAR' | 'BUS';

/**
 * Canonical stored transport for a student.
 *
 * BUSINESS RULE: an unset transport means WALKER. The column is nullable and
 * the transport sheet leaves cells blank for children who walk, so NULL / ''
 * is not "unknown" — it is the school's default. Normalizing here, at the
 * single read boundary, keeps cards, table, filters, gate, lookup and badges
 * from each inventing their own answer, WITHOUT a risky bulk UPDATE of live
 * rows (the stored NULL stays NULL; only its interpretation is fixed).
 *
 * 'LEFT' is preserved as-is: it is a status, not a transport mode, and five
 * call sites depend on being able to see it.
 */
export function normalizeTransport(transport: string | null | undefined): string {
  const value = (transport ?? '').trim();
  if (value === '') return 'WALKER';
  if (value === 'LEFT') return 'LEFT';
  const upper = value.toUpperCase();
  if (upper === 'WALKER' || upper === 'CAR') return upper;
  if (/^\d+$/.test(value)) return value;
  return value;
}

/** Which radio button a stored value corresponds to (bus number → 'BUS'). */
export function transportChoiceOf(transport: string | null | undefined): TransportChoice {
  const value = normalizeTransport(transport);
  if (value === 'CAR') return 'CAR';
  if (/^\d+$/.test(value)) return 'BUS';
  return 'WALKER';
}

/** The bus route for a stored value, or '' when the student is not on a bus. */
export function busNumberOf(transport: string | null | undefined): string {
  const value = normalizeTransport(transport);
  return /^\d+$/.test(value) ? value : '';
}

/**
 * Turn a UI choice back into the value the DB accepts.
 * Returns null when BUS is chosen without a route number (caller must block).
 */
export function toStoredTransport(choice: TransportChoice, busNumber: string): string | null {
  if (choice === 'WALKER' || choice === 'CAR') return choice;
  const digits = (busNumber ?? '').replace(/\D/g, '');
  return digits === '' ? null : String(Number(digits));
}

/**
 * Display label for a stored transport value ('9' → 'Bus 9').
 * Empty/NULL renders as WALKER, per the business rule above.
 */
export function transportLabel(transport: string | null | undefined): string {
  const value = normalizeTransport(transport);
  if (value === 'WALKER' || value === 'CAR' || value === 'LEFT') return value;
  if (/^\d+$/.test(value)) return `Bus ${value}`;
  return value;
}

/**
 * Compact grade chip for the printed family card ('Grade 7-A' → 'G7').
 *
 * `students.className` is the authoritative grade source — there is no
 * separate grade/year column on students in any migration, and the app
 * already labels this value "Grade" (StudentDirectory, transport import,
 * gate strings). The card has ~123pt of row width, which is not enough for
 * a full class name beside a real student name (measured: "Xalimo Xasan
 * Maxamed" + "Grade 12-C" = 133.8pt), so the printed chip is compact.
 *
 * NOTE: deliberately NOT named getGrade() — `getGrade(score)` already exists
 * in src/types and means "letter grade from an exam score".
 */
export function formatGradeLabel(className: string | null | undefined): string {
  const value = (className ?? '').trim();
  if (!value) return '';

  const grade = value.match(/^Grade\s+(\d+)/i);
  if (grade) return `G${grade[1]}`;

  const year = value.match(/^Year\s+(\d+)/i);
  if (year) return `Y${year[1]}`;

  const foundation = value.match(/^Foundation\s+([A-Za-z])/i);
  if (foundation) return `F-${foundation[1].toUpperCase()}`;

  if (/^KG/i.test(value)) return 'KG';

  // Unknown/legacy class naming: never throw, never render blank.
  return value.slice(0, 3).toUpperCase();
}

/** '0421' → 'MBK-0421' (prefix is print/display only, per design decision 8). */
export function displayFamilyId(familyId: string | null | undefined): string {
  if (!familyId) return '—';
  const digits = familyId.replace(/\D/g, '');
  return digits ? `MBK-${digits.padStart(4, '0')}` : familyId;
}
