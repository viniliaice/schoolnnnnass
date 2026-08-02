// Pure helpers for the /gate screen — kept free of DOM/Supabase so they are
// trivially unit-testable (see src/lib/__tests__/gate-utils.test.ts).

/** Strip everything but digits from a family-ID input ('MBK-0421' → '0421'). */
export function normalizeGateInput(raw: string): string {
  return (raw ?? '').replace(/\D/g, '').slice(0, 6);
}

/** Family IDs are 4-digit zero-padded; gate accepts 4-6 digits before lookup. */
export function gateCanCheck(digits: string): boolean {
  return digits.length >= 4;
}

/** Display the input as the user types it (digits only, spaces every 4). */
export function formatGateDigits(digits: string): string {
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}
