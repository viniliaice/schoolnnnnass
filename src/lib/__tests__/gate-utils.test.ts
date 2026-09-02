import { describe, expect, it } from 'vitest';
import {
  buildBulkReleasePlan, formatGateDigits, gateCanCheck, gateEligibility,
  normalizeGateInput, summarizeBulk,
} from '../gate/gate-utils';

describe('normalizeGateInput', () => {
  it('strips the MBK- prefix', () => {
    expect(normalizeGateInput('MBK-0421')).toBe('0421');
    expect(normalizeGateInput('mbk0421')).toBe('0421');
  });
  it('strips spaces, dashes, and letters', () => {
    expect(normalizeGateInput('04 21')).toBe('0421');
    expect(normalizeGateInput('04-21')).toBe('0421');
    expect(normalizeGateInput('abc')).toBe('');
  });
  it('caps at 6 digits', () => {
    expect(normalizeGateInput('1234567890')).toBe('123456');
  });
  it('handles null-ish input', () => {
    expect(normalizeGateInput('')).toBe('');
  });
});

describe('gateCanCheck', () => {
  it('requires at least 4 digits', () => {
    expect(gateCanCheck('0421')).toBe(true);
    expect(gateCanCheck('04210')).toBe(true);
    expect(gateCanCheck('042')).toBe(false);
    expect(gateCanCheck('')).toBe(false);
  });
});

describe('formatGateDigits', () => {
  it('groups 5-6 digits with a space', () => {
    expect(formatGateDigits('0421')).toBe('0421');
    expect(formatGateDigits('04215')).toBe('0421 5');
    expect(formatGateDigits('042156')).toBe('0421 56');
  });
});

describe('gateEligibility (transport → release class)', () => {
  it('walking: WALKER, CAR, and unset are releasable without a driver', () => {
    expect(gateEligibility('WALKER')).toBe('walking');
    expect(gateEligibility('CAR')).toBe('walking');
    expect(gateEligibility('')).toBe('walking');
    expect(gateEligibility(null)).toBe('walking');
    expect(gateEligibility(undefined)).toBe('walking');
  });

  it('driver: DRIVER transport requires an assigned registered driver', () => {
    expect(gateEligibility('DRIVER')).toBe('driver');
    expect(gateEligibility('driver')).toBe('driver'); // normalized to uppercase
  });

  it('bus: numeric transport is excluded from the gate', () => {
    expect(gateEligibility('9')).toBe('excluded');
    expect(gateEligibility('27')).toBe('excluded');
  });

  it('LEFT and unrecognized transports are excluded', () => {
    expect(gateEligibility('LEFT')).toBe('excluded');
    expect(gateEligibility('BIKE')).toBe('excluded');
  });
});

describe('buildBulkReleasePlan', () => {
  const students = [
    { id: 's1', transport: 'WALKER' }, // walking, assigned to d1 (temporary pickup)
    { id: 's2', transport: 'DRIVER' }, // driver, assigned to d1
    { id: 's3', transport: 'DRIVER' }, // driver, assigned to d2
    { id: 's4', transport: '9' },      // bus — never included, even if assigned
    { id: 's5', transport: 'WALKER' }, // walking, unassigned
    { id: 's6', transport: 'DRIVER' }, // driver, unassigned
    { id: 's7', transport: 'LEFT' },   // left — never included
  ];
  const assignments: Record<string, string> = {
    s1: 'd1', s2: 'd1', s3: 'd2', s4: 'd1', s6: '', s7: 'd1',
  };

  it('includes walking AND driver students assigned to that driver', () => {
    expect(buildBulkReleasePlan(students, assignments, 'd1')).toEqual(['s1', 's2']);
  });

  it('never includes bus, LEFT, other drivers, or unassigned students', () => {
    const plan = buildBulkReleasePlan(students, assignments, 'd1');
    expect(plan).not.toContain('s4'); // bus (assigned but excluded)
    expect(plan).not.toContain('s5'); // walking unassigned
    expect(plan).not.toContain('s3'); // other driver
    expect(plan).not.toContain('s6'); // driver unassigned
    expect(plan).not.toContain('s7'); // LEFT
  });
});

describe('summarizeBulk (partial failure)', () => {
  it('counts ok and failed exactly', () => {
    const summary = summarizeBulk([
      { studentId: 'a', ok: true },
      { studentId: 'b', ok: true },
      { studentId: 'c', ok: false },
    ]);
    expect(summary).toEqual({ total: 3, ok: 2, failed: 1 });
  });

  it('never reports full success when part failed', () => {
    const summary = summarizeBulk([
      { studentId: 'a', ok: true },
      { studentId: 'b', ok: false },
    ]);
    expect(summary.ok).toBeLessThan(summary.total);
    expect(summary.failed).toBe(1);
  });
});
