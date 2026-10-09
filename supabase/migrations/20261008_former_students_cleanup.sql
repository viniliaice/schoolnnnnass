-- ============================================================================
-- Migration 20261008 — Former Students / Student Cleanup
-- ============================================================================
-- Problem: the students table still holds records for children who no longer
-- study at the school. They inflate every roster, every active count and every
-- teacher's "marks not entered" list, but they must NEVER be deleted — their
-- exams, attendance, homework, quiz attempts, payments, parent links, messages
-- and historical class assignments are the school's record.
--
-- Solution: a proper STATUS on the existing students table (no second,
-- disconnected student table and no second identifier). students.id — the
-- stable "student-<epoch>-<hash>" System ID already used by every import,
-- report and RPC — stays the authoritative identifier.
--
--   students.status = 'active' | 'former'
--
-- The cleanup workflow is: upload a list of leavers (Student Name + System ID)
-- → the DATABASE matches every row by System ID → admin reviews → one atomic,
-- admin-gated RPC marks the confirmed leavers as 'former'. Nothing is deleted.
--
-- ── Matching contract (the database decides, never the browser) ─────────────
--   1. System ID (students.id) is the ONLY match key. Names are never used to
--      find a student, and a name-only match can never deactivate anyone.
--   2. Exact System ID match + names agree            → SAFE (auto-selectable)
--   3. Exact System ID match + names differ           → REVIEW (strong warning;
--      deactivation needs an explicit per-row admin confirmation)
--   4. System ID missing / not found                  → BLOCKED (never applied)
--   5. More than one database row for a System ID     → BLOCKED (ambiguous)
--   6. Duplicate System ID or duplicate name IN FILE  → REVIEW (ambiguous file)
--   7. Student already 'former'                       → NO-OP (skipped, counted)
--   Names are normalized for COMPARISON ONLY (case, extra spaces, punctuation).
--   There is no fuzzy matching and no similarity threshold that can, on its
--   own, mark a student as former: similarity only decides how loud the
--   warning is.
--
-- ── What marking a student 'former' does ────────────────────────────────────
--   * students.status            -> 'former'
--   * students.statusUpdatedAt   -> now()          (who/when, for the UI)
--   * students.statusUpdatedBy   -> acting admin
--   * students.transport         -> 'LEFT'         (the school's existing
--                                   left-school marker: family-ID generation,
--                                   family cards, print batches and the
--                                   dismissal gate ALREADY exclude 'LEFT', so
--                                   a leaver immediately stops getting a gate
--                                   card or a release)
--   * EVERYTHING ELSE IS UNTOUCHED: name, id, className, parentId, parentPhone,
--     govId, familyId, createdAt — and every child row (exams, attendance,
--     homework, quiz_attempts, report_comments, student_enrollments,
--     student_promotions, release_log, authorized_pickup_students, messages).
--   * A row is appended to student_status_changes with the PREVIOUS status and
--     the PREVIOUS transport, so a restore/rollback is exact — never a guess.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--   rollback_former_student_import() restores the students ONE import batch
--   deactivated, and only while the audit history still says that import was
--   the last thing that changed them. A student whose status was changed again
--   after the import (manual restore, a later import) is SKIPPED and reported —
--   a rollback never overwrites an unrelated later decision.
--
-- New objects
--   * students.status / statusUpdatedAt / statusUpdatedBy
--   * student_status_changes          — append-only status ledger (audit + safe
--                                       rollback source of truth)
--   * former_student_imports          — import history (one row per upload)
--   * former_student_import_rows      — per-row result of an import
--   * former_students_policy()        — the documented policy (single source of
--                                       truth for the rules AND the UI text)
--   * _former_name_key/_former_name_similarity/_former_evaluate_rows (internal)
--   * preview_former_student_import() — DRY RUN, zero writes
--   * apply_former_student_import()   — admin-only atomic commit
--   * rollback_former_student_import()
--   * list_former_student_imports() / get_former_student_import()
--   * list_former_students()          — the Former Students directory
--   * set_student_former_status()     — one student, mark former or restore
--
-- Existing objects updated so "current students" means ACTIVE students
--   * get_system_stats()              — totalStudents counts active students
--                                       (+ new formerStudents count)
--   * teacher_exam_progress (view)    — leavers no longer count as "missing
--                                       entries" against their old teachers
--   * get_class_student_subject_progress() — same, for the class progress grid
--   * promote_students()              — a leaver is never promoted to a new class
--   * mark_student_left()             — keeps students.status in sync with the
--                                       existing family-IDs "LEFT" toggle
--
-- Historical surfaces are DELIBERATELY UNCHANGED: midterm/final/monthly report
-- RPCs resolve peers through student_enrollments + class_students_for_term, so
-- a report issued for a term a leaver attended still includes them.
--
-- DEPLOY ORDER: apply this migration BEFORE the matching client release. The
-- client reads students.status and falls back gracefully (legacy column list)
-- if the column is missing, so an out-of-order deploy degrades instead of
-- breaking — but the RPCs only exist after this file runs.
--
-- Idempotent. The only production data it changes is the documented backfill
-- of students already marked transport = 'LEFT' (they are, by the school's own
-- existing definition, leavers) — recorded in the ledger and in audit_logs.
-- ============================================================================

-- ─── 1. students.status ────────────────────────────────────────────────────
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_status_check;
ALTER TABLE public.students ADD CONSTRAINT students_status_check
  CHECK (status IN ('active', 'former'));

-- Who/when, denormalized for the Former Students directory. The authoritative
-- history is student_status_changes; these two columns only save a join on
-- every list read.
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "statusUpdatedAt" TIMESTAMPTZ;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "statusUpdatedBy" TEXT;

-- Every current-student list filters on this; every former-student lookup
-- filters on (status, className).
CREATE INDEX IF NOT EXISTS idx_students_status ON public.students (status);
CREATE INDEX IF NOT EXISTS idx_students_status_class ON public.students (status, "className");
CREATE INDEX IF NOT EXISTS idx_students_status_updated ON public.students ("statusUpdatedAt" DESC)
  WHERE status = 'former';

-- ─── 2. Status ledger (append-only) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_status_changes (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  "studentName" TEXT,
  "previousStatus" TEXT NOT NULL,
  "newStatus" TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN
    ('former_import', 'former_manual', 'import_rollback', 'manual_restore', 'legacy_left_backfill')),
  -- Exact values needed to undo this change without guessing.
  "previousTransport" TEXT,
  "changedBy" TEXT,
  "changedByName" TEXT,
  "importId" TEXT,
  "fileName" TEXT,
  note TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_changes_student ON public.student_status_changes ("studentId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_status_changes_import ON public.student_status_changes ("importId");
CREATE INDEX IF NOT EXISTS idx_status_changes_created ON public.student_status_changes ("createdAt" DESC);

ALTER TABLE public.student_status_changes ENABLE ROW LEVEL SECURITY;

-- Read: admin only (this is an admin cleanup audit trail).
-- Write: NONE. Rows are created only inside the SECURITY DEFINER RPCs below,
-- so no client can forge or rewrite a status change.
DROP POLICY IF EXISTS "admin_read_status_changes" ON public.student_status_changes;
CREATE POLICY "admin_read_status_changes"
  ON public.student_status_changes FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'admin');

-- ─── 3. Import history ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.former_student_imports (
  id TEXT PRIMARY KEY,
  -- Human "Import #12" number, assigned by the database in commit order.
  seq BIGSERIAL UNIQUE,
  "fileName" TEXT,
  "adminId" TEXT,
  "adminName" TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'rolled_back', 'partially_rolled_back')),
  -- File/preview statistics (what the admin saw before confirming).
  "uploadedCount" INTEGER NOT NULL DEFAULT 0,
  "validCount" INTEGER NOT NULL DEFAULT 0,
  "missingNameCount" INTEGER NOT NULL DEFAULT 0,
  "missingSystemIdCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateSystemIdCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateNameCount" INTEGER NOT NULL DEFAULT 0,
  "foundCount" INTEGER NOT NULL DEFAULT 0,
  "notFoundCount" INTEGER NOT NULL DEFAULT 0,
  "exactMatchCount" INTEGER NOT NULL DEFAULT 0,
  "nameConflictCount" INTEGER NOT NULL DEFAULT 0,
  "possibleDuplicateCount" INTEGER NOT NULL DEFAULT 0,
  "reviewCount" INTEGER NOT NULL DEFAULT 0,
  "alreadyFormerCount" INTEGER NOT NULL DEFAULT 0,
  "readyCount" INTEGER NOT NULL DEFAULT 0,
  -- Outcome.
  "deactivatedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "restoredCount" INTEGER NOT NULL DEFAULT 0,
  "rollbackSkippedCount" INTEGER NOT NULL DEFAULT 0,
  "rolledBackAt" TIMESTAMPTZ,
  "rolledBackBy" TEXT,
  "rolledBackByName" TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_former_imports_created ON public.former_student_imports ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_former_imports_admin ON public.former_student_imports ("adminId");

ALTER TABLE public.former_student_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_read_former_imports" ON public.former_student_imports;
CREATE POLICY "admin_read_former_imports"
  ON public.former_student_imports FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'admin');

CREATE TABLE IF NOT EXISTS public.former_student_import_rows (
  id TEXT PRIMARY KEY,
  "importId" TEXT NOT NULL REFERENCES public.former_student_imports(id) ON DELETE CASCADE,
  "rowNumber" INTEGER,
  "uploadedName" TEXT,
  "uploadedSystemId" TEXT,
  "studentId" TEXT,
  "studentName" TEXT,
  "className" TEXT,
  "matchStatus" TEXT NOT NULL,
  "nameMatch" TEXT,
  "nameSimilarity" NUMERIC,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  "requestedAction" TEXT NOT NULL,
  "adminConfirmed" BOOLEAN NOT NULL DEFAULT false,
  -- deactivated | kept_active | skipped | blocked | already_former
  "actionTaken" TEXT NOT NULL,
  "actionReason" TEXT,
  "previousStatus" TEXT,
  "newStatus" TEXT,
  "restoredAt" TIMESTAMPTZ,
  "restoredBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_former_import_rows_import ON public.former_student_import_rows ("importId");
CREATE INDEX IF NOT EXISTS idx_former_import_rows_student ON public.former_student_import_rows ("studentId");

ALTER TABLE public.former_student_import_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_read_former_import_rows" ON public.former_student_import_rows;
CREATE POLICY "admin_read_former_import_rows"
  ON public.former_student_import_rows FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'admin');

-- ─── 4. The documented policy (single source of truth for rules + UI text) ──
CREATE OR REPLACE FUNCTION public.former_students_policy()
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'policyId', 'former_students_system_id_match',
    'version', 1,
    'nameEn', 'Former Students / Student Cleanup',
    'matchKeyEn', 'System ID (students.id) is the only match key.',
    'matchKeyAr', 'معرّف النظام (students.id) هو مفتاح المطابقة الوحيد.',
    'neverDeleteEn', 'No student record is ever deleted. History is preserved.',
    'confirmPhrase', 'MARK AS FORMER STUDENTS',
    'rollbackConfirmPhrase', 'ROLLBACK IMPORT',
    'maxRows', 5000,
    'statuses', jsonb_build_object(
      'exact_match', 'Exact Match — System ID found and the names agree',
      'id_match_name_conflict', 'ID Match but Name Different — manual review required',
      'possible_duplicate', 'Possible Duplicate — the same System ID or name appears more than once in the file',
      'requires_review', 'Requires Review — the uploaded record cannot be verified',
      'not_found', 'System ID Not Found — nothing will be changed',
      'already_former', 'Already a Former Student — nothing to do'
    ),
    'actions', jsonb_build_object(
      'deactivate', 'Mark as Former Student',
      'keep_active', 'Keep Active',
      'review', 'Review'
    ),
    'autoSafeConditions', jsonb_build_array(
      'system_id_present',
      'system_id_matches_exactly_one_student',
      'uploaded_name_present',
      'uploaded_name_agrees_with_database_name',
      'system_id_unique_in_uploaded_file',
      'uploaded_name_unique_in_uploaded_file',
      'student_currently_active'
    ),
    'neverDeactivateWhen', jsonb_build_array(
      'system_id_missing',
      'system_id_not_found',
      'multiple_database_records_share_the_system_id',
      'uploaded_record_is_ambiguous',
      'only_the_name_matches',
      'uploaded_name_is_very_different_from_the_database_name'
    ),
    'invariants', jsonb_build_object(
      'noDeletes', 'This feature never deletes a student row or any child row.',
      'noFuzzyNameMatch', 'A name match never identifies a student; only System ID does.',
      'notInFileStaysActive', 'A student who is not in the uploaded file is never touched.',
      'historyPreserved', 'Marks, attendance, payments, parents, messages and historical classes stay intact.',
      'rollbackIsChecked', 'Rollback consults the status ledger and skips students changed after the import.'
    )
  );
$$;

-- ─── 5. Name normalization helpers (comparison only — never a match key) ───
CREATE OR REPLACE FUNCTION public._former_name_key(p_text TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(regexp_replace(lower(COALESCE(p_text, '')), '\s+', ' ', 'g'));
$$;

-- Formatting-insensitive variant: punctuation AND spacing are ignored, so
-- "Cabdi-raxmaan" == "Cabdi raxmaan" is a formatting difference, not a
-- different child. Only ever used to compare two names for a student the
-- System ID has ALREADY identified.
CREATE OR REPLACE FUNCTION public._former_name_key_loose(p_text TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(public._former_name_key(p_text), '[^a-z0-9]', '', 'g');
$$;

-- Token Jaccard similarity in [0,1]. Used ONLY to size the warning, never to
-- decide a match.
CREATE OR REPLACE FUNCTION public._former_name_similarity(p_a TEXT, p_b TEXT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH a AS (
    SELECT DISTINCT t FROM unnest(regexp_split_to_array(public._former_name_key(p_a), '\s+')) AS t
    WHERE t <> ''
  ), b AS (
    SELECT DISTINCT t FROM unnest(regexp_split_to_array(public._former_name_key(p_b), '\s+')) AS t
    WHERE t <> ''
  )
  SELECT CASE
    WHEN (SELECT count(*) FROM a) = 0 OR (SELECT count(*) FROM b) = 0 THEN 0
    ELSE ROUND(
      (SELECT count(*) FROM a WHERE t IN (SELECT t FROM b))::NUMERIC
      / NULLIF((SELECT count(*) FROM (SELECT t FROM a UNION SELECT t FROM b) u), 0),
      3)
  END;
$$;

-- ─── 6. The evaluation contract (used by BOTH preview and apply) ───────────
-- One place decides what a row means. apply_former_student_import() re-runs
-- this on the live rows at commit time, so a client list can only NARROW the
-- scope (which rows the admin asked to deactivate) and can never WIDEN it: the
-- server refuses anything this function does not consider eligible.
--
-- p_rows: [{ "rowNumber": int, "name": text, "systemId": text,
--            "action": 'deactivate'|'keep_active'|'review',
--            "adminConfirmed": bool }]
CREATE OR REPLACE FUNCTION public._former_evaluate_rows(p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows JSONB := COALESCE(p_rows, '[]'::jsonb);
  v_row JSONB;
  v_out JSONB := '[]'::jsonb;
  v_row_no INTEGER;
  v_name TEXT;
  v_sys TEXT;
  v_action TEXT;
  v_confirmed BOOLEAN;
  v_id_key TEXT;
  v_name_key TEXT;
  v_matches JSONB;
  v_match_count INTEGER;
  v_match JSONB;
  v_db_name TEXT;
  v_db_class TEXT;
  v_db_status TEXT;
  v_db_transport TEXT;
  v_db_name_key TEXT;
  v_db_name_loose TEXT;
  v_up_name_loose TEXT;
  v_similarity NUMERIC;
  v_name_match TEXT;
  v_status TEXT;
  v_reasons TEXT[];
  v_auto_safe BOOLEAN;
  v_needs_review BOOLEAN;
  v_blocked BOOLEAN;
  v_default_action TEXT;
  -- duplicate detection over the whole file
  v_id_counts JSONB;
  v_name_counts JSONB;
  v_id_dupe BOOLEAN;
  v_name_dupe BOOLEAN;
  -- summary counters
  n_total INTEGER := 0;
  n_valid INTEGER := 0;
  n_missing_name INTEGER := 0;
  n_missing_id INTEGER := 0;
  n_dupe_id INTEGER := 0;
  n_dupe_name INTEGER := 0;
  n_found INTEGER := 0;
  n_not_found INTEGER := 0;
  n_exact INTEGER := 0;
  n_name_conflict INTEGER := 0;
  n_possible_dupe INTEGER := 0;
  n_review_status INTEGER := 0;
  n_review INTEGER := 0;
  n_already INTEGER := 0;
  n_ready INTEGER := 0;
  n_no_action INTEGER := 0;
  n_blocked INTEGER := 0;
BEGIN
  IF jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'Rows must be a JSON array.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(v_rows) > (public.former_students_policy()->>'maxRows')::INTEGER THEN
    RAISE EXCEPTION 'Too many rows in one import (max %). Split the file.',
      (public.former_students_policy()->>'maxRows')::INTEGER
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  -- File-level duplicate counts, computed once (a System ID or a normalized
  -- name appearing on more than one row makes EVERY one of those rows
  -- ambiguous — the admin must look at them).
  SELECT
    COALESCE(jsonb_object_agg(k, c) FILTER (WHERE k <> ''), '{}'::jsonb),
    COALESCE(jsonb_object_agg(nk, nc) FILTER (WHERE nk <> ''), '{}'::jsonb)
  INTO v_id_counts, v_name_counts
  FROM (
    SELECT
      btrim(COALESCE(r->>'systemId', '')) AS k,
      count(*) OVER (PARTITION BY btrim(COALESCE(r->>'systemId', ''))) AS c,
      public._former_name_key(r->>'name') AS nk,
      count(*) OVER (PARTITION BY public._former_name_key(r->>'name')) AS nc
    FROM jsonb_array_elements(v_rows) AS r
  ) d;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_rows)
  LOOP
    n_total := n_total + 1;
    v_row_no := NULLIF(btrim(COALESCE(v_row->>'rowNumber', '')), '')::INTEGER;
    v_name := btrim(COALESCE(v_row->>'name', ''));
    v_sys := btrim(COALESCE(v_row->>'systemId', ''));
    v_action := lower(btrim(COALESCE(v_row->>'action', 'review')));
    IF v_action NOT IN ('deactivate', 'keep_active', 'review') THEN v_action := 'review'; END IF;
    v_confirmed := COALESCE((v_row->>'adminConfirmed')::BOOLEAN, false);
    v_id_key := upper(v_sys);
    v_name_key := public._former_name_key(v_name);
    v_up_name_loose := public._former_name_key_loose(v_name);
    v_reasons := ARRAY[]::TEXT[];
    v_matches := '[]'::jsonb;
    v_match_count := 0;
    v_match := NULL;
    v_db_name := NULL; v_db_class := NULL; v_db_status := NULL; v_db_transport := NULL;
    v_name_match := NULL; v_similarity := NULL;
    -- Loop-carried state must be reset explicitly: PL/pgSQL variables survive
    -- from the previous row, and a leftover classification would silently
    -- label an unrelated row with the previous row's status.
    v_status := NULL;
    v_default_action := NULL;
    v_auto_safe := false; v_needs_review := false; v_blocked := false;

    -- ── File-level problems ──────────────────────────────────────────────
    IF v_sys = '' THEN
      n_missing_id := n_missing_id + 1;
      v_reasons := array_append(v_reasons, 'missing_system_id');
      v_blocked := true;
    END IF;
    IF v_name = '' THEN
      n_missing_name := n_missing_name + 1;
      v_reasons := array_append(v_reasons, 'missing_name');
      v_needs_review := true;
    END IF;

    v_id_dupe := v_sys <> '' AND COALESCE((v_id_counts->>v_sys)::INTEGER, 0) > 1;
    v_name_dupe := v_name_key <> '' AND COALESCE((v_name_counts->>v_name_key)::INTEGER, 0) > 1;
    IF v_id_dupe THEN
      n_dupe_id := n_dupe_id + 1;
      v_reasons := array_append(v_reasons, 'duplicate_system_id_in_file');
      v_needs_review := true;
    END IF;
    IF v_name_dupe THEN
      n_dupe_name := n_dupe_name + 1;
      v_reasons := array_append(v_reasons, 'duplicate_name_in_file');
      v_needs_review := true;
    END IF;

    -- ── Database lookup: System ID only, exact ───────────────────────────
    IF v_sys <> '' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'className', s."className",
               'status', s.status, 'transport', s."transport") ORDER BY s.id), '[]'::jsonb),
             count(*)
        INTO v_matches, v_match_count
        FROM public.students s
       WHERE upper(btrim(s.id)) = v_id_key;

      IF v_match_count = 0 THEN
        n_not_found := n_not_found + 1;
        v_reasons := array_append(v_reasons, 'system_id_not_found');
        v_status := 'not_found';
        v_blocked := true;
      ELSIF v_match_count > 1 THEN
        -- Impossible while students.id is the primary key, and enforced anyway:
        -- an ambiguous System ID is never resolved automatically.
        v_reasons := array_append(v_reasons, 'multiple_database_matches');
        v_status := 'requires_review';
        v_blocked := true;
      ELSE
        v_match := v_matches->0;
        v_db_name := v_match->>'name';
        v_db_class := v_match->>'className';
        v_db_status := COALESCE(v_match->>'status', 'active');
        v_db_transport := v_match->>'transport';
        n_found := n_found + 1;

        -- Name comparison (normalized; never a match key).
        v_db_name_key := public._former_name_key(v_db_name);
        v_db_name_loose := public._former_name_key_loose(v_db_name);
        v_similarity := public._former_name_similarity(v_name, v_db_name);
        IF v_name = '' OR v_db_name_key = '' THEN
          v_name_match := 'missing';
          v_reasons := array_append(v_reasons, 'name_unverified');
          v_needs_review := true;
        ELSIF v_name = v_db_name THEN
          v_name_match := 'exact';
        ELSIF v_name_key = v_db_name_key OR v_up_name_loose = v_db_name_loose THEN
          v_name_match := 'normalized';
          v_reasons := array_append(v_reasons, 'name_case_or_space_difference');
        ELSE
          v_name_match := 'different';
          v_reasons := array_append(v_reasons, 'name_differs');
          IF COALESCE(v_similarity, 0) < 0.5 THEN
            v_reasons := array_append(v_reasons, 'name_very_different');
          END IF;
          v_needs_review := true;
        END IF;

        -- Base classification, decided by the DATABASE match alone. File-level
        -- ambiguity is applied afterwards so it can only DOWNGRADE a clean
        -- match, never upgrade one.
        IF v_db_status = 'former' THEN
          v_status := 'already_former';
          v_reasons := array_append(v_reasons, 'already_former');
        ELSIF v_name_match = 'different' THEN
          v_status := 'id_match_name_conflict';
        ELSIF v_name_match IN ('exact', 'normalized') THEN
          v_status := 'exact_match';
        ELSE
          -- The name could not be verified (missing on one side).
          v_status := 'requires_review';
        END IF;
      END IF;
    ELSE
      -- No System ID at all: nothing can be matched, nothing can be applied.
      v_status := 'requires_review';
    END IF;

    -- File-level ambiguity wins over an otherwise clean match: a duplicated
    -- System ID or name means the FILE is not trustworthy for that row.
    IF (v_id_dupe OR v_name_dupe) AND v_status IN ('exact_match', 'id_match_name_conflict') THEN
      v_status := 'possible_duplicate';
      v_needs_review := true;
    END IF;
    IF v_status IS NULL THEN v_status := 'requires_review'; END IF;

    -- The ONLY automatically safe outcome: one exact System ID match, names
    -- agree, nothing missing and nothing duplicated in the file.
    v_auto_safe := v_status = 'exact_match' AND NOT v_needs_review AND NOT v_blocked;

    v_default_action := CASE
      WHEN v_blocked THEN 'none'
      WHEN v_status = 'already_former' THEN 'none'
      WHEN v_auto_safe THEN 'deactivate'
      ELSE 'review'
    END;

    -- Status counters are taken from the FINAL classification, so a clean match
    -- that the file downgraded to "possible duplicate" is never also counted as
    -- an exact match.
    CASE v_status
      WHEN 'exact_match' THEN n_exact := n_exact + 1;
      WHEN 'id_match_name_conflict' THEN n_name_conflict := n_name_conflict + 1;
      WHEN 'possible_duplicate' THEN n_possible_dupe := n_possible_dupe + 1;
      WHEN 'already_former' THEN n_already := n_already + 1;
      WHEN 'requires_review' THEN n_review_status := n_review_status + 1;
      ELSE NULL;
    END CASE;

    IF v_default_action = 'deactivate' THEN n_ready := n_ready + 1; END IF;
    IF v_default_action = 'review' THEN n_review := n_review + 1; END IF;
    IF v_default_action = 'none' THEN n_no_action := n_no_action + 1; END IF;
    IF v_blocked THEN n_blocked := n_blocked + 1; END IF;
    IF v_sys <> '' AND v_name <> '' THEN n_valid := n_valid + 1; END IF;

    v_out := v_out || jsonb_build_object(
      'rowNumber', v_row_no,
      'uploadedName', v_name,
      'uploadedSystemId', v_sys,
      'matchedStudentId', v_match->>'id',
      'databaseName', v_db_name,
      'databaseSystemId', v_match->>'id',
      'className', v_db_class,
      'databaseStatus', v_db_status,
      'databaseTransport', v_db_transport,
      'matchStatus', v_status,
      'nameMatch', v_name_match,
      'nameSimilarity', v_similarity,
      'reasons', to_jsonb(v_reasons),
      'autoSafe', v_auto_safe,
      'requiresReview', v_needs_review,
      'blocked', v_blocked,
      'defaultAction', v_default_action,
      'requestedAction', v_action,
      'adminConfirmed', v_confirmed
    );
  END LOOP;

  RETURN jsonb_build_object(
    'summary', jsonb_build_object(
      'totalUploaded', n_total,
      'validRecords', n_valid,
      'missingNames', n_missing_name,
      'missingSystemIds', n_missing_id,
      'duplicateSystemIds', n_dupe_id,
      'duplicateNames', n_dupe_name,
      'foundInDatabase', n_found,
      'notFoundInDatabase', n_not_found,
      'exactMatches', n_exact,
      'nameConflicts', n_name_conflict,
      'possibleDuplicates', n_possible_dupe,
      'requiresReviewStatus', n_review_status,
      'alreadyFormer', n_already,
      'requiresReview', n_review,
      'readyToDeactivate', n_ready,
      'noAction', n_no_action,
      'blocked', n_blocked
    ),
    'rows', v_out,
    'evaluatedAt', now()
  );
END;
$$;

-- ─── 7. Preview (DRY RUN — zero writes) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_former_student_import(p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_eval JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may preview a former-student import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_eval := public._former_evaluate_rows(p_rows);
  RETURN v_eval || jsonb_build_object(
    'dryRun', true,
    'writesPerformed', 0,
    'policy', public.former_students_policy()
  );
END;
$$;

-- ─── 8. Apply (one atomic, admin-gated transaction) ────────────────────────
CREATE OR REPLACE FUNCTION public.apply_former_student_import(
  p_rows JSONB,
  p_file_name TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_actor_name TEXT;
  v_eval JSONB;
  v_row JSONB;
  v_import_id TEXT;
  v_file TEXT := NULLIF(btrim(COALESCE(p_file_name, '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_requested TEXT;
  v_confirmed BOOLEAN;
  v_status TEXT;
  v_student_id TEXT;
  v_prev_status TEXT;
  v_prev_transport TEXT;
  v_action_taken TEXT;
  v_action_reason TEXT;
  v_ledger_id TEXT;
  n_deactivated INTEGER := 0;
  n_skipped INTEGER := 0;
  n_kept INTEGER := 0;
  n_blocked INTEGER := 0;
  v_deactivated_ids TEXT[] := ARRAY[]::TEXT[];
  v_skipped JSONB := '[]'::jsonb;
  v_started TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may mark students as former.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Administrator profile not found.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  -- The server re-evaluates every row from the LIVE table. Whatever the
  -- browser believed when it rendered the preview is not trusted here.
  v_eval := public._former_evaluate_rows(p_rows);

  v_import_id := 'fsi-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::TEXT
                 || '-' || substr(md5(random()::TEXT || v_actor), 1, 6);

  INSERT INTO public.former_student_imports (
    id, "fileName", "adminId", "adminName", reason,
    "uploadedCount", "validCount", "missingNameCount", "missingSystemIdCount",
    "duplicateSystemIdCount", "duplicateNameCount", "foundCount", "notFoundCount",
    "exactMatchCount", "nameConflictCount", "possibleDuplicateCount", "reviewCount",
    "alreadyFormerCount", "readyCount", summary, "createdAt")
  VALUES (
    v_import_id, v_file, v_actor, v_actor_name, v_reason,
    (v_eval->'summary'->>'totalUploaded')::INTEGER,
    (v_eval->'summary'->>'validRecords')::INTEGER,
    (v_eval->'summary'->>'missingNames')::INTEGER,
    (v_eval->'summary'->>'missingSystemIds')::INTEGER,
    (v_eval->'summary'->>'duplicateSystemIds')::INTEGER,
    (v_eval->'summary'->>'duplicateNames')::INTEGER,
    (v_eval->'summary'->>'foundInDatabase')::INTEGER,
    (v_eval->'summary'->>'notFoundInDatabase')::INTEGER,
    (v_eval->'summary'->>'exactMatches')::INTEGER,
    (v_eval->'summary'->>'nameConflicts')::INTEGER,
    (v_eval->'summary'->>'possibleDuplicates')::INTEGER,
    (v_eval->'summary'->>'requiresReview')::INTEGER,
    (v_eval->'summary'->>'alreadyFormer')::INTEGER,
    (v_eval->'summary'->>'readyToDeactivate')::INTEGER,
    v_eval->'summary', NOW());

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_eval->'rows')
  LOOP
    v_requested := COALESCE(v_row->>'requestedAction', 'review');
    v_confirmed := COALESCE((v_row->>'adminConfirmed')::BOOLEAN, false);
    v_status := v_row->>'matchStatus';
    v_student_id := v_row->>'matchedStudentId';
    v_action_taken := NULL;
    v_action_reason := NULL;

    IF v_requested = 'keep_active' THEN
      v_action_taken := 'kept_active';
      v_action_reason := 'admin_kept_active';
      n_kept := n_kept + 1;

    ELSIF v_requested <> 'deactivate' THEN
      v_action_taken := 'skipped';
      v_action_reason := 'not_selected_for_deactivation';
      n_skipped := n_skipped + 1;

    ELSIF COALESCE(v_row->>'blocked', 'false')::BOOLEAN THEN
      -- Missing System ID, unknown System ID, ambiguous match: refused even
      -- though the client asked for it.
      v_action_taken := 'blocked';
      v_action_reason := COALESCE(v_row->'reasons'->>0, 'blocked_by_safety_rule');
      n_blocked := n_blocked + 1;
      v_skipped := v_skipped || jsonb_build_object(
        'rowNumber', v_row->>'rowNumber', 'uploadedSystemId', v_row->>'uploadedSystemId',
        'reason', v_action_reason);

    ELSIF v_status = 'already_former' THEN
      v_action_taken := 'already_former';
      v_action_reason := 'already_former';
      n_skipped := n_skipped + 1;

    ELSIF COALESCE(v_row->>'requiresReview', 'false')::BOOLEAN AND NOT v_confirmed THEN
      -- ID matched but the name differs, or the file row is ambiguous: the
      -- admin must confirm that single row explicitly.
      v_action_taken := 'blocked';
      v_action_reason := 'requires_manual_review';
      n_blocked := n_blocked + 1;
      v_skipped := v_skipped || jsonb_build_object(
        'rowNumber', v_row->>'rowNumber', 'uploadedSystemId', v_row->>'uploadedSystemId',
        'reason', v_action_reason);

    ELSIF v_student_id IS NULL THEN
      v_action_taken := 'blocked';
      v_action_reason := 'no_matched_student';
      n_blocked := n_blocked + 1;

    ELSE
      -- Re-read with a row lock: a concurrent admin may have changed this
      -- student between the preview and this commit.
      SELECT status, "transport" INTO v_prev_status, v_prev_transport
        FROM public.students WHERE id = v_student_id FOR UPDATE;
      IF NOT FOUND THEN
        v_action_taken := 'blocked';
        v_action_reason := 'student_disappeared';
        n_blocked := n_blocked + 1;
      ELSIF COALESCE(v_prev_status, 'active') = 'former' THEN
        v_action_taken := 'already_former';
        v_action_reason := 'already_former';
        n_skipped := n_skipped + 1;
      ELSE
        v_ledger_id := 'ssc-' || floor(extract(epoch FROM clock_timestamp()) * 1000000)::TEXT
                       || '-' || substr(md5(random()::TEXT || v_student_id), 1, 8);

        -- STATUS ONLY. Name, System ID, class, parent, phone, Gov ID, family
        -- ID and every child row are preserved exactly as they are.
        UPDATE public.students
           SET status = 'former',
               "statusUpdatedAt" = NOW(),
               "statusUpdatedBy" = v_actor,
               "transport" = 'LEFT'
         WHERE id = v_student_id;

        INSERT INTO public.student_status_changes (
          id, "studentId", "studentName", "previousStatus", "newStatus", reason,
          "previousTransport", "changedBy", "changedByName", "importId", "fileName", note, "createdAt")
        VALUES (
          v_ledger_id, v_student_id, v_row->>'databaseName', COALESCE(v_prev_status, 'active'), 'former',
          'former_import', v_prev_transport, v_actor, v_actor_name, v_import_id, v_file, v_reason, NOW());

        v_action_taken := 'deactivated';
        v_action_reason := CASE WHEN v_confirmed THEN 'admin_confirmed_review_row' ELSE 'exact_system_id_match' END;
        n_deactivated := n_deactivated + 1;
        v_deactivated_ids := array_append(v_deactivated_ids, v_student_id);
      END IF;
    END IF;

    INSERT INTO public.former_student_import_rows (
      id, "importId", "rowNumber", "uploadedName", "uploadedSystemId", "studentId", "studentName",
      "className", "matchStatus", "nameMatch", "nameSimilarity", reasons,
      "requestedAction", "adminConfirmed", "actionTaken", "actionReason",
      "previousStatus", "newStatus", "createdAt")
    VALUES (
      'fsr-' || floor(extract(epoch FROM clock_timestamp()) * 1000000)::TEXT
        || '-' || substr(md5(random()::TEXT || COALESCE(v_row->>'uploadedSystemId', '')), 1, 8),
      v_import_id, NULLIF(v_row->>'rowNumber', '')::INTEGER,
      v_row->>'uploadedName', v_row->>'uploadedSystemId', v_student_id, v_row->>'databaseName',
      v_row->>'className', v_status, v_row->>'nameMatch',
      NULLIF(v_row->>'nameSimilarity', '')::NUMERIC, COALESCE(v_row->'reasons', '[]'::jsonb),
      v_requested, v_confirmed, v_action_taken, v_action_reason,
      CASE WHEN v_action_taken = 'deactivated' THEN 'active' ELSE NULL END,
      CASE WHEN v_action_taken = 'deactivated' THEN 'former' ELSE NULL END,
      NOW());
  END LOOP;

  UPDATE public.former_student_imports
     SET "deactivatedCount" = n_deactivated,
         "skippedCount" = n_skipped + n_kept + n_blocked
   WHERE id = v_import_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.former_import', jsonb_build_object(
    'importId', v_import_id,
    'actor', v_actor,
    'actorName', v_actor_name,
    'fileName', v_file,
    'reason', v_reason,
    'uploaded', (v_eval->'summary'->>'totalUploaded')::INTEGER,
    'exactMatches', (v_eval->'summary'->>'exactMatches')::INTEGER,
    'nameConflicts', (v_eval->'summary'->>'nameConflicts')::INTEGER,
    'notFound', (v_eval->'summary'->>'notFoundInDatabase')::INTEGER,
    'deactivated', n_deactivated,
    'skipped', n_skipped,
    'keptActive', n_kept,
    'blocked', n_blocked,
    'deletedStudents', 0,
    'formerStudentIds', to_jsonb(v_deactivated_ids),
    'skippedRows', v_skipped), NOW());

  RETURN jsonb_build_object(
    'importId', v_import_id,
    'importNumber', (SELECT seq FROM public.former_student_imports WHERE id = v_import_id),
    'committed', true,
    'atomic', true,
    'fileName', v_file,
    'adminId', v_actor,
    'adminName', v_actor_name,
    'deactivated', n_deactivated,
    'skipped', n_skipped,
    'keptActive', n_kept,
    'blocked', n_blocked,
    'deleted', 0,
    'formerStudentIds', to_jsonb(v_deactivated_ids),
    'skippedRows', v_skipped,
    'summary', v_eval->'summary',
    'invariants', public.former_students_policy()->'invariants',
    'durationMs', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::INTEGER,
    'completedAt', now());
END;
$$;

-- ─── 9. Rollback one import batch ──────────────────────────────────────────
-- Restores ONLY the students this import deactivated, and ONLY while the
-- ledger still says this import was the last status change for them. Anything
-- changed afterwards is skipped and reported, never overwritten.
CREATE OR REPLACE FUNCTION public.rollback_former_student_import(
  p_import_id TEXT,
  p_confirm_phrase TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_actor_name TEXT;
  v_phrase TEXT := upper(btrim(COALESCE(p_confirm_phrase, '')));
  v_expected TEXT := public.former_students_policy()->>'rollbackConfirmPhrase';
  v_file_name TEXT;
  v_import_status TEXT;
  v_row RECORD;
  v_latest RECORD;
  v_current_status TEXT;
  v_current_transport TEXT;
  n_restored INTEGER := 0;
  n_skipped INTEGER := 0;
  v_skipped JSONB := '[]'::jsonb;
  v_restored_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may roll back a former-student import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_phrase <> upper(v_expected) THEN
    RAISE EXCEPTION 'Rollback confirmation phrase required: type % to undo this import.', v_expected
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i."fileName", i.status INTO v_file_name, v_import_status
    FROM public.former_student_imports i WHERE i.id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found.', p_import_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_import_status = 'rolled_back' THEN
    RAISE EXCEPTION 'Import % was already rolled back.', p_import_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  FOR v_row IN
    SELECT r.id AS row_id,
           r."studentId" AS student_id,
           r."studentName" AS student_name,
           led.id AS ledger_id
      FROM public.former_student_import_rows r
      LEFT JOIN LATERAL (
        SELECT c.id
          FROM public.student_status_changes c
         WHERE c."studentId" = r."studentId"
           AND c."importId" = r."importId"
           AND c.reason = 'former_import'
         ORDER BY c."createdAt" DESC, c.id DESC
         LIMIT 1
      ) led ON true
     WHERE r."importId" = p_import_id
       AND r."actionTaken" = 'deactivated'
     ORDER BY r."createdAt", r.id
  LOOP
    SELECT s.status, s."transport" INTO v_current_status, v_current_transport
      FROM public.students s WHERE s.id = v_row.student_id FOR UPDATE;
    IF NOT FOUND THEN
      n_skipped := n_skipped + 1;
      v_skipped := v_skipped || jsonb_build_object(
        'studentId', v_row.student_id, 'reason', 'student_missing');
      CONTINUE;
    END IF;

    -- Audit check #1: the most recent status change for this student must
    -- still be the one THIS import wrote. If anything changed the student
    -- afterwards (a manual restore, a later import), the rollback reports it
    -- and moves on — it never overwrites an unrelated later decision.
    SELECT c.id AS ledger_id, c."previousStatus" AS prev_status,
           c."previousTransport" AS prev_transport, c.reason AS change_reason,
           c."createdAt" AS changed_at
      INTO v_latest
      FROM public.student_status_changes c
     WHERE c."studentId" = v_row.student_id
     ORDER BY c."createdAt" DESC, c.id DESC
     LIMIT 1;

    IF v_latest.ledger_id IS DISTINCT FROM v_row.ledger_id THEN
      n_skipped := n_skipped + 1;
      v_skipped := v_skipped || jsonb_build_object(
        'studentId', v_row.student_id, 'studentName', v_row.student_name,
        'reason', 'changed_after_import',
        'lastChangeReason', v_latest.change_reason, 'lastChangeAt', v_latest.changed_at);
      CONTINUE;
    END IF;

    -- Audit check #2: the student must still be in the state the import left
    -- them in (defence in depth against a direct SQL edit).
    IF COALESCE(v_current_status, 'active') <> 'former' THEN
      n_skipped := n_skipped + 1;
      v_skipped := v_skipped || jsonb_build_object(
        'studentId', v_row.student_id, 'reason', 'status_already_changed',
        'currentStatus', v_current_status);
      CONTINUE;
    END IF;

    -- Restore the EXACT previous status and transport recorded in the ledger.
    UPDATE public.students
       SET status = v_latest.prev_status,
           "transport" = v_latest.prev_transport,
           "statusUpdatedAt" = NOW(),
           "statusUpdatedBy" = v_actor
     WHERE id = v_row.student_id;

    INSERT INTO public.student_status_changes (
      id, "studentId", "studentName", "previousStatus", "newStatus", reason,
      "previousTransport", "changedBy", "changedByName", "importId", "fileName", note, "createdAt")
    VALUES (
      'ssc-' || floor(extract(epoch FROM clock_timestamp()) * 1000000)::TEXT
        || '-' || substr(md5(random()::TEXT || v_row.student_id), 1, 8),
      v_row.student_id, v_row.student_name, 'former', v_latest.prev_status,
      'import_rollback', v_current_transport, v_actor, v_actor_name, p_import_id,
      v_file_name, 'Rollback of import ' || p_import_id, NOW());

    UPDATE public.former_student_import_rows
       SET "restoredAt" = NOW(), "restoredBy" = v_actor
     WHERE id = v_row.row_id;

    n_restored := n_restored + 1;
    v_restored_ids := array_append(v_restored_ids, v_row.student_id);
  END LOOP;

  UPDATE public.former_student_imports
     SET status = CASE WHEN n_skipped = 0 THEN 'rolled_back' ELSE 'partially_rolled_back' END,
         "restoredCount" = public.former_student_imports."restoredCount" + n_restored,
         "rollbackSkippedCount" = public.former_student_imports."rollbackSkippedCount" + n_skipped,
         "rolledBackAt" = NOW(),
         "rolledBackBy" = v_actor,
         "rolledBackByName" = v_actor_name
   WHERE id = p_import_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.former_import_rollback', jsonb_build_object(
    'importId', p_import_id, 'actor', v_actor, 'actorName', v_actor_name,
    'fileName', v_file_name, 'restored', n_restored, 'skipped', n_skipped,
    'restoredStudentIds', to_jsonb(v_restored_ids), 'skippedRows', v_skipped), NOW());

  RETURN jsonb_build_object(
    'importId', p_import_id,
    'restored', n_restored,
    'skipped', n_skipped,
    'restoredStudentIds', to_jsonb(v_restored_ids),
    'skippedRows', v_skipped,
    'importStatus', CASE WHEN n_skipped = 0 THEN 'rolled_back' ELSE 'partially_rolled_back' END,
    'completedAt', now());
END;
$$;

-- ─── 10. Import history ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_former_student_imports(
  p_limit INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_total INTEGER;
  v_rows JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may read the former-student import history.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_total FROM public.former_student_imports;

  -- The page is applied in the inner query (jsonb_agg itself cannot be paged),
  -- then the page is re-assembled newest-first.
  SELECT COALESCE(jsonb_agg(x ORDER BY ord DESC), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT i.seq AS ord, jsonb_build_object(
        'id', i.id, 'importNumber', i.seq, 'fileName', i."fileName",
        'adminId', i."adminId", 'adminName', i."adminName", 'reason', i.reason,
        'status', i.status,
        'uploadedCount', i."uploadedCount", 'validCount', i."validCount",
        'missingNameCount', i."missingNameCount", 'missingSystemIdCount', i."missingSystemIdCount",
        'duplicateSystemIdCount', i."duplicateSystemIdCount", 'duplicateNameCount', i."duplicateNameCount",
        'foundCount', i."foundCount", 'notFoundCount', i."notFoundCount",
        'exactMatchCount', i."exactMatchCount", 'nameConflictCount', i."nameConflictCount",
        'possibleDuplicateCount', i."possibleDuplicateCount",
        'reviewCount', i."reviewCount", 'alreadyFormerCount', i."alreadyFormerCount",
        'readyCount', i."readyCount",
        'deactivatedCount', i."deactivatedCount", 'skippedCount', i."skippedCount",
        'restoredCount', i."restoredCount", 'rollbackSkippedCount', i."rollbackSkippedCount",
        'rolledBackAt', i."rolledBackAt", 'rolledBackByName', i."rolledBackByName",
        'createdAt', i."createdAt") AS x
        FROM public.former_student_imports i
       ORDER BY i.seq DESC
       LIMIT v_limit OFFSET v_offset
    ) s;

  RETURN jsonb_build_object('total', v_total, 'imports', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_former_student_import(
  p_import_id TEXT,
  p_limit INTEGER DEFAULT 200,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 2000);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_import JSONB;
  v_rows JSONB;
  v_total INTEGER;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may read a former-student import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT jsonb_build_object(
      'id', i.id, 'importNumber', i.seq, 'fileName', i."fileName",
      'adminId', i."adminId", 'adminName', i."adminName", 'reason', i.reason,
      'status', i.status, 'summary', i.summary,
      'uploadedCount', i."uploadedCount", 'validCount', i."validCount",
      'missingNameCount', i."missingNameCount", 'missingSystemIdCount', i."missingSystemIdCount",
      'duplicateSystemIdCount', i."duplicateSystemIdCount", 'duplicateNameCount', i."duplicateNameCount",
      'foundCount', i."foundCount", 'notFoundCount', i."notFoundCount",
      'exactMatchCount', i."exactMatchCount", 'nameConflictCount', i."nameConflictCount",
      'possibleDuplicateCount', i."possibleDuplicateCount",
      'reviewCount', i."reviewCount", 'alreadyFormerCount', i."alreadyFormerCount",
      'readyCount', i."readyCount",
      'deactivatedCount', i."deactivatedCount", 'skippedCount', i."skippedCount",
      'restoredCount', i."restoredCount", 'rollbackSkippedCount', i."rollbackSkippedCount",
      'rolledBackAt', i."rolledBackAt", 'rolledBackByName', i."rolledBackByName",
      'createdAt', i."createdAt")
    INTO v_import
    FROM public.former_student_imports i WHERE i.id = p_import_id;

  IF v_import IS NULL THEN
    RAISE EXCEPTION 'Import % not found.', p_import_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_total FROM public.former_student_import_rows r WHERE r."importId" = p_import_id;

  SELECT COALESCE(jsonb_agg(x ORDER BY ord), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT r."createdAt" AS ord, jsonb_build_object(
        'id', r.id, 'rowNumber', r."rowNumber",
        'uploadedName', r."uploadedName", 'uploadedSystemId', r."uploadedSystemId",
        'studentId', r."studentId", 'studentName', r."studentName", 'className', r."className",
        'matchStatus', r."matchStatus", 'nameMatch', r."nameMatch",
        'nameSimilarity', r."nameSimilarity", 'reasons', r.reasons,
        'requestedAction', r."requestedAction", 'adminConfirmed', r."adminConfirmed",
        'actionTaken', r."actionTaken", 'actionReason', r."actionReason",
        'previousStatus', r."previousStatus", 'newStatus', r."newStatus",
        'restoredAt', r."restoredAt") AS x
        FROM public.former_student_import_rows r
       WHERE r."importId" = p_import_id
       ORDER BY r."createdAt", r.id
       LIMIT v_limit OFFSET v_offset
    ) s;

  RETURN jsonb_build_object('import', v_import, 'rows', v_rows, 'rowTotal', v_total);
END;
$$;

-- ─── 11. Former Students directory ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_former_students(
  p_search TEXT DEFAULT NULL,
  p_class TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_q TEXT := btrim(COALESCE(p_search, ''));
  v_class TEXT := NULLIF(btrim(COALESCE(p_class, '')), '');
  v_total INTEGER;
  v_rows JSONB;
  v_classes JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may list former students.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_total
    FROM public.students s
   WHERE s.status = 'former'
     AND (v_class IS NULL OR s."className" = v_class)
     AND (v_q = '' OR s.name ILIKE '%' || v_q || '%' OR s.id ILIKE '%' || v_q || '%'
          OR COALESCE(s."govId", '') ILIKE '%' || v_q || '%');

  SELECT COALESCE(jsonb_agg(x ORDER BY sort_name), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT lower(s.name) AS sort_name, jsonb_build_object(
        'id', s.id, 'name', s.name, 'className', s."className",
        'govId', s."govId", 'parentId', s."parentId", 'parentName', p.name,
        'parentPhone', s."parentPhone", 'transport', s."transport", 'familyId', s."familyId",
        'status', s.status, 'markedFormerAt', s."statusUpdatedAt", 'markedFormerBy', s."statusUpdatedBy",
        'markedFormerByName', actor.name,
        'createdAt', s."createdAt",
        'lastChange', (
          SELECT jsonb_build_object('reason', c.reason, 'at', c."createdAt", 'by', c."changedByName",
                                    'fileName', c."fileName", 'importId', c."importId")
            FROM public.student_status_changes c
           WHERE c."studentId" = s.id
           ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1)) AS x
        FROM public.students s
        LEFT JOIN public.profiles p ON p.id = s."parentId"
        LEFT JOIN public.profiles actor ON actor.id = s."statusUpdatedBy"
       WHERE s.status = 'former'
         AND (v_class IS NULL OR s."className" = v_class)
         AND (v_q = '' OR s.name ILIKE '%' || v_q || '%' OR s.id ILIKE '%' || v_q || '%'
              OR COALESCE(s."govId", '') ILIKE '%' || v_q || '%')
       ORDER BY lower(s.name)
       LIMIT v_limit OFFSET v_offset
    ) t;

  SELECT COALESCE(jsonb_agg(DISTINCT c ORDER BY c), '[]'::jsonb) INTO v_classes
    FROM public.students s2, LATERAL (SELECT s2."className" AS c) k
   WHERE s2.status = 'former' AND s2."className" IS NOT NULL;

  RETURN jsonb_build_object('total', v_total, 'students', v_rows, 'classes', v_classes);
END;
$$;

-- ─── 12. One student: mark former / restore to active ──────────────────────
CREATE OR REPLACE FUNCTION public.set_student_former_status(
  p_student_id TEXT,
  p_status TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_actor_name TEXT;
  v_target TEXT := lower(btrim(COALESCE(p_status, '')));
  v_note TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_student RECORD;
  v_prev_status TEXT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may change a student status.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_target NOT IN ('active', 'former') THEN
    RAISE EXCEPTION 'Status must be "active" or "former".' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, name, status, "transport" INTO v_student
    FROM public.students WHERE id = p_student_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  v_prev_status := COALESCE(v_student.status, 'active');

  IF v_prev_status = v_target THEN
    RETURN jsonb_build_object('studentId', v_student.id, 'status', v_target,
      'changed', false, 'reason', 'already_in_state');
  END IF;

  IF v_target = 'former' THEN
    UPDATE public.students
       SET status = 'former', "statusUpdatedAt" = NOW(), "statusUpdatedBy" = v_actor,
           "transport" = 'LEFT'
     WHERE id = v_student.id;
  ELSE
    -- Restore the exact transport the student had before they were marked
    -- former (never a guess, never a hardcoded WALKER).
    UPDATE public.students
       SET status = 'active', "statusUpdatedAt" = NOW(), "statusUpdatedBy" = v_actor,
           "transport" = (
             SELECT c."previousTransport" FROM public.student_status_changes c
              WHERE c."studentId" = v_student.id AND c."newStatus" = 'former'
              ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1)
     WHERE id = v_student.id;
  END IF;

  INSERT INTO public.student_status_changes (
    id, "studentId", "studentName", "previousStatus", "newStatus", reason,
    "previousTransport", "changedBy", "changedByName", note, "createdAt")
  VALUES (
    'ssc-' || floor(extract(epoch FROM clock_timestamp()) * 1000000)::TEXT
      || '-' || substr(md5(random()::TEXT || v_student.id), 1, 8),
    v_student.id, v_student.name, v_prev_status, v_target,
    CASE WHEN v_target = 'former' THEN 'former_manual' ELSE 'manual_restore' END,
    v_student."transport", v_actor, v_actor_name, v_note, NOW());

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.status_change', jsonb_build_object(
    'actor', v_actor, 'actorName', v_actor_name, 'studentId', v_student.id,
    'studentName', v_student.name, 'previousStatus', v_prev_status, 'newStatus', v_target,
    'reason', v_note), NOW());

  RETURN jsonb_build_object('studentId', v_student.id, 'studentName', v_student.name,
    'previousStatus', v_prev_status, 'status', v_target, 'changed', true,
    'changedBy', v_actor, 'changedAt', now());
END;
$$;

-- ─── 13. Keep the existing family-IDs "LEFT" toggle in sync ────────────────
-- mark_student_left() predates students.status. Recreated from
-- 20260819_family_id_stability_and_cards.sql with the status ledger added, so
-- the two features can never disagree about who has left. familyId is still
-- preserved in BOTH directions (unchanged behaviour).
CREATE OR REPLACE FUNCTION public.mark_student_left(p_student_id TEXT, p_left BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor TEXT := public.current_profile_id();
  v_actor_name TEXT;
  v_student RECORD;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may mark students as left.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, name, status, "transport" INTO v_student
    FROM public.students WHERE id = p_student_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  -- familyId is preserved in BOTH directions: a restored student rejoins the
  -- family they always belonged to.
  IF p_left THEN
    UPDATE public.students
       SET "transport" = 'LEFT',
           status = 'former',
           "statusUpdatedAt" = NOW(),
           "statusUpdatedBy" = v_actor
     WHERE id = p_student_id;
  ELSE
    UPDATE public.students
       SET "transport" = NULL,
           status = 'active',
           "statusUpdatedAt" = NOW(),
           "statusUpdatedBy" = v_actor
     WHERE id = p_student_id;
  END IF;

  IF COALESCE(v_student.status, 'active') <> (CASE WHEN p_left THEN 'former' ELSE 'active' END) THEN
    INSERT INTO public.student_status_changes (
      id, "studentId", "studentName", "previousStatus", "newStatus", reason,
      "previousTransport", "changedBy", "changedByName", note, "createdAt")
    VALUES (
      'ssc-' || floor(extract(epoch FROM clock_timestamp()) * 1000000)::TEXT
        || '-' || substr(md5(random()::TEXT || p_student_id), 1, 8),
      p_student_id, v_student.name, COALESCE(v_student.status, 'active'),
      CASE WHEN p_left THEN 'former' ELSE 'active' END,
      CASE WHEN p_left THEN 'former_manual' ELSE 'manual_restore' END,
      v_student."transport", v_actor, v_actor_name,
      'family_ids.mark_student_left', NOW());
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('family_ids.left', jsonb_build_object('studentId', p_student_id, 'left', p_left,
    'actor', v_actor), NOW());
END;
$$;

-- ─── 14. Active-student surfaces ───────────────────────────────────────────
-- get_system_stats(): totalStudents is an ACTIVE count now; formerStudents is
-- reported separately so the dashboard can show both. Every other key is
-- byte-for-byte the previous behaviour.
CREATE OR REPLACE FUNCTION public.get_system_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  select jsonb_build_object(
    'totalTeachers', (
      select count(*)
      from public.profiles
      where lower(trim(role::text)) = 'teacher'
    ),
    'totalParents', (
      select count(*)
      from public.profiles
      where lower(trim(role::text)) = 'parent'
    ),
    'totalStudents', (
      select count(*)
      from public.students
      where coalesce(status, 'active') = 'active'
    ),
    'formerStudents', (
      select count(*)
      from public.students
      where coalesce(status, 'active') = 'former'
    ),
    'totalExams', (
      select count(*)
      from public.exams
    ),
    'pendingExams', (
      select count(*)
      from public.exams
      where status = 'pending'
    ),
    'approvedExams', (
      select count(*)
      from public.exams
      where status = 'approved'
    ),
    'rejectedExams', (
      select count(*)
      from public.exams
      where status = 'rejected'
    ),
    'averageScore', (
      select coalesce(
        round(
          avg(
            case
              when total > 0 then (score::numeric / total::numeric) * 100
              else null
            end
          ),
          2
        ),
        0
      )
      from public.exams
    )
  );
$$;

-- promote_students(): a leaver is never moved into a new class. Recreated from
-- 20260906c (SECURITY DEFINER, admin-gated, enrollment-aware) with the single
-- added predicate.
CREATE OR REPLACE FUNCTION public.promote_students(
  from_class TEXT, to_class TEXT, academic_year_id TEXT DEFAULT NULL
)
RETURNS TABLE(promoted_id TEXT, student_name TEXT, old_class TEXT, new_class TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_effective DATE := COALESCE(
    (SELECT "startDate" FROM public.academic_years WHERE id = academic_year_id),
    CURRENT_DATE);
  rec RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.student_promotions
    WHERE "fromClass" = from_class AND "academicYearId" = academic_year_id
      AND source = 'promotion'
  ) THEN
    RAISE EXCEPTION 'Class "%" has already been promoted this academic year', from_class;
  END IF;

  FOR rec IN
    SELECT id, name, "className" FROM public.students
     WHERE "className" = from_class
       AND COALESCE(status, 'active') <> 'former'  -- leavers stay where they are
     FOR UPDATE
  LOOP
    UPDATE public.students SET "className" = to_class WHERE id = rec.id;
    INSERT INTO public.student_promotions
      (id, "studentId", "fromClass", "toClass", "academicYearId", source)
    VALUES ('promo-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
            || '-' || substr(md5(random()::text || rec.id),1,6),
            rec.id, from_class, to_class, academic_year_id, 'promotion');
    PERFORM public.record_class_assignment(
      rec.id, to_class, 'promotion', v_effective, academic_year_id, NULL, 'promote_students');
    promoted_id := rec.id; student_name := rec.name;
    old_class := from_class; new_class := to_class;
    RETURN NEXT;
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.promote', jsonb_build_object('actor', v_actor,
      'fromClass', from_class, 'toClass', to_class,
      'academicYearId', academic_year_id), NOW());
END;
$$;

-- ─── 15. Backfill: transport = 'LEFT' already means "left the school" ──────
-- The family-ID feature has marked leavers as transport = 'LEFT' since
-- 20260802. Those students ARE former students, so status is normalized once
-- here — with a ledger row per student and one audit_logs summary, so the
-- backfill is fully traceable and reversible through the same ledger.
DO $$
DECLARE
  v_n INTEGER;
BEGIN
  INSERT INTO public.student_status_changes (
    id, "studentId", "studentName", "previousStatus", "newStatus", reason,
    "previousTransport", note, "createdAt")
  SELECT 'ssc-backfill-' || s.id, s.id, s.name, 'active', 'former', 'legacy_left_backfill',
         s."transport",
         'Backfill: student was already marked transport = LEFT by the family-ID feature.',
         NOW()
    FROM public.students s
   WHERE COALESCE(s."transport", '') = 'LEFT'
     AND COALESCE(s.status, 'active') <> 'former'
     AND NOT EXISTS (SELECT 1 FROM public.student_status_changes c WHERE c.id = 'ssc-backfill-' || s.id);

  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.students s
     SET status = 'former',
         "statusUpdatedAt" = COALESCE(s."statusUpdatedAt", NOW())
    FROM public.student_status_changes c
   WHERE c.id = 'ssc-backfill-' || s.id
     AND COALESCE(s.status, 'active') <> 'former';

  IF v_n > 0 THEN
    INSERT INTO public.audit_logs (action, details, "createdAt")
    VALUES ('students.status_backfill', jsonb_build_object(
      'migration', '20261008_former_students_cleanup',
      'reason', 'legacy_left_backfill',
      'studentsMarkedFormer', v_n), NOW());
  END IF;
END $$;

-- ─── 16. Grants (mirrors the 20260925 two-tier convention) ─────────────────
-- Client-callable RPCs keep EXECUTE for `authenticated` and each one re-checks
-- current_profile_role() internally. The `_former_*` helpers are INTERNAL: they
-- run inside the SECURITY DEFINER chain above, so revoking the direct call path
-- only removes a way to read arbitrary student rows (bypassing student RLS).
DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.former_students_policy()',
    'public.preview_former_student_import(JSONB)',
    'public.apply_former_student_import(JSONB,TEXT,TEXT)',
    'public.rollback_former_student_import(TEXT,TEXT)',
    'public.list_former_student_imports(INTEGER,INTEGER)',
    'public.get_former_student_import(TEXT,INTEGER,INTEGER)',
    'public.list_former_students(TEXT,TEXT,INTEGER,INTEGER)',
    'public.set_student_former_status(TEXT,TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public._former_name_key(TEXT)',
    'public._former_name_key_loose(TEXT)',
    'public._former_name_similarity(TEXT,TEXT)',
    'public._former_evaluate_rows(JSONB)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
