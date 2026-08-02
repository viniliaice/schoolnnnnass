import { describe, expect, it } from 'vitest';
import {
  displayFamilyId, mapSheetClassCode, normalizeName, normalizePhone,
  parseTransportCell, transportLabel,
} from '../transport';

describe('parseTransportCell', () => {
  it('treats nb/NB/0/empty as WALKER', () => {
    expect(parseTransportCell('nb')).toEqual({ kind: 'walker', value: 'WALKER' });
    expect(parseTransportCell('NB')).toEqual({ kind: 'walker', value: 'WALKER' });
    expect(parseTransportCell('0')).toEqual({ kind: 'walker', value: 'WALKER' });
    expect(parseTransportCell('')).toEqual({ kind: 'walker', value: 'WALKER' });
    expect(parseTransportCell(null)).toEqual({ kind: 'walker', value: 'WALKER' });
  });

  it('treats digits as a bus number', () => {
    expect(parseTransportCell('9')).toEqual({ kind: 'bus', value: '9' });
    expect(parseTransportCell(' 27 ')).toEqual({ kind: 'bus', value: '27' });
  });

  it('flags LEFT and unknown values', () => {
    expect(parseTransportCell('LEFT')).toEqual({ kind: 'left', value: 'LEFT' });
    expect(parseTransportCell('?')).toEqual({ kind: 'unknown', value: '?' });
  });
});

describe('normalizePhone', () => {
  it('strips +252 country prefix (12-digit)', () => {
    expect(normalizePhone('+252634537584')).toBe('634537584');
    expect(normalizePhone('252634537584')).toBe('634537584');
  });
  it('keeps 9-digit numbers and strips non-digits', () => {
    expect(normalizePhone('634537584')).toBe('634537584');
    expect(normalizePhone('0634 537 584')).toBe('0634537584');
  });
  it('returns empty for null/empty', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone('')).toBe('');
  });
});

describe('mapSheetClassCode', () => {
  it('maps observed sheet codes', () => {
    expect(mapSheetClassCode('G2A')).toBe('Grade 2-A');
    expect(mapSheetClassCode('G7A')).toBe('Grade 7-A');
    expect(mapSheetClassCode('KG')).toBe('KG-A');
    expect(mapSheetClassCode('g2a')).toBe('Grade 2-A');
  });
  it('returns null for unknown codes', () => {
    expect(mapSheetClassCode('F3A')).toBeNull();
    expect(mapSheetClassCode('')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('Abdalla Cumar  Maxamud')).toBe('abdalla cumar maxamud');
  });
});

describe('display helpers', () => {
  it('formats MBK-#### with zero padding', () => {
    expect(displayFamilyId('42')).toBe('MBK-0042');
    expect(displayFamilyId('0421')).toBe('MBK-0421');
    expect(displayFamilyId(null)).toBe('—');
  });
  it('labels transport values', () => {
    expect(transportLabel('9')).toBe('Bus 9');
    expect(transportLabel('WALKER')).toBe('WALKER');
    expect(transportLabel(null)).toBe('—');
  });
});
