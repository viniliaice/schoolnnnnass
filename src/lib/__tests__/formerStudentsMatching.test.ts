// Former Students / Student Cleanup — MATCHING & SAFETY RULES.
//
// This is the pure contract that the browser preview shows and that
// `_former_evaluate_rows()` implements in SQL (the SQL is authoritative at
// commit time; see formerStudents.cleanup.db.test.ts, which asserts the same
// rules against real PostgreSQL).
//
// The rules under test are the ones the school asked for explicitly:
//   * System ID is the ONLY match key — a name can never identify a student.
//   * Only an exact System ID match whose names agree is "automatically safe".
//   * Missing / unknown / ambiguous System IDs can never be applied.
//   * An ID match with a different name is a strong warning needing review.
//   * Duplicate rows in the file are ambiguous and never auto-applied.
//   * A student already marked former is a no-op.

import { describe, expect, it } from 'vitest';
import {
  canRequestDeactivation,
  evaluateFormerStudentRows,
  nameSimilarity,
  normalizeNameKey,
  normalizeNameKeyLoose,
  requiresExplicitConfirmation,
  selectAllSafeRowNumbers,
  systemIdKey,
  type FormerStudentEvaluation,
} from '../import/formerStudents';
import type { Student } from '../../types';

function student(partial: Partial<Student> & { id: string; name: string }): Student {
  return {
    className: 'Grade 4-B',
    parentId: null,
    createdAt: '2026-01-01',
    status: 'active',
    transport: 'WALKER',
    ...partial,
  } as Student;
}

const STUDENTS: Student[] = [
  student({ id: 'student-123456', name: 'Example Student', className: 'Grade 4-B' }),
  student({ id: 'student-789012', name: 'Aisha Hassan Ali', className: 'Grade 2-C', transport: '7' }),
  student({ id: 'student-555555', name: 'Cabdi-raxmaan Maxamed', className: 'Grade 7-A' }),
  student({ id: 'student-former-1', name: 'Already Gone', className: 'Grade 9-A', status: 'former', transport: 'LEFT' }),
];

function evaluate(rows: Array<{ rowNumber?: number; name: string; systemId: string; action?: string; adminConfirmed?: boolean }>) {
  return evaluateFormerStudentRows(
    rows.map((r, i) => ({ rowNumber: r.rowNumber ?? i + 2, ...r })),
    STUDENTS,
  );
}

function only(res: { rows: FormerStudentEvaluation[] }): FormerStudentEvaluation {
  expect(res.rows).toHaveLength(1);
  return res.rows[0];
}

describe('name normalization (comparison only, never a match key)', () => {
  it('collapses case and whitespace', () => {
    expect(normalizeNameKey('  Aisha   HASSAN  ali ')).toBe('aisha hassan ali');
    expect(normalizeNameKeyLoose('Cabdi-raxmaan Maxamed')).toBe('cabdiraxmaanmaxamed');
    expect(systemIdKey('  STUDENT-123456 ')).toBe('STUDENT-123456');
  });

  it('measures token overlap so the warning can be sized, not so a match can be made', () => {
    expect(nameSimilarity('Aisha Hassan Ali', 'Aisha Hassan Ali')).toBe(1);
    expect(nameSimilarity('Aisha Hassan Ali', 'Aisha Hassan')).toBeCloseTo(0.667, 3);
    expect(nameSimilarity('Example Student', 'Completely Other Person')).toBe(0);
    expect(nameSimilarity('', 'Anyone')).toBe(0);
  });
});

describe('exact System ID matches', () => {
  it('is automatically safe when the names agree exactly', () => {
    const row = only(evaluate([{ name: 'Example Student', systemId: 'student-123456' }]));
    expect(row.matchStatus).toBe('exact_match');
    expect(row.nameMatch).toBe('exact');
    expect(row.autoSafe).toBe(true);
    expect(row.requiresReview).toBe(false);
    expect(row.blocked).toBe(false);
    expect(row.defaultAction).toBe('deactivate');
    expect(row.databaseName).toBe('Example Student');
    expect(row.databaseSystemId).toBe('student-123456');
    expect(row.className).toBe('Grade 4-B');
  });

  it('stays safe when only capitalization or spacing differs', () => {
    const row = only(evaluate([{ name: '   aisha   hassan ALI ', systemId: 'student-789012' }]));
    expect(row.matchStatus).toBe('exact_match');
    expect(row.nameMatch).toBe('normalized');
    expect(row.reasons).toContain('name_case_or_space_difference');
    expect(row.autoSafe).toBe(true);
  });

  it('stays safe when only punctuation differs', () => {
    const row = only(evaluate([{ name: 'Cabdi raxmaan Maxamed', systemId: 'student-555555' }]));
    expect(row.matchStatus).toBe('exact_match');
    expect(row.nameMatch).toBe('normalized');
    expect(row.autoSafe).toBe(true);
  });

  it('matches the System ID case-insensitively', () => {
    const row = only(evaluate([{ name: 'Example Student', systemId: 'STUDENT-123456' }]));
    expect(row.matchStatus).toBe('exact_match');
    expect(row.matchedStudentId).toBe('student-123456');
  });
});

describe('ID match but name different', () => {
  it('is a strong warning, never automatically safe', () => {
    const row = only(evaluate([{ name: 'Somebody Else Entirely', systemId: 'student-123456' }]));
    expect(row.matchStatus).toBe('id_match_name_conflict');
    expect(row.nameMatch).toBe('different');
    expect(row.autoSafe).toBe(false);
    expect(row.requiresReview).toBe(true);
    expect(row.blocked).toBe(false);
    expect(row.defaultAction).toBe('review');
    expect(row.reasons).toContain('name_differs');
    expect(row.reasons).toContain('name_very_different');
    expect(canRequestDeactivation(row)).toBe(true);           // allowed…
    expect(requiresExplicitConfirmation(row)).toBe(true);     // …but only after review
  });

  it('does not shout "very different" for a small spelling drift', () => {
    const row = only(evaluate([{ name: 'Aisha Hassan Aly', systemId: 'student-789012' }]));
    expect(row.matchStatus).toBe('id_match_name_conflict');
    expect(row.reasons).toContain('name_differs');
    expect(row.reasons).not.toContain('name_very_different');
    expect(Number(row.nameSimilarity)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('rows that can NEVER be applied', () => {
  it('missing System ID → requires review, blocked, no match attempted', () => {
    const res = evaluate([{ name: 'Example Student', systemId: '' }]);
    const row = only(res);
    expect(row.matchStatus).toBe('requires_review');
    expect(row.reasons).toContain('missing_system_id');
    expect(row.blocked).toBe(true);
    expect(row.defaultAction).toBe('none');
    expect(row.matchedStudentId).toBeNull();
    expect(row.databaseName).toBeNull();
    expect(canRequestDeactivation(row)).toBe(false);
    expect(res.summary.missingSystemIds).toBe(1);
  });

  it('never matches on the name alone: a known name with an unknown ID is Not Found', () => {
    const res = evaluate([{ name: 'Example Student', systemId: 'student-does-not-exist' }]);
    const row = only(res);
    expect(row.matchStatus).toBe('not_found');
    expect(row.reasons).toContain('system_id_not_found');
    expect(row.matchedStudentId).toBeNull();
    expect(row.blocked).toBe(true);
    expect(row.defaultAction).toBe('none');
    expect(canRequestDeactivation(row)).toBe(false);
    expect(res.summary.notFoundInDatabase).toBe(1);
    expect(res.summary.foundInDatabase).toBe(0);
  });

  it('a System ID shared by several database records is ambiguous and blocked', () => {
    const duplicated = [
      ...STUDENTS,
      student({ id: 'student-123456', name: 'Example Student Copy', className: 'Grade 4-B' }),
    ];
    const res = evaluateFormerStudentRows(
      [{ rowNumber: 2, name: 'Example Student', systemId: 'student-123456' }],
      duplicated,
    );
    const row = res.rows[0];
    expect(row.matchStatus).toBe('requires_review');
    expect(row.reasons).toContain('multiple_database_matches');
    expect(row.blocked).toBe(true);
    expect(row.defaultAction).toBe('none');
    expect(canRequestDeactivation(row)).toBe(false);
  });

  it('a missing name cannot be verified even when the System ID matches', () => {
    const row = only(evaluate([{ name: '', systemId: 'student-123456' }]));
    expect(row.autoSafe).toBe(false);
    expect(row.requiresReview).toBe(true);
    expect(row.nameMatch).toBe('missing');
    expect(row.reasons).toContain('missing_name');
    expect(row.reasons).toContain('name_unverified');
    expect(row.defaultAction).toBe('review');
  });
});

describe('ambiguous uploaded files', () => {
  it('a System ID appearing twice makes BOTH rows Possible Duplicate', () => {
    const res = evaluate([
      { name: 'Example Student', systemId: 'student-123456' },
      { name: 'Example Student', systemId: 'student-123456' },
    ]);
    expect(res.rows.map(r => r.matchStatus)).toEqual(['possible_duplicate', 'possible_duplicate']);
    expect(res.rows.every(r => r.autoSafe === false)).toBe(true);
    expect(res.rows.every(r => r.requiresReview)).toBe(true);
    expect(res.rows.every(r => r.reasons.includes('duplicate_system_id_in_file'))).toBe(true);
    expect(res.summary.duplicateSystemIds).toBe(2);
    expect(res.summary.readyToDeactivate).toBe(0);
  });

  it('the same name under two different System IDs is Possible Duplicate too', () => {
    const res = evaluate([
      { name: 'Example Student', systemId: 'student-123456' },
      { name: 'example student', systemId: 'student-789012' },
    ]);
    expect(res.rows.map(r => r.matchStatus)).toEqual(['possible_duplicate', 'possible_duplicate']);
    expect(res.summary.duplicateNames).toBe(2);
    expect(res.summary.exactMatches).toBe(0);
  });
});

describe('students who already left', () => {
  it('an already-former student is a no-op, never re-applied', () => {
    const res = evaluate([{ name: 'Already Gone', systemId: 'student-former-1' }]);
    const row = only(res);
    expect(row.matchStatus).toBe('already_former');
    expect(row.reasons).toContain('already_former');
    expect(row.autoSafe).toBe(false);
    expect(row.defaultAction).toBe('none');
    expect(canRequestDeactivation(row)).toBe(false);
    expect(res.summary.alreadyFormer).toBe(1);
    expect(res.summary.readyToDeactivate).toBe(0);
  });
});

describe('selection helpers', () => {
  it('Select All Safe Matches only ever selects exact matches', () => {
    const res = evaluate([
      { rowNumber: 2, name: 'Example Student', systemId: 'student-123456' },      // safe
      { rowNumber: 3, name: 'Wrong Name', systemId: 'student-789012' },           // name conflict
      { rowNumber: 4, name: 'Ghost', systemId: 'student-404' },                   // not found
      { rowNumber: 5, name: '', systemId: 'student-555555' },                     // missing name
      { rowNumber: 6, name: 'Already Gone', systemId: 'student-former-1' },       // already former
    ]);
    expect(selectAllSafeRowNumbers(res.rows)).toEqual([2]);
    expect(res.summary.totalUploaded).toBe(5);
    expect(res.summary.foundInDatabase).toBe(4);   // rows 2, 3, 5 and 6 all matched
    expect(res.summary.notFoundInDatabase).toBe(1);
    expect(res.summary.readyToDeactivate).toBe(1); // only row 2
    expect(res.summary.requiresReview).toBe(2);    // name conflict + missing name
    expect(res.summary.noAction).toBe(2);          // not found + already former
    expect(res.summary.blocked).toBe(1);           // the unknown System ID
    expect(res.summary.validRecords).toBe(4);
  });

  it('blocked rows can never be requested for deactivation', () => {
    const res = evaluate([
      { name: 'No Id', systemId: '' },
      { name: 'Ghost', systemId: 'student-404' },
      { name: 'Example Student', systemId: 'student-123456' },
    ]);
    expect(res.rows.map(canRequestDeactivation)).toEqual([false, false, true]);
  });
});

describe('the requested action is carried through for the server', () => {
  it('keeps keep_active / deactivate / review and the per-row confirmation flag', () => {
    const res = evaluate([
      { rowNumber: 2, name: 'Example Student', systemId: 'student-123456', action: 'keep_active' },
      { rowNumber: 3, name: 'Wrong Name', systemId: 'student-789012', action: 'deactivate', adminConfirmed: true },
      { rowNumber: 4, name: 'Aisha Hassan Ali', systemId: 'student-789012', action: 'nonsense' },
    ]);
    expect(res.rows[0].requestedAction).toBe('keep_active');
    expect(res.rows[1].requestedAction).toBe('deactivate');
    expect(res.rows[1].adminConfirmed).toBe(true);
    expect(res.rows[2].requestedAction).toBe('review');   // unknown values normalize to review
  });

  it('the evaluation never depends on what the client asked for', () => {
    const asked = evaluate([{ name: 'Ghost', systemId: 'student-404', action: 'deactivate', adminConfirmed: true }]);
    const notAsked = evaluate([{ name: 'Ghost', systemId: 'student-404' }]);
    expect(asked.rows[0].matchStatus).toBe(notAsked.rows[0].matchStatus);
    expect(asked.rows[0].blocked).toBe(true);
    expect(asked.rows[0].autoSafe).toBe(false);
  });
});
