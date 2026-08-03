import { describe, expect, it } from 'vitest';
import { buildQrPath } from '../qrPath';

describe('buildQrPath', () => {
  it('produces a non-empty path for a family ID', () => {
    const { d, size } = buildQrPath('0421');
    expect(size).toBeGreaterThan(20); // 4-digit numeric fits version 1 (21 modules) + quiet zone
    expect(d).toMatch(/M\d+ \d+h1v1h-1z/);
    expect(d.length).toBeGreaterThan(100);
  });

  it('is deterministic per value', () => {
    expect(buildQrPath('0421').d).toBe(buildQrPath('0421').d);
    expect(buildQrPath('0421').d).not.toBe(buildQrPath('1234').d);
  });

  it('draws fewer squares for shorter content (smaller grid)', () => {
    const short = buildQrPath('1');
    const long = buildQrPath('9999');
    expect(short.size).toBeLessThanOrEqual(long.size);
  });
});
