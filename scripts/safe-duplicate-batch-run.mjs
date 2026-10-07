#!/usr/bin/env node
/**
 * Operator runner for the Duplicate Students → "Merge All Safe Duplicates" batch.
 *
 * This script is a thin, auditable front-end for the SAME RPCs the admin page
 * uses. It decides NOTHING: which pairs are safe, which Student ID is kept,
 * which field survives and when a pair must be refused are all computed by the
 * SECURITY DEFINER functions in
 * supabase/migrations/20260925_safe_duplicate_batch.sql. The list this script
 * sends back to the server is advisory only — the server recomputes
 * eligibility from live rows, locks the pair, revalidates the fingerprint and
 * refuses anything it does not consider safe.
 *
 *   preview_safe_duplicate_batch()        → dry run, zero writes, exact pairs
 *   merge_safe_duplicate_batch()          → ONE atomic chunk per call
 *   verify_safe_duplicate_batch_state()   → read-only post-run verification
 *
 * ── Targets ────────────────────────────────────────────────────────────────
 *   --analyse           Read-only breakdown of exactly what the database is
 *                       excluding and why, per profile field. Works against
 *                       either target. Writes nothing.
 *   --allow-blocked N   Tolerate N already-reviewed blocked pairs in preflight.
 *                       Blocked pairs stay excluded from the batch regardless.
 *   --consolidation-fixtures N
 *                       (pglite only) also seed N pairs whose keeper is missing
 *                       a value the duplicate holds, plus the counter-examples,
 *                       so one run exercises the transfer path end to end.
 *
 *   --target pglite     (default) Real PostgreSQL (PGlite, in-process WASM)
 *                       with the SHIPPED migrations applied and a
 *                       reproducible reproduction of the reported screen
 *                       (254 safe / 24 needs review / 0 blocked / 8 merged).
 *                       Touches no production data — use it to rehearse.
 *
 *   --target supabase   The live project. Requires:
 *                         SUPABASE_URL          https://<ref>.supabase.co
 *                         SUPABASE_ANON_KEY     the public anon key
 *                       plus ONE genuine admin identity:
 *                         SUPABASE_ADMIN_EMAIL + SUPABASE_ADMIN_PASSWORD
 *                           → the runner signs in with signInWithPassword(),
 *                             exactly as the web app does, and pins every
 *                             request to that access token
 *                         or SUPABASE_ADMIN_JWT
 *                           → an existing admin access token (browser session:
 *                             supabase.auth.getSession().data.session.access_token)
 *
 *                       The service_role key deliberately does NOT work and
 *                       must not be used. The RPCs resolve the actor with
 *                       auth.uid(); a service-role call carries no user, so
 *                       current_profile_role() is NULL and every RPC refuses.
 *                       This runner does not work around that — it obtains a
 *                       real authenticated admin identity instead.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   # 1. DRY RUN — always safe, always first. Never writes.
 *   node scripts/safe-duplicate-batch-run.mjs
 *
 *   # 2. Execute (preflight must pass; requires the explicit --yes).
 *   node scripts/safe-duplicate-batch-run.mjs --execute --yes
 *
 *   # 3. Re-run the very same batch to prove idempotency.
 *   node scripts/safe-duplicate-batch-run.mjs --execute --yes --rerun
 *
 *   # Against production
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *   SUPABASE_ADMIN_EMAIL=admin@school.example SUPABASE_ADMIN_PASSWORD=... \
 *     node scripts/safe-duplicate-batch-run.mjs --target supabase
 *   ... --target supabase --execute --yes --rerun
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
 * Exit code is non-zero if any preflight check fails or any post-run invariant
 * is violated.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { REQUIRED_RPCS, runPreflight } from './lib/safeBatchPreflight.mjs';

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
    analyse: false,
    consolidationFixtures: 0,
    allowBlocked: 0,
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
      case '--analyse': case '--analyze': out.analyse = true; break;
      case '--consolidation-fixtures': out.consolidationFixtures = Number(next()); break;
      case '--allow-blocked': out.allowBlocked = Number(next()); break;
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
  const actorLabel = await seedReproduction(db, opts);
  return {
    kind: 'pglite',
    db,
    supabaseUrl: null,
    accessToken: 'pglite-session',
    actorLabel,
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
  const url = process.env.SUPABASE_URL ?? '';
  const anon = process.env.SUPABASE_ANON_KEY ?? '';
  const email = process.env.SUPABASE_ADMIN_EMAIL ?? '';
  const password = process.env.SUPABASE_ADMIN_PASSWORD ?? '';
  const jwt = process.env.SUPABASE_ADMIN_JWT ?? '';

  // No URL / no key: return a context that fails the preflight honestly rather
  // than throwing before the operator sees WHICH check failed.
  if (!url || !anon) {
    const fail = async (fn) => { throw new Error(`cannot reach the database: ${!url ? 'SUPABASE_URL is not set' : 'SUPABASE_ANON_KEY is not set'} (called ${fn})`); };
    return {
      kind: 'supabase', db: null, supabaseUrl: url || null, accessToken: null, actorLabel: null,
      rpc: fail, query: null, snapshot: null, close: async () => {},
    };
  }

  const { createClient } = await import('@supabase/supabase-js');
  const baseOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const base = createClient(url, anon, baseOptions);

  // Obtain a GENUINE authenticated admin identity. This is the project's own
  // pattern (src/lib/supabase.ts createAuthedClient + profiles.ts createUser):
  // sign in, then pin every request to that user's access token.
  let token = jwt || null;
  let actorLabel = jwt ? 'SUPABASE_ADMIN_JWT (pre-existing admin access token)' : null;
  if (!token && email && password) {
    const { data, error } = await base.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`admin sign-in failed: ${error.message}`);
    token = data.session.access_token;
    actorLabel = `signed in as ${email}`;
  }

  const client = token
    ? createClient(url, anon, { ...baseOptions, accessToken: async () => token })
    : base;

  return {
    kind: 'supabase',
    db: null,
    supabaseUrl: url,
    accessToken: token,
    actorLabel,
    async rpc(fn, params) {
      const { data, error } = await client.rpc(fn, params);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data;
    },
    query: null,
    snapshot: null,
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
  await seedProfile(db, 'teacher-1', 'teacher', 'Not An Admin', '22222222-2222-4222-8222-222222222222');
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
  // ── OPT-IN: one-sided-data pairs (migration 20261008 field consolidation) ──
  // The 254 pairs above deliberately leave every duplicate record BLANK, so the
  // default rehearsal cannot exercise the transfer path at all. These fixtures
  // add exactly that shape: the keeper is missing a value the duplicate holds.
  // They also add the counter-examples, so one run proves BOTH directions — that
  // one-sided data now transfers AND that true conflicts still block.
  if (opts.consolidationFixtures > 0) {
    const n = opts.consolidationFixtures;
    const shapes = ['phone', 'transport', 'family', 'gov'];
    for (let k = 1; k <= n; k += 1) {
      step('consolidation pairs');
      const className = cls(k + 7);
      const name = `Ismaaciil Faarax Jaamac ${String(k).padStart(3, '0')}`;
      const keeper = `s-cons-${k}-k`;
      const removed = `s-cons-${k}-r`;
      const shape = shapes[k % shapes.length];
      await seedProfile(db, `cparent-${k}`, 'parent', `Consol Parent ${k}`);
      // The keeper is parent-assigned but BLANK on the field under test.
      await seedStudent(db, {
        id: keeper, name, className, parentId: `cparent-${k}`, createdAt: '2026-05-01T08:00:00Z',
      });
      const dup = { id: removed, name, className, createdAt: '2026-06-15T08:00:00Z' };
      if (shape === 'phone') dup.parentPhone = `+25261700${String(k).padStart(4, '0')}`;
      if (shape === 'transport') dup.transport = String(100 + k);
      if (shape === 'gov') dup.govId = `CF-${String(k).padStart(6, '0')}`;
      if (shape === 'family') dup.familyId = `CFAM-${k}`;
      await seedStudent(db, dup);
      if (shape === 'family') {
        // The ONLY evidence the policy accepts for a family transfer: a sibling
        // already assigned to the KEEPER'S OWN parent holds that exact family id.
        await seedStudent(db, {
          id: `s-cons-${k}-sib`, name: `Walaal Kale ${String(k).padStart(3, '0')}`,
          className: 'Grade 8-Z', parentId: `cparent-${k}`, familyId: `CFAM-${k}`,
          createdAt: '2026-04-01T08:00:00Z',
        });
      }
      await seedEnrollment(db, { id: `enr-${keeper}`, studentId: keeper, className, academicYearId: 'ay-2026' });
      await seedEnrollment(db, { id: `enr-${removed}`, studentId: removed, className, academicYearId: 'ay-2026' });
    }

    // ── Counter-examples: the new policy must STILL refuse these ──────────────
    const conflict = async (k, name, keep, dupv, extra) => {
      const className = cls(k + 9);
      const keeper = `s-conf-${k}-k`;
      const removed = `s-conf-${k}-r`;
      await seedProfile(db, `xparent-${k}`, 'parent', `Conflict Parent ${k}`);
      await seedStudent(db, { id: keeper, name, className, parentId: `xparent-${k}`, createdAt: '2026-05-01T08:00:00Z', ...keep });
      await seedStudent(db, { id: removed, name, className, createdAt: '2026-06-15T08:00:00Z', ...dupv });
      await seedEnrollment(db, { id: `enr-${keeper}`, studentId: keeper, className, academicYearId: 'ay-2026' });
      if (extra) await seedStudent(db, extra);
    };
    // A true phone conflict: both records populated, different numbers.
    await conflict(1, 'Cabdiraxmaan Xuseen Warsame 001',
      { parentPhone: '611111111' }, { parentPhone: '622222222' });
    // A true transport conflict: WALKER vs a bus number.
    await conflict(2, 'Cabdiraxmaan Xuseen Warsame 002',
      { transport: 'WALKER' }, { transport: '9' });
    // A phone that already belongs to ANOTHER parent's family.
    await conflict(3, 'Cabdiraxmaan Xuseen Warsame 003',
      {}, { parentPhone: '634453468' },
      { id: 's-conf-3-other', name: 'Qof Kale Oo Gebi Ahaan', className: 'Grade 9-Z',
        parentId: 'staff-1', parentPhone: '634453468', createdAt: '2026-04-01T08:00:00Z' });
    // A family id the database cannot prove belongs to the keeper's family.
    // NOTE: normalize_family_id() is regexp_replace(raw,'\D','','g'), so the id
    // MUST contain digits — an alphabetic id normalizes to '' and is treated as
    // blank, which would silently skip the very check this fixture exists for.
    await conflict(4, 'Cabdiraxmaan Xuseen Warsame 004',
      {}, { familyId: '99990001' });
    // A family ID with NO DIGIT. normalize_family_id() strips every non-digit,
    // so this normalizes to '' and the batch sees the pair as "both blank":
    // it merges, transfers nothing, records nothing in the audit — and the raw
    // value is deleted with the duplicate. This is exactly the silent-loss case
    // the --analyse normalization check exists to catch BEFORE a real merge.
    await conflict(5, 'Cabdiraxmaan Xuseen Warsame 005',
      {}, { familyId: 'HOUSE-RED' });
  }

  process.stdout.write('\r  seeding done.                                          \n');
  await db.setAuthUid(ADMIN_UID);
  return 'admin-1 (profiles.role = admin, auth uid set in this PGlite session)';
}

// ── Report rendering ─────────────────────────────────────────────────────────
function renderPreflight(preflight) {
  h1(preflight.ok ? 'Preflight — all checks passed' : 'Preflight — FAILED');
  for (const r of preflight.results) {
    console.log(`  ${r.ok ? c(GREEN, '✓') : c(RED, '✗')} ${r.label.padEnd(44)} ${c(DIM, r.detail)}`);
  }
  return preflight.ok;
}

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

  const sample = (preview.rows ?? []).slice(0, 3);
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

function renderVerifiedBlock(preview) {
  const s = preview.summary ?? {};
  line('');
  console.log(c(BOLD, '  DATABASE VERIFIED: ') + c(GREEN, `${s.safeCount ?? 0} pairs currently eligible for safe merge.`));
  console.log(`  ${c(AMBER, `${s.needsReviewCount ?? 0} pairs require individual review.`)}`);
  console.log(`  ${s.blockedCount ? c(RED, `${s.blockedCount} blocked.`) : `${s.blockedCount ?? 0} blocked.`}`);
  console.log('  ' + c(RED, 'This operation will modify student records.'));
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
  for (const [key, list] of [['skip reasons', acc.skipped], ['block reasons', acc.blocked]]) {
    if (list.length) {
      const byReason = {};
      for (const item of list) byReason[item.reason ?? 'unknown'] = (byReason[item.reason ?? 'unknown'] ?? 0) + 1;
      kv(key, Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', '));
    }
  }
  for (const f of acc.failed.slice(0, 10)) bad(`failure: ${JSON.stringify(f)}`);
  return { merged: acc.merged.length, skipped: acc.skipped.length, blocked: acc.blocked.length, failed: acc.failed.length, chunks: chunk };
}

/** Read back the state the batch promised, using the read-only server RPC so
 *  the same verification runs in rehearsal AND against production. */
async function renderPostState(ctx, label = 'Post-run verification (read back from the server)') {
  h1(label);
  let v;
  try {
    v = await ctx.rpc('verify_safe_duplicate_batch_state', {});
  } catch (e) {
    bad(`verify_safe_duplicate_batch_state() failed: ${e?.message ?? e}`);
    bad('apply supabase/migrations/20261007_safe_batch_post_run_verification.sql, then re-verify');
    return null;
  }
  const a = v.authoritative ?? {};
  kv('still eligible (safe)', c(a.safeEligible ? RED : GREEN, a.safeEligible));
  kv('needs individual review', c(AMBER, a.needsReview));
  kv('blocked', c(a.blocked ? RED : GREEN, a.blocked));
  kv('candidate pairs remaining', a.candidatePairs);
  kv('students', v.students);
  kv('merge audits (total)', v.audits?.total);
  kv('  └ safe_batch', v.audits?.safeBatch);
  kv('  └ individual', v.audits?.individual);
  kv('  └ distinct removed IDs', v.audits?.distinctRemovedIds);
  kv('batch runs', v.batches?.runs);
  kv('  └ merged / skipped / blocked', `${v.batches?.mergedSum} / ${v.batches?.skippedSum} / ${v.batches?.blockedSum}`);
  kv('students.merge_batch audit logs', v.batchAuditLogs);
  const integrity = v.integrity ?? {};
  kv('orphaned child rows', c(integrity.orphanedChildRows ? RED : GREEN, integrity.orphanedChildRows));
  if (integrity.orphanedChildRows) bad(`orphan detail: ${JSON.stringify(integrity.orphanDetail)}`);
  kv('students w/ >1 open enrollment', c(integrity.studentsWithMultipleOpenEnrollments ? RED : GREEN, integrity.studentsWithMultipleOpenEnrollments));

  // ── Field consolidation: prove nothing was discarded ──────────────────────
  // Every value copied off a removed record is stamped on its audit row, and the
  // value must still be readable ON THE KEEPER. This is the "no transferred data
  // is lost" check, read back from the server rather than taken on trust.
  line('');
  line(c(BOLD, '  Field consolidation (values carried from the removed record onto the keeper)'));
  if (typeof ctx.query !== 'function') {
    line(c(DIM, '    not verifiable on this target — no direct SQL access; read student_merge_audits.transferred_fields'));
  } else {
    const { rows } = await ctx.query(`
      SELECT
        count(*) FILTER (WHERE a.transferred_fields IS NOT NULL
                           AND a.transferred_fields <> '{}'::jsonb)::text AS with_transfers,
        count(*)::text AS safe_audits
      FROM public.student_merge_audits a
      WHERE a.merge_kind = 'safe_batch'`);
    kv('  safe_batch audits', rows[0]?.safe_audits ?? '?');
    kv('  └ carrying a transfer', rows[0]?.with_transfers ?? '?');
    const { rows: fields } = await ctx.query(`
      SELECT f.key AS field, count(*)::text AS n
      FROM public.student_merge_audits a,
           LATERAL jsonb_each(a.transferred_fields) AS f
      WHERE a.merge_kind = 'safe_batch'
      GROUP BY f.key ORDER BY f.key`);
    for (const r of fields) kv(`    ${r.field}`, r.n);
    // The decisive check: is each transferred value STILL on the surviving row?
    const { rows: lost } = await ctx.query(`
      SELECT count(*)::text AS n
      FROM public.student_merge_audits a
      JOIN public.students k ON k.id = a.canonical_id
      CROSS JOIN LATERAL jsonb_each_text(a.transferred_fields) AS f(key, value)
      WHERE a.merge_kind = 'safe_batch'
        AND f.value IS NOT NULL
        AND CASE f.key
              WHEN 'parentPhone' THEN k."parentPhone"
              WHEN 'transport'   THEN k.transport
              WHEN 'familyId'    THEN k."familyId"
              WHEN 'govId'       THEN k."govId"
            END IS DISTINCT FROM f.value`);
    const lostN = Number(lost[0]?.n ?? 0);
    kv('  transferred values missing from the keeper', c(lostN ? RED : GREEN, lostN));
    if (lostN) bad(`${lostN} transferred value(s) did not survive on the keeper`);
    else ok('every transferred value is present on the surviving Student ID — nothing was discarded');
  }
  return v;
}

// ── Analysis mode ────────────────────────────────────────────────────────────
// Answers "what exactly is the database excluding, and why?" against ANY target
// (PGlite rehearsal or the live Supabase project). It is read-only: it calls the
// same get_safe_duplicate_batch() RPC the screen calls, pages through every
// candidate pair, and tallies the per-field classification the policy publishes
// in `fieldStates`. It never writes and never changes eligibility.
//
// The key number is `newlySafeByTransfer`: pairs that policy v2 marks SAFE only
// because one-sided data is now transferred instead of excluded. Those are
// exactly the pairs policy v1 would have pushed into Needs Review, so this is
// the honest "how many more become safely mergeable" figure — measured by the
// database, not assumed.

const FIELDS = ['parentPhone', 'transport', 'familyId', 'govId'];

/**
 * Ordered, human-readable breakdown per field — the exact rows an operator
 * needs to see, derived from the policy's own `fieldStates` classification.
 * Crucially this SPLITS `duplicate_only` by outcome, because "the duplicate is
 * the only record with a value" is not a verdict: it can be safely transferred,
 * refused as another family's data, or held for review as unprovable.
 */
const FIELD_ROWS = {
  parentPhone: [
    ['both blank', (f) => f.state === 'both_blank'],
    ['keeper only', (f) => f.state === 'keeper_only'],
    ['duplicate only → safely transferable', (f) => f.state === 'duplicate_only' && f.action === 'transfer'],
    ['identical', (f) => f.state === 'identical'],
    ['true conflict', (f) => f.state === 'conflict'],
    ['belongs to another family', (f) => f.state === 'duplicate_only' && f.action === 'block'],
  ],
  transport: [
    ['both blank', (f) => f.state === 'both_blank'],
    ['keeper only', (f) => f.state === 'keeper_only'],
    ['duplicate only → safely transferable', (f) => f.state === 'duplicate_only' && f.action === 'transfer'],
    ['identical', (f) => f.state === 'identical'],
    ['incompatible conflict', (f) => f.state === 'conflict'],
  ],
  familyId: [
    ['both blank', (f) => f.state === 'both_blank'],
    ['keeper only', (f) => f.state === 'keeper_only'],
    ['duplicate only → proven transferable', (f) => f.state === 'duplicate_only' && f.action === 'transfer'],
    ['duplicate only → unprovable (review)', (f) => f.state === 'duplicate_only' && f.action === 'review'],
    ['identical', (f) => f.state === 'identical'],
    ['conflicting family IDs', (f) => f.state === 'conflict'
      || (f.state === 'duplicate_only' && f.action === 'block')],
  ],
  govId: [
    ['both blank', (f) => f.state === 'both_blank'],
    ['keeper only', (f) => f.state === 'keeper_only'],
    ['duplicate only', (f) => f.state === 'duplicate_only' && f.action === 'transfer'],
    ['identical', (f) => f.state === 'identical'],
    ['conflict', (f) => f.state === 'conflict'],
  ],
};

// JS mirror of public.normalize_family_id(TEXT) — 20260802:55:
//   regexp_replace(COALESCE(p_raw,''), '\D', '', 'g')
// It strips EVERY non-digit, so a family ID with no digit at all becomes '' and
// the batch treats the record as having no family ID at all.
const normalizeFamilyIdJs = (v) => String(v ?? '').replace(/\D/g, '');

/** Show only what an admin needs to identify a record. Phone and Gov ID are
 *  partially masked; nothing more is revealed than the screen already shows. */
function mask(v) {
  if (v === null || v === undefined || v === '') return '—';
  const t = String(v);
  return t.length <= 4 ? '••••' : `${'•'.repeat(Math.min(t.length - 4, 8))}${t.slice(-4)}`;
}

async function runAnalysis(ctx, opts) {
  const pageSize = opts.chunk && opts.chunk > 0 ? Math.min(opts.chunk, 500) : 200;
  const rows = [];
  const excluded = [];
  let summary = null;
  let exclusionReasons = {};
  let policy = null;
  for (let offset = 0; ; offset += pageSize) {
    const page = await ctx.rpc('get_safe_duplicate_batch', {
      p_limit: pageSize, p_offset: offset, p_include_excluded: true,
    });
    summary = page?.summary ?? summary;
    exclusionReasons = page?.exclusionReasons ?? exclusionReasons;
    policy = page?.policy ?? policy;
    const r = page?.rows ?? [];
    const x = page?.excludedRows ?? [];
    rows.push(...r);
    excluded.push(...x);
    if (r.length < pageSize && x.length < pageSize) break;
    if (offset > 200000) break; // hard stop; a candidate set this size is a data problem
  }

  // Per-field tally by the human-readable rows above, plus transfer counts.
  const perField = {};
  for (const f of FIELDS) perField[f] = {};
  const transfers = {};
  const examples = { newlySafe: [], blocked: [], review: [] };
  let newlySafe = 0;
  let plainSafe = 0;
  // Family-ID normalization findings, measured from the RAW values the RPC
  // returns for each side of the pair — i.e. from real production data.
  const famNorm = {
    pairsWithRawFamilyId: 0,     // at least one side has a non-blank raw value
    pairsInvisibleToPolicy: 0,   // raw value present but normalizes to ''
    distinctInvisibleValues: new Set(),
    pairsWhereBothSidesRaw: 0,   // both sides carry a raw value
    pairsRawDifferKeySame: 0,    // distinct spellings, identical normalized key
  };

  const pushExample = (bucket, row, fs) => {
    if (examples[bucket].length >= 10) return;
    examples[bucket].push({
      keeperId: row?.keeperId ?? '?',
      removedId: row?.removedId ?? '?',
      studentName: row?.studentName ?? '?',
      className: row?.className ?? '?',
      verdict: bucket === 'newlySafe' ? 'SAFE' : bucket === 'blocked' ? 'BLOCKED' : 'REVIEW',
      reasons: row?.exclusionCodes ?? [],
      // the object, not its entries — renderAnalysis re-reads it with entries()
      transfers: transfersFor(fs),
    });
  };

  function transfersFor(fs) {
    const out = {};
    for (const f of FIELDS) {
      const cell = fs?.[f];
      if (cell?.action === 'transfer') out[f] = cell.value ?? null;
    }
    return out;
  }

  for (const row of [...rows, ...excluded]) {
    const fs = row?.fieldStates ?? {};

    // ── family ID normalization impact on THIS pair ────────────────────────
    const famRawK = String(row?.keeper?.familyId ?? '').trim();
    const famRawR = String(row?.removed?.familyId ?? '').trim();
    if (famRawK !== '' || famRawR !== '') famNorm.pairsWithRawFamilyId += 1;
    if (famRawK !== '' && famRawR !== '') famNorm.pairsWhereBothSidesRaw += 1;
    let invisible = false;
    for (const raw of [famRawK, famRawR]) {
      if (raw !== '' && normalizeFamilyIdJs(raw) === '') {
        invisible = true;
        famNorm.distinctInvisibleValues.add(raw);
      }
    }
    if (invisible) famNorm.pairsInvisibleToPolicy += 1;
    if (famRawK !== '' && famRawR !== ''
        && famRawK !== famRawR
        && normalizeFamilyIdJs(famRawK) !== ''
        && normalizeFamilyIdJs(famRawK) === normalizeFamilyIdJs(famRawR)) {
      famNorm.pairsRawDifferKeySame += 1;
    }

    let anyTransfer = false;
    for (const f of FIELDS) {
      const cell = fs[f];
      if (!cell) continue;
      for (const [label, test] of FIELD_ROWS[f]) {
        if (test(cell)) { perField[f][label] = (perField[f][label] ?? 0) + 1; break; }
      }
      if (cell.action === 'transfer') { anyTransfer = true; transfers[f] = (transfers[f] ?? 0) + 1; }
    }
    if (row?.eligible) {
      if (anyTransfer) { newlySafe += 1; pushExample('newlySafe', row, fs); }
      else plainSafe += 1;
    } else if (row?.severity === 'blocked') {
      pushExample('blocked', row, fs);
    } else if (row?.severity === 'review') {
      pushExample('review', row, fs);
    }
  }

  const reasonsFor = (sev) => {
    const counts = {};
    for (const r of excluded) {
      if (r?.severity !== sev) continue;
      for (const code of r?.exclusionCodes ?? []) counts[code] = (counts[code] ?? 0) + 1;
    }
    return counts;
  };

  // "Already merged" — read-only post-run verification RPC (20261007). Wrapped
  // because an older deployment may not have that migration yet.
  let verified = null;
  try { verified = await ctx.rpc('verify_safe_duplicate_batch_state', {}); } catch { verified = null; }

  return {
    policy,
    summary,
    candidatePairs: summary?.candidatePairs ?? rows.length + excluded.length,
    safeCount: summary?.safeCount ?? rows.length,
    blockedCount: summary?.blockedCount ?? 0,
    needsReviewCount: summary?.needsReviewCount ?? 0,
    exclusionReasons,
    plainSafe,
    newlySafe,
    transfers,
    perField,
    examples,
    blockedReasons: reasonsFor('blocked'),
    reviewReasons: reasonsFor('review'),
    rowsCollected: rows.length,
    excludedCollected: excluded.length,
    verified,
    famNorm: {
      pairsWithRawFamilyId: famNorm.pairsWithRawFamilyId,
      pairsInvisibleToPolicy: famNorm.pairsInvisibleToPolicy,
      distinctInvisibleValues: [...famNorm.distinctInvisibleValues],
      pairsWhereBothSidesRaw: famNorm.pairsWhereBothSidesRaw,
      pairsRawDifferKeySame: famNorm.pairsRawDifferKeySame,
    },
  };
}

function renderAnalysis(a, opts) {
  h1('PRODUCTION ANALYSIS — computed by the database, read-only');
  kv('policy', `${a.policy?.policyId ?? '?'} v${a.policy?.version ?? '?'}`);
  line('');
  line(c(BOLD, '  Duplicate totals'));
  kv('potential duplicate pairs', a.candidatePairs);
  kv('server-safe pairs', c(GREEN, a.safeCount));
  kv('needs review', c(AMBER, a.needsReviewCount));
  kv('blocked', c(a.blockedCount ? RED : GREEN, a.blockedCount));
  const aud = a.verified?.audits;
  if (aud) {
    kv('already merged (individual)', aud.individual ?? 0);
    kv('already merged (safe batch)', aud.safeBatch ?? 0);
    kv('distinct student IDs removed', aud.distinctRemovedIds ?? 0);
  } else {
    kv('already merged', c(DIM, 'unavailable — verify_safe_duplicate_batch_state() not present'));
  }
  line('');
  kv('  └ safe with nothing to consolidate', a.plainSafe);
  kv('  └ NEWLY safe via field consolidation', c(GREEN, a.newlySafe));
  if (a.rowsCollected + a.excludedCollected !== a.candidatePairs) {
    warn(`paged ${a.rowsCollected + a.excludedCollected} of ${a.candidatePairs} pairs — counts below cover the paged subset`);
  }

  line('');
  line(c(BOLD, '  Field consolidation analysis (per profile field)'));
  for (const f of FIELDS) {
    line(`    ${c(BOLD, f)}`);
    for (const [label] of FIELD_ROWS[f]) {
      const n = a.perField[f][label] ?? 0;
      const highlight = label.includes('transferable') ? GREEN : (label.includes('conflict') || label.includes('another family')) ? RED : (label.includes('review') ? AMBER : null);
      kv(`      ${label}`, highlight ? c(highlight, n) : n);
    }
  }

  const tEntries = Object.entries(a.transfers);
  line('');
  line(c(BOLD, '  Values that will be transferred from the duplicate onto the keeper'));
  if (tEntries.length === 0) {
    line(c(DIM, '    none — every examined pair already agrees on every populated field'));
  } else {
    for (const [f, n] of tEntries.sort((x, y) => y[1] - x[1])) kv(`  ${f}`, c(GREEN, n));
    line(c(DIM, '    each is recorded per merge in student_merge_audits.transferred_fields'));
  }

  const dump = (title, obj, colour) => {
    line('');
    line(c(BOLD, `  ${title}`));
    const entries = Object.entries(obj).sort((x, y) => y[1] - x[1]);
    if (entries.length === 0) { line(c(DIM, '    none')); return; }
    for (const [code, n] of entries) {
      const desc = a.policy?.exclusionCodes?.[code] ?? '';
      kv(`  ${code}`, `${c(colour, n)}${desc ? c(DIM, `  ${desc}`) : ''}`);
    }
  };
  dump('Why pairs are BLOCKED', a.blockedReasons, RED);
  dump('Why pairs stay in individual review', a.reviewReasons, AMBER);

  line('');
  line(c(BOLD, '  Family ID normalization impact (normalize_family_id strips every non-digit)'));
  const fn = a.famNorm ?? {};
  kv('  pairs where a raw family ID exists', fn.pairsWithRawFamilyId ?? 0);
  kv('  pairs where BOTH sides carry one', fn.pairsWhereBothSidesRaw ?? 0);
  kv('  pairs INVISIBLE to the policy', c((fn.pairsInvisibleToPolicy ?? 0) ? RED : GREEN, fn.pairsInvisibleToPolicy ?? 0));
  if ((fn.distinctInvisibleValues ?? []).length) {
    line(c(DIM, `    values that normalize to '': ${fn.distinctInvisibleValues.slice(0, 20).join(', ')}`));
    warn('these records look like they have NO family ID; the batch cannot reason about them');
  }
  kv('  distinct spellings, same key', c((fn.pairsRawDifferKeySame ?? 0) ? RED : GREEN, fn.pairsRawDifferKeySame ?? 0));
  if ((fn.pairsInvisibleToPolicy ?? 0) > 0 || (fn.pairsRawDifferKeySame ?? 0) > 0) {
    warn('run supabase/tests/family-id-normalization-audit.sql and resolve these before merging');
  } else {
    ok('no family ID in any candidate pair is hidden or collapsed by normalization');
  }

  const showExamples = (title, list, colour) => {
    line('');
    line(c(BOLD, `  ${title}`));
    if (list.length === 0) { line(c(DIM, '    none')); return; }
    for (const e of list) {
      line(`    ${c(colour, e.verdict.padEnd(7))} ${e.studentName}  ${c(DIM, `[${e.className}]`)}`);
      line(`            keeper ${e.keeperId}  ←  duplicate ${e.removedId}`);
      if (e.reasons.length) line(`            reason: ${e.reasons.join(', ')}`);
      const t = Object.entries(e.transfers ?? {});
      if (t.length) {
        const parts = t.map(([f, v]) => `${f}=${f === 'parentPhone' || f === 'govId' ? mask(v) : (v ?? '—')}`);
        line(`            ${c(GREEN, 'transfers')}: ${parts.join(', ')}`);
      }
    }
  };
  showExamples('Representative examples — newly SAFE because of field transfer', a.examples.newlySafe, GREEN);
  showExamples('Representative examples — remaining BLOCKED', a.examples.blocked, RED);
  showExamples('Representative examples — remaining REVIEW', a.examples.review, AMBER);

  if (opts.json) {
    line('');
    line(JSON.stringify({
      policy: a.policy?.policyId, version: a.policy?.version,
      potentialDuplicatePairs: a.candidatePairs, serverSafe: a.safeCount,
      needsReview: a.needsReviewCount, blocked: a.blockedCount,
      alreadyMerged: aud ? { individual: aud.individual, safeBatch: aud.safeBatch, distinctRemovedIds: aud.distinctRemovedIds } : null,
      newlySafeByFieldConsolidation: a.newlySafe,
      safeWithNothingToConsolidate: a.plainSafe,
      perField: a.perField, transfers: a.transfers, familyIdNormalization: a.famNorm,
      blockedReasons: a.blockedReasons, reviewReasons: a.reviewReasons,
      exclusionReasons: a.exclusionReasons, examples: a.examples,
    }, null, 2));
  }
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
    // ── 0a. ANALYSIS (read-only, deliberately before the preflight gate) ──────
    // This is the tool an operator uses to find out WHY pairs are blocked, so
    // gating it behind "no blocked records" would defeat its purpose. It writes
    // nothing and changes no eligibility, and the RPC it calls still enforces
    // admin-only access server-side, so a non-administrator is refused there.
    if (opts.analyse) {
      try {
        renderAnalysis(await runAnalysis(ctx, opts), opts);
      } catch (e) {
        bad(`analysis failed: ${e?.message ?? e}`);
        problems.push('analysis could not be produced');
      }
    }

    // ── 0. PREFLIGHT — refuses everything downstream if any check fails ──────
    const preflight = await runPreflight(ctx, {
      yes: opts.yes,
      execution: opts.execute,
      // Non-zero ONLY when the operator states a number of known, already
      // reviewed blocked pairs. It never lowers a safety rule: blocked pairs are
      // still excluded from the batch by the database either way.
      blockedTolerance: opts.allowBlocked,
    });
    const preflightOk = renderPreflight(preflight);
    if (!preflightOk) {
      line('');
      bad('preflight failed — refusing to continue. No preview result is treated as authorisation.');
      process.exitCode = 1;
      return;
    }
    const preview = preflight.preview;

    // ── 1. DRY RUN ───────────────────────────────────────────────────────────
    // The preview already ran inside the preflight, so the zero-write proof is
    // the digests IT captured around that call — comparing anything now would
    // compare two post-preview states and prove nothing.
    const assertionsOk = renderPreview(preview, opts);
    if (!assertionsOk) problems.push('server-side safety assertions failed');
    const snap = preflight.previewSnapshot;
    if (snap) {
      if (snap.before.digest === snap.after.digest) {
        ok(`preview wrote nothing — ${snap.before.tables.length} public tables byte-identical immediately before and after the call`);
      } else {
        bad('preview MODIFIED the database');
        problems.push('preview was not read-only');
      }
    } else {
      // No SQL access on this target: fall back to the server's own claim.
      ok(`preview reported dryRun=${preview.dryRun}, writesPerformed=${preview.writesPerformed} (no SQL access to digest tables on this target)`);
    }

    if (!opts.execute) {
      renderVerifiedBlock(preview);
      line('');
      line(c(AMBER, '  Dry run only. Nothing was changed. Re-run with --execute --yes to merge.'));
      return;
    }

    // ── 2. EXECUTE ───────────────────────────────────────────────────────────
    renderVerifiedBlock(preview);
    const expected = preview.summary?.safeCount ?? 0;
    const first = await runChunks(ctx, preview, opts, 'Batch merge');
    const post = await renderPostState(ctx);
    if (post) {
      if (first.merged !== expected) problems.push(`merged ${first.merged} but the preview identified ${expected}`);
      if (first.failed > 0) problems.push(`${first.failed} pair(s) failed`);
      if (post.authoritative?.safeEligible !== 0) problems.push(`${post.authoritative.safeEligible} pair(s) are still eligible after the batch`);
      if (post.authoritative?.needsReview !== (preview.summary?.needsReviewCount ?? 0)) {
        problems.push(`Needs Review changed from ${preview.summary?.needsReviewCount} to ${post.authoritative?.needsReview} — it must stay untouched`);
      }
      if (post.integrity?.orphanedChildRows) problems.push(`${post.integrity.orphanedChildRows} orphaned child row(s)`);
      if (post.audits?.safeBatch !== first.merged) problems.push(`${post.audits?.safeBatch} safe_batch audit rows but ${first.merged} merges`);
    }

    // ── 3. IDEMPOTENCY ───────────────────────────────────────────────────────
    if (opts.rerun) {
      const auditsBefore = post?.audits?.safeBatch ?? null;
      const again = await runChunks(ctx, preview, opts, 'Idempotency re-run (same batch id, same reviewed list)');
      const post2 = await renderPostState(ctx, 'Post-run verification after the idempotency re-run');
      if (again.merged !== 0) problems.push(`re-run merged ${again.merged} pair(s) — the batch is NOT idempotent`);
      else ok('re-run merged 0 newly eligible pairs: no duplicate merges, no duplicate history, no duplicate relationships');
      if (auditsBefore !== null && post2?.audits?.safeBatch !== auditsBefore) {
        problems.push(`safe_batch audit rows grew from ${auditsBefore} to ${post2.audits.safeBatch} on re-run`);
      } else if (post2) {
        ok(`exactly ${post2.audits.safeBatch} safe_batch audit rows — one per merged student, unchanged by the re-run`);
      }
    }
  } finally {
    await ctx.close();
  }

  h1(problems.length === 0 ? 'Result: all checks passed' : 'Result: PROBLEMS FOUND');
  for (const p of problems) bad(p);
  if (problems.length > 0) process.exitCode = 1;
}

// Only run when invoked as a script. Under vitest this module is imported for
// its exports (the tests must exercise the real runner code, not a copy), and
// importing it must not boot a database or start a batch.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => { console.error(c(RED, `\n${e?.message ?? e}`)); process.exit(1); });
}

export {
  parseArgs,
  openPglite,
  openSupabase,
  renderPreflight,
  renderPreview,
  renderVerifiedBlock,
  runChunks,
  renderPostState,
  main,
  REQUIRED_RPCS,
  runPreflight,
  runAnalysis,
  renderAnalysis,
  FIELDS,
  CONFIRM_PHRASE,
};
