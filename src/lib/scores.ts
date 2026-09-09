// Shared half-point score helpers.
//
// Grades in this school are recorded in steps of 0.5: a teacher may legitimately
// enter 4, 4.5, 12, or 12.5 for a homework or classwork. The database already
// stores `exams.score` as NUMERIC with a `score * 2 = floor(score * 2)` check
// (see supabase/migrations/20260911_half_point_scores.sql), and the Excel
// pipeline (`interpretScoreCell`) accepts whole/half values.
//
// This module exists so the MANUAL score-entry screens use exactly the same rule
// instead of `parseInt`, which silently truncated 4.5 → 4.
//
// Rules enforced here (identical to the server):
//   * blank                 → no score (never 0)
//   * whole or half points  → accepted (0, 0.5, 1, 1.5, … up to the total)
//   * quarter points (4.25) → rejected
//   * negative / above max  → rejected

/** True for whole numbers and half points (multiples of 0.5), e.g. 4 or 4.5. */
export function isHalfStep(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n * 2);
}

/**
 * Parses a raw score string WITHOUT truncating half points.
 *
 * Returns the numeric score, or `null` when the text is blank or is not a valid
 * whole/half-point number. Never rounds and never floors: "4.5" stays 4.5.
 */
export function parseScoreInput(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  // Full-string match: rejects "4abc", "4.25", "1e3", and stray separators.
  if (!/^\d+(?:\.[05])?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Validates a raw score against a maximum. Returns the parsed score when valid,
 * or `null` when it is blank/invalid. Use together with `isScoreTextInvalid` to
 * distinguish "not entered yet" from "entered but wrong".
 */
export function parseScoreWithin(raw: string | number | null | undefined, total: number): number | null {
  const value = parseScoreInput(raw);
  if (value == null) return null;
  if (value < 0 || value > total) return null;
  return value;
}

/**
 * True when the teacher typed something that is NOT an acceptable score.
 * Blank is not an error — it simply means "no grade entered yet".
 */
export function isScoreTextInvalid(raw: string | number | null | undefined, total: number): boolean {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return false;
  return parseScoreWithin(text, total) == null;
}

/** Formats a score for display without adding trailing zeros: 4 → "4", 4.5 → "4.5". */
export function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return String(value);
}
