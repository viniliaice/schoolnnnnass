// Production preflight for the operator runner (scripts/safe-duplicate-batch-run.mjs).
//
// These tests import the REAL runner module and the REAL preflight module — not
// a copy — so a change to the runner's gating is caught here. Where a check has
// to be answered by PostgreSQL ("is this actor an admin?") the test runs it
// against real PostgreSQL (PGlite) with the shipped migrations, so the answer
// comes from current_profile_role() exactly as it will in production.
//
// The property under test: the runner refuses to execute a merge unless there
// is a genuine authenticated ADMIN identity, and it never even asks for a
// preview when there isn't one.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDuplicateBatchTestDb,
  seedEnrollment,
  seedProfile,
  seedStudent,
  type PgDuplicateDb,
} from './pgDuplicateBatchHarness';
// @ts-expect-error — plain JS operator module, no type declarations.
import { runPreflight } from '../../../scripts/lib/safeBatchPreflight.mjs';
// @ts-expect-error — plain JS operator module, no type declarations.
import { openPglite } from '../../../scripts/safe-duplicate-batch-run.mjs';

type Result = { id: string; label: string; ok: boolean; detail: string };
type Preflight = {
  ok: boolean;
  results: Result[];
  preview: unknown;
  previewSnapshot: { before: { digest: string }; after: { digest: string } } | null;
};

// The uids openPglite()'s seed assigns to its admin and teacher profiles.
const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const TEACHER_UID = '22222222-2222-4222-8222-222222222222';
// A uid with no profile at all.
const STRANGER_UID = '4a7c1d90-1f2b-4c3d-9e5f-6a7b8c9d0e11';

/** A ctx shaped like the runner's supabase target, with a recording rpc stub. */
function stubSupabaseCtx(opts: {
  url?: string | null;
  accessToken?: string | null;
  role?: string | null;
  reachable?: boolean;
}) {
  const calls: string[] = [];
  const ctx = {
    kind: 'supabase' as const,
    supabaseUrl: opts.url === undefined ? 'https://ref.supabase.co' : opts.url,
    accessToken: opts.accessToken === undefined ? 'jwt-token' : opts.accessToken,
    actorLabel: 'stub',
    query: null,
    snapshot: null,
    close: async () => {},
    rpc: async (fn: string) => {
      calls.push(fn);
      if (opts.reachable === false) throw new Error('fetch failed');
      // PostgREST carries the token as the JWT; with no token auth.uid() is
      // NULL and current_profile_role() therefore returns NULL.
      if (fn === 'current_profile_role') {
        if (opts.accessToken === null) return null;
        return opts.role === undefined ? 'admin' : opts.role;
      }
      if (fn === 'safe_duplicate_batch_policy') return { policyId: 'safe_batch_parent_assigned_keeper' };
      if (fn === 'preview_safe_duplicate_batch') {
        return {
          summary: { candidatePairs: 4, safeCount: 2, excludedCount: 2, needsReviewCount: 2, blockedCount: 0 },
          dryRun: true,
          writesPerformed: 0,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { ctx, calls };
}

const byId = (p: Preflight, id: string) => p.results.find((r) => r.id === id);

describe('safe batch runner — production preflight refuses unsafe execution', () => {
  it('refuses when there is no authenticated session, and never asks for a preview', async () => {
    const { ctx, calls } = stubSupabaseCtx({ accessToken: null });
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'session_valid')?.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.ok).toBe(false);
    expect(byId(p, 'operator_confirmed')?.ok).toBe(true); // the flag was given; identity was not
    // The critical property: no preview, no merge, nothing that touches data.
    // current_profile_role() is called twice — once as the reachability probe,
    // once as the role check — and both are read-only.
    expect(new Set(calls)).toEqual(new Set(['current_profile_role']));
    expect(calls).not.toContain('preview_safe_duplicate_batch');
    expect(calls).not.toContain('merge_safe_duplicate_batch');
  });

  it('refuses a signed-in NON-admin, and never asks for a preview', async () => {
    const { ctx, calls } = stubSupabaseCtx({ role: 'teacher' });
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'session_valid')?.ok).toBe(true);
    expect(byId(p, 'actor_is_admin')?.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.detail).toContain("'teacher'");
    expect(calls).not.toContain('preview_safe_duplicate_batch');
  });

  it('refuses when auth.uid() resolves no profile at all (current_profile_role() NULL)', async () => {
    const { ctx } = stubSupabaseCtx({ role: null });
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.detail).toContain('NULL');
  });

  it('refuses when the Supabase URL is not configured', async () => {
    const { ctx } = stubSupabaseCtx({ url: null });
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'target_configured')?.ok).toBe(false);
  });

  it('refuses when the database is unreachable', async () => {
    const { ctx } = stubSupabaseCtx({ reachable: false });
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'database_reachable')?.ok).toBe(false);
    expect(byId(p, 'preview_succeeds')?.ok).toBe(false);
  });

  it('refuses execution without the explicit operator confirmation', async () => {
    const { ctx } = stubSupabaseCtx({});
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: false });
    expect(p.ok).toBe(false);
    expect(byId(p, 'operator_confirmed')?.ok).toBe(false);
    // A read-only dry run is still allowed without --yes.
    const dry: Preflight = await runPreflight(ctx, { execution: false, yes: false });
    expect(byId(dry, 'operator_confirmed')?.ok).toBe(true);
  });

  it('refuses when the database reports blocked records', async () => {
    const { ctx } = stubSupabaseCtx({});
    const blockedPreview = {
      summary: { candidatePairs: 4, safeCount: 1, excludedCount: 3, needsReviewCount: 0, blockedCount: 3 },
      dryRun: true,
      writesPerformed: 0,
    };
    const blockedCtx = {
      ...ctx,
      rpc: async (fn: string) =>
        fn === 'preview_safe_duplicate_batch' ? blockedPreview : ctx.rpc(fn),
    };
    const p: Preflight = await runPreflight(blockedCtx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'no_unexpected_blocked')?.ok).toBe(false);
    expect(byId(p, 'no_unexpected_blocked')?.detail).toContain('blockedCount=3');
  });

  it('the zero-write check is not vacuous: it fails when a table changes across the preview', async () => {
    const { ctx } = stubSupabaseCtx({});
    let n = 0;
    const snapshotCtx = { ...ctx, snapshot: async () => ({ tables: ['students'], digest: `d${(n += 1)}` }) };
    const p: Preflight = await runPreflight(snapshotCtx, { execution: true, yes: true });
    expect(byId(p, 'preview_zero_write')?.ok).toBe(false);
    expect(p.ok).toBe(false);
    // …and passes when nothing changed.
    const stableCtx = { ...ctx, snapshot: async () => ({ tables: ['students'], digest: 'same' }) };
    const p2: Preflight = await runPreflight(stableCtx, { execution: true, yes: true });
    expect(byId(p2, 'preview_zero_write')?.ok).toBe(true);
    expect(p2.previewSnapshot?.before.digest).toBe('same');
    expect(p2.previewSnapshot?.after.digest).toBe('same');
  });

  it('fails every downstream check when the preview itself fails', async () => {
    const { ctx } = stubSupabaseCtx({});
    const failingCtx = {
      ...ctx,
      rpc: async (fn: string) => {
        if (fn === 'preview_safe_duplicate_batch') throw new Error('boom');
        return ctx.rpc(fn);
      },
    };
    const p: Preflight = await runPreflight(failingCtx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    for (const id of ['preview_succeeds', 'preview_zero_write', 'safe_count_reported', 'no_unexpected_blocked']) {
      expect(byId(p, id)?.ok, id).toBe(false);
    }
  });
});

describe('safe batch runner — preflight against real PostgreSQL', () => {
  let runnerCtx: Awaited<ReturnType<typeof openPglite>>;

  beforeAll(async () => {
    // The REAL runner's pglite target, with a small dataset for speed. It seeds
    // an admin AND a teacher profile so the role check can be exercised both ways.
    runnerCtx = await openPglite({ seed: 4, review: 2, merged: 1, keepDb: false });
  }, 120_000);

  afterAll(async () => {
    await runnerCtx?.close();
  });

  it('passes every check for a genuine admin session and reports the server safe count', async () => {
    const p: Preflight = await runPreflight(runnerCtx, { execution: false });
    for (const r of p.results) expect(r.ok, `${r.id}: ${r.detail}`).toBe(true);
    expect(p.ok).toBe(true);
    const summary = (p.preview as { summary: { safeCount: number; needsReviewCount: number } }).summary;
    expect(summary.safeCount).toBe(4);
    expect(summary.needsReviewCount).toBe(2);
  }, 120_000);

  it('is refused by PostgreSQL itself when the session is a teacher, not by runner heuristics', async () => {
    await runnerCtx.db.setAuthUid(TEACHER_UID);
    const p: Preflight = await runPreflight(runnerCtx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.detail).toContain("'teacher'");
    expect(byId(p, 'preview_succeeds')?.ok).toBe(false);
    await runnerCtx.db.setAuthUid(ADMIN_UID);
  }, 120_000);

  it('is refused when the session is anonymous (no auth uid at all)', async () => {
    await runnerCtx.db.setAuthUid(null);
    const p: Preflight = await runPreflight(runnerCtx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.ok).toBe(false);
    expect(byId(p, 'preview_succeeds')?.ok).toBe(false);
    await runnerCtx.db.setAuthUid(ADMIN_UID);
  }, 120_000);
});

describe('safe batch runner — preflight detects a blocked pair in real PostgreSQL', () => {
  let db: PgDuplicateDb;

  beforeAll(async () => {
    db = await createDuplicateBatchTestDb();
    await seedProfile(db, 'admin-1', 'admin', 'A', ADMIN_UID);
    await seedProfile(db, 'p1', 'parent', 'P1');
    await seedProfile(db, 'p2', 'parent', 'P2');
    // Two records, two DIFFERENT Gov IDs → blocked, never batchable.
    await seedStudent(db, { id: 'b-a', name: 'Blocked Case', className: 'G1', parentId: 'p1', govId: 'AA-111' });
    await seedStudent(db, { id: 'b-b', name: 'Blocked Case', className: 'G1', parentId: 'p2', govId: 'BB-222' });
    await seedEnrollment(db, { id: 'enr-b-a', studentId: 'b-a', className: 'G1' });
    await db.setAuthUid(ADMIN_UID);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('refuses to execute while any pair is blocked', async () => {
    const ctx = {
      kind: 'pglite' as const,
      supabaseUrl: null,
      accessToken: 'pglite-session',
      actorLabel: 'admin-1',
      rpc: (fn: string, params?: Record<string, unknown>) => db.rpc(fn, params),
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      snapshot: null,
      close: async () => {},
    };
    const p: Preflight = await runPreflight(ctx, { execution: true, yes: true });
    expect(p.ok).toBe(false);
    expect(byId(p, 'actor_is_admin')?.ok).toBe(true); // the admin IS allowed in…
    expect(byId(p, 'no_unexpected_blocked')?.ok).toBe(false); // …but the data is not safe
    expect(byId(p, 'no_unexpected_blocked')?.detail).toContain('blockedCount=1');
    const summary = (p.preview as { summary: { safeCount: number; blockedCount: number } }).summary;
    expect(summary.safeCount).toBe(0);
    expect(summary.blockedCount).toBe(1);
  }, 120_000);
});
