// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { supabase } from '../supabase';
import { getMergeConflicts, mergeWithResolution } from '../db/duplicateStudents';

describe('Duplicate Students — HIGH SAFETY (enrollment + history + final assertion)', () => {
  beforeEach(() => {
    (globalThis as any).__mockRole = 'admin';
  });

  // Helper to create pair with controlled enrollments
  async function createPair(opts: {
    name: string;
    classA: string; classB: string;
    ayA: string; ayB: string;
    extraOpen?: boolean;
    noOpen?: boolean;
  }) {
    const cid = `stu-safe-can-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const did = `stu-safe-dup-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    await supabase.from('students').insert({ id: cid, name: opts.name, className: opts.classA, parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: opts.name, className: opts.classB, parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    if (!opts.noOpen) {
      await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: opts.classA, academicYearId: opts.ayA, effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
      await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: opts.classB, academicYearId: opts.ayB, effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
      if (opts.extraOpen) {
        await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open2`, studentId: cid, className: opts.classA, academicYearId: opts.ayA, effectiveFrom: '2026-09-02', effectiveTo: null, reason: 'import', sourceRef: 'test2' });
      }
    }
    return { cid, did };
  }

  const baseProfile = { name: 'canonical', govId: 'canonical', parentId: 'canonical', parentPhone: 'canonical', transport: 'canonical', className: 'canonical' };
  const emptyHistory = { exam_resolution: [], attendance_resolution: [], quiz_resolution: [], release_resolution: [], report_comment_resolution: [] };

  // ── Case A: same class + same year → consolidate keep 1, audit provenance ──────
  it('Case A: same class+same year consolidate keeps exactly 1 open and audit', async () => {
    const { cid, did } = await createPair({ name: 'CaseA', classA: 'Grade 1-A', classB: 'Grade 1-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'consolidate', keep: 'canonical' } };
    const result = await mergeWithResolution(cid, did, res, 'case A');
    expect(result.auditId).toBeTruthy();
    const { data: opens } = await supabase.from('student_enrollments').select('id').eq('studentId', cid) as any;
    const openCnt = (opens as any[]).filter((e:any)=> e.effectiveTo == null || !('effectiveTo' in e) ? true : false);
    // In mock, effectiveTo may be null for open; check via direct query
    const openRows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data.filter((r:any)=> r.effectiveTo == null);
    expect(openRows.length).toBe(1);
    expect(openRows[0].className).toBe('Grade 1-A');
    expect(openRows[0].academicYearId).toBe('ay-2026');
    // duplicate must be gone
    const { data: dup } = await supabase.from('students').select('id').eq('id', did).maybeSingle();
    expect(dup).toBeNull();
  });

  it('Case A with explicit keep duplicate replaces canonical with duplicate enrollment', async () => {
    const { cid, did } = await createPair({ name: 'CaseA2', classA: 'Grade 1-A', classB: 'Grade 1-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: { ...baseProfile, className: 'duplicate' }, ...emptyHistory, enrollment_resolution: { action: 'keep_duplicate', keep: 'duplicate' } };
    const result = await mergeWithResolution(cid, did, res, 'case A keep duplicate');
    expect(result.auditId).toBeTruthy();
    const openRows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data.filter((r:any)=> r.effectiveTo == null);
    expect(openRows.length).toBe(1);
  });

  // ── Case B: different class → require explicit keep → exactly 1 open, other historical/closed or blocked ──
  it('Case B: different class without explicit enrollment blocked', async () => {
    const { cid, did } = await createPair({ name: 'CaseBNoExplicit', classA: 'Grade 2-A', classB: 'Grade 3-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory };
    await expect(mergeWithResolution(cid, did, res, 'case B no explicit')).rejects.toThrow(/enrollment|contradictory/i);
    // both still exist (rollback)
    const { data: can } = await supabase.from('students').select('id').eq('id', cid).maybeSingle();
    const { data: dup } = await supabase.from('students').select('id').eq('id', did).maybeSingle();
    expect(can).toBeTruthy();
    expect(dup).toBeTruthy();
  });

  it('Case B: different class explicit keep canonical leaves exactly 1 open (canonical) and duplicate historical closed', async () => {
    const { cid, did } = await createPair({ name: 'CaseBKeepCan', classA: 'Grade 2-A', classB: 'Grade 3-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'keep_canonical', keep: 'canonical' } };
    const result = await mergeWithResolution(cid, did, res, 'case B keep canonical');
    expect(result.auditId).toBeTruthy();
    const rows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data;
    const openRows = rows.filter((r:any)=> r.effectiveTo == null);
    const histRows = rows.filter((r:any)=> r.effectiveTo != null);
    expect(openRows.length).toBe(1);
    expect(openRows[0].className).toBe('Grade 2-A');
    expect(histRows.length).toBe(1); // duplicate closed as historical
    expect(histRows[0].className).toBe('Grade 3-A');
  });

  it('Case B: different class explicit keep duplicate leaves exactly 1 open (duplicate) and canonical historical', async () => {
    const { cid, did } = await createPair({ name: 'CaseBKeepDup', classA: 'Grade 2-A', classB: 'Grade 3-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: { ...baseProfile, className: 'duplicate' }, ...emptyHistory, enrollment_resolution: { action: 'keep_duplicate', keep: 'duplicate' } };
    const result = await mergeWithResolution(cid, did, res, 'case B keep duplicate');
    expect(result.auditId).toBeTruthy();
    const rows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data;
    const openRows = rows.filter((r:any)=> r.effectiveTo == null);
    expect(openRows.length).toBe(1);
    expect(openRows[0].className).toBe('Grade 3-A');
    const histRows = rows.filter((r:any)=> r.effectiveTo != null);
    expect(histRows.length).toBe(1);
    expect(histRows[0].className).toBe('Grade 2-A');
  });

  it('Case B: consolidate with different class rejected', async () => {
    const { cid, did } = await createPair({ name: 'CaseBConsolidateReject', classA: 'Grade 2-A', classB: 'Grade 3-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'consolidate', keep: 'canonical' } };
    await expect(mergeWithResolution(cid, did, res, 'consolidate different class')).rejects.toThrow(/Cannot consolidate/);
  });

  // ── Case C: same class different year → explicit, exactly 1 open+historical ─────
  it('Case C: same class different year without explicit blocked', async () => {
    const { cid, did } = await createPair({ name: 'CaseCNoExplicit', classA: 'Grade 2-A', classB: 'Grade 2-A', ayA: 'ay-2026', ayB: 'ay-2025' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory };
    await expect(mergeWithResolution(cid, did, res, 'case C no explicit')).rejects.toThrow(/enrollment|contradictory|year/i);
  });

  it('Case C: same class different year explicit keep canonical → exactly 1 open + historical', async () => {
    const { cid, did } = await createPair({ name: 'CaseCKeepCan', classA: 'Grade 2-A', classB: 'Grade 2-A', ayA: 'ay-2026', ayB: 'ay-2025' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'keep_canonical', keep: 'canonical' } };
    const result = await mergeWithResolution(cid, did, res, 'case C keep canonical');
    expect(result.auditId).toBeTruthy();
    const rows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data;
    const openRows = rows.filter((r:any)=> r.effectiveTo == null);
    const histRows = rows.filter((r:any)=> r.effectiveTo != null);
    expect(openRows.length).toBe(1);
    expect(openRows[0].academicYearId).toBe('ay-2026');
    expect(histRows.length).toBe(1);
    expect(histRows[0].academicYearId).toBe('ay-2025');
  });

  it('Case C: same class different year explicit keep duplicate → exactly 1 open (duplicate year) + historical', async () => {
    const { cid, did } = await createPair({ name: 'CaseCKeepDup', classA: 'Grade 2-A', classB: 'Grade 2-A', ayA: 'ay-2026', ayB: 'ay-2025' });
    const res: any = { profile_resolution: { ...baseProfile, className: 'duplicate' }, ...emptyHistory, enrollment_resolution: { action: 'keep_duplicate', keep: 'duplicate' } };
    const result = await mergeWithResolution(cid, did, res, 'case C keep duplicate');
    expect(result.auditId).toBeTruthy();
    const rows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data;
    const openRows = rows.filter((r:any)=> r.effectiveTo == null);
    expect(openRows.length).toBe(1);
    expect(openRows[0].academicYearId).toBe('ay-2025');
  });

  // ── Case D: multiple opens → MULTIPLE_OPEN_ENROLLMENTS block ────────────────
  it('Case D: multiple open enrollments blocked', async () => {
    const { cid, did } = await createPair({ name: 'CaseDMulti', classA: 'Grade 2-A', classB: 'Grade 2-A', ayA: 'ay-2026', ayB: 'ay-2026', extraOpen: true });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'consolidate', keep: 'canonical' } };
    await expect(mergeWithResolution(cid, did, res, 'case D')).rejects.toThrow(/multiple open enrollments/i);
  });

  // ── Final open-enrollment assertion (canonical exactly 1, duplicate 0) ───────
  it('Final assertion: canonical exactly 1 open after merge, duplicate 0 open+0 rows', async () => {
    const { cid, did } = await createPair({ name: 'FinalAssert', classA: 'Grade 1-A', classB: 'Grade 1-A', ayA: 'ay-2026', ayB: 'ay-2026' });
    // add historical to test preservation
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-hist`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2025', effectiveFrom: '2025-09-01', effectiveTo: '2026-05-31', reason: 'promotion', sourceRef: 'test' });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'consolidate', keep: 'canonical' } };
    const result = await mergeWithResolution(cid, did, res, 'final assert');
    expect(result.auditId).toBeTruthy();
    const canRows = (await supabase.from('student_enrollments').select('*').eq('studentId', cid) as any).data;
    const canOpen = canRows.filter((r:any)=> r.effectiveTo == null);
    expect(canOpen.length).toBe(1);
    const dupRows = (await supabase.from('student_enrollments').select('*').eq('studentId', did) as any).data;
    expect(dupRows.length).toBe(0);
    const dupOpen = dupRows.filter((r:any)=> r.effectiveTo == null);
    expect(dupOpen.length).toBe(0);
  });

  it('Final assertion fails if merge would leave 0 open (both had no open)', async () => {
    const { cid, did } = await createPair({ name: 'FinalZero', classA: 'Grade 1-A', classB: 'Grade 1-A', ayA: 'ay-2026', ayB: 'ay-2026', noOpen: true });
    const res: any = { profile_resolution: baseProfile, ...emptyHistory, enrollment_resolution: { action: 'consolidate', keep: 'canonical' } };
    await expect(mergeWithResolution(cid, did, res, 'zero open')).rejects.toThrow(/exactly 1 open/i);
  });

  // ── History server validation against EXACT conflict ───────────────────────
  it('Attendance: reject when canonical/duplicate dates do not match exact conflict', async () => {
    const cid = `stu-att-mismatch-a-${Date.now()}`;
    const did = `stu-att-mismatch-b-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'AttMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'AttMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    // Create 1 real conflict (same date) plus extra non-matching for duplicate
    await supabase.from('attendance').insert({ id: `att-${cid}-1`, studentId: cid, className: 'Grade 1-A', date: '2026-09-15', status: 'present', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('attendance').insert({ id: `att-${did}-1`, studentId: did, className: 'Grade 1-A', date: '2026-09-15', status: 'absent', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('attendance').insert({ id: `att-${did}-2`, studentId: did, className: 'Grade 1-A', date: '2026-09-16', status: 'absent', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    // Try to claim mismatch: pair canonical's 2026-09-15 with duplicate's 2026-09-16 (different dates) -> should fail exact identity
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [],
      attendance_resolution: [{ canonical_id: `att-${cid}-1`, duplicate_id: `att-${did}-2`, keep: 'canonical' }],
      quiz_resolution: [], release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'att mismatch')).rejects.toThrow(/do not share identical date/i);
  });

  it('Attendance: reject third-party attendance id (belongs to other student)', async () => {
    const cid = `stu-att-third-a-${Date.now()}`;
    const did = `stu-att-third-b-${Date.now()}`;
    const third = `stu-att-third-c-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'AttThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'AttThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: third, name: 'Third', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${third}-open`, studentId: third, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('attendance').insert({ id: `att-${cid}-1`, studentId: cid, className: 'Grade 1-A', date: '2026-09-15', status: 'present', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('attendance').insert({ id: `att-${did}-1`, studentId: did, className: 'Grade 1-A', date: '2026-09-15', status: 'absent', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('attendance').insert({ id: `att-${third}-1`, studentId: third, className: 'Grade 1-A', date: '2026-09-15', status: 'present', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [],
      attendance_resolution: [{ canonical_id: `att-${third}-1`, duplicate_id: `att-${did}-1`, keep: 'canonical' }],
      quiz_resolution: [], release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'att third')).rejects.toThrow(/not canonical/);
  });

  it('Quiz: reject when quizId does not match exact conflict', async () => {
    const cid = `stu-quiz-mismatch-a-${Date.now()}`;
    const did = `stu-quiz-mismatch-b-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'QuizMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'QuizMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('quiz_attempts').insert({ id: `quiz-${cid}-1`, studentId: cid, quizId: 'quiz-111', answers: [], totalEarned: 5, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    await supabase.from('quiz_attempts').insert({ id: `quiz-${did}-1`, studentId: did, quizId: 'quiz-111', answers: [], totalEarned: 7, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    await supabase.from('quiz_attempts').insert({ id: `quiz-${did}-2`, studentId: did, quizId: 'quiz-222', answers: [], totalEarned: 8, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    // Pair canonical quiz-111 with duplicate quiz-222 (different quizId) -> should fail
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [],
      quiz_resolution: [{ canonical_id: `quiz-${cid}-1`, duplicate_id: `quiz-${did}-2`, keep: 'canonical' }],
      release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'quiz mismatch')).rejects.toThrow(/do not share identical quizId/i);
  });

  it('Quiz: reject third-party quiz id', async () => {
    const cid = `stu-quiz-third-a-${Date.now()}`;
    const did = `stu-quiz-third-b-${Date.now()}`;
    const third = `stu-quiz-third-c-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'QuizThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'QuizThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: third, name: 'Third', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${third}-open`, studentId: third, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('quiz_attempts').insert({ id: `quiz-${cid}-1`, studentId: cid, quizId: 'quiz-123', answers: [], totalEarned: 5, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    await supabase.from('quiz_attempts').insert({ id: `quiz-${did}-1`, studentId: did, quizId: 'quiz-123', answers: [], totalEarned: 7, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    await supabase.from('quiz_attempts').insert({ id: `quiz-${third}-1`, studentId: third, quizId: 'quiz-123', answers: [], totalEarned: 9, totalPossible: 10, startedAt: new Date().toISOString(), submittedAt: new Date().toISOString(), status: 'submitted' } as any);
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [],
      quiz_resolution: [{ canonical_id: `quiz-${third}-1`, duplicate_id: `quiz-${did}-1`, keep: 'canonical' }],
      release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'quiz third')).rejects.toThrow(/not canonical/);
  });

  it('Release: reject when UTC day does not match', async () => {
    const cid = `stu-rel-mismatch-a-${Date.now()}`;
    const did = `stu-rel-mismatch-b-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'RelMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'RelMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('release_log').insert({ id: `rel-${cid}-1`, studentId: cid, createdAt: '2026-09-20T08:00:00Z' } as any);
    await supabase.from('release_log').insert({ id: `rel-${did}-1`, studentId: did, createdAt: '2026-09-20T08:00:00Z' } as any);
    await supabase.from('release_log').insert({ id: `rel-${did}-2`, studentId: did, createdAt: '2026-09-21T08:00:00Z' } as any);
    // Pair same day canonical with different day duplicate
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [], quiz_resolution: [],
      release_resolution: [{ canonical_id: `rel-${cid}-1`, duplicate_id: `rel-${did}-2`, keep: 'canonical' }],
      report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'rel mismatch')).rejects.toThrow(/do not share identical UTC date/i);
  });

  it('Release: reject third-party release id', async () => {
    const cid = `stu-rel-third-a-${Date.now()}`;
    const did = `stu-rel-third-b-${Date.now()}`;
    const third = `stu-rel-third-c-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'RelThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'RelThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: third, name: 'Third', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${third}-open`, studentId: third, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    const day = '2026-09-20T08:00:00Z';
    await supabase.from('release_log').insert({ id: `rel-${cid}-1`, studentId: cid, createdAt: day } as any);
    await supabase.from('release_log').insert({ id: `rel-${did}-1`, studentId: did, createdAt: day } as any);
    await supabase.from('release_log').insert({ id: `rel-${third}-1`, studentId: third, createdAt: day } as any);
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [], quiz_resolution: [],
      release_resolution: [{ canonical_id: `rel-${third}-1`, duplicate_id: `rel-${did}-1`, keep: 'canonical' }],
      report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'rel third')).rejects.toThrow(/not canonical/);
  });

  it('Report: reject when termId does not match', async () => {
    const cid = `stu-rep-mismatch-a-${Date.now()}`;
    const did = `stu-rep-mismatch-b-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'RepMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'RepMismatch', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('report_comments').insert({ id: `rep-${cid}-1`, studentId: cid, termId: 'term-1', teacherComment: 'Good', principalComment: 'Well', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('report_comments').insert({ id: `rep-${did}-1`, studentId: did, termId: 'term-1', teacherComment: 'Great', principalComment: 'Excellent', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('report_comments').insert({ id: `rep-${did}-2`, studentId: did, termId: 'term-2', teacherComment: 'Other', principalComment: 'Other', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    // Pair term-1 canonical with term-2 duplicate (mismatch)
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [], quiz_resolution: [], release_resolution: [],
      report_comment_resolution: [{ canonical_id: `rep-${cid}-1`, duplicate_id: `rep-${did}-2`, keep: 'canonical' }],
      enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'rep mismatch')).rejects.toThrow(/do not share identical termId/i);
  });

  it('Report: reject third-party report id', async () => {
    const cid = `stu-rep-third-a-${Date.now()}`;
    const did = `stu-rep-third-b-${Date.now()}`;
    const third = `stu-rep-third-c-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'RepThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'RepThird', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: third, name: 'Third', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${third}-open`, studentId: third, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('report_comments').insert({ id: `rep-${cid}-1`, studentId: cid, termId: 'term-1', teacherComment: 'Good', principalComment: 'Well', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('report_comments').insert({ id: `rep-${did}-1`, studentId: did, termId: 'term-1', teacherComment: 'Great', principalComment: 'Excellent', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    await supabase.from('report_comments').insert({ id: `rep-${third}-1`, studentId: third, termId: 'term-1', teacherComment: 'Other', principalComment: 'Other', teacherId: 'teacher-1', createdAt: new Date().toISOString() } as any);
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [], attendance_resolution: [], quiz_resolution: [], release_resolution: [],
      report_comment_resolution: [{ canonical_id: `rep-${third}-1`, duplicate_id: `rep-${did}-1`, keep: 'canonical' }],
      enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'rep third')).rejects.toThrow(/not canonical/);
  });

  // ── General rule verify→verify exact conflict→verify no third party→then DELETE/UPDATE ──
  it('General: arbitrary DELETE via client-provided id rejected (verify exact conflict)', async () => {
    const cid = `stu-gen-a-${Date.now()}`;
    const did = `stu-gen-b-${Date.now()}`;
    const third = `stu-gen-c-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'GenTest', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: did, name: 'GenTest', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('students').insert({ id: third, name: 'Third', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: null, familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${third}-open`, studentId: third, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('exams').insert({ id: `exam-${cid}-gen`, studentId: cid, subjectId: 'sub-gen', subject: 'Math', examType: 'Quiz', assessmentLabel: 'Q-01', termId: 'term-1', score: 60, total: 100, status: 'approved', entryState: 'scored', date: '2026-09-01', createdAt: '2026-09-01T08:00:00Z', teacherId: 'teacher-1' });
    await supabase.from('exams').insert({ id: `exam-${did}-gen`, studentId: did, subjectId: 'sub-gen', subject: 'Math', examType: 'Quiz', assessmentLabel: 'Q-01', termId: 'term-1', score: 70, total: 100, status: 'approved', entryState: 'scored', date: '2026-09-01', createdAt: '2026-09-01T08:00:00Z', teacherId: 'teacher-1' });
    await supabase.from('exams').insert({ id: `exam-${third}-gen`, studentId: third, subjectId: 'sub-gen', subject: 'Math', examType: 'Quiz', assessmentLabel: 'Q-01', termId: 'term-1', score: 99, total: 100, status: 'approved', entryState: 'scored', date: '2026-09-01', createdAt: '2026-09-01T08:00:00Z', teacherId: 'teacher-1' });
    // Try to delete third's exam by claiming it's canonical's exam
    const res: any = {
      profile_resolution: baseProfile, exam_resolution: [{ canonical_exam_id: `exam-${third}-gen`, duplicate_exam_id: `exam-${did}-gen`, keep: 'duplicate' }],
      attendance_resolution: [], quiz_resolution: [], release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res, 'arbitrary')).rejects.toThrow(/does not belong to canonical/);
    // Ensure third's exam still exists
    const { data: thirdExam } = await supabase.from('exams').select('id').eq('id', `exam-${third}-gen`).maybeSingle();
    expect(thirdExam).toBeTruthy();
  });

  // ── Rollback: failure after writes restores all ─────────────────────────────────
  it('Rollback: failure after profile update and history writes restores everything', async () => {
    const cid = `stu-rollback-a-${Date.now()}`;
    const did = `stu-rollback-b-${Date.now()}`;
    await supabase.from('students').insert({ id: cid, name: 'RollbackTest', className: 'Grade 1-A', parentId: 'parent-1', govId: 'GOV-ROLL-A', parentPhone: '2526000000', createdAt: new Date().toISOString(), transport: 'Bus 1', familyId: null });
    await supabase.from('students').insert({ id: did, name: 'RollbackTest', className: 'Grade 1-A', parentId: null, govId: null, parentPhone: null, createdAt: new Date().toISOString(), transport: 'Bus 1', familyId: null });
    await supabase.from('student_enrollments').insert({ id: `enr-${cid}-open`, studentId: cid, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('student_enrollments').insert({ id: `enr-${did}-open`, studentId: did, className: 'Grade 1-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'import', sourceRef: 'test' });
    await supabase.from('exams').insert({ id: `exam-${cid}-roll`, studentId: cid, subjectId: 'sub-roll', subject: 'Math', examType: 'Quiz', assessmentLabel: 'Q-01', termId: 'term-1', score: 60, total: 100, status: 'approved', entryState: 'scored', date: '2026-09-01', createdAt: new Date().toISOString(), teacherId: 'teacher-1' });
    await supabase.from('exams').insert({ id: `exam-${did}-roll`, studentId: did, subjectId: 'sub-roll', subject: 'Math', examType: 'Quiz', assessmentLabel: 'Q-01', termId: 'term-1', score: 70, total: 100, status: 'approved', entryState: 'scored', date: '2026-09-01', createdAt: new Date().toISOString(), teacherId: 'teacher-1' });
    // Create a third gov that will cause failure late (after profile would have been updated) — use parent validation failure via non-existent parent after profile stage?
    // Instead trigger exam validation failure by using mismatched identity (will fail after profile applied but before delete, triggering rollback)
    const beforeName = (await supabase.from('students').select('name').eq('id', cid).maybeSingle() as any).data.name;
    const res: any = {
      profile_resolution: { name: 'duplicate', govId: 'canonical', parentId: 'canonical', parentPhone: 'canonical', transport: 'canonical', className: 'canonical' },
      exam_resolution: [{ canonical_exam_id: `exam-${cid}-roll`, duplicate_exam_id: `exam-${did}-roll`, keep: 'canonical' }], // valid exam ids but we will inject a second invalid attendance to force late failure
      attendance_resolution: [], quiz_resolution: [], release_resolution: [], report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    // Inject a fake attendance conflict that doesn't exist to cause late failure — but we have no attendance conflict, so adding one will be wrong length
    // Instead we trigger failure by providing mismatched quiz validation: add quiz attempt with same quizId but we will claim mismatched keep that fails due to enrollment? Simpler: use valid exam but make duplicate enrollment multiple opens to fail after profile
    // Let's add an extra open to canonical to cause final assertion failure after writes (canonical will have 2 opens before merge, but our enrollAction will still be checked)
    // Actually multiple opens is checked before profile, so failure is early. To test rollback after writes, we need a failure that occurs after profile writes.
    // We'll use release mismatch that is validated after profile: add two releases with different days and claim they are same day conflict
    await supabase.from('release_log').insert({ id: `rel-${cid}-roll`, studentId: cid, createdAt: '2026-09-20T08:00:00Z' } as any);
    await supabase.from('release_log').insert({ id: `rel-${did}-roll`, studentId: did, createdAt: '2026-09-20T08:00:00Z' } as any);
    await supabase.from('release_log').insert({ id: `rel-${did}-roll2`, studentId: did, createdAt: '2026-09-21T08:00:00Z' } as any);
    const res2: any = {
      profile_resolution: { name: 'duplicate', govId: 'canonical', parentId: 'canonical', parentPhone: 'canonical', transport: 'canonical', className: 'canonical' },
      exam_resolution: [{ canonical_exam_id: `exam-${cid}-roll`, duplicate_exam_id: `exam-${did}-roll`, keep: 'canonical' }],
      attendance_resolution: [], quiz_resolution: [],
      release_resolution: [{ canonical_id: `rel-${cid}-roll`, duplicate_id: `rel-${did}-roll2`, keep: 'canonical' }],
      report_comment_resolution: [], enrollment_resolution: { action: 'consolidate', keep: 'canonical' }
    };
    await expect(mergeWithResolution(cid, did, res2, 'rollback')).rejects.toThrow(/do not share identical UTC date/i);
    // Verify rollback: profile unchanged, both students still exist, enrollments unchanged, exams unchanged
    const afterName = (await supabase.from('students').select('name').eq('id', cid).maybeSingle() as any).data.name;
    expect(afterName).toBe(beforeName);
    const { data: can } = await supabase.from('students').select('id').eq('id', cid).maybeSingle();
    const { data: dup } = await supabase.from('students').select('id').eq('id', did).maybeSingle();
    expect(can).toBeTruthy();
    expect(dup).toBeTruthy();
    const { data: examCan } = await supabase.from('exams').select('id').eq('id', `exam-${cid}-roll`).maybeSingle();
    const { data: examDup } = await supabase.from('exams').select('id').eq('id', `exam-${did}-roll`).maybeSingle();
    expect(examCan).toBeTruthy();
    expect(examDup).toBeTruthy();
  });
});
