# Deploying the Lesson Plan fixes

Two things must reach Supabase for the fixes to fully work:

1. **Migration** — `supabase/migrations/20260731_lesson_plan_locking_and_ai_logs.sql`
2. **Edge function** — `supabase/functions/generate-lesson-review/index.ts`

The frontend needs a normal rebuild/redeploy, but it degrades gracefully and is
not urgent (see *What works before you deploy*).

---

## Option A — Supabase Dashboard (no CLI needed)

Recommended if you have been applying past migrations by pasting SQL.

### A1. Migration

1. Open your project → **SQL Editor** → **New query**.
2. Paste the entire contents of
   `supabase/migrations/20260731_lesson_plan_locking_and_ai_logs.sql`.
3. Click **Run**.

Expected: `Success. No rows returned.`

The script is safe to re-run — it uses `IF NOT EXISTS`, `DROP ... IF EXISTS`,
and `CREATE OR REPLACE` throughout.

### A2. Edge function

1. Go to **Edge Functions** → `generate-lesson-review`.
2. Replace the code with `supabase/functions/generate-lesson-review/index.ts`.
3. **Deploy**.

### A3. Confirm the secret exists

**Edge Functions → Secrets** must contain `NVIDIA_API_KEY`.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

> A missing/expired `NVIDIA_API_KEY` is a prime suspect for the original
> "stuck on waiting" reports. After deploying, failures of this kind show up
> as `api_error` in **Admin → AI Review Logs** instead of hanging.

---

## Option B — Supabase CLI

```bash
# One-time: authenticate and link the project
npx supabase login
npx supabase link --project-ref <YOUR_PROJECT_REF>

# 1. Preview what will run (recommended)
npx supabase db push --dry-run

# 2. Apply the migration
npx supabase db push

# 3. Deploy the edge function
npx supabase functions deploy generate-lesson-review

# 4. Set the API key if it is not already configured
npx supabase secrets set NVIDIA_API_KEY=<key>
```

`<YOUR_PROJECT_REF>` is the ID in your project URL:
`https://supabase.com/dashboard/project/<YOUR_PROJECT_REF>`.

> **Note on migration history.** Earlier migrations in this repo appear to have
> been applied by hand via the SQL Editor. If so, `db push` may try to replay
> them and fail on objects that already exist. Always run `--dry-run` first; if
> it lists old migrations, use **Option A** for this one, or repair history with
> `npx supabase migration repair --status applied <version>`.

---

## Frontend

Deploy however you normally do (the build output is a single
`dist/index.html`):

```bash
npm install
npm run build
```

No new environment variables are required.

---

## Verifying it worked

Run in the SQL Editor:

```sql
-- 1. New status accepted?
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'lesson_plans'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%status%';
-- expect 'revision_requested' in the list

-- 2. Lock triggers installed?
SELECT tgname FROM pg_trigger
WHERE tgname IN ('trg_lesson_plans_lock', 'trg_lesson_plan_periods_lock');
-- expect 2 rows

-- 3. Helper functions present?
SELECT proname FROM pg_proc
WHERE proname IN ('lesson_plan_is_editable',
                  'request_lesson_plan_revision',
                  'expire_stuck_ai_reviews');
-- expect 3 rows

-- 4. Log table present?
SELECT COUNT(*) FROM ai_review_logs;
-- expect 0 (or more) — an error here means the table is missing

-- 5. New columns present?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'lesson_plans'
  AND column_name IN ('ai_started_at','ai_failure_reason',
                      'revision_note','revision_requested_at');
-- expect 4 rows
```

### End-to-end smoke test

1. **Locking** — submit a plan, then try to edit it. It should open read-only.
   As supervisor, click **Request Revisions (unlock for editing)**; the
   teacher's edit controls should reappear.
2. **Server-side locking** — the real test. With a plan in `submitted`, run:
   ```sql
   UPDATE lesson_plan_periods SET topic = 'hack'
   WHERE plan_id = '<a submitted plan id>';
   ```
   This **must fail** with `Lesson plan ... is locked`. If it succeeds, the
   migration did not apply.
3. **Dates** — plan lists should show e.g. `1 Aug – 5 Aug 2026`.
4. **Week bug** — with a submitted plan on 1–5 Aug, select 8–12 Aug. You should
   get a blank plan for the new week, *not* the old week's content.
5. **AI timeout** — submit a plan; if the AI does not respond it must flip to
   **AI failed** within ~3 minutes and offer **Retry**, never hang.
6. **Monitoring** — visit **Admin → AI Review Logs** and confirm attempts appear.

---

## Clearing plans already stuck

Any plan currently stuck on "waiting" from before the fix:

```sql
SELECT expire_stuck_ai_reviews(3);
```

Returns the rows it moved to `ai_failed`, each then retryable from the
supervisor's review page. The app also runs this automatically, so it is
only needed if you want to clear the backlog immediately.

---

## What works before you deploy

The frontend was written to degrade gracefully:

| Behaviour | Before migration | After migration |
|---|---|---|
| Read-only UI for submitted plans | ✅ works | ✅ works |
| **Enforced** locking (blocks direct DB/API writes) | ❌ **client-side only** | ✅ enforced |
| Dates on plans | ✅ works | ✅ works |
| Week-selection fix | ✅ works | ✅ works |
| AI timeout → `ai_failed` | ⚠️ client watchdog only | ✅ + SQL sweep |
| Retry button | ✅ works | ✅ works |
| Failure reason on plan | ❌ column missing | ✅ persisted |
| Admin AI Review Logs page | ❌ table missing | ✅ populated |

`requestPlanRevision` and `expireStuckAiReviews` fall back to direct table
updates if their RPCs are absent, so nothing crashes — but the **security
guarantee of #1 only exists once the migration is applied**, since until then
locking is purely client-side.

---

## Rollback

```sql
DROP TRIGGER IF EXISTS trg_lesson_plans_lock ON lesson_plans;
DROP TRIGGER IF EXISTS trg_lesson_plan_periods_lock ON lesson_plan_periods;
DROP FUNCTION IF EXISTS enforce_lesson_plan_lock();
DROP FUNCTION IF EXISTS enforce_lesson_plan_period_lock();
DROP FUNCTION IF EXISTS expire_stuck_ai_reviews(INTEGER);
DROP FUNCTION IF EXISTS request_lesson_plan_revision(TEXT, TEXT);
-- optional: DROP TABLE ai_review_logs;
```

Leave the `status` CHECK constraint alone unless you have first migrated any
`revision_requested` rows back to `draft`, or the constraint will reject them.
The added columns are nullable and harmless to keep.
