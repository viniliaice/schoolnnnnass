import { describe, expect, it } from 'vitest';
import {
  parseNewValue,
  isReasonValid,
  isChanged,
  validateCorrection,
  displayScore,
  type CorrectionDraft,
} from '../../pages/admin/gradeCorrectionUtils';

const draft = (over: Partial<CorrectionDraft> = {}): CorrectionDraft => ({
  newScoreText: '10',
  newEntryState: 'scored',
  reason: 'Incorrect value entered during bulk upload',
  ...over,
});

describe('gradeCorrectionUtils.parseNewValue', () => {
  it('parses a valid integer within range', () => {
    expect(parseNewValue(draft({ newScoreText: '10' }), 15)).toEqual({ score: 10, entryState: 'scored' });
  });
  it('rejects empty', () => {
    expect(parseNewValue(draft({ newScoreText: '' }), 15)).toMatch(/Enter a new score/);
  });
  it('rejects above maximum', () => {
    expect(parseNewValue(draft({ newScoreText: '16' }), 15)).toMatch(/between 0 and 15/);
  });
  it('rejects negative', () => {
    expect(parseNewValue(draft({ newScoreText: '-1' }), 15)).toMatch(/negative/);
  });
  it('rejects NaN / non-numeric', () => {
    expect(parseNewValue(draft({ newScoreText: 'abc' }), 15)).toMatch(/valid number/);
  });
  it('rejects non-integer', () => {
    expect(parseNewValue(draft({ newScoreText: '10.5' }), 15)).toMatch(/whole number/);
  });
  it('rejects Infinity', () => {
    expect(parseNewValue(draft({ newScoreText: 'Infinity' }), 15)).toMatch(/valid number/);
  });
  it('returns null score for absent/not_applicable', () => {
    expect(parseNewValue(draft({ newEntryState: 'absent' }), 15)).toEqual({ score: null, entryState: 'absent' });
    expect(parseNewValue(draft({ newEntryState: 'not_applicable' }), 15)).toEqual({ score: null, entryState: 'not_applicable' });
  });
});

describe('gradeCorrectionUtils.isReasonValid', () => {
  it('rejects empty and whitespace-only', () => {
    expect(isReasonValid('')).toBe(false);
    expect(isReasonValid('   ')).toBe(false);
  });
  it('accepts a meaningful reason', () => {
    expect(isReasonValid('Verified against mark sheet')).toBe(true);
  });
  it('rejects over 1000 characters', () => {
    expect(isReasonValid('x'.repeat(1001))).toBe(false);
    expect(isReasonValid('x'.repeat(1000))).toBe(true);
  });
});

describe('gradeCorrectionUtils.isChanged', () => {
  it('detects a score change', () => {
    expect(isChanged({ score: 12, entryState: 'scored' }, { score: 10, entryState: 'scored' })).toBe(true);
  });
  it('detects no change', () => {
    expect(isChanged({ score: 12, entryState: 'scored' }, { score: 12, entryState: 'scored' })).toBe(false);
  });
  it('detects an entry-state change (scored 0 vs absent)', () => {
    expect(isChanged({ score: 0, entryState: 'scored' }, { score: null, entryState: 'absent' })).toBe(true);
  });
});

describe('gradeCorrectionUtils.validateCorrection', () => {
  const current = { score: 12, entryState: 'scored' as const };
  it('passes a valid correction', () => {
    expect(validateCorrection(draft({ newScoreText: '10' }), current, 15)).toEqual({ score: 10, entryState: 'scored' });
  });
  it('blocks when reason is missing', () => {
    expect(validateCorrection(draft({ newScoreText: '10', reason: '  ' }), current, 15)).toMatch(/reason is required/);
  });
  it('blocks a no-op correction', () => {
    expect(validateCorrection(draft({ newScoreText: '12' }), current, 15)).toMatch(/matches the current score/);
  });
  it('blocks an out-of-range score before reason is even checked', () => {
    expect(validateCorrection(draft({ newScoreText: '99' }), current, 15)).toMatch(/between 0 and 15/);
  });
});

describe('gradeCorrectionUtils.displayScore', () => {
  it('shows the number when scored', () => {
    expect(displayScore(12, 'scored')).toBe('12');
  });
  it('shows Absent / N/A for non-scored states', () => {
    expect(displayScore(null, 'absent')).toBe('Absent');
    expect(displayScore(null, 'not_applicable')).toBe('N/A');
  });
  it('shows a dash for a missing scored value', () => {
    expect(displayScore(null, 'scored')).toBe('—');
  });
});
