import { describe, expect, it } from 'vitest';
import { computeSquareCrop } from '../photoResize';

describe('computeSquareCrop', () => {
  it('centers a landscape crop', () => {
    expect(computeSquareCrop(1200, 900)).toEqual({ sx: 150, sy: 0, size: 900 });
  });

  it('centers a portrait crop', () => {
    expect(computeSquareCrop(900, 1200)).toEqual({ sx: 0, sy: 150, size: 900 });
  });

  it('keeps an already-square image unchanged', () => {
    expect(computeSquareCrop(800, 800)).toEqual({ sx: 0, sy: 0, size: 800 });
  });
});
