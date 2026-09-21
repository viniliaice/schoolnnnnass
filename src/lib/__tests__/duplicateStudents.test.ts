import { describe, it, expect } from 'vitest';
import { normalizeNameForDuplicate, govKeyLoose, evaluatePair } from '../db/duplicateStudents';
import type { Student } from '../../types';

// Helpers
function makeStudent(overrides: Partial<Student> & { id: string; name: string; className: string }): Student {
  return {
    id: overrides.id,
    name: overrides.name,
    className: overrides.className,
    parentId: overrides.parentId ?? null,
    createdAt: overrides.createdAt ?? '2026-06-01T08:00:00Z',
    govId: overrides.govId ?? null,
    transport: overrides.transport ?? null,
    parentPhone: overrides.parentPhone ?? null,
    familyId: overrides.familyId ?? null,
  };
}

describe('normalizeNameForDuplicate', () => {
  it('trims and lowercases', () => {
    expect(normalizeNameForDuplicate('  Ahmed MOHAMED  ')).toBe('ahmed mohamed');
  });
  it('collapses whitespace', () => {
    expect(normalizeNameForDuplicate('Axmed   yaasiin   ismaaciil')).toBe('axmed yaasiin ismaaciil');
    expect(normalizeNameForDuplicate('Axmed\nyaasiin\tismaaciil')).toBe('axmed yaasiin ismaaciil');
  });
  it('strips punctuation but keeps letters and numbers', () => {
    expect(normalizeNameForDuplicate('Ahmed-Mohamed.')).toBe('ahmedmohamed');
    expect(normalizeNameForDuplicate('  Abshir Cabdi Maxamed!  ')).toBe('abshir cabdi maxamed');
  });
  it('is stable for candidate detector (same input yields same key)', () => {
    const a = normalizeNameForDuplicate('Axmed yaasiin ismaaciil');
    const b = normalizeNameForDuplicate('AXMED YAASIIN ISMAACIIL');
    expect(a).toBe(b);
  });
  it('handles empty and whitespace only', () => {
    expect(normalizeNameForDuplicate('')).toBe('');
    expect(normalizeNameForDuplicate('   ')).toBe('');
  });
});

describe('govKeyLoose', () => {
  it('returns empty for null/undefined/blank', () => {
    expect(govKeyLoose(null)).toBe('');
    expect(govKeyLoose(undefined)).toBe('');
    expect(govKeyLoose('')).toBe('');
    expect(govKeyLoose('   ')).toBe('');
  });
  it('uppercases and strips non-alphanumeric', () => {
    expect(govKeyLoose('mbk-1a-001')).toBe('MBK1A001');
    expect(govKeyLoose(' 123-456 ')).toBe('123456');
    expect(govKeyLoose('AB/12:34')).toBe('AB1234');
  });
  it('is case-insensitive and formatting-insensitive', () => {
    expect(govKeyLoose('123456')).toBe(govKeyLoose('123-456'));
    expect(govKeyLoose('abc')).toBe(govKeyLoose('ABC'));
    expect(govKeyLoose('  MBK-2C-010 ')).toBe('MBK2C010');
  });
});

describe('evaluatePair — evidence strength and risk (no numeric scores)', () => {
  it('Axmed-type: parent assigned vs unassigned with one Gov ID → strong, low risk, high confidence, recommend keep assigned+older', () => {
    const a = makeStudent({ id: 'stu-axmed-a', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: 'parent-1', govId: '123456', createdAt: '2026-03-15T08:00:00Z' });
    const b = makeStudent({ id: 'stu-axmed-b', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: null, govId: null, createdAt: '2026-09-10T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('strong');
    expect(ev.risk).toBe('low');
    expect(ev.canMergeLocal).toBe(true);
    expect(ev.isBlocked).toBe(false);
    expect(ev.isHighConfidence).toBe(true);
    expect(ev.isParentVsUnassigned).toBe(true);
    expect(ev.hasGovId).toBe(true);
    expect(ev.hasSameGov).toBe(false);
    expect(ev.hasConflictingGov).toBe(false);
    expect(ev.bothHaveParents).toBe(false);
    expect(ev.recommendation.keep).toBe('A');
    expect(ev.recommendation.reasons).toEqual(expect.arrayContaining(['Parent assigned']));
  });

  it('Axmed-type reversed: still recommends the parent-assigned side', () => {
    const a = makeStudent({ id: 'a', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: null, govId: null, createdAt: '2026-09-10T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: 'parent-1', govId: '123456', createdAt: '2026-03-15T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('strong');
    expect(ev.risk).toBe('low');
    expect(ev.recommendation.keep).toBe('B');
  });

  it('Ahmed-type: conflicting Gov IDs → critical blocked, conflicting evidence', () => {
    const a = makeStudent({ id: 'stu-ahmed-a', name: 'Ahmed Mohamed', className: 'Grade 5-A', parentId: 'parent-1', govId: '111', createdAt: '2026-01-10T08:00:00Z' });
    const b = makeStudent({ id: 'stu-ahmed-b', name: 'Ahmed Mohamed', className: 'Grade 5-A', parentId: 'parent-2', govId: '222', createdAt: '2026-01-12T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('conflicting');
    expect(ev.risk).toBe('critical');
    expect(ev.canMergeLocal).toBe(false);
    expect(ev.isBlocked).toBe(true);
    expect(ev.blockedReasons).toContain('gov_id_conflict');
    expect(ev.hasConflictingGov).toBe(true);
    expect(ev.hasSameGov).toBe(false);
    expect(ev.evidenceSummary.join(' ')).toMatch(/Different Government IDs/);
  });

  it('Leyla-type: same Gov ID → strong low risk, mergeable, even if one unassigned', () => {
    const a = makeStudent({ id: 'stu-samegov-a', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: 'parent-3', govId: '999888', createdAt: '2026-02-15T08:00:00Z' });
    const b = makeStudent({ id: 'stu-samegov-b', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: null, govId: '999888', createdAt: '2026-05-20T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('strong');
    expect(ev.risk).toBe('low');
    expect(ev.canMergeLocal).toBe(true);
    expect(ev.isHighConfidence).toBe(true);
    expect(ev.hasSameGov).toBe(true);
    expect(ev.hasConflictingGov).toBe(false);
  });

  it('Same Gov ID but both have parents → still strong (shared Gov resolves parent conflict at identity level)', () => {
    const a = makeStudent({ id: 'a', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: 'parent-1', govId: '999888', createdAt: '2026-02-15T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: 'parent-2', govId: '999888', createdAt: '2026-05-20T08:00:00Z' });
    const ev = evaluatePair(a, b);
    // local evaluate does not block on bothHaveParents when sameGov is true
    expect(ev.evidence).toBe('strong');
    expect(ev.canMergeLocal).toBe(true);
    expect(ev.hasSameGov).toBe(true);
    expect(ev.bothHaveParents).toBe(true);
  });

  it('Both have parents without shared Gov → critical blocked', () => {
    const a = makeStudent({ id: 'a', name: 'Ali Farah', className: 'Grade 2-C', parentId: 'parent-1', govId: null, createdAt: '2026-02-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Ali Farah', className: 'Grade 2-C', parentId: 'parent-2', govId: null, createdAt: '2026-02-15T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('conflicting');
    expect(ev.risk).toBe('critical');
    expect(ev.canMergeLocal).toBe(false);
    expect(ev.blockedReasons).toContain('both_have_parents');
    expect(ev.bothHaveParents).toBe(true);
  });

  it('Neither has parent, no Gov → possible, high risk, needs review', () => {
    const a = makeStudent({ id: 'a', name: 'Noor Ali', className: 'Grade 1-A', parentId: null, govId: null, createdAt: '2026-04-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Noor Ali', className: 'Grade 1-A', parentId: null, govId: null, createdAt: '2026-04-15T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('possible');
    expect(ev.risk).toBe('high');
    expect(ev.canMergeLocal).toBe(true);
    expect(ev.isHighConfidence).toBe(false);
    expect(ev.evidenceSummary.join(' ')).toMatch(/Neither record has a parent/);
  });

  it('Parent vs unassigned but unassigned carries Gov ID → downgraded to possible/high risk (government ID belongs to unassigned, review which identity is correct)', () => {
    const a = makeStudent({ id: 'a', name: 'Test Student', className: 'Grade 2-C', parentId: 'parent-1', govId: null, createdAt: '2026-01-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Test Student', className: 'Grade 2-C', parentId: null, govId: '777', createdAt: '2026-02-01T08:00:00Z' });
    const ev = evaluatePair(a, b);
    // per code: oneHasParent but unassigned has Gov -> possible/high
    expect(ev.evidence).toBe('possible');
    expect(ev.risk).toBe('high');
    expect(ev.canMergeLocal).toBe(true);
  });

  it('Parent assigned side with Gov ID → strong, recommended', () => {
    const a = makeStudent({ id: 'a', name: 'Test Student', className: 'Grade 2-C', parentId: 'parent-1', govId: '555', createdAt: '2026-01-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Test Student', className: 'Grade 2-C', parentId: null, govId: null, createdAt: '2026-02-01T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.evidence).toBe('strong');
    expect(ev.risk).toBe('low');
    expect(ev.recommendation.keep).toBe('A');
  });

  it('Recommendation prefers older record when parent/gov scores tie', () => {
    const a = makeStudent({ id: 'a', name: 'Same Student', className: 'Grade 1-A', parentId: null, govId: null, createdAt: '2026-01-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Same Student', className: 'Grade 1-A', parentId: null, govId: null, createdAt: '2026-06-01T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.recommendation.keep).toBe('A');
    expect(ev.recommendation.reasons).toContain('Older established record');
  });

  it('Explainable evidence: never returns numeric score', () => {
    const a = makeStudent({ id: 'a', name: 'X', className: 'Grade 1-A', parentId: null, govId: null });
    const b = makeStudent({ id: 'b', name: 'X', className: 'Grade 1-A', parentId: null, govId: null });
    const ev = evaluatePair(a, b);
    // evidence is textual, not numeric
    expect(typeof ev.evidence).toBe('string');
    expect(typeof ev.risk).toBe('string');
    expect(ev.evidenceSummary.length).toBeGreaterThan(0);
    // ensure no hidden numeric score property
    expect((ev as unknown as Record<string, unknown>).score).toBeUndefined();
    expect((ev as unknown as Record<string, unknown>).confidenceScore).toBeUndefined();
  });

  it('Gov IDs with different formatting are considered same (loose match)', () => {
    const a = makeStudent({ id: 'a', name: 'Same', className: 'Grade 1-A', parentId: 'parent-1', govId: '123-456', createdAt: '2026-01-01T08:00:00Z' });
    const b = makeStudent({ id: 'b', name: 'Same', className: 'Grade 1-A', parentId: null, govId: '123456', createdAt: '2026-02-01T08:00:00Z' });
    const ev = evaluatePair(a, b);
    expect(ev.hasSameGov).toBe(true);
    expect(ev.hasConflictingGov).toBe(false);
  });
});
