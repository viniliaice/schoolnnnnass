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

/** Display label for a stored transport value ('9' → 'Bus 9'). */
export function transportLabel(transport: string | null | undefined): string {
  if (!transport) return '—';
  if (transport === 'WALKER' || transport === 'CAR') return transport;
  if (/^\d+$/.test(transport)) return `Bus ${transport}`;
  return transport;
}

/** '0421' → 'MBK-0421' (prefix is print/display only, per design decision 8). */
export function displayFamilyId(familyId: string | null | undefined): string {
  if (!familyId) return '—';
  const digits = familyId.replace(/\D/g, '');
  return digits ? `MBK-${digits.padStart(4, '0')}` : familyId;
}
