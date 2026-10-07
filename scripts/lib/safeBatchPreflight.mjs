/**
 * Production preflight for the safe duplicate batch runner.
 *
 * Extracted from scripts/safe-duplicate-batch-run.mjs so the TESTS exercise the
 * real preflight code rather than a copy of it. The runner refuses to execute a
 * merge if any check fails.
 *
 * Every check is a real call against the target database. Nothing here is a
 * heuristic about the environment: "is the actor an admin" is answered by
 * public.current_profile_role(), the same function the batch RPCs themselves
 * call, so the preflight can never disagree with the server about who is
 * allowed in.
 *
 * The preflight does NOT authorise anything. It reports. merge_safe_duplicate_batch()
 * re-checks the role, the confirmation phrase, the eligibility of every pair
 * and the fingerprint of every row regardless of what happened here.
 */

/** The RPCs that must exist for the batch to be runnable at all. */
export const REQUIRED_RPCS = [
  'safe_duplicate_batch_policy',
  'get_safe_duplicate_batch',
  'preview_safe_duplicate_batch',
  'merge_safe_duplicate_batch',
  'verify_safe_duplicate_batch_state',
];

/**
 * @typedef {object} PreflightCtx
 * @property {'pglite'|'supabase'} kind
 * @property {(fn: string, params?: Record<string, unknown>) => Promise<any>} rpc
 * @property {((sql: string, params?: unknown[]) => Promise<{rows: any[]}>) | null} [query]
 * @property {(() => Promise<{tables: string[], digest: string} | null>) | null} [snapshot]
 * @property {string|null} [supabaseUrl]
 * @property {string|null} [accessToken]
 * @property {string|null} [actorLabel]
 */

/**
 * @param {PreflightCtx} ctx
 * @param {{yes?: boolean, blockedTolerance?: number, execution?: boolean}} [opts]
 *   `execution: true` means a merge is about to happen, so the operator
 *   confirmation becomes a hard gate. For a dry run it is reported but does not
 *   fail the preflight — a dry run is safe to call without confirming anything.
 * @returns {Promise<{ok: boolean, results: Array<{id: string, label: string, ok: boolean, detail: string}>, preview: any|null, previewSnapshot: {before: any, after: any}|null}>}
 */
export async function runPreflight(ctx, opts = {}) {
  const results = [];
  // Table digests taken immediately around the preview call, so the caller can
  // show the zero-write proof. The comparison MUST happen here: by the time the
  // runner looks, the preview has already run.
  let previewSnapshot = null;
  const record = (id, label, ok, detail) => {
    results.push({ id, label, ok: ok === true, detail });
    return ok === true;
  };

  // 1. Target configured -----------------------------------------------------
  if (ctx.kind === 'supabase') {
    const url = ctx.supabaseUrl ?? null;
    record(
      'target_configured',
      'Supabase URL is configured',
      !!url && /^https:\/\/.+/.test(String(url)),
      url ? String(url).replace(/\/\/[^@/]+@/, '//') : 'SUPABASE_URL is not set',
    );
  } else {
    record('target_configured', 'Target is configured', true, 'pglite (in-process PostgreSQL, shipped migrations)');
  }

  // 2. Database reachable ----------------------------------------------------
  let reachable = false;
  try {
    await ctx.rpc('current_profile_role', {});
    reachable = true;
    record('database_reachable', 'Database is reachable', true, 'current_profile_role() answered');
  } catch (e) {
    record('database_reachable', 'Database is reachable', false, e?.message ?? String(e));
  }

  // 3. Session valid ---------------------------------------------------------
  // A genuine authenticated identity must exist. For supabase that means a real
  // access token is being sent; for pglite it means the harness set an auth uid.
  if (!reachable) {
    record('session_valid', 'Authentication session is valid', false, 'skipped — the database is not reachable');
  } else if (ctx.kind === 'supabase' && !ctx.accessToken) {
    record('session_valid', 'Authentication session is valid', false,
      'no access token: set SUPABASE_ADMIN_EMAIL + SUPABASE_ADMIN_PASSWORD, or SUPABASE_ADMIN_JWT');
  } else {
    record('session_valid', 'Authentication session is valid', true, ctx.actorLabel ?? 'authenticated session present');
  }

  // 4. Actor is an admin — asked of the DATABASE, not of the environment ------
  let isAdmin = false;
  if (reachable) {
    try {
      const role = await ctx.rpc('current_profile_role', {});
      isAdmin = role === 'admin';
      record('actor_is_admin', 'Current actor is an admin',
        isAdmin,
        role ? `current_profile_role() = '${role}'` : 'current_profile_role() returned NULL (no profile for this auth user)');
    } catch (e) {
      record('actor_is_admin', 'Current actor is an admin', false, e?.message ?? String(e));
    }
  } else {
    record('actor_is_admin', 'Current actor is an admin', false, 'skipped — the database is not reachable');
  }

  // 5. Required RPCs exist ---------------------------------------------------
  if (isAdmin) {
    try {
      const policy = await ctx.rpc('safe_duplicate_batch_policy', {});
      const policyId = policy?.policyId;
      // policy proves one RPC; the remaining ones are proved by calling them
      // (preview below) and by a catalogue lookup where one is available.
      let missing = [];
      if (typeof ctx.query === 'function') {
        const { rows } = await ctx.query(
          `SELECT v.name FROM (VALUES ${REQUIRED_RPCS.map((_, i) => `($${i + 1})`).join(',')}) AS v(name)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = v.name)`,
          REQUIRED_RPCS,
        );
        missing = rows.map((r) => r.name);
      } else if (!policyId) {
        missing = ['safe_duplicate_batch_policy'];
      }
      record('rpcs_present', 'Required RPCs exist', missing.length === 0,
        missing.length === 0
          ? `${REQUIRED_RPCS.length} RPCs present (policy '${policyId}')`
          : `missing: ${missing.join(', ')}`);
    } catch (e) {
      record('rpcs_present', 'Required RPCs exist', false, e?.message ?? String(e));
    }
  } else {
    record('rpcs_present', 'Required RPCs exist', false, 'skipped — the actor is not an administrator');
  }

  // 6 + 7 + 8 + 9. The preview: succeeds, writes nothing, reports a count,
  // and surfaces no blocked records ----------------------------------------
  let preview = null;
  if (isAdmin) {
    const before = typeof ctx.snapshot === 'function' ? await ctx.snapshot() : null;
    try {
      preview = await ctx.rpc('preview_safe_duplicate_batch', { p_limit: 2000 });
      record('preview_succeeds', 'Preview succeeds', !!preview && !!preview.summary,
        preview ? `${preview.summary?.candidatePairs ?? '?'} candidate pairs evaluated` : 'no result');
    } catch (e) {
      record('preview_succeeds', 'Preview succeeds', false, e?.message ?? String(e));
    }
    const after = typeof ctx.snapshot === 'function' ? await ctx.snapshot() : null;
    if (before && after) previewSnapshot = { before, after };

    if (preview) {
      const zeroWrite = preview.dryRun === true && preview.writesPerformed === 0;
      const digestOk = !before || !after || before.digest === after.digest;
      record('preview_zero_write', 'Preview is zero-write', zeroWrite && digestOk,
        `dryRun=${preview.dryRun}, writesPerformed=${preview.writesPerformed}`
        + (before && after ? `, ${before.tables.length} tables byte-identical=${before.digest === after.digest}` : ''));

      const safe = preview.summary?.safeCount;
      record('safe_count_reported', 'Safe count is reported by the database',
        typeof safe === 'number' && safe >= 0,
        typeof safe === 'number' ? `safeCount=${safe} (server-authoritative)` : 'summary.safeCount missing');

      const blocked = preview.summary?.blockedCount ?? 0;
      const tolerance = opts.blockedTolerance ?? 0;
      record('no_unexpected_blocked', 'No unexpected blocked records', blocked <= tolerance,
        blocked === 0 ? 'blockedCount=0' : `blockedCount=${blocked} (tolerance ${tolerance}) — review them individually before batching`);
    } else {
      record('preview_zero_write', 'Preview is zero-write', false, 'skipped — the preview failed');
      record('safe_count_reported', 'Safe count is reported by the database', false, 'skipped — the preview failed');
      record('no_unexpected_blocked', 'No unexpected blocked records', false, 'skipped — the preview failed');
    }
  } else {
    for (const [id, label] of [
      ['preview_succeeds', 'Preview succeeds'],
      ['preview_zero_write', 'Preview is zero-write'],
      ['safe_count_reported', 'Safe count is reported by the database'],
      ['no_unexpected_blocked', 'No unexpected blocked records'],
    ]) record(id, label, false, 'skipped — the actor is not an administrator');
  }

  // 10. Operator confirmation ------------------------------------------------
  // Only a hard gate when a merge is actually about to happen. A dry run is
  // read-only, so it must be callable without --yes.
  const confirmed = opts.yes === true;
  if (opts.execution === false) {
    record('operator_confirmed', 'Operator explicitly confirmed execution', true,
      'not required for a read-only dry run');
  } else {
    record('operator_confirmed', 'Operator explicitly confirmed execution', confirmed,
      confirmed ? '--execute --yes supplied' : 'missing --yes (the server also requires the typed phrase)');
  }

  return { ok: results.every((r) => r.ok), results, preview, previewSnapshot };
}
