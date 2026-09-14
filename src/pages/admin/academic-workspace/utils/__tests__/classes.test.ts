import { describe, expect, it } from 'vitest';
import { CLASSES } from '../../../../../types';

const EXPECTED_ACTIVE_CLASSES = [
  'Foundation A',
  'Foundation B',
  'Foundation C',
  'KG-A',
  'KG-B',
  'KG-C',
  'Grade 1-A',
  'Grade 1-B',
  'Grade 1-C',
  'Grade 2-A',
  'Grade 2-B',
  'Grade 2-C',
  'Grade 3-A',
  'Grade 3-B',
  'Grade 3-C',
  'Grade 4-A',
  'Grade 4-B',
  'Grade 4-C',
  'Grade 5-A',
  'Grade 5-B',
  'Grade 5-C',
  'Grade 6-A',
  'Grade 6-B',
  'Grade 6-C',
  'Grade 7-A',
  'Grade 7-B',
  'Grade 8-A',
  'Grade 8-B',
  'Grade 9-A',
  'Grade 9-B',
  'Grade 10-A',
  'Grade 10-B',
  'Grade 11-A',
  'Grade 11-B',
  'Grade 12-A',
];

describe('Academic Workspace active class catalogue', () => {
  it('contains exactly the 35 active school classes in display order', () => {
    expect(CLASSES).toEqual(EXPECTED_ACTIVE_CLASSES);
    expect(CLASSES).toHaveLength(35);
    expect(new Set(CLASSES).size).toBe(CLASSES.length);
  });
});
