// Admin → Duplicate Students → "Merge All Safe Duplicates"
//
// This panel is a thin, bilingual front-end for the server-side batch:
//   preview_safe_duplicate_batch()  → dry run, zero writes, exact pairs
//   merge_safe_duplicate_batch()    → ONE atomic chunk per call
//
// It never decides eligibility. Which pairs are safe, which record is kept,
// which field survives and when a pair must be refused are all computed by the
// SECURITY DEFINER functions in supabase/migrations/20260925 and re-computed at
// execution time. The reviewed list this panel sends back is advisory: the
// server narrows its scope with it and refuses anything it does not consider
// safe (including invented pairs and bare "delete this student" requests).

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GitMerge,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { useToast } from '../../context/ToastContext';
import {
  previewSafeDuplicateBatch,
  reviewedPairsFromPreview,
  runSafeDuplicateBatchChunk,
  type SafeBatchBlockedEntry,
  type SafeBatchChunkResult,
  type SafeBatchMergedEntry,
  type SafeBatchPreview,
  type SafeBatchSkippedEntry,
} from '../../lib/db/duplicateStudents';

type Phase = 'idle' | 'previewing' | 'reviewed' | 'running' | 'done' | 'error';

interface Props {
  /** Called after a chunk (or an aborted chunk) so the page can reload its data. */
  onBatchSettled?: () => void | Promise<void>;
}

function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

export function SafeBatchMergePanel({ onBatchSettled }: Props) {
  const { t, language } = useI18n();
  const { addToast } = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<SafeBatchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'preview' | 'chunk'>('chunk');
  const [open, setOpen] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [confirmations, setConfirmations] = useState({ keeper: false, excluded: false, audit: false });
  const [phrase, setPhrase] = useState('');
  const [reason, setReason] = useState('');
  const [chunkIndex, setChunkIndex] = useState(0);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [results, setResults] = useState<{
    merged: SafeBatchMergedEntry[];
    skipped: SafeBatchSkippedEntry[];
    blocked: SafeBatchBlockedEntry[];
    failed: unknown[];
  }>({ merged: [], skipped: [], blocked: [], failed: [] });
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);

  const policy = preview?.policy ?? null;
  const confirmPhrase = policy?.confirmPhrase ?? 'MERGE SAFE DUPLICATES';
  const chunkSize = policy?.chunkSize?.default ?? 25;
  const safeCount = preview?.summary.safeCount ?? 0;

  const exclusionText = useMemo(() => {
    const map = (policy?.exclusionCodes ?? policy?.exclusionDescriptions ?? {}) as Record<string, string>;
    return (code: string) => map[code] ?? code;
  }, [policy]);

  const allConfirmed = confirmations.keeper && confirmations.excluded && confirmations.audit;
  const phraseMatches = phrase.trim().toUpperCase() === confirmPhrase.toUpperCase();
  const canRun = phase === 'reviewed' && safeCount > 0 && allConfirmed && phraseMatches;

  const keeperRule = policy ? (language === 'ar' ? policy.keeperRuleAr : policy.keeperRuleEn) : '';
  const policyName = policy ? (language === 'ar' ? policy.nameAr : policy.nameEn) : '';

  const runPreview = async () => {
    setPhase('previewing');
    setError(null);
    setErrorKind('chunk');
    try {
      const p = await previewSafeDuplicateBatch(500);
      setPreview(p);
      setPhase('reviewed');
      setOpen(true);
      setConfirmations({ keeper: false, excluded: false, audit: false });
      setPhrase('');
      setResults({ merged: [], skipped: [], blocked: [], failed: [] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setErrorKind('preview');
      setError(message);
      addToast({ type: 'error', title: t('duplicateBatch.previewFailed'), description: message });
    }
  };

  const runBatch = async () => {
    if (!preview || !canRun) return;
    const reviewed = reviewedPairsFromPreview(preview);
    if (reviewed.length === 0) return;
    const totalChunks = Math.max(1, Math.ceil(reviewed.length / chunkSize));
    setPhase('running');
    setError(null);
    setErrorKind('chunk');
    setChunkIndex(0);
    setChunkTotal(totalChunks);
    setResults({ merged: [], skipped: [], blocked: [], failed: [] });
    // One batch id for the whole run: the server uses it to recognise pairs an
    // earlier chunk already merged, and it stamps every per-merge audit row.
    const batchId = preview.batchId;
    setLastBatchId(batchId);

    const acc = { merged: [] as SafeBatchMergedEntry[], skipped: [] as SafeBatchSkippedEntry[], blocked: [] as SafeBatchBlockedEntry[], failed: [] as unknown[] };
    try {
      let remaining = reviewed.length;
      let chunk = 0;
      // Hard stop so a stuck server can never loop forever on a destructive call.
      while (remaining > 0 && chunk < totalChunks + 1) {
        chunk += 1;
        setChunkIndex(chunk);
        const res: SafeBatchChunkResult = await runSafeDuplicateBatchChunk({
          reviewedPairs: reviewed,
          chunkSize,
          confirmPhrase: phrase.trim(),
          reason: reason.trim() ? reason.trim() : null,
          batchId,
        });
        acc.merged.push(...(res.merged ?? []));
        acc.skipped.push(...(res.skipped ?? []));
        acc.blocked.push(...(res.blocked ?? []));
        acc.failed.push(...(res.failed ?? []));
        setResults({ merged: [...acc.merged], skipped: [...acc.skipped], blocked: [...acc.blocked], failed: [...acc.failed] });
        remaining = res.totals?.remaining ?? 0;
        if ((res.totals?.merged ?? 0) === 0) break; // no progress → stop and report
      }
      setPhase('done');
      addToast({
        type: acc.failed.length > 0 ? 'error' : 'success',
        title: t('duplicateBatch.done.title'),
        description: fill(t('duplicateBatch.done.summary'), {
          merged: acc.merged.length,
          skipped: acc.skipped.length,
          blocked: acc.blocked.length,
        }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setErrorKind('chunk');
      setError(message);
      addToast({ type: 'error', title: t('duplicateBatch.error.aborted'), description: message });
    } finally {
      if (onBatchSettled) await onBatchSettled();
    }
  };

  const resetAll = () => {
    setPhase('idle');
    setPreview(null);
    setOpen(false);
    setError(null);
    setErrorKind('chunk');
    setPhrase('');
    setReason('');
    setConfirmations({ keeper: false, excluded: false, audit: false });
    setResults({ merged: [], skipped: [], blocked: [], failed: [] });
  };

  const busy = phase === 'previewing' || phase === 'running';

  return (
    <section
      data-testid="safe-batch-merge-panel"
      className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 border-b border-slate-100">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <GitMerge className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">
              {t('duplicateBatch.title', policyName || 'Merge All Safe Duplicates')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">{t('duplicateBatch.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {phase !== 'idle' && (
            <button
              type="button"
              onClick={resetAll}
              disabled={busy}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {t('duplicateBatch.close')}
            </button>
          )}
          <button
            type="button"
            onClick={runPreview}
            disabled={busy}
            data-testid="safe-batch-preview-button"
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border transition',
              busy
                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                : 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700',
            )}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {phase === 'previewing' ? t('duplicateBatch.previewing') : phase === 'reviewed' || phase === 'done' ? t('duplicateBatch.refresh') : t('duplicateBatch.runPreview')}
          </button>
        </div>
      </div>

      <p className="px-4 py-2 text-[11px] leading-relaxed text-slate-500 bg-slate-50 border-b border-slate-100 flex items-start gap-1.5">
        <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{t('duplicateBatch.serverDecides')}</span>
      </p>

      {error && (
        <div className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <p className="font-bold flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4" />{' '}
            {errorKind === 'preview' ? t('duplicateBatch.previewFailed') : t('duplicateBatch.error.aborted')}
          </p>
          <p className="mt-1 font-mono break-words">{error}</p>
        </div>
      )}

      {phase === 'running' && (
        <div className="mx-4 mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-semibold">
            {fill(t('duplicateBatch.confirm.running'), { chunk: Math.max(1, chunkIndex), chunks: Math.max(1, chunkTotal) })}
          </span>
          <span className="ms-auto tabular-nums">
            {t('duplicateBatch.progress.merged')}: {results.merged.length}
          </span>
        </div>
      )}

      {/* Preview / review */}
      {preview && open && (
        <div className="p-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { label: t('duplicateBatch.summary.candidates'), value: preview.summary.candidatePairs, tone: 'slate' },
              { label: t('duplicateBatch.summary.safe'), value: preview.summary.safeCount, tone: 'emerald' },
              { label: t('duplicateBatch.summary.excluded'), value: preview.summary.excludedCount, tone: 'amber' },
              { label: t('duplicateBatch.summary.blocked'), value: preview.summary.blockedCount, tone: 'red' },
              { label: t('duplicateBatch.summary.review'), value: preview.summary.needsReviewCount, tone: 'orange' },
              { label: t('duplicateBatch.summary.idsPreserved'), value: preview.summary.studentIdsPreserved, tone: 'indigo' },
            ].map((card) => (
              <div
                key={card.label}
                className={cn(
                  'rounded-xl border p-3',
                  card.tone === 'emerald' && 'border-emerald-200 bg-emerald-50',
                  card.tone === 'amber' && 'border-amber-200 bg-amber-50',
                  card.tone === 'red' && 'border-red-200 bg-red-50',
                  card.tone === 'orange' && 'border-orange-200 bg-orange-50',
                  card.tone === 'indigo' && 'border-indigo-200 bg-indigo-50',
                  card.tone === 'slate' && 'border-slate-200 bg-slate-50',
                )}
              >
                <div className="text-xl font-bold text-slate-900 tabular-nums">{card.value}</div>
                <div className="text-[11px] font-semibold text-slate-600 mt-1 leading-tight">{card.label}</div>
              </div>
            ))}
          </div>

          <p
            className={cn(
              'text-xs font-semibold',
              safeCount > 0 ? 'text-emerald-700' : 'text-slate-500',
            )}
            data-testid="safe-batch-status"
          >
            {safeCount > 0
              ? fill(t('duplicateBatch.status.ready'), { count: safeCount })
              : t('duplicateBatch.status.none')}
          </p>

          {/* Policy */}
          {policy && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 space-y-2">
              <div>
                <span className="font-bold text-slate-700">{t('duplicateBatch.policy.keeperRule')}: </span>
                <span>{keeperRule}</span>
              </div>
              <div>
                <span className="font-bold text-slate-700">{t('duplicateBatch.policy.chunkRule')}: </span>
                <span>{fill(t('duplicateBatch.policy.chunkDetail'), { size: chunkSize })}</span>
              </div>
              <div>
                <span className="font-bold text-slate-700">{t('duplicateBatch.policy.invariants')}:</span>
                <ul className="list-disc ps-5 mt-1 space-y-0.5">
                  {(policy.invariants ?? []).map((inv) => (
                    <li key={inv} className="font-mono text-[11px]">{inv}</li>
                  ))}
                </ul>
              </div>
              <div className="text-[11px] text-slate-500">
                {t('duplicateBatch.summary.recordsToRemove')}: <span className="font-semibold">{preview.summary.recordsToRemove}</span>
                {' · '}
                {t('duplicateBatch.pairs.reviewed')}: <span className="font-mono">{preview.previewToken?.slice(0, 12)}</span>
                {' · '}dry run writes: <span className="font-semibold">{preview.writesPerformed}</span>
              </div>
            </div>
          )}

          {/* Exact safe pairs */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <h3 className="text-xs font-bold text-emerald-800">{t('duplicateBatch.pairs.title')}</h3>
              <span className="ms-auto text-[11px] font-semibold text-emerald-700 tabular-nums">{preview.rows.length}</span>
            </div>
            {preview.rows.length === 0 ? (
              <p className="p-3 text-xs text-slate-500">{t('duplicateBatch.pairs.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.name')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.class')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.keeperId')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.removedId')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.parent')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.history')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.enrollment')}</th>
                      <th className="text-start font-semibold px-3 py-2">{t('duplicateBatch.pairs.reviewed')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.rows.map((row) => (
                      <tr key={row.pairKey} data-testid={`safe-batch-row-${row.pairKey}`}>
                        <td className="px-3 py-2 font-semibold text-slate-800">{row.studentName}</td>
                        <td className="px-3 py-2 text-slate-600">{row.className}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-emerald-700">{row.keeperId}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-red-600">{row.removedId}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.keeper.parentName ?? row.keeper.parentId ?? t('duplicateBatch.pairs.unassigned')}
                        </td>
                        <td className="px-3 py-2 text-slate-600 tabular-nums">
                          {row.history?.exams ? `${row.history.exams.keeper}+${row.history.exams.removed}` : '0'}
                          {row.history?.attendance ? ` · ${row.history.attendance.keeper}+${row.history.attendance.removed}` : ''}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{row.enrollmentAction ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-[10px] text-slate-400">{(row.fingerprint ?? '').slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Excluded pairs */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowExcluded((v) => !v)}
              className="w-full px-3 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-2 text-start"
            >
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span className="text-xs font-bold text-amber-800">{t('duplicateBatch.excluded.title')}</span>
              <span className="ms-auto text-[11px] font-semibold text-amber-700 tabular-nums">{preview.excludedRows.length}</span>
              {showExcluded ? <ChevronUp className="w-4 h-4 text-amber-600" /> : <ChevronDown className="w-4 h-4 text-amber-600" />}
            </button>
            {showExcluded && (
              preview.excludedRows.length === 0 ? (
                <p className="p-3 text-xs text-slate-500">{t('duplicateBatch.excluded.empty')}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {preview.excludedRows.map((row) => (
                    <li key={row.pairKey} className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-800">{row.studentName}</span>
                        <span className="text-slate-500">{row.className}</span>
                        <span
                          className={cn(
                            'inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border',
                            row.severity === 'blocked' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200',
                          )}
                        >
                          {row.severity}
                        </span>
                        <span className="ms-auto font-mono text-[10px] text-slate-400">{row.keeperId} → {row.removedId}</span>
                      </div>
                      <div className="mt-1 text-slate-600">
                        <span className="font-semibold">{t('duplicateBatch.excluded.reason')}: </span>
                        {(row.exclusionCodes ?? []).map(exclusionText).join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          {/* Confirmation gate — never a single click */}
          {safeCount > 0 && (
            <div className="rounded-xl border border-slate-300 bg-white p-3 space-y-3">
              <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-slate-500" /> {t('duplicateBatch.confirm.title')}
              </h3>
              {([
                ['keeper', t('duplicateBatch.confirm.keeper')],
                ['excluded', t('duplicateBatch.confirm.excluded')],
                ['audit', t('duplicateBatch.confirm.audit')],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmations[key]}
                    disabled={busy}
                    data-testid={`safe-batch-confirm-${key}`}
                    onChange={(e) => setConfirmations((c) => ({ ...c, [key]: e.target.checked }))}
                  />
                  <span>{label}</span>
                </label>
              ))}

              <div>
                <label htmlFor="safe-batch-phrase" className="block text-xs font-semibold text-slate-700">
                  {t('duplicateBatch.confirm.phraseLabel')}
                </label>
                <input
                  id="safe-batch-phrase"
                  type="text"
                  autoComplete="off"
                  value={phrase}
                  disabled={busy}
                  onChange={(e) => setPhrase(e.target.value)}
                  data-testid="safe-batch-phrase-input"
                  placeholder={confirmPhrase}
                  className={cn(
                    'mt-1 w-full rounded-xl border px-3 py-2 text-xs font-mono',
                    phrase && !phraseMatches ? 'border-red-300 bg-red-50' : 'border-slate-300',
                  )}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  {fill(t('duplicateBatch.confirm.phraseHint'), { phrase: confirmPhrase })}
                </p>
                {phrase.length > 0 && !phraseMatches && (
                  <p className="mt-1 text-[11px] font-semibold text-red-600">
                    {fill(t('duplicateBatch.confirm.phraseMismatch'), { phrase: confirmPhrase })}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="safe-batch-reason" className="block text-xs font-semibold text-slate-700">
                  {t('duplicateBatch.confirm.reasonLabel')}
                </label>
                <input
                  id="safe-batch-reason"
                  type="text"
                  autoComplete="off"
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="safe-batch-reason-input"
                  placeholder={t('duplicateBatch.confirm.reasonPlaceholder')}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                />
              </div>

              <button
                type="button"
                onClick={runBatch}
                disabled={!canRun}
                data-testid="safe-batch-run-button"
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold border transition',
                  canRun
                    ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed',
                )}
              >
                {phase === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                {t('duplicateBatch.confirm.run')}
              </button>
              {!allConfirmed || !phraseMatches ? (
                <p className="text-[11px] text-slate-500 text-center">{t('duplicateBatch.confirm.required')}</p>
              ) : null}
            </div>
          )}

          {/* Results */}
          {(phase === 'done' || phase === 'error') && (
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 flex flex-wrap items-center gap-3">
                <h3 className="text-xs font-bold text-slate-800">{t('duplicateBatch.results.title')}</h3>
                <span className="text-[11px] text-slate-500 font-mono">{lastBatchId}</span>
                <span className="ms-auto flex items-center gap-3 text-[11px] font-semibold tabular-nums">
                  <span className="text-emerald-700">{t('duplicateBatch.results.merged')}: {results.merged.length}</span>
                  <span className="text-amber-700">{t('duplicateBatch.results.skipped')}: {results.skipped.length}</span>
                  <span className="text-red-700">{t('duplicateBatch.results.blocked')}: {results.blocked.length}</span>
                  <span className="text-slate-600">{t('duplicateBatch.results.failed')}: {results.failed.length}</span>
                </span>
              </div>
              <div className="p-3 space-y-3 text-xs">
                {results.merged.length === 0 && results.skipped.length === 0 && results.blocked.length === 0 && (
                  <p className="text-slate-500">{t('duplicateBatch.results.none')}</p>
                )}
                {results.merged.length > 0 && (
                  <div>
                    <p className="font-bold text-emerald-700 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" /> {t('duplicateBatch.results.merged')}
                    </p>
                    <ul className="mt-1 space-y-1">
                      {results.merged.map((m) => (
                        <li key={`${m.pairKey}-${m.auditId}`} className="flex flex-wrap items-center gap-2 text-slate-700" data-testid={`safe-batch-merged-${m.pairKey}`}>
                          <span className="font-semibold">{m.studentName}</span>
                          <span className="text-slate-500">{m.className}</span>
                          <span className="font-mono text-[11px] text-emerald-700">{m.preservedStudentId}</span>
                          <span className="text-slate-400">←</span>
                          <span className="font-mono text-[11px] text-red-600 line-through">{m.removedStudentId}</span>
                          {m.auditId && (
                            <span className="ms-auto font-mono text-[10px] text-slate-400">
                              {t('duplicateBatch.results.auditId')}: {String(m.auditId).slice(0, 12)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {results.skipped.length > 0 && (
                  <div>
                    <p className="font-bold text-amber-700 flex items-center gap-1.5">
                      <XCircle className="w-3.5 h-3.5" /> {t('duplicateBatch.results.skipped')}
                    </p>
                    <ul className="mt-1 space-y-1">
                      {results.skipped.map((s, i) => (
                        <li key={`${s.pairKey}-skip-${i}`} className="text-slate-700">
                          <span className="font-mono text-[11px]">{s.pairKey}</span>
                          <span className="text-slate-500"> — {t('duplicateBatch.results.reason')}: </span>
                          <span className="font-semibold">{(s.codes ?? []).map(exclusionText).join(' · ') || s.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {results.blocked.length > 0 && (
                  <div>
                    <p className="font-bold text-red-700 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5" /> {t('duplicateBatch.results.blocked')}
                    </p>
                    <ul className="mt-1 space-y-1">
                      {results.blocked.map((b, i) => (
                        <li key={`${b.pairKey}-blocked-${i}`} className="text-slate-700">
                          <span className="font-mono text-[11px]">{b.pairKey}</span>
                          <span className="text-slate-500"> — {t('duplicateBatch.results.reason')}: </span>
                          <span className="font-semibold">{((b.codes ?? b.exclusionCodes ?? []) as string[]).map(exclusionText).join(' · ') || b.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
