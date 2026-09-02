// Pure-logic tests for the supervisor review queue.

import { describe, expect, it } from 'vitest';
import {
  awaitsDecision, confirmedLabel, filterQueue, nextPlanAfter, queueCounts, queuePosition,
  formatWaited, scoreBand, sortQueue, statusInfo, submittingLabel, type QueuePlan,
} from '../lessonReview/reviewQueue';
import type { PlanStatus } from '../../types';

const plan = (id: string, status: PlanStatus, updated = '2026-09-01T10:00:00Z'): QueuePlan => ({
  id,
  teacher_id: 't1',
  subject_id: null,
  class_name: 'Grade 7-A',
  title: `Plan ${id}`,
  week_label: 'W1',
  period_count: 6,
  status,
  created_at: updated,
  updated_at: updated,
} as unknown as QueuePlan);

describe('scoreBand', () => {
  it.each([
    [100, 'excellent', 'Excellent'],
    [90, 'excellent', 'Excellent'],
    [89, 'strong', 'Strong'],
    [75, 'strong', 'Strong'],
    [74, 'attention', 'Needs attention'],
    [60, 'attention', 'Needs attention'],
    [59, 'weak', 'Weak'],
    [0, 'weak', 'Weak'],
  ])('%i%% is %s', (pct, band, label) => {
    expect(scoreBand(pct).band).toBe(band);
    expect(scoreBand(pct).label).toBe(label);
  });

  it('always supplies a non-colour glyph so the band survives greyscale', () => {
    for (const pct of [95, 80, 65, 20]) {
      expect(scoreBand(pct).glyph.trim().length).toBeGreaterThan(0);
    }
  });

  it('clamps nonsense scores instead of throwing', () => {
    expect(scoreBand(130).band).toBe('excellent');
    expect(scoreBand(-10).band).toBe('weak');
    expect(scoreBand(Number.NaN).band).toBe('weak');
  });
});

describe('awaitsDecision', () => {
  it('treats ai_failed as actionable — the supervisor decides without a score', () => {
    expect(awaitsDecision('ai_failed')).toBe(true);
    expect(awaitsDecision('submitted')).toBe(true);
    expect(awaitsDecision('in_review')).toBe(true);
  });

  it('excludes plans that are already decided or back with the teacher', () => {
    expect(awaitsDecision('approved')).toBe(false);
    expect(awaitsDecision('rejected')).toBe(false);
    expect(awaitsDecision('revision_requested')).toBe(false);
    expect(awaitsDecision('draft')).toBe(false);
  });
});

describe('statusInfo', () => {
  it('gives every status a label and a non-colour glyph', () => {
    const statuses: PlanStatus[] = [
      'draft', 'submitted', 'in_review', 'approved', 'rejected', 'ai_failed', 'revision_requested',
    ];
    for (const s of statuses) {
      const info = statusInfo(s);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.glyph.length).toBeGreaterThan(0);
      // Never leak a raw snake_case status to the supervisor.
      expect(info.label).not.toContain('_');
    }
  });
});

describe('sortQueue', () => {
  it('puts plans awaiting a decision first, oldest first', () => {
    const sorted = sortQueue([
      plan('approved-1', 'approved', '2026-09-05T10:00:00Z'),
      plan('new', 'submitted', '2026-09-04T10:00:00Z'),
      plan('old', 'in_review', '2026-09-01T10:00:00Z'),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['old', 'new', 'approved-1']);
  });

  it('orders already-decided plans newest first', () => {
    const sorted = sortQueue([
      plan('older', 'approved', '2026-09-01T10:00:00Z'),
      plan('newer', 'rejected', '2026-09-08T10:00:00Z'),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate the input array', () => {
    const input = [plan('a', 'approved'), plan('b', 'submitted')];
    const copy = [...input];
    sortQueue(input);
    expect(input).toEqual(copy);
  });
});

describe('filterQueue + queueCounts', () => {
  const plans = [
    plan('a', 'submitted'), plan('b', 'approved'), plan('c', 'ai_failed'),
    plan('d', 'revision_requested'), plan('e', 'in_review'),
  ];

  it('"awaiting" keeps only plans needing a decision', () => {
    expect(filterQueue(plans, 'awaiting').map((p) => p.id)).toEqual(['a', 'c', 'e']);
  });

  it('"all" keeps everything, a status filter keeps exactly that status', () => {
    expect(filterQueue(plans, 'all')).toHaveLength(5);
    expect(filterQueue(plans, 'approved').map((p) => p.id)).toEqual(['b']);
  });

  it('counts awaiting vs total', () => {
    expect(queueCounts(plans)).toEqual({ awaiting: 3, total: 5 });
  });
});

describe('nextPlanAfter', () => {
  it('moves FORWARD to the next plan awaiting a decision', () => {
    const visible = [plan('a', 'submitted'), plan('b', 'approved'), plan('c', 'in_review')];
    expect(nextPlanAfter(visible, 'a')?.id).toBe('c');
  });

  it('never returns the plan just decided', () => {
    const visible = [plan('a', 'submitted'), plan('b', 'submitted')];
    // 'a' is still 'submitted' in a stale list; it must still be skipped.
    expect(nextPlanAfter(visible, 'a')?.id).toBe('b');
  });

  it('wraps to the first awaiting plan when the current one is last', () => {
    const visible = [plan('a', 'submitted'), plan('b', 'approved'), plan('c', 'submitted')];
    expect(nextPlanAfter(visible, 'c')?.id).toBe('a');
  });

  it('returns null when nothing else awaits a decision (all caught up)', () => {
    const visible = [plan('a', 'approved'), plan('b', 'rejected'), plan('c', 'revision_requested')];
    expect(nextPlanAfter(visible, 'a')).toBeNull();
  });

  it('returns null for an empty queue and the first item when nothing is selected', () => {
    expect(nextPlanAfter([], null)).toBeNull();
    expect(nextPlanAfter([plan('a', 'submitted')], null)?.id).toBe('a');
  });

  it('falls back to the first candidate when the current plan left the list', () => {
    const visible = [plan('x', 'submitted')];
    expect(nextPlanAfter(visible, 'gone')?.id).toBe('x');
  });
});

describe('queuePosition', () => {
  it('is 1-based and 0 when unknown', () => {
    const visible = [plan('a', 'submitted'), plan('b', 'submitted')];
    expect(queuePosition(visible, 'b')).toBe(2);
    expect(queuePosition(visible, null)).toBe(0);
    expect(queuePosition(visible, 'nope')).toBe(0);
  });
});

describe('decision lifecycle labels', () => {
  it('uses a distinct in-flight verb per decision', () => {
    expect(submittingLabel('approve')).toBe('Approving…');
    expect(submittingLabel('reject')).toBe('Rejecting…');
    expect(submittingLabel('revision')).toBe('Sending back…');
  });

  it('confirms revisions by stating that teacher editing is re-enabled', () => {
    expect(confirmedLabel('revision')).toMatch(/editing has been re-enabled/i);
    expect(confirmedLabel('approve')).toMatch(/approved/i);
    expect(confirmedLabel('reject')).toMatch(/rejected/i);
  });
});

describe('formatWaited', () => {
  it('reads as minutes, hours or days rather than raw arithmetic', () => {
    expect(formatWaited(1)).toBe('1 minute');
    expect(formatWaited(45)).toBe('45 minutes');
    expect(formatWaited(60)).toBe('1 hour');
    expect(formatWaited(150)).toBe('2 hours');
    expect(formatWaited(1440)).toBe('1 day');
    expect(formatWaited(1080)).toBe('18 hours');
    expect(formatWaited(4320)).toBe('3 days');
  });

  it('clamps negatives to zero', () => {
    expect(formatWaited(-5)).toBe('0 minutes');
  });
});
