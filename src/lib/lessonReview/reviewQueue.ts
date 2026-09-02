// Supervisor review queue — pure logic, no React/Supabase so it stays trivially
// testable (see src/lib/__tests__/lesson-review-queue.test.ts).
//
// This module owns three things the review screen previously did inline and
// inconsistently:
//   1. AI score banding (a NAMED band, never colour alone).
//   2. What counts as "still needs a decision" vs "already decided".
//   3. Which plan the supervisor should move to after deciding one.

import type { LessonPlan, PlanStatus } from '../../types';

/** A plan row as the supervisor queue needs it (list query shape). */
export type QueuePlan = LessonPlan & { teacher_name?: string };

// ─── AI score bands ───────────────────────────────────────────────────────
// The brief fixes these four bands. They are deliberately NOT the same five
// buckets the old scoreTone() used, because a supervisor needs a word, not a
// hue: every band carries a label and a glyph so the meaning survives
// greyscale, colour-blindness, and printing.

export type ScoreBand = 'excellent' | 'strong' | 'attention' | 'weak';

export interface ScoreBandInfo {
  band: ScoreBand;
  /** Human label shown next to the number. */
  label: string;
  /** Non-colour redundant indicator. */
  glyph: string;
  /** Tailwind classes for the score block. */
  tone: string;
  /** Tailwind classes for the small inline chip. */
  chip: string;
}

const BANDS: Record<ScoreBand, ScoreBandInfo> = {
  excellent: {
    band: 'excellent', label: 'Excellent', glyph: '★',
    tone: 'review-chip review-chip-success',
    chip: 'review-chip review-chip-success',
  },
  strong: {
    band: 'strong', label: 'Strong', glyph: '●',
    tone: 'review-chip review-chip-info',
    chip: 'review-chip review-chip-info',
  },
  attention: {
    band: 'attention', label: 'Needs attention', glyph: '▲',
    tone: 'review-chip review-chip-warning',
    chip: 'review-chip review-chip-warning',
  },
  weak: {
    band: 'weak', label: 'Weak', glyph: '■',
    tone: 'review-chip review-chip-danger',
    chip: 'review-chip review-chip-danger',
  },
};

/**
 * Band a 0-100 AI percentage.
 *   90-100 Excellent · 75-89 Strong · 60-74 Needs attention · 0-59 Weak
 * Out-of-range and non-finite input clamps rather than throwing — a bad score
 * from the model must never break the review screen.
 */
export function scoreBand(percentage: number): ScoreBandInfo {
  const pct = Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
  if (pct >= 90) return BANDS.excellent;
  if (pct >= 75) return BANDS.strong;
  if (pct >= 60) return BANDS.attention;
  return BANDS.weak;
}

// ─── Decision status ──────────────────────────────────────────────────────

/**
 * Statuses that still need a supervisor decision.
 * `ai_failed` IS actionable — the supervisor decides manually without a score.
 * `revision_requested` is NOT: the ball is with the teacher.
 */
const AWAITING: PlanStatus[] = ['submitted', 'in_review', 'ai_failed'];

export function awaitsDecision(status: PlanStatus): boolean {
  return AWAITING.includes(status);
}

export interface StatusInfo {
  label: string;
  /** Redundant non-colour marker. */
  glyph: string;
  chip: string;
}

/**
 * One canonical presentation per plan status. Previously the screen had a
 * STATUS_CHIP colour map plus ad-hoc `status.replace('_',' ')` labels in three
 * places, which drifted (e.g. 'submitted' rendered as both "submitted" and
 * "AI review pending"). Everything now reads from here.
 */
export function statusInfo(status: PlanStatus): StatusInfo {
  switch (status) {
    case 'submitted':
      return { label: 'AI review pending', glyph: '◷', chip: 'review-chip review-chip-info' };
    case 'in_review':
      return { label: 'Awaiting decision', glyph: '◆', chip: 'review-chip review-chip-info' };
    case 'ai_failed':
      return { label: 'AI failed — decide manually', glyph: '▲', chip: 'review-chip review-chip-warning' };
    case 'approved':
      return { label: 'Approved', glyph: '✓', chip: 'review-chip review-chip-success' };
    case 'rejected':
      return { label: 'Rejected', glyph: '✕', chip: 'review-chip review-chip-danger' };
    case 'revision_requested':
      return { label: 'Revision requested', glyph: '↩', chip: 'review-chip review-chip-warning' };
    case 'draft':
    default:
      return { label: 'Draft', glyph: '○', chip: 'review-chip review-chip-neutral' };
  }
}

// ─── Queue construction ───────────────────────────────────────────────────

export type QueueFilter = 'awaiting' | 'all' | PlanStatus;

/**
 * Order the queue for a supervisor working top-to-bottom:
 *   plans awaiting a decision first, oldest submission first (fairest to the
 *   teacher who has waited longest), then everything already decided, newest
 *   first (so a supervisor can check recent work).
 */
export function sortQueue(plans: QueuePlan[]): QueuePlan[] {
  const time = (p: QueuePlan) => new Date(p.updated_at || p.created_at || 0).getTime() || 0;
  return [...plans].sort((a, b) => {
    const aWaiting = awaitsDecision(a.status);
    const bWaiting = awaitsDecision(b.status);
    if (aWaiting !== bWaiting) return aWaiting ? -1 : 1;
    return aWaiting ? time(a) - time(b) : time(b) - time(a);
  });
}

export function filterQueue(plans: QueuePlan[], filter: QueueFilter): QueuePlan[] {
  if (filter === 'all') return plans;
  if (filter === 'awaiting') return plans.filter((p) => awaitsDecision(p.status));
  return plans.filter((p) => p.status === filter);
}

/** Counts for the queue header. */
export function queueCounts(plans: QueuePlan[]): { awaiting: number; total: number } {
  let awaiting = 0;
  for (const p of plans) if (awaitsDecision(p.status)) awaiting += 1;
  return { awaiting, total: plans.length };
}

/**
 * The plan to jump to after deciding `currentId`.
 *
 * Rules, in order:
 *  1. Prefer the next plan still AWAITING a decision that appears AFTER the
 *     current one in the visible list — the supervisor keeps moving forward
 *     rather than bouncing back to the top.
 *  2. Otherwise wrap to the first awaiting plan before it.
 *  3. Never return the plan just decided (it no longer awaits a decision).
 *  4. Return null when the queue is clear — the caller shows "All caught up".
 *
 * `visible` must be the list the supervisor can actually see, so "next" always
 * matches what is on screen rather than some hidden global ordering.
 */
export function nextPlanAfter(visible: QueuePlan[], currentId: string | null): QueuePlan | null {
  const candidates = visible.filter((p) => awaitsDecision(p.status) && p.id !== currentId);
  if (candidates.length === 0) return null;
  if (!currentId) return candidates[0];

  const index = visible.findIndex((p) => p.id === currentId);
  if (index === -1) return candidates[0];

  for (let i = index + 1; i < visible.length; i += 1) {
    const p = visible[i];
    if (awaitsDecision(p.status) && p.id !== currentId) return p;
  }
  return candidates[0];
}

/** 1-based position of a plan in the visible queue, for "12 of 40". */
export function queuePosition(visible: QueuePlan[], planId: string | null): number {
  if (!planId) return 0;
  return visible.findIndex((p) => p.id === planId) + 1;
}

// ─── Decision lifecycle ───────────────────────────────────────────────────
// Explicit states so the UI can never show a success it has not been told
// about by the server.

export type DecisionKind = 'approve' | 'reject' | 'revision';

export type DecisionPhase =
  | { phase: 'idle' }
  | { phase: 'submitting'; kind: DecisionKind }
  | { phase: 'done'; kind: DecisionKind }
  | { phase: 'error'; kind: DecisionKind; message: string };

export const IDLE: DecisionPhase = { phase: 'idle' };

/** Verb shown on the button while the request is in flight. */
export function submittingLabel(kind: DecisionKind): string {
  return kind === 'approve' ? 'Approving…' : kind === 'reject' ? 'Rejecting…' : 'Sending back…';
}

/** Confirmation shown only AFTER the server accepted the decision. */
export function confirmedLabel(kind: DecisionKind): string {
  return kind === 'approve'
    ? 'Lesson plan approved.'
    : kind === 'reject'
      ? 'Lesson plan rejected.'
      : 'Sent back for revisions. Teacher editing has been re-enabled.';
}

/**
 * Humanise a waiting duration. A stuck plan can sit for days, and
 * "No AI review after 1080 minutes" is arithmetic the supervisor should not
 * have to do — it reads as a bug rather than a stale job.
 */
export function formatWaited(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
