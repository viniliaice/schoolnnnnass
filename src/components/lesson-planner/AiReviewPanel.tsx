import { AIReview, PlanStatus } from '../../types';
import { Loader2, Sparkles, AlertTriangle, RotateCcw, Clock } from 'lucide-react';
import { cn } from '../../utils/cn';

export function scoreTone(pct: number): string {
  if (pct >= 90) return 'bg-emerald-100 text-emerald-700';
  if (pct >= 80) return 'bg-blue-100 text-blue-700';
  if (pct >= 70) return 'bg-amber-100 text-amber-700';
  if (pct >= 60) return 'bg-orange-100 text-orange-700';
  return 'bg-rose-100 text-rose-700';
}

/** Minutes since the given timestamp (0 when unknown). */
export function minutesSince(iso?: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

interface AiReviewPanelProps {
  review?: AIReview | null;
  status: PlanStatus;
  updatedAt?: string | null;
  /** Recorded reason the last AI attempt failed, shown verbatim. */
  failureReason?: string | null;
  /** Shown while a retry is running */
  retrying?: boolean;
  onRetry?: () => void;
  retryError?: string | null;
  /** Wording differs slightly for teacher vs supervisor */
  audience?: 'teacher' | 'supervisor';
}

/**
 * Single source of truth for "what is the AI doing?".
 * Explicitly distinguishes: still running · took too long · failed · done.
 */
export function AiReviewPanel({
  review,
  status,
  updatedAt,
  failureReason,
  retrying,
  onRetry,
  retryError,
  audience = 'teacher',
}: AiReviewPanelProps) {
  const waited = minutesSince(updatedAt);
  const stale = waited >= 2;

  // ── AI failed ────────────────────────────────────────────────
  if (status === 'ai_failed') {
    return (
      <div className="space-y-4 rounded-2xl border-2 border-rose-200 bg-white p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="p-2 rounded-xl bg-rose-100 text-rose-700">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-slate-900">AI review failed</h2>
            <p className="text-xs text-rose-600 font-medium">The plan was NOT reviewed by the AI</p>
          </div>
          <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-bold text-rose-700 sm:ml-auto">Failed</span>
        </div>
        <p className="text-sm text-slate-600">
          {audience === 'supervisor'
            ? 'The AI could not produce a review for this plan. You can retry the review, or approve/reject it manually based on the plan content above.'
            : 'The AI could not generate a review for this plan. Nothing was lost — your plan is saved. Retry the review below; if it keeps failing, tell your supervisor, they can approve the plan without an AI score.'}
        </p>
        {failureReason && (
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-3">
            <p className="text-xs font-semibold text-rose-800 mb-1">Failure reason</p>
            <p className="text-xs text-rose-700 font-mono break-words">{failureReason}</p>
          </div>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            {retrying ? 'Retrying AI review…' : 'Retry AI review'}
          </button>
        )}
        {retryError && (
          <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl p-3">
            Retry failed: {retryError}
          </p>
        )}
      </div>
    );
  }

  // ── Waiting on the AI ────────────────────────────────────────
  if (!review) {
    if (status === 'draft') return null;
    return (
      <div className={cn(
        'space-y-3 rounded-2xl border-2 bg-white p-4 sm:p-6',
        stale ? 'border-amber-200' : 'border-blue-200'
      )}>
        <div className="flex flex-wrap items-center gap-3">
          <div className={cn('p-2 rounded-xl', stale ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
            {stale ? <Clock className="w-5 h-5" /> : <Loader2 className="w-5 h-5 animate-spin" />}
          </div>
          <h2 className="min-w-0 flex-1 text-lg font-bold text-slate-900">
            {stale ? 'AI review is taking longer than usual' : 'AI review in progress'}
          </h2>
          <span className={cn(
            'rounded-full px-3 py-1 text-xs font-bold sm:ml-auto',
            stale ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700 animate-pulse'
          )}>
            {waited > 0 ? `Waiting ${waited} min` : 'Waiting…'}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {stale
            ? 'A review normally arrives within a minute. This page checks again every few seconds — if nothing appears, the AI call most likely failed and the plan will switch to “AI failed”, where it can be retried.'
            : 'This page refreshes automatically every few seconds. You will see the score here as soon as the AI responds.'}
        </p>
        {audience === 'supervisor' && (
          <p className="text-xs text-slate-500">
            You can still read the full plan above and make a decision without waiting for the AI.
          </p>
        )}
        {stale && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            {retrying ? 'Retrying…' : 'Retry AI review now'}
          </button>
        )}
      </div>
    );
  }

  // ── Review ready ─────────────────────────────────────────────
  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700">
          <Sparkles className="w-5 h-5" />
        </div>
        <h2 className="min-w-0 flex-1 text-lg font-bold text-slate-900">AI Review</h2>
        <span className={cn('rounded-full px-3 py-1 text-xs font-bold sm:ml-auto', scoreTone(review.percentage))}>
          {review.percentage}% · {review.performance_level}
        </span>
      </div>

      <p className="text-sm text-slate-600 leading-relaxed">{review.executive_summary}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Object.entries(review.scores).map(([key, val]: [string, any]) => (
          <div key={key} className="bg-slate-50 rounded-xl p-3">
            <p className="text-xs text-slate-500 capitalize mb-1">{key.replace(/_/g, ' ')}</p>
            <p className="text-lg font-bold text-slate-900">{val.score}/5</p>
            <p className="mt-1 break-words text-xs leading-5 text-slate-500">{val.explanation}</p>
          </div>
        ))}
      </div>

      {review.strengths?.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Strengths</h3>
          <ul className="list-disc list-inside text-sm text-slate-600 space-y-1">
            {review.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {review.improvements?.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Improvements</h3>
          <ul className="space-y-2">
            {review.improvements.map((imp, i) => (
              <li key={i} className="bg-amber-50 rounded-xl p-3 text-sm">
                <p className="font-medium text-amber-800">{imp.area}</p>
                <p className="text-amber-700 text-xs mt-0.5">{imp.why}</p>
                <p className="text-amber-600 text-xs mt-1">{imp.recommendation}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.supervisor_comment && (
        <div className="bg-indigo-50 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-indigo-800 mb-1">Supervisor comment</h3>
          <p className="text-sm text-indigo-700">{review.supervisor_comment}</p>
        </div>
      )}
    </div>
  );
}
