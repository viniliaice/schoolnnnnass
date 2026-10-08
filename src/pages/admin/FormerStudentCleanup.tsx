// Former Students / Student Cleanup — admin workflow.
//
// Upload a list of leavers (Student Name + System ID) → the DATABASE matches
// every row by System ID → review → explicit typed confirmation → ONE atomic
// admin-gated RPC (apply_former_student_import). Nothing is written before the
// administrator confirms, and nothing is EVER deleted: the RPC only moves
// students.status from 'active' to 'former'.
//
// Safety rules this page must never work around (they are enforced again in SQL,
// see supabase/migrations/20261008_former_students_cleanup.sql):
//   * System ID is the only match key. A name can never identify a student.
//   * Missing / unknown / ambiguous System IDs can never be applied.
//   * An ID match whose name differs needs a per-row, explicit confirmation.
//   * Students who are NOT in the uploaded file are never touched.
//
// Authorization: route is admin-only (ROUTE_ACCESS + App switch) AND every RPC
// re-checks the role server-side. Hiding this page is not the control.

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  UploadCloud, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle,
  Loader2, ShieldCheck, Search, UserMinus, Users, FileWarning, Info, ArrowRight,
  RotateCcw, ListChecks,
} from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { cn } from '../../utils/cn';
import { getStudents } from '../../lib/db/students';
import {
  applyFormerStudentImport,
  matchStatusLabel,
  previewFormerStudentImport,
  FORMER_STUDENT_CONFIRM_PHRASE,
  type FormerStudentApplyResult,
  type FormerStudentSummary,
} from '../../lib/db/formerStudents';
import {
  buildFormerStudentTemplate,
  canRequestDeactivation,
  evaluateFormerStudentRows,
  isCsvFileName,
  isSupportedFormerStudentFile,
  MAX_FORMER_IMPORT_FILE_BYTES,
  MAX_FORMER_IMPORT_ROWS,
  parseFormerStudentFile,
  requiresExplicitConfirmation,
  summarizeFormerStudentFile,
  type FormerStudentEvaluation,
  type FormerStudentParseResult,
} from '../../lib/import/formerStudents';

type Step = 'upload' | 'review' | 'done';
type RowDecision = 'deactivate' | 'keep_active' | 'review';
type RowFilter = 'all' | 'safe' | 'review' | 'notfound';

/** Badge styling per match status (the ✅ / ⚠️ / ❌ set the school asked for). */
const STATUS_BADGE: Record<FormerStudentEvaluation['matchStatus'], { label: string; icon: typeof CheckCircle2; className: string }> = {
  exact_match: { label: '✅ Exact Match', icon: CheckCircle2, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  id_match_name_conflict: { label: '⚠️ ID Match but Name Different', icon: AlertTriangle, className: 'bg-amber-50 text-amber-800 border-amber-200' },
  possible_duplicate: { label: '⚠️ Possible Duplicate', icon: AlertTriangle, className: 'bg-orange-50 text-orange-800 border-orange-200' },
  requires_review: { label: '⚠️ Requires Review', icon: AlertTriangle, className: 'bg-amber-50 text-amber-800 border-amber-200' },
  not_found: { label: '❌ System ID Not Found', icon: XCircle, className: 'bg-red-50 text-red-700 border-red-200' },
  already_former: { label: 'ℹ️ Already a Former Student', icon: Info, className: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const REASON_TEXT: Record<string, string> = {
  missing_system_id: 'No System ID in the file — nothing can be matched safely.',
  missing_name: 'No student name in the file — the match cannot be verified.',
  duplicate_system_id_in_file: 'This System ID appears more than once in the file.',
  duplicate_name_in_file: 'This name appears more than once in the file with different System IDs.',
  system_id_not_found: 'No student in the database has this System ID.',
  multiple_database_matches: 'More than one database record shares this System ID — ambiguous.',
  name_unverified: 'A name is missing on one side, so the match could not be verified.',
  name_case_or_space_difference: 'Names agree apart from capitalization/spacing.',
  name_differs: 'The uploaded name differs from the database name.',
  name_very_different: 'The names are very different — check this is really the same child.',
  already_former: 'This student is already marked as a Former Student.',
};

function StatusBadge({ status }: { status: FormerStudentEvaluation['matchStatus'] }) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.requires_review;
  const Icon = badge.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border whitespace-nowrap', badge.className)}>
      <Icon className="w-3.5 h-3.5" />
      {matchStatusLabel(status)}
    </span>
  );
}

function NameMatchBadge({ evaluation }: { evaluation: FormerStudentEvaluation }) {
  if (!evaluation.matchedStudentId) return <span className="text-xs text-slate-400">—</span>;
  if (evaluation.nameMatch === 'exact') {
    return <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Names agree</span>;
  }
  if (evaluation.nameMatch === 'normalized') {
    return <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Names agree (spacing/case)</span>;
  }
  if (evaluation.nameMatch === 'missing') {
    return <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">Name not verifiable</span>;
  }
  const veryDifferent = evaluation.reasons.includes('name_very_different');
  return (
    <span className={cn(
      'inline-flex px-2 py-0.5 rounded-md text-xs font-semibold border',
      veryDifferent ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-800 border-amber-200',
    )}>
      {veryDifferent ? 'Names very different' : 'Names differ'}
      {typeof evaluation.nameSimilarity === 'number' && ` · ${Math.round(evaluation.nameSimilarity * 100)}% overlap`}
    </span>
  );
}

function SummaryCard({ label, value, accent, icon: Icon, hint }: {
  label: string; value: number | string; accent: string; icon: typeof Users; hint?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', accent)}>
          <Icon className="w-5 h-5" />
        </div>
        <span className="text-2xl font-bold text-slate-900 tabular-nums">{value}</span>
      </div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-3">{label}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

function StepBadge({ index, label, state }: { index: number; label: string; state: 'done' | 'current' | 'todo' }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border',
        state === 'done' && 'bg-emerald-600 text-white border-emerald-600',
        state === 'current' && 'bg-indigo-600 text-white border-indigo-600',
        state === 'todo' && 'bg-white text-slate-400 border-slate-300',
      )}>
        {state === 'done' ? <CheckCircle2 className="w-4 h-4" /> : index}
      </span>
      <span className={cn('text-xs font-semibold', state === 'todo' ? 'text-slate-400' : 'text-slate-700')}>{label}</span>
    </div>
  );
}

export function FormerStudentCleanup() {
  const { session } = useRole();
  const { addToast } = useToast();
  const role = session?.role ?? null;

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<FormerStudentParseResult | null>(null);
  const [evaluations, setEvaluations] = useState<FormerStudentEvaluation[]>([]);
  const [summary, setSummary] = useState<FormerStudentSummary | null>(null);
  const [decisions, setDecisions] = useState<Record<number, RowDecision>>({});
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [previewMode, setPreviewMode] = useState<'server' | 'local'>('server');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [reviewRow, setReviewRow] = useState<FormerStudentEvaluation | null>(null);
  const [reviewAck, setReviewAck] = useState(false);
  const [selectAllOpen, setSelectAllOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<FormerStudentApplyResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = role === 'admin';

  // ── Parse + preview ───────────────────────────────────────────────────────
  const runPreview = useCallback(async (rows: FormerStudentParseResult['rows']) => {
    setLoadingFile(true);
    setError(null);
    const payload = rows.map(r => ({ rowNumber: r.rowNumber, name: r.name, systemId: r.systemId }));
    try {
      const res = await previewFormerStudentImport(payload);
      setEvaluations(res.rows);
      setSummary(res.summary);
      setPreviewMode('server');
      // Only the rows the database calls automatically safe are pre-selected.
      const next: Record<number, RowDecision> = {};
      for (const r of res.rows) next[r.rowNumber] = r.autoSafe ? 'deactivate' : 'review';
      setDecisions(next);
      setConfirmed([]);
      setStep('review');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missingRpc = /not implemented|PGRST202|42883|does not exist/i.test(message);
      if (!missingRpc) {
        setError(message);
        setLoadingFile(false);
        return;
      }
      // The database has not been migrated (or this is the offline preview
      // client): evaluate in the browser so the admin can still see the file.
      // The server re-checks every row at commit time, so this can never apply
      // something the database refuses.
      try {
        const students = await getStudents(undefined, 'all');
        const local = evaluateFormerStudentRows(payload, students);
        setEvaluations(local.rows);
        setSummary(local.summary);
        setPreviewMode('local');
        const next: Record<number, RowDecision> = {};
        for (const r of local.rows) next[r.rowNumber] = r.autoSafe ? 'deactivate' : 'review';
        setDecisions(next);
        setConfirmed([]);
        setStep('review');
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : 'Could not preview this file.');
      }
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const handleFile = useCallback(async (chosen: File) => {
    setError(null);
    if (!isSupportedFormerStudentFile(chosen.name)) {
      setError('Unsupported file type. Upload a .csv, .xlsx or .xls export.');
      return;
    }
    if (chosen.size > MAX_FORMER_IMPORT_FILE_BYTES) {
      setError(`That file is ${(chosen.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_FORMER_IMPORT_FILE_BYTES / 1024 / 1024} MB — split it into smaller files.`);
      return;
    }
    setLoadingFile(true);
    try {
      const buffer = await chosen.arrayBuffer();
      const asText = isCsvFileName(chosen.name) ? new TextDecoder('utf-8').decode(buffer) : null;
      const res = parseFormerStudentFile(asText ?? buffer, chosen.name);
      setFile(chosen);
      setParsed(res);
      const fatal = res.issues.some(i => i.severity === 'error');
      if (fatal || res.rows.length === 0) {
        setEvaluations([]);
        setSummary(null);
        setStep('upload');
        setError(res.issues.find(i => i.severity === 'error')?.message ?? 'No usable rows were found in that file.');
        return;
      }
      if (res.rows.length > MAX_FORMER_IMPORT_ROWS) {
        setError(`That file has ${res.rows.length} rows; the limit is ${MAX_FORMER_IMPORT_ROWS} per import. Split it into smaller files.`);
        return;
      }
      await runPreview(res.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setLoadingFile(false);
    }
  }, [runPreview]);

  const fileSummary = useMemo(
    () => (parsed ? summarizeFormerStudentFile(parsed.rows, parsed.issues) : null),
    [parsed],
  );

  // ── Selection helpers ─────────────────────────────────────────────────────
  const selectedRows = useMemo(
    () => evaluations.filter(e => decisions[e.rowNumber] === 'deactivate' && canRequestDeactivation(e)),
    [evaluations, decisions],
  );
  const selectedNeedsConfirmation = useMemo(
    () => selectedRows.filter(e => requiresExplicitConfirmation(e) && !confirmed.includes(e.rowNumber)),
    [selectedRows, confirmed],
  );

  const selectAllSafe = useCallback(() => {
    setDecisions(prev => {
      const next = { ...prev };
      for (const e of evaluations) {
        if (e.autoSafe) next[e.rowNumber] = 'deactivate';
      }
      return next;
    });
    addToast({ type: 'success', title: 'Safe matches selected', description: 'Only exact System ID matches whose names agree were selected.' });
  }, [evaluations, addToast]);

  const clearSelection = useCallback(() => {
    setDecisions(prev => {
      const next = { ...prev };
      for (const e of evaluations) next[e.rowNumber] = 'review';
      return next;
    });
    setConfirmed([]);
  }, [evaluations]);

  /** The deliberately loud "select every found row" path (never blocked rows). */
  const selectEveryFoundRow = useCallback(() => {
    setDecisions(prev => {
      const next = { ...prev };
      for (const e of evaluations) {
        if (canRequestDeactivation(e) && e.matchStatus !== 'already_former') next[e.rowNumber] = 'deactivate';
      }
      return next;
    });
    setSelectAllOpen(false);
    addToast({
      type: 'warning',
      title: 'Every found row selected',
      description: 'Rows with a name mismatch still need an individual confirmation before they can be applied.',
    });
  }, [evaluations, addToast]);

  const setRowDecision = useCallback((rowNumber: number, decision: RowDecision) => {
    setDecisions(prev => ({ ...prev, [rowNumber]: decision }));
  }, []);

  // ── Filtering for the review table ────────────────────────────────────────
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return evaluations.filter(e => {
      if (filter === 'safe' && !e.autoSafe) return false;
      if (filter === 'review' && !(e.requiresReview || e.matchStatus === 'id_match_name_conflict')) return false;
      if (filter === 'notfound' && e.matchStatus !== 'not_found' && !e.blocked) return false;
      if (!q) return true;
      return [e.uploadedName, e.uploadedSystemId, e.databaseName ?? '', e.className ?? '']
        .some(v => v.toLowerCase().includes(q));
    });
  }, [evaluations, filter, search]);

  // ── Commit ────────────────────────────────────────────────────────────────
  const doApply = useCallback(async () => {
    if (!isAdmin) return;
    setApplying(true);
    setError(null);
    try {
      const payload = evaluations.map(e => ({
        rowNumber: e.rowNumber,
        name: e.uploadedName,
        systemId: e.uploadedSystemId,
        action: decisions[e.rowNumber] ?? 'review',
        adminConfirmed: confirmed.includes(e.rowNumber) || e.autoSafe,
      }));
      const res = await applyFormerStudentImport(payload, file?.name ?? null, 'Former Students / Student Cleanup import');
      setResult(res);
      setStep('done');
      setConfirmOpen(false);
      setPhrase('');
      addToast({
        type: 'success',
        title: `Import #${res.importNumber} applied`,
        description: `${res.deactivated} student(s) marked as Former Students. Nothing was deleted.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed. Nothing was changed.');
      setConfirmOpen(false);
      addToast({ type: 'error', title: 'Import failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setApplying(false);
    }
  }, [isAdmin, evaluations, decisions, confirmed, file, addToast]);

  const reset = useCallback(() => {
    setStep('upload');
    setFile(null);
    setParsed(null);
    setEvaluations([]);
    setSummary(null);
    setDecisions({});
    setConfirmed([]);
    setResult(null);
    setError(null);
    setFilter('all');
    setSearch('');
    setPhrase('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const downloadTemplate = useCallback(() => {
    const blob = buildFormerStudentTemplate();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'former-students-template.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="max-w-xl mx-auto bg-white rounded-2xl border border-red-200 p-6 text-center">
          <ShieldCheck className="w-10 h-10 text-red-500 mx-auto" />
          <h2 className="text-lg font-bold text-slate-900 mt-3">Administrators only</h2>
          <p className="text-sm text-slate-600 mt-2">
            The Former Students cleanup changes who counts as an enrolled student. It is restricted to
            administrators in the app AND in the database.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 pb-32 md:pb-8">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">Former Students / Student Cleanup</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
              <ShieldCheck className="w-3.5 h-3.5" /> Admin only
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Upload the school's list of students who left. The system identifies them by{' '}
            <strong>System ID</strong>, you review the matches, and the selected students are marked as{' '}
            <strong>Former Students</strong>. Records are never deleted and all history is preserved.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/admin/former-students"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <UserMinus className="w-4 h-4" /> Former Students
          </a>
          <button
            onClick={downloadTemplate}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Download className="w-4 h-4" /> Template
          </button>
        </div>
      </div>

      {/* ── Steps ────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-wrap items-center gap-x-6 gap-y-3">
        <StepBadge index={1} label="Upload list" state={step === 'upload' ? 'current' : 'done'} />
        <ArrowRight className="w-4 h-4 text-slate-300 hidden sm:block" />
        <StepBadge index={2} label="Review matches" state={step === 'review' ? 'current' : step === 'done' ? 'done' : 'todo'} />
        <ArrowRight className="w-4 h-4 text-slate-300 hidden sm:block" />
        <StepBadge index={3} label="Confirm" state={step === 'done' ? 'done' : 'todo'} />
        <ArrowRight className="w-4 h-4 text-slate-300 hidden sm:block" />
        <StepBadge index={4} label="Completed" state={step === 'done' ? 'current' : 'todo'} />
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">
            <p className="font-semibold">Something stopped this step</p>
            <p className="mt-1 break-words">{error}</p>
          </div>
        </div>
      )}

      {previewMode === 'local' && step !== 'upload' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-900">
            This preview was matched in the browser because the <code>preview_former_student_import</code> RPC is
            not available on this database yet (migration <code>20261008_former_students_cleanup.sql</code>). The
            server re-checks every row when you confirm, so nothing unsafe can be applied.
          </p>
        </div>
      )}

      {/* ── Step 1: upload ───────────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault();
                setDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) void handleFile(dropped);
              }}
              className={cn(
                'rounded-2xl border-2 border-dashed bg-white p-8 sm:p-12 text-center transition-colors',
                dragging ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-300',
              )}
            >
              <UploadCloud className="w-10 h-10 text-indigo-500 mx-auto" />
              <h2 className="text-lg font-bold text-slate-900 mt-3">Upload the list of students who left</h2>
              <p className="text-sm text-slate-600 mt-1">
                Drop a .csv, .xlsx or .xls file here, or choose one. Columns:{' '}
                <span className="font-semibold">Student Name</span> and <span className="font-semibold">System ID</span>.
              </p>
              <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loadingFile}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loadingFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                  {loadingFile ? 'Reading file…' : 'Choose file'}
                </button>
                <button
                  onClick={downloadTemplate}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Download className="w-4 h-4" /> Download template (.xlsx)
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,.tsv,.xlsx,.xlsm,.xls"
                className="hidden"
                onChange={e => {
                  const chosen = e.target.files?.[0];
                  if (chosen) void handleFile(chosen);
                }}
              />
              <p className="text-xs text-slate-400 mt-4">
                Max {MAX_FORMER_IMPORT_FILE_BYTES / 1024 / 1024} MB · {MAX_FORMER_IMPORT_ROWS.toLocaleString()} rows per import ·
                comma, semicolon, pipe or tab separated CSV all work.
              </p>
            </div>

            {parsed && fileSummary && (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <FileWarning className="w-4 h-4 text-amber-500" /> File check — {file?.name}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-3 text-center">
                  {[
                    ['Rows', fileSummary.totalUploaded],
                    ['Valid', fileSummary.validRecords],
                    ['Missing name', fileSummary.missingNames],
                    ['Missing ID', fileSummary.missingSystemIds],
                    ['Duplicate IDs', fileSummary.duplicateSystemIds],
                    ['Duplicate names', fileSummary.duplicateNames],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-xl bg-slate-50 border border-slate-200 p-2">
                      <p className="text-lg font-bold text-slate-900 tabular-nums">{value as number}</p>
                      <p className="text-[11px] text-slate-500 uppercase tracking-wide font-semibold">{label as string}</p>
                    </div>
                  ))}
                </div>
                {parsed.issues.length > 0 && (
                  <ul className="mt-3 space-y-1 max-h-40 overflow-y-auto text-xs">
                    {parsed.issues.slice(0, 40).map((issue, i) => (
                      <li key={i} className={cn('flex items-start gap-2', issue.severity === 'error' ? 'text-red-700' : 'text-amber-700')}>
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{issue.row > 0 ? `Row ${issue.row}: ` : ''}{issue.message}</span>
                      </li>
                    ))}
                    {parsed.issues.length > 40 && <li className="text-slate-500">…and {parsed.issues.length - 40} more.</li>}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-600" /> How this stays safe
              </h3>
              <ul className="mt-3 space-y-2.5 text-sm text-slate-600">
                <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /><span><strong>System ID is the only match key.</strong> Names are compared for agreement, never used to find a student.</span></li>
                <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /><span><strong>Nothing is deleted.</strong> Students are moved to status <em>Former Student</em>.</span></li>
                <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /><span><strong>All history is preserved</strong> — marks, attendance, payments, parents, messages and historical classes.</span></li>
                <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /><span><strong>Students not in the file are never touched.</strong> There is no “absent means former” logic.</span></li>
                <li className="flex gap-2"><XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" /><span><strong>Never auto-applied:</strong> missing IDs, unknown IDs, ambiguous rows, or rows matched only by name.</span></li>
                <li className="flex gap-2"><RotateCcw className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" /><span><strong>Every import can be rolled back</strong> from the Former Students page.</span></li>
              </ul>
            </div>
            <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-bold text-slate-900">Accepted file shape</h3>
              <pre className="mt-2 text-xs bg-white border border-slate-200 rounded-lg p-3 overflow-x-auto text-slate-700">{`Student Name,System ID
Example Student,student-123456
Another Student,student-789012`}</pre>
              <p className="text-xs text-slate-500 mt-2">
                A header row is recommended. Pipe (<code>|</code>), semicolon and tab separated CSV are detected
                automatically. Without a header, column 1 is read as the name and column 2 as the System ID.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: review ───────────────────────────────────────────────── */}
      {step === 'review' && summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <SummaryCard label="Uploaded" value={summary.totalUploaded} accent="bg-slate-100 text-slate-600" icon={FileSpreadsheet} />
            <SummaryCard label="Matched" value={summary.foundInDatabase} accent="bg-emerald-50 text-emerald-600" icon={Users}
              hint={`${summary.exactMatches} exact · ${summary.nameConflicts} name conflicts`} />
            <SummaryCard label="Needs review" value={summary.requiresReview} accent="bg-amber-50 text-amber-600" icon={AlertTriangle}
              hint={`${summary.possibleDuplicates} possible duplicates`} />
            <SummaryCard label="Not found" value={summary.notFoundInDatabase} accent="bg-red-50 text-red-600" icon={XCircle}
              hint={`${summary.missingSystemIds} missing System ID`} />
            <SummaryCard label="Ready to deactivate" value={selectedRows.length} accent="bg-indigo-50 text-indigo-600" icon={CheckCircle2}
              hint={`${summary.readyToDeactivate} rows are automatically safe`} />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-200 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2 min-w-0">
                  <FileSpreadsheet className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="truncate">Reviewing {file?.name ?? 'the uploaded list'}</span>
                </h2>
                <p className="text-xs text-slate-500 shrink-0">
                  {summary.validRecords} of {summary.totalUploaded} rows have both a name and a System ID
                  {summary.alreadyFormer > 0 && ` · ${summary.alreadyFormer} already former`}
                </p>
              </div>
              <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                <div className="flex flex-wrap gap-2">
                  {([
                    ['all', `All (${summary.totalUploaded})`],
                    ['safe', `Safe (${summary.readyToDeactivate})`],
                    ['review', `Needs review (${summary.requiresReview})`],
                    ['notfound', `Not found (${summary.notFoundInDatabase + summary.missingSystemIds})`],
                  ] as Array<[RowFilter, string]>).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={cn(
                        'px-3 py-1.5 rounded-full text-xs font-bold border transition-colors',
                        filter === key ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search name, System ID or class…"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={selectAllSafe}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700"
                >
                  <ListChecks className="w-4 h-4" /> Select All Safe Matches
                </button>
                <button
                  onClick={clearSelection}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  Clear selection
                </button>
                <button
                  onClick={() => setSelectAllOpen(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 text-xs font-bold text-amber-800 hover:bg-amber-100"
                >
                  <AlertTriangle className="w-4 h-4" /> Select every found row…
                </button>
                <button
                  onClick={reset}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  <UploadCloud className="w-4 h-4" /> Upload a different file
                </button>
              </div>
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-bold px-4 py-3">Uploaded Name</th>
                    <th className="text-left font-bold px-4 py-3">Uploaded System ID</th>
                    <th className="text-left font-bold px-4 py-3">Database Name</th>
                    <th className="text-left font-bold px-4 py-3">Database System ID</th>
                    <th className="text-left font-bold px-4 py-3">Class / Section</th>
                    <th className="text-left font-bold px-4 py-3">Match Status</th>
                    <th className="text-left font-bold px-4 py-3">Name Match</th>
                    <th className="text-left font-bold px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map(e => (
                    <tr key={e.rowNumber} className={cn(
                      'hover:bg-slate-50',
                      decisions[e.rowNumber] === 'deactivate' && 'bg-indigo-50/40',
                      decisions[e.rowNumber] === 'keep_active' && 'bg-slate-50/70 opacity-70',
                    )}>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {e.uploadedName || <span className="text-red-500 italic">missing</span>}
                        <span className="block text-[11px] text-slate-400">row {e.rowNumber}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {e.uploadedSystemId || <span className="text-red-500 italic">missing</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{e.databaseName ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{e.databaseSystemId ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3 text-slate-700">{e.className ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3"><StatusBadge status={e.matchStatus} /></td>
                      <td className="px-4 py-3"><NameMatchBadge evaluation={e} /></td>
                      <td className="px-4 py-3">
                        <RowActions
                          evaluation={e}
                          decision={decisions[e.rowNumber] ?? 'review'}
                          confirmed={confirmed.includes(e.rowNumber)}
                          onDecision={setRowDecision}
                          onReview={row => { setReviewRow(row); setReviewAck(false); }}
                        />
                      </td>
                    </tr>
                  ))}
                  {visibleRows.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">No rows match this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-slate-100">
              {visibleRows.map(e => (
                <div key={e.rowNumber} className={cn('p-4 space-y-2', decisions[e.rowNumber] === 'deactivate' && 'bg-indigo-50/50')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{e.uploadedName || <span className="text-red-500 italic">missing name</span>}</p>
                      <p className="font-mono text-[11px] text-slate-500 truncate">{e.uploadedSystemId || 'no System ID'}</p>
                    </div>
                    <StatusBadge status={e.matchStatus} />
                  </div>
                  {e.matchedStudentId && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                      <p className="text-slate-700"><span className="font-semibold">Database:</span> {e.databaseName}</p>
                      <p className="font-mono text-slate-500">{e.databaseSystemId}</p>
                      <p className="text-slate-600"><span className="font-semibold">Class:</span> {e.className ?? '—'}</p>
                      <div className="pt-1"><NameMatchBadge evaluation={e} /></div>
                    </div>
                  )}
                  {e.reasons.length > 0 && (
                    <ul className="text-[11px] text-slate-500 space-y-0.5">
                      {e.reasons.slice(0, 3).map(r => <li key={r}>• {REASON_TEXT[r] ?? r}</li>)}
                    </ul>
                  )}
                  <RowActions
                    evaluation={e}
                    decision={decisions[e.rowNumber] ?? 'review'}
                    confirmed={confirmed.includes(e.rowNumber)}
                    onDecision={setRowDecision}
                    onReview={row => { setReviewRow(row); setReviewAck(false); }}
                  />
                </div>
              ))}
              {visibleRows.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No rows match this filter.</p>}
            </div>
          </div>
        </>
      )}

      {/* ── Step 3: done ─────────────────────────────────────────────────── */}
      {step === 'done' && result && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-emerald-200 p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">Import #{result.importNumber} completed</h2>
                <p className="text-sm text-slate-600">{file?.name ?? 'Uploaded file'} · applied atomically in one transaction</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
              <SummaryCard label="Deactivated" value={result.deactivated} accent="bg-indigo-50 text-indigo-600" icon={UserMinus} />
              <SummaryCard label="Skipped" value={result.skipped} accent="bg-slate-100 text-slate-600" icon={Info} />
              <SummaryCard label="Kept active" value={result.keptActive} accent="bg-emerald-50 text-emerald-600" icon={CheckCircle2} />
              <SummaryCard label="Blocked by safety rules" value={result.blocked} accent="bg-red-50 text-red-600" icon={ShieldCheck} />
            </div>
            <div className="mt-5 rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-900">
              <p className="font-semibold flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> {result.deleted} student records were deleted.</p>
              <p className="mt-1 text-xs">
                Marks, attendance, payments, parent links, messages and historical classes are untouched. These students
                no longer appear in active student lists, and they can be restored at any time from the Former Students page.
              </p>
            </div>
            {result.skippedRows.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Rows that were refused</h3>
                <ul className="mt-2 space-y-1 text-xs text-slate-600 max-h-40 overflow-y-auto">
                  {result.skippedRows.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                      <span>Row {r.rowNumber} · <span className="font-mono">{r.uploadedSystemId || 'no System ID'}</span> — {r.reason.replace(/_/g, ' ')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href="/admin/former-students"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
              >
                <UserMinus className="w-4 h-4" /> Open Former Students
              </a>
              <button
                onClick={reset}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <UploadCloud className="w-4 h-4" /> Import another list
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sticky action bar ────────────────────────────────────────────── */}
      {step === 'review' && summary && (
        <div className="fixed bottom-0 inset-x-0 z-30 md:static md:mt-6">
          <div className="md:hidden bg-white/95 backdrop-blur border-t border-slate-200 p-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-slate-600">
                <span className="font-bold text-slate-900 text-base tabular-nums">{selectedRows.length}</span> selected
                {selectedNeedsConfirmation.length > 0 && (
                  <span className="block text-amber-700 font-semibold">{selectedNeedsConfirmation.length} need a review confirmation</span>
                )}
              </div>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={selectedRows.length === 0 || selectedNeedsConfirmation.length > 0 || applying}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <UserMinus className="w-4 h-4" /> Deactivate Selected
              </button>
            </div>
          </div>
          <div className="hidden md:flex items-center justify-between gap-4 bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="text-sm text-slate-600">
              <span className="font-bold text-slate-900 text-lg tabular-nums">{selectedRows.length}</span> student(s) selected to be marked as Former Students.
              {selectedNeedsConfirmation.length > 0 && (
                <span className="ml-2 text-amber-700 font-semibold">
                  {selectedNeedsConfirmation.length} still need an individual review confirmation.
                </span>
              )}
              <span className="block text-xs text-slate-500 mt-0.5">
                {summary.notFoundInDatabase} System ID(s) not found and {summary.missingSystemIds} missing — these can never be applied.
              </span>
            </div>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={selectedRows.length === 0 || selectedNeedsConfirmation.length > 0 || applying}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              <UserMinus className="w-4 h-4" /> Deactivate Selected ({selectedRows.length})
            </button>
          </div>
        </div>
      )}

      {/* ── Per-row review dialog ────────────────────────────────────────── */}
      <Dialog
        open={reviewRow !== null}
        onClose={() => { if (reviewRow) setReviewRow(null); }}
        title="Review this match before deactivating"
        description="The System ID matched, but something else needs your eyes."
      >
        {reviewRow && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-1 text-amber-900">
              {reviewRow.reasons.map(r => (
                <p key={r} className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{REASON_TEXT[r] ?? r}</span>
                </p>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-[11px] uppercase tracking-wide font-bold text-slate-400">Uploaded</p>
                <p className="font-semibold text-slate-900 mt-1 break-words">{reviewRow.uploadedName || '—'}</p>
                <p className="font-mono text-xs text-slate-500 break-all">{reviewRow.uploadedSystemId || '—'}</p>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-[11px] uppercase tracking-wide font-bold text-slate-400">Database</p>
                <p className="font-semibold text-slate-900 mt-1 break-words">{reviewRow.databaseName || '—'}</p>
                <p className="font-mono text-xs text-slate-500 break-all">{reviewRow.databaseSystemId || '—'}</p>
                <p className="text-xs text-slate-600 mt-1">Class: {reviewRow.className ?? '—'}</p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              The System ID is the authoritative identifier. If these are the same child, confirm below; if you are not
              sure, leave the row unselected — nothing happens to it.
            </p>
            <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewAck}
                onChange={e => setReviewAck(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-indigo-600"
              />
              <span className="text-sm text-slate-700">
                I have checked this record and it is the correct student. Mark them as a Former Student.
              </span>
            </label>
            <div className="flex flex-wrap gap-2 justify-end pt-1">
              <button
                onClick={() => { setReviewRow(null); setReviewAck(false); }}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!reviewRow) return;
                  setConfirmed(prev => [...new Set([...prev, reviewRow.rowNumber])]);
                  setRowDecision(reviewRow.rowNumber, 'deactivate');
                  setReviewRow(null);
                  setReviewAck(false);
                }}
                disabled={!reviewAck}
                className="px-4 py-2 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-40"
              >
                Confirm this student
              </button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ── "Select every found row" warning ─────────────────────────────── */}
      <Dialog
        open={selectAllOpen}
        onClose={() => setSelectAllOpen(false)}
        title="Select every found row?"
        description="This is not a safe shortcut — read it first."
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-red-900 space-y-1">
            <p className="font-semibold flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> You are selecting rows that have NOT been individually checked.</p>
            <p className="text-xs">Rows whose uploaded name differs from the database name still need a per-row confirmation — the button below will not bypass that.</p>
            <p className="text-xs">Rows with a missing or unknown System ID are never selected and can never be applied.</p>
          </div>
          <p className="text-xs text-slate-600">
            Recommended path: <strong>Select All Safe Matches</strong>, then work through the “Needs review” tab one row at a time.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setSelectAllOpen(false)}
              className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={selectEveryFoundRow}
              className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700"
            >
              I understand — select them
            </button>
          </div>
        </div>
      </Dialog>

      {/* ── Final confirmation ───────────────────────────────────────────── */}
      <Dialog
        open={confirmOpen}
        onClose={() => { if (!applying) { setConfirmOpen(false); setPhrase(''); } }}
        title="Confirm: mark students as Former Students"
        description="This is the last step before the database is changed."
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-2 text-amber-900">
            <p className="font-bold text-base">You are about to mark {selectedRows.length} students as Former Students.</p>
            <p className="font-semibold">No student records will be deleted.</p>
            <p className="font-semibold">Historical records will be preserved.</p>
            <p className="font-semibold">These students will no longer appear in active student lists.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="font-bold text-slate-500 uppercase tracking-wide">File</p>
              <p className="text-slate-800 mt-1 break-all">{file?.name ?? '—'}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="font-bold text-slate-500 uppercase tracking-wide">Rows in file</p>
              <p className="text-slate-800 mt-1">{summary?.totalUploaded ?? 0} uploaded · {selectedRows.length} selected</p>
            </div>
          </div>
          {selectedRows.some(e => requiresExplicitConfirmation(e)) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
              {selectedRows.filter(e => requiresExplicitConfirmation(e)).length} of the selected rows were individually
              confirmed by you (name mismatch or duplicate in the file).
            </div>
          )}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
              Type <span className="font-mono text-slate-800">{FORMER_STUDENT_CONFIRM_PHRASE}</span> to confirm
            </label>
            <input
              value={phrase}
              onChange={e => setPhrase(e.target.value)}
              placeholder={FORMER_STUDENT_CONFIRM_PHRASE}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex flex-wrap gap-2 justify-end pt-1">
            <button
              onClick={() => { setConfirmOpen(false); setPhrase(''); }}
              disabled={applying}
              className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void doApply()}
              disabled={phrase.trim().toUpperCase() !== FORMER_STUDENT_CONFIRM_PHRASE || applying || selectedRows.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserMinus className="w-4 h-4" />}
              {applying ? 'Applying…' : `Mark ${selectedRows.length} as Former Students`}
            </button>
          </div>
          <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
            The button says “mark as former”, never “delete”: the RPC only changes a status field and records an audit
            entry. Every import can be rolled back afterwards from the Former Students page.
          </p>
        </div>
      </Dialog>
    </div>
  );
}

/** Per-row Deactivate / Keep Active / Review actions. */
function RowActions({ evaluation, decision, confirmed, onDecision, onReview }: {
  evaluation: FormerStudentEvaluation;
  decision: RowDecision;
  confirmed: boolean;
  onDecision: (rowNumber: number, decision: RowDecision) => void;
  onReview: (evaluation: FormerStudentEvaluation) => void;
}) {
  const canDeactivate = canRequestDeactivation(evaluation) && evaluation.matchStatus !== 'already_former';
  const needsConfirm = requiresExplicitConfirmation(evaluation);

  if (!canDeactivate) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">
          <ShieldCheck className="w-3.5 h-3.5" />
          {evaluation.matchStatus === 'already_former' ? 'No action needed' : 'Cannot be applied'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {decision === 'deactivate' ? (
        <button
          onClick={() => onDecision(evaluation.rowNumber, 'review')}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> Deactivate
        </button>
      ) : (
        <button
          onClick={() => {
            if (needsConfirm && !confirmed) { onReview(evaluation); return; }
            onDecision(evaluation.rowNumber, 'deactivate');
          }}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border',
            needsConfirm && !confirmed
              ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <UserMinus className="w-3.5 h-3.5" />
          {needsConfirm && !confirmed ? 'Review' : 'Deactivate'}
        </button>
      )}
      <button
        onClick={() => onDecision(evaluation.rowNumber, decision === 'keep_active' ? 'review' : 'keep_active')}
        className={cn(
          'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border',
          decision === 'keep_active'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
        )}
      >
        <CheckCircle2 className="w-3.5 h-3.5" /> Keep Active
      </button>
      {confirmed && (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
          <ShieldCheck className="w-3 h-3" /> confirmed
        </span>
      )}
    </div>
  );
}
