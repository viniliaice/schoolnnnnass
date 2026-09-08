// Pure, unit-testable helpers for the Admin Grade Correction UI. No React, no
// network — the same validation the server enforces, surfaced client-side for
// immediate feedback (the RPC remains the authority).

export type CorrectionEntryState = 'scored' | 'absent' | 'not_applicable';

export interface CorrectionDraft {
  newScoreText: string;      // raw text from the number input
  newEntryState: CorrectionEntryState;
  reason: string;
}

export interface ParsedNewValue {
  score: number | null;
  entryState: CorrectionEntryState;
}

/** Parse the draft into a concrete {score, entryState}, or an error string. */
export function parseNewValue(draft: CorrectionDraft, total: number): ParsedNewValue | string {
  if (draft.newEntryState !== 'scored') {
    return { score: null, entryState: draft.newEntryState };
  }
  const raw = draft.newScoreText.trim();
  if (raw === '') return 'Enter a new score.';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'The score must be a valid number.';
  if (!Number.isInteger(n)) return 'The score must be a whole number.';
  if (n < 0) return 'The score cannot be negative.';
  if (n > total) return `The score must be between 0 and ${total}.`;
  return { score: n, entryState: 'scored' };
}

/** True when the trimmed reason is non-empty and within the length limit. */
export function isReasonValid(reason: string): boolean {
  const t = reason.trim();
  return t.length > 0 && t.length <= 1000;
}

/** True when the new value is actually different from the current value. */
export function isChanged(
  current: { score: number | null; entryState: CorrectionEntryState },
  next: ParsedNewValue,
): boolean {
  return current.score !== next.score || current.entryState !== next.entryState;
}

/**
 * Full gate for enabling the "Review Correction" action. Returns either the
 * parsed value ready to submit, or a human-readable reason it is blocked.
 */
export function validateCorrection(
  draft: CorrectionDraft,
  current: { score: number | null; entryState: CorrectionEntryState },
  total: number,
): ParsedNewValue | string {
  const parsed = parseNewValue(draft, total);
  if (typeof parsed === 'string') return parsed;
  if (!isReasonValid(draft.reason)) return 'A correction reason is required.';
  if (!isChanged(current, parsed)) return 'No correction was made because the new score matches the current score.';
  return parsed;
}

/** Human-readable score for display: '12' or 'Absent' / 'N/A'. */
export function displayScore(score: number | null, entryState: CorrectionEntryState | null): string {
  if (entryState === 'absent') return 'Absent';
  if (entryState === 'not_applicable') return 'N/A';
  return score == null ? '—' : String(score);
}
