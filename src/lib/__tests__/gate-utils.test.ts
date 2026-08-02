import { describe, expect, it } from 'vitest';
import { formatGateDigits, gateCanCheck, normalizeGateInput } from '../gate/gate-utils';

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
