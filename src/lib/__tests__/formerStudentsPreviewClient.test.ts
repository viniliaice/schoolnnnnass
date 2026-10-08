// Preview client (no Supabase credentials) — Former Students / Student Cleanup.
//
// The repo ships a mock Supabase client so the app is demoable without a
// backend (see marks-entry-preview-client.test.ts for the established pattern).
// This test drives the whole cleanup workflow through that mock: preview →
// apply → directory → history → rollback → restore, asserting the mock honours
// the SAME safety contract as the SQL RPCs (System ID only, nothing deleted,
// review rows need a confirmation, rollback restores the previous transport).

import { describe, expect, it } from 'vitest';
import { isPlaceholderEnv, supabase } from '../supabase';
import {
  applyFormerStudentImport,
  getFormerStudentImport,
  getFormerStudentsPolicy,
  listFormerStudentImports,
  listFormerStudents,
  previewFormerStudentImport,
  rollbackFormerStudentImport,
  setStudentFormerStatus,
} from '../db/formerStudents';
import { getStudents } from '../db/students';

const preview = isPlaceholderEnv ? describe : describe.skip;

preview('former-students preview client', () => {
  it('exposes the documented policy instead of a missing-function error', async () => {
    const policy = await getFormerStudentsPolicy();
    expect(policy?.policyId).toBe('former_students_system_id_match');
    expect(policy?.confirmPhrase).toBe('MARK AS FORMER STUDENTS');
    expect(policy?.rollbackConfirmPhrase).toBe('ROLLBACK IMPORT');
    expect(policy?.neverDeactivateWhen).toContain('only_the_name_matches');
  });

  it('keeps demo leavers out of the active roster but in the directory', async () => {
    const active = await getStudents();
    const everyone = await getStudents(undefined, 'all');
    expect(active.every(s => s.status !== 'former')).toBe(true);
    expect(everyone.length).toBeGreaterThan(active.length);
    expect(everyone.some(s => s.status === 'former')).toBe(true);

    const directory = await listFormerStudents({ search: '', className: null, limit: 50, offset: 0 });
    expect(directory.total).toBe(everyone.length - active.length);
    expect(directory.students.every(s => s.status === 'former')).toBe(true);
    expect(directory.classes.length).toBeGreaterThan(0);
  });

  it('runs the full workflow with the same safety rules as the database', async () => {
    const roster = await getStudents(undefined, 'all');
    const target = roster.find(s => s.status !== 'former' && s.transport && s.transport !== 'LEFT');
    expect(target, 'demo data should contain an active student with a transport value').toBeTruthy();
    const previousTransport = target!.transport ?? null;

    const rows = [
      { rowNumber: 2, name: target!.name, systemId: target!.id },                 // exact match
      { rowNumber: 3, name: 'Somebody Else', systemId: target!.id },              // duplicate ID in file
      { rowNumber: 4, name: 'Ghost Child', systemId: 'student-not-in-demo-data' },// not found
      { rowNumber: 5, name: 'No Id Child', systemId: '' },                        // missing ID
    ];

    // 1. Preview writes nothing.
    const dry = await previewFormerStudentImport(rows);
    expect(dry.dryRun).toBe(true);
    expect(dry.writesPerformed).toBe(0);
    expect(dry.summary.totalUploaded).toBe(4);
    expect(dry.summary.notFoundInDatabase).toBe(1);
    expect(dry.summary.missingSystemIds).toBe(1);
    // The duplicate System ID makes both of its rows ambiguous, never auto-safe.
    expect(dry.rows[0].matchStatus).toBe('possible_duplicate');
    expect(dry.rows[0].autoSafe).toBe(false);
    expect(dry.summary.readyToDeactivate).toBe(0);
    expect((await getStudents(undefined, 'all')).find(s => s.id === target!.id)?.status).not.toBe('former');

    // 2. Apply refuses the unsafe rows and honours the confirmed one.
    const applied = await applyFormerStudentImport([
      { rowNumber: 2, name: target!.name, systemId: target!.id, action: 'deactivate', adminConfirmed: true },
      { rowNumber: 3, name: 'Somebody Else', systemId: target!.id, action: 'deactivate' },
      { rowNumber: 4, name: 'Ghost Child', systemId: 'student-not-in-demo-data', action: 'deactivate' },
      { rowNumber: 5, name: 'No Id Child', systemId: '', action: 'deactivate' },
    ], 'preview-leavers.csv', 'Preview smoke test');

    expect(applied.committed).toBe(true);
    expect(applied.deleted).toBe(0);
    expect(applied.deactivated).toBe(1);                   // only the confirmed exact row
    // Blocked: the unconfirmed duplicate row, the unknown ID and the missing ID.
    expect(applied.blocked).toBe(3);
    const reasons = applied.skippedRows.map(r => r.reason);
    expect(reasons).toContain('requires_manual_review');
    expect(reasons).toContain('system_id_not_found');
    expect(reasons).toContain('missing_system_id');

    const after = (await getStudents(undefined, 'all')).find(s => s.id === target!.id);
    expect(after?.status).toBe('former');
    expect(after?.transport).toBe('LEFT');
    expect(after?.name).toBe(target!.name);                // identity preserved
    expect(after?.className).toBe(target!.className);
    expect(await getStudents()).toHaveLength(
      (await getStudents(undefined, 'all')).filter(s => s.status !== 'former').length);

    // 3. The directory shows who marked them and when.
    const found = await listFormerStudents({ search: target!.id, className: null, limit: 10, offset: 0 });
    expect(found.students.map(s => s.id)).toContain(target!.id);
    const listed = found.students.find(s => s.id === target!.id)!;
    expect(listed.markedFormerAt).toBeTruthy();
    expect(listed.markedFormerByName).toBeTruthy();
    expect(listed.lastChange?.fileName).toBe('preview-leavers.csv');

    // 4. Import history carries the counts and the per-row trail.
    const history = await listFormerStudentImports(10, 0);
    expect(history.total).toBeGreaterThan(0);
    const record = history.imports.find(i => i.id === applied.importId)!;
    expect(record.fileName).toBe('preview-leavers.csv');
    expect(record.uploadedCount).toBe(4);
    expect(record.deactivatedCount).toBeGreaterThanOrEqual(1);
    expect(record.status).toBe('applied');

    const detail = await getFormerStudentImport(applied.importId, 100, 0);
    expect(detail.rowTotal).toBe(4);
    expect(detail.rows.some(r => r.actionTaken === 'blocked' && r.actionReason === 'system_id_not_found')).toBe(true);

    // 5. Rollback needs the phrase, then restores the exact previous transport.
    await expect(rollbackFormerStudentImport(applied.importId, 'nope'))
      .rejects.toThrow(/ROLLBACK IMPORT/);
    const rolled = await rollbackFormerStudentImport(applied.importId, 'ROLLBACK IMPORT');
    expect(rolled.restoredStudentIds).toContain(target!.id);

    const restored = (await getStudents(undefined, 'all')).find(s => s.id === target!.id);
    expect(restored?.status).toBe('active');
    expect(restored?.transport).toBe(previousTransport);

    // 6. One student at a time, both directions.
    await setStudentFormerStatus(target!.id, 'former', 'Manual check');
    expect((await getStudents(undefined, 'all')).find(s => s.id === target!.id)?.status).toBe('former');
    await setStudentFormerStatus(target!.id, 'active', 'Undo manual check');
    const final = (await getStudents(undefined, 'all')).find(s => s.id === target!.id);
    expect(final?.status).toBe('active');
    expect(final?.transport).toBe(previousTransport);
  });

  it('never loses a demo student record, however many imports run', async () => {
    const before = await supabase.from('students').select('id');
    await applyFormerStudentImport(
      [{ rowNumber: 2, name: 'Ghost', systemId: 'student-does-not-exist', action: 'deactivate' }],
      'ghosts.csv',
    );
    const after = await supabase.from('students').select('id');
    expect((after.data ?? []).length).toBe((before.data ?? []).length);
  });
});
