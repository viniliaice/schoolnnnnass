#!/usr/bin/env node
/**
 * Operator runner for the Duplicate Students → "Merge All Safe Duplicates" batch.
 *
 * This script is a thin, auditable front-end for the SAME two RPCs the admin
 * page uses. It decides NOTHING: which pairs are safe, which Student ID is
 * kept, which field survives and when a pair must be refused are all computed
 * by the SECURITY DEFINER functions in
 * supabase/migrations/20260925_safe_duplicate_batch.sql. The list this script
 * sends back to the server is advisory only — the server recomputes
 * eligibility from live rows, locks the pair, revalidates the fingerprint and
 * refuses anything it does not consider safe.
 *
 *   preview_safe_duplicate_batch()  → dry run, zero writes, exact pairs
 *   merge_safe_duplicate_batch()    → ONE atomic chunk per call
 *
 * ── Targets ────────────────────────────────────────────────────────────────
 *   --target pglite     (default) Real PostgreSQL (PGlite, in-process WASM)
 *                       with the SHIPPED migrations applied and a
 *                       reproducible reproduction of the reported screen
 *                       (254 safe / 24 needs review / 0 blocked / 8 merged).
 *                       Touches no production data — used to rehearse the run
 *                       and to prove the preview writes nothing.
 *
 *   --target supabase   The live project. Requires:
 *                         SUPABASE_URL          https://<ref>.supabase.co
 *                         SUPABASE_ANON_KEY     the public anon key
 *                         SUPABASE_ADMIN_JWT    an ACCESS TOKEN for a user whose
 *                                               public.profiles.role = 'admin'
 *                       The service_role key does NOT work: the RPCs resolve
 *                       the actor with auth.uid(), which a service-role call
 *                       does not carry, and they refuse a NULL role.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   # 1. DRY RUN — always safe, always first. Never writes.
 *   node scripts/safe-duplicate-batch-run.mjs
 *
 *   # 2. Execute the chunked batch (requires the explicit --yes).
 *   node scripts/safe-duplicate-batch-run.mjs --execute --yes
 *
 *   # 3. Re-run the very same batch to prove idempotency.
 *   node scripts/safe-duplicate-batch-run.mjs --execute --yes --rerun
 *
 *   # Against production
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_ADMIN_JWT=... \
 *     node scripts/safe-duplicate-batch-run.mjs --target supabase
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_ADMIN_JWT=... \
 *     node scripts/safe-duplicate-batch-run.mjs --target supabase --execute --yes
 *
 * ── Options ────────────────────────────────────────────────────────────────
 *   --chunk N            chunk size per atomic transaction (server clamps 1..50)
 *   --reason "..."       audit reason stamped on every merge
 *   --json               print the raw server JSON (preview / chunk results)
 *   --seed N             pglite only: number of safe (high-confidence) pairs
 *   --review N           pglite only: number of needs-review pairs
 *   --merged N           pglite only: number of already-merged audit rows
 *   --keep-db            pglite only: keep the database open at the end
 *
 * Exit code is non-zero if any invariant the script can check is violated.
 */

import { setTimeout as delay } from 'node:timers/promises';

const CONFIRM_PHRASE = 'MERGE SAFE DUPLICATES';

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    target: 'pglite',
    execute: false,
    rerun: false,
    yes: false,
    json: false,
    keepDb: false,
    chunk: null,
    reason: 'Safe duplicate batch — server-decided high-confidence pairs',
    seed: 254,
    review: 24,
    merged: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--target': out.target = next(); break;
      case '--execute': out.execute = true; break;
      case '--rerun': out.rerun = true; break;
      case '--yes': out.yes = true; break;
      case '--json': out.json = true; break;
      case '--keep-db': out.keepDb = true; break;
      case '--chunk': out.chunk = Number(next()); break;
      case '--reason': out.reason = next(); break;
      case '--seed': out.seed = Number(next()); break;
      case '--review': out.review = Number(next()); break;
      case '--merged': out.merged = Number(next()); break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  if (out.target !== 'pglite' && out.target !== 'supabase') {
    throw new Error(`--target must be "pglite" or "supabase" (got "${out.target}")`);
  }
  if (out.execute && !out.yes) {
    throw new Error('--execute refuses to run without --yes. Type the flag deliberately; the server also requires the phrase MERGE SAFE DUPLICATES.');
  }
  return out;
}

// ── Output helpers ───────────────────────────────────────────────────────────
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const AMBER = '\x1b[33m';
const OFF = '\x1b[0m';
const isTTY = process.stdout.isTTY === true;
const c = (colour, s) => (isTTY ? `${colour}${s}${OFF}` : String(s));

function h1(s) { console.log(`\n${c(BOLD, s)}`); }
function line(s = '') { console.log(s); }
function kv(label, value) { console.log(`  ${label.padEnd(30)} ${value}`); }
function ok(s) { console.log(`  ${c(GREEN, '✓')} ${s}`); }
function bad(s) { console.log(`  ${c(RED, '✗')} ${s}`); }
function warn(s) { console.log(`  ${c(AMBER, '!')} ${s}`); }

// ── Database access: one interface, two back ends ────────────────────────────
async function openPglite(opts) {
  const harness = await import('../src/lib/__tests__/pgDuplicateBatchHarness.ts');
  if (!(await harness.pgliteAvailable())) throw new Error('@electric-sql/pglite is not installed — run npm install.');
  const db = await harness.createDuplicateBatchTestDb();
  await seedReproduction(db, opts);
  return {
    kind: 'pglite',
    db,
    rpc: (fn, params) => db.rpc(fn, params),
    query: (sql, params) => db.query(sql, params),
    /** Content hash of every public table — used to prove a dry run wrote nothing. */
    async snapshot() {
      const tables = (await db.query(
        `SELECT c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY c.relname`,
      )).rows.map((r) => r.relname);
      const parts = [];
      for (const t of tables) {
        const { rows } = await db.query(
          `SELECT (SELECT count(*) FROM public."${t}")::TEXT AS n,
                  COALESCE((SELECT md5(string_agg(x.h, '|' ORDER BY x.h))
                              FROM (SELECT md5(t2.*::TEXT) AS h FROM public."${t}" t2) x), '') AS h`,
        );
        parts.push(`${t}=${rows[0].n}:${rows[0].h}`);
      }
      return { tables, digest: parts.join(';') };
    },
    close: () => (opts.keepDb ? delay(0) : db.close()),
  };
}

async function openSupabase() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const jwt = process.env.SUPABASE_ADMIN_JWT;
  const missing = [url && 'SUPABASE_URL', anon && 'SUPABASE_ANON_KEY', jwt && 'SUPABASE_ADMIN_JWT'].filter(Boolean);
  if (missing.length < 3) {
    throw new Error(`--target supabase needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_ADMIN_JWT (missing: ${
      ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_ADMIN_JWT'].filter((k) => !process.env[k]).join(', ')})`);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  return {
    kind: 'supabase',
    db: null,
    async rpc(fn, params) {
      const { data, error } = await supabase.rpc(fn, params);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data;
    },
    query: async () => { throw new Error('Direct SQL is not available against a live project; use the Supabase SQL editor.'); },
    snapshot: async () => null,
    close: async () => {},
  };
}

// ── Reproducible dataset (pglite target only) ────────────────────────────────
// Mirrors the reported admin screen: 278 potential duplicate groups made of
// 254 server-safe pairs + 24 pairs that need individual review, plus 8 records
// that were already merged by the individual guided workflow.
async function seedReproduction(db, opts) {
  const { seedProfile, seedStudent, seedEnrollment } = await import('../src/lib/__tests__/pgDuplicateBatchHarness.ts');
  const ADMIN_UID = '11111111-1111-4111-8111-111111111111';

  await seedProfile(db, 'admin-1', 'admin', 'Batch Administrator', ADMIN_UID);
  await seedProfile(db, 'staff-1', 'office', 'Gate Officer');
  await db.query(`INSERT INTO public.academic_years (id, name, "isCurrent") VALUES ('ay-2026','2026',true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.terms (id, name, "academicYearId", "isCurrent") VALUES ('term-1','Term 1','ay-2026',true) ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.subjects (id, name) VALUES ('math','Mathematics'),('eng','English') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.quizzes (id, title) VALUES ('q1','Quiz 1') ON CONFLICT DO NOTHING`);

  const classes = ['Grade 1-A', 'Grade 2-A', 'Grade 3-B', 'Grade 4-A', 'Grade 5-C', 'Grade 6-B',
    'Grade 7-A', 'Grade 8-B', 'Grade 9-A', 'Grade 10-C', 'Grade 11-A', 'Grade 12-B'];
  const cls = (i) => classes[i % classes.length];
  let n = 0;
  const step = (label) => { if (n++ % 50 === 0) process.stdout.write(`\r  seeding ${label}… `); };

  // ── 254 server-safe pairs: parent-assigned keeper vs unassigned duplicate ──
  for (let i = 1; i <= opts.seed; i += 1) {
    step('safe pairs');
    const keeper = `s-safe-${i}-k`;
    const removed = `s-safe-${i}-r`;
    const className = cls(i);
    const name = `Abdi Kaafi Xasan ${String(i).padStart(3, '0')}`;
    await seedProfile(db, `parent-${i}`, 'parent', `Parent Of ${i}`);

    // Half the keepers are the NEWER Student ID on purpose: the keeper is the
    // parent-assigned record, never the older one.
    const keeperFirst = i % 2 === 0;
    const keeperAt = keeperFirst ? '2026-05-01T08:00:00Z' : '2026-06-15T08:00:00Z';
    const removedAt = keeperFirst ? '2026-06-15T08:00:00Z' : '2026-05-01T08:00:00Z';

    await seedStudent(db, {
      id: keeper, name, className,
      parentId: `parent-${i}`,
      govId: i % 4 === 0 ? `AA-1000${i}` : null,
      parentPhone: i % 3 === 0 ? `+252615000${String(i).padStart(3, '0')}` : null,
      transport: i % 5 === 0 ? 'WALKER' : null,
      familyId: i % 11 === 0 ? `FAM-${i}` : null,
      createdAt: keeperAt,
    });
    await seedStudent(db, { id: removed, name, className, createdAt: removedAt });

    // Enrollment state drives which consolidation path the merge takes.
    const variant = i % 10;
    if (variant < 6) {
      await seedEnrollment(db, { id: `enr-${keeper}`, studentId: keeper, className, academicYearId: 'ay-2026' });
    } else if (variant < 9) {
      await seedEnrollment(db, { id: `enr-${keeper}`, studentId: keeper, className, academicYearId: 'ay-2026' });
      await seedEnrollment(db, { id: `enr-${removed}`, studentId: removed, className, academicYearId: 'ay-2026' });
    } else {
      await seedEnrollment(db, { id: `enr-${removed}`, studentId: removed, className, academicYearId: 'ay-2026' });
    }

    // History on BOTH sides, deliberately non-conflicting, so the batch has to
    // transfer the duplicate's rows instead of discarding them.
    const ins = async (sql, params) => { await db.query(sql, params); };
    await ins(`INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",date)
               VALUES ($1,$2,'math','Mathematics',17,20,'MIDTERM','Midterm','term-1','2026-05-10')`, [`ex-k-${i}`, keeper]);
    await ins(`INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",date)
               VALUES ($1,$2,'math','Mathematics',15,20,'FINAL','Final','term-1','2026-06-20')`, [`ex-r-${i}`, removed]);
    await ins(`INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",date)
               VALUES ($1,$2,'eng','English',18,20,'FINAL','Final','term-1','2026-06-21')`, [`ex-r2-${i}`, removed]);
    for (let d = 1; d <= 3; d += 1) {
      await ins(`INSERT INTO public.attendance (id,"studentId","className",date,status)
                 VALUES ($1,$2,$3,$4,'present')`, [`att-r-${i}-${d}`, removed, className, `2026-04-0${d}`]);
    }
    await ins(`INSERT INTO public.attendance (id,"studentId","className",date,status)
               VALUES ($1,$2,$3,'2026-04-20','present')`, [`att-k-${i}`, keeper, className]);
    await ins(`INSERT INTO public.homework (id,"studentId","className",subject,title,status)
               VALUES ($1,$2,$3,'Mathematics','HW 1','submitted')`, [`hw-r-${i}`, removed, className]);
    await ins(`INSERT INTO public.student_promotions (id,"studentId","fromClass","toClass","academicYearId")
               VALUES ($1,$2,$3,$4,'ay-2026')`, [`pr-r-${i}`, removed, 'Grade 0', className]);
    await ins(`INSERT INTO public.quiz_attempts (id,"quizId","studentId","totalEarned","totalPossible")
               VALUES ($1,'q1',$2,8,10)`, [`qa-r-${i}`, removed]);
    if (i % 6 === 0) {
      await ins(`INSERT INTO public.release_log ("studentId","familyId","staffId") VALUES ($1,$2,'staff-1')`, [removed, `FAM-R-${i}`]);
    }
    if (i % 7 === 0) {
      await ins(`INSERT INTO public.report_comments (id,"studentId","termId","teacherComment")
                 VALUES ($1,$2,'term-1','Good progress.')`, [`rc-r-${i}`, removed]);
    }
  }

  // ── 24 pairs that must stay in individual review (neither record assigned) ──
  for (let j = 1; j <= opts.review; j += 1) {
    step('review pairs');
    const className = cls(j + 3);
    const name = `Hodan Cabdi Nuur ${String(j).padStart(3, '0')}`;
    await seedStudent(db, { id: `s-rev-${j}-a`, name, className, createdAt: '2026-05-02T08:00:00Z' });
    await seedStudent(db, { id: `s-rev-${j}-b`, name, className, createdAt: '2026-06-16T08:00:00Z' });
    await seedEnrollment(db, { id: `enr-s-rev-${j}-a`, studentId: `s-rev-${j}-a`, className, academicYearId: 'ay-2026' });
  }

  // ── 8 records already merged by the individual guided workflow ─────────────
  for (let m = 1; m <= opts.merged; m += 1) {
    step('merged records');
    const className = cls(m + 5);
    await seedStudent(db, { id: `s-merged-${m}`, name: `Sahra Maxamed Cali ${m}`, className, parentId: 'staff-1', createdAt: '2026-04-01T08:00:00Z' });
    await seedEnrollment(db, { id: `enr-s-merged-${m}`, studentId: `s-merged-${m}`, className, academicYearId: 'ay-2026' });
    await db.query(
      `INSERT INTO public.student_merge_audits
         (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts, enrollment_action, merge_kind, created_at)
       VALUES ($1,$2,$3,'admin-1','Individual guided merge (before the batch)',
               '{"exams":3}'::jsonb, '{"exams":5}'::jsonb, '{"action":"consolidate"}'::jsonb, 'individual', NOW())`,
      [`audit-pre-${m}`, `s-merged-${m}`, `s-gone-${m}`],
    );
  }
  process.stdout.write('\r  seeding done.                                          \n');
  await db.setAuthUid(ADMIN_UID);
}

// ── Report rendering ─────────────────────────────────────────────────────────
function renderPreview(preview, opts) {
  const s = preview.summary ?? {};
  h1('Safe preview (dry run) — computed by the database, not by this script');
  kv('policy', preview.policy?.policyId ?? '?');
  kv('keeper rule', preview.policy?.keeperRuleEn ?? '?');
  kv('candidate pairs', s.candidatePairs ?? '?');
  kv('ELIGIBLE (safe merges)', c(GREEN, s.safeCount ?? 0));
  kv('excluded', s.excludedCount ?? 0);
  kv('  └ needs individual review', c(AMBER, s.needsReviewCount ?? 0));
  kv('  └ blocked', c(RED, s.blockedCount ?? 0));
  kv('records to be removed', s.recordsToRemove ?? 0);
  kv('Student IDs preserved', s.studentIdsPreserved ?? 0);
  kv('chunk plan', `${preview.chunkPlan?.chunks ?? 0} chunk(s) × ${preview.chunkPlan?.chunkSize ?? '?'} (atomic per chunk)`);
  kv('batch id', preview.batchId ?? '?');
  kv('preview token', preview.previewToken ?? '?');
  kv('dry run / writes', `${preview.dryRun} / ${preview.writesPerformed}`);

  const reasons = preview.summary?.exclusionReasons ?? preview.exclusionReasons ?? {};
  const codes = Object.entries(reasons).filter(([, v]) => v > 0);
  if (codes.length > 0) {
    line('');
    line(c(BOLD, '  Why the excluded pairs stay in individual review'));
    const descriptions = preview.policy?.exclusionCodes ?? preview.policy?.exclusionDescriptions ?? {};
    for (const [code, count] of codes.sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)} × ${code}${descriptions[code] ? ` — ${descriptions[code]}` : ''}`);
    }
  }

  const failed = Object.entries(preview.assertions ?? {}).filter(([, v]) => v !== true);
  line('');
  if (failed.length === 0) ok('every server-side safety assertion holds across all eligible rows');
  else for (const [k] of failed) bad(`safety assertion failed: ${k}`);
  if (preview.dryRun === true && preview.writesPerformed === 0) ok('preview reports dryRun=true, writesPerformed=0');
  else bad('preview did not report a clean dry run');

  const sample = (preview.rows ?? []).slice(0, opts.sampleRows ?? 3);
  if (sample.length > 0) {
    line('');
    line(c(BOLD, '  Sample of the eligible pairs (merge direction + preserved history)'));
    for (const r of sample) {
      const h = r.history ?? {};
      const hist = [
        h.exams && `exams ${h.exams.keeper}+${h.exams.removed}`,
        h.attendance && `attendance ${h.attendance.keeper}+${h.attendance.removed}`,
        h.quizAttempts && `quizzes ${h.quizAttempts.keeper}+${h.quizAttempts.removed}`,
        h.reportComments && `comments ${h.reportComments.keeper}+${h.reportComments.removed}`,
        h.releaseLogs && `releases ${h.releaseLogs.keeper}+${h.releaseLogs.removed}`,
      ].filter(Boolean).join(', ');
      console.log(`    ${r.pairKey}`);
      console.log(`      ${r.studentName}  [${r.className}]`);
      console.log(`      KEEP   ${r.keeperId}  (parent-assigned: ${r.keeperIsParentAssigned}, parent ${r.keeper?.parentName ?? '—'})`);
      console.log(`      MERGE  ${r.removedId}  (parent: ${r.removed?.parentId ?? 'unassigned'})`);
      console.log(`      enrollment action: ${r.enrollmentAction ?? '—'}   history preserved: ${hist || 'none'}`);
      console.log(`      evidence: ${(r.eligibilityCodes ?? []).join(', ')}`);
    }
    if ((preview.rows ?? []).length > sample.length) console.log(`    … and ${(preview.rows ?? []).length - sample.length} more`);
  }
  return failed.length === 0;
}

async function runChunks(ctx, preview, opts, label) {
  const reviewed = (preview.rows ?? []).map((row) => ({
    keeperId: row.keeperId,
    removedId: row.removedId,
    fingerprint: row.fingerprint ?? null,
    pairKey: row.pairKey,
  }));
  const chunkSize = opts.chunk ?? preview.policy?.chunkSize?.default ?? 25;
  const totalChunks = Math.max(1, Math.ceil(reviewed.length / chunkSize));
  const batchId = preview.batchId;

  h1(`${label} — ${reviewed.length} pairs, ${totalChunks} atomic chunk(s), batch ${batchId}`);
  if (reviewed.length === 0) { warn('nothing eligible to merge'); return { merged: 0, skipped: 0, blocked: 0, failed: 0, chunks: 0 }; }

  const acc = { merged: [], skipped: [], blocked: [], failed: [] };
  let remaining = reviewed.length;
  let chunk = 0;
  const t0 = Date.now();
  while (remaining > 0 && chunk < totalChunks + 1) {
    chunk += 1;
    process.stdout.write(`\r  merging ${Math.min(reviewed.length - remaining + chunkSize, reviewed.length)}/${reviewed.length} safe duplicate pairs (chunk ${chunk}/${totalChunks})… `);
    const res = await ctx.rpc('merge_safe_duplicate_batch', {
      p_pairs: reviewed,
      p_chunk_size: chunkSize,
      p_confirm_phrase: CONFIRM_PHRASE,
      p_reason: opts.reason,
      p_batch_id: batchId,
    });
    acc.merged.push(...(res.merged ?? []));
    acc.skipped.push(...(res.skipped ?? []));
    acc.blocked.push(...(res.blocked ?? []));
    acc.failed.push(...(res.failed ?? []));
    if (opts.json) line(JSON.stringify(res, null, 2));
    remaining = res.totals?.remaining ?? 0;
    if ((res.totals?.merged ?? 0) === 0) break; // no progress → stop and report
  }
  process.stdout.write(`\r  ${' '.repeat(90)}\r`);
  console.log(`  completed in ${((Date.now() - t0) / 1000).toFixed(1)}s across ${chunk} chunk(s)`);
  line('');
  kv('successfully merged', c(GREEN, acc.merged.length));
  kv('skipped after re-check', acc.skipped.length);
  kv('blocked by the server', c(acc.blocked.length ? RED : '', acc.blocked.length));
  kv('failed', c(acc.failed.length ? RED : '', acc.failed.length));
  if (acc.skipped.length) {
    const byReason = {};
    for (const s of acc.skipped) byReason[s.reason ?? 'unknown'] = (byReason[s.reason ?? 'unknown'] ?? 0) + 1;
    kv('skip reasons', Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  if (acc.blocked.length) {
    const byReason = {};
    for (const b of acc.blocked) byReason[b.reason ?? 'unknown'] = (byReason[b.reason ?? 'unknown'] ?? 0) + 1;
    kv('block reasons', Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  for (const f of acc.failed.slice(0, 10)) bad(`failure: ${JSON.stringify(f)}`);
  return { merged: acc.merged.length, skipped: acc.skipped.length, blocked: acc.blocked.length, failed: acc.failed.length, chunks: chunk, entries: acc.merged };
}

async function renderPostState(ctx) {
  h1('Database state after the batch (read back from the server)');
  const report = await ctx.rpc('get_safe_duplicate_batch', { p_limit: 1, p_offset: 0, p_include_excluded: false });
  const s = report.summary ?? {};
  kv('candidate pairs remaining', s.candidatePairs ?? '?');
  kv('still eligible', c(s.safeCount ? RED : GREEN, s.safeCount ?? 0));
  kv('needs individual review', c(AMBER, s.needsReviewCount ?? 0));
  kv('blocked', c(s.blockedCount ? RED : GREEN, s.blockedCount ?? 0));

  if (ctx.kind === 'pglite') {
    const q = async (sql) => (await ctx.query(sql)).rows[0];
    kv('students', (await q('SELECT count(*)::INT n FROM public.students')).n);
    kv('merge audits (total)', (await q('SELECT count(*)::INT n FROM public.student_merge_audits')).n);
    kv('  └ stamped safe_batch', (await q(`SELECT count(*)::INT n FROM public.student_merge_audits WHERE merge_kind='safe_batch'`)).n);
    kv('  └ pre-existing individual', (await q(`SELECT count(*)::INT n FROM public.student_merge_audits WHERE merge_kind='individual'`)).n);
    kv('duplicate groups (page count)', (await q('SELECT count(*)::INT n FROM public.get_duplicate_candidates()')).n);
    kv('batch runs', (await q('SELECT count(*)::INT n FROM public.student_merge_batches')).n);
    kv('audit_logs (merge_batch)', (await q(`SELECT count(*)::INT n FROM public.audit_logs WHERE action='students.merge_batch'`)).n);
    kv('orphaned child rows', (await q(`
      SELECT (SELECT count(*) FROM public.exams e LEFT JOIN public.students s ON s.id=e."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.attendance a LEFT JOIN public.students s ON s.id=a."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.homework hw LEFT JOIN public.students s ON s.id=hw."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.quiz_attempts qa LEFT JOIN public.students s ON s.id=qa."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.report_comments rc LEFT JOIN public.students s ON s.id=rc."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.release_log rl LEFT JOIN public.students s ON s.id=rl."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.student_promotions sp LEFT JOIN public.students s ON s.id=sp."studentId" WHERE s.id IS NULL)
           + (SELECT count(*) FROM public.student_enrollments se LEFT JOIN public.students s ON s.id=se."studentId" WHERE s.id IS NULL)
           ::INT AS n`)).n);
  }
  return report;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(new URL(import.meta.url).pathname); return; }

  h1(`Safe Duplicate Batch — target: ${opts.target}`);
  line(c(DIM, '  Eligibility is computed by the database (SECURITY DEFINER), never by this script.'));
  line(c(DIM, '  The reviewed list is re-checked at execution time.'));

  const ctx = opts.target === 'pglite' ? await openPglite(opts) : await openSupabase();
  const problems = [];
  try {
    // ── 1. DRY RUN ───────────────────────────────────────────────────────────
    const before = await ctx.snapshot();
    const preview = await ctx.rpc('preview_safe_duplicate_batch', { p_limit: 2000 });
    const after = await ctx.snapshot();
    const assertionsOk = renderPreview(preview, opts);
    if (!assertionsOk) problems.push('server-side safety assertions failed');

    if (before && after) {
      if (before.digest === after.digest) {
        ok(`preview wrote nothing — ${before.tables.length} public tables byte-identical before and after`);
      } else {
        bad('preview MODIFIED the database');
        problems.push('preview was not read-only');
      }
    }

    if (!opts.execute) {
      line('');
      line(c(AMBER, '  Dry run only. Nothing was changed. Re-run with --execute --yes to merge.'));
    } else {
      // ── 2. EXECUTE ─────────────────────────────────────────────────────────
      const expected = preview.summary?.safeCount ?? 0;
      const first = await runChunks(ctx, preview, opts, 'Batch merge');
      const post = await renderPostState(ctx);

      if (first.merged !== expected) problems.push(`merged ${first.merged} but the preview identified ${expected}`);
      if (first.failed > 0) problems.push(`${first.failed} pair(s) failed`);
      if ((post.summary?.safeCount ?? 0) !== 0) problems.push(`${post.summary.safeCount} pair(s) are still eligible after the batch`);

      // ── 3. IDEMPOTENCY ─────────────────────────────────────────────────────
      if (opts.rerun) {
        const again = await runChunks(ctx, preview, opts, 'Idempotency re-run (same batch id, same reviewed list)');
        if (again.merged !== 0) problems.push(`re-run merged ${again.merged} pair(s) — the batch is NOT idempotent`);
        else ok('re-run merged nothing: no duplicate merges, no duplicate history, no duplicate audits');
        if (ctx.kind === 'pglite') {
          const audits = (await ctx.query(
            `SELECT count(*)::INT n FROM public.student_merge_audits WHERE merge_kind='safe_batch'`)).rows[0].n;
          if (audits !== expected) problems.push(`${audits} safe_batch audit rows but ${expected} merges`);
          else ok(`exactly ${audits} safe_batch audit rows — one per merged student`);
        }
        await renderPostState(ctx);
      }
    }
  } finally {
    await ctx.close();
  }

  h1(problems.length === 0 ? 'Result: all checks passed' : 'Result: PROBLEMS FOUND');
  for (const p of problems) bad(p);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(c(RED, `\n${e?.message ?? e}`)); process.exit(1); });
