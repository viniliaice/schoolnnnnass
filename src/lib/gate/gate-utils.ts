// Pure helpers for the /gate screen — kept free of DOM/Supabase so they are
// trivially unit-testable (see src/lib/__tests__/gate-utils.test.ts).

import { normalizeTransport } from '../transport';

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

/**
 * Whether a student may be released at the Dismissal Gate, and how.
 *  - 'walking'  → WALKER / CAR / unset: one-click release, no driver.
 *  - 'driver'   → DRIVER transport: release requires an assigned registered driver.
 *  - 'excluded' → bus (numeric), LEFT, or an unrecognized transport: never
 *                 released at the gate (server enforces the same rule).
 */
export type GateEligibility = 'walking' | 'driver' | 'excluded';

export function gateEligibility(transport: string | null | undefined): GateEligibility {
  const value = normalizeTransport(transport);
  if (value === 'WALKER' || value === 'CAR') return 'walking';
  if (value === 'DRIVER') return 'driver';
  return 'excluded';
}

/** A student whose transport is DRIVER and who is assigned to `driverId`. */
export interface BulkStudent {
  id: string;
  transport: string | null | undefined;
}

/**
 * Which students "Release all for driver X" covers.
 * A student is included ONLY when they are a DRIVER-transport student whose
 * assignment is exactly `driverId`. Bus students (numeric transport), walking
 * students, and students assigned to a different driver are excluded — so a
 * bulk action can never release a bus student or the wrong driver's student.
 */
export function buildBulkReleasePlan(
  students: BulkStudent[],
  assignmentByStudent: Record<string, string>,
  driverId: string,
): string[] {
  const eligible: string[] = [];
  for (const s of students) {
    if (gateEligibility(s.transport) !== 'driver') continue;
    if (assignmentByStudent[s.id] !== driverId) continue;
    eligible.push(s.id);
  }
  return eligible;
}

/** Per-student bulk outcome (one record_release attempt per student). */
export interface BulkOutcome {
  studentId: string;
  ok: boolean;
}

/** Summary for the "X of Y released" bulk result. */
export interface BulkSummary {
  total: number;
  ok: number;
  failed: number;
}

export function summarizeBulk(outcomes: BulkOutcome[]): BulkSummary {
  let ok = 0;
  for (const o of outcomes) if (o.ok) ok += 1;
  return { total: outcomes.length, ok, failed: outcomes.length - ok };
}
