import { useMemo, useState } from 'react';
import { useAiReviewLogs } from '../../lib/hooks/useLessonPlans';
import { AiReviewOutcome } from '../../types';
import { Activity, AlertTriangle, CheckCircle2, Clock, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

const OUTCOME_META: Record<AiReviewOutcome, { label: string; chip: string }> = {
  success:          { label: 'Success',          chip: 'bg-emerald-100 text-emerald-700' },
  timeout:          { label: 'Timeout',          chip: 'bg-amber-100 text-amber-700' },
  api_error:        { label: 'API error',        chip: 'bg-rose-100 text-rose-700' },
  unit_match_error: { label: 'Unit match error', chip: 'bg-violet-100 text-violet-700' },
  malformed_json:   { label: 'Malformed JSON',   chip: 'bg-orange-100 text-orange-700' },
  rate_limit:       { label: 'Rate limited',     chip: 'bg-blue-100 text-blue-700' },
  save_error:       { label: 'Save error',       chip: 'bg-rose-100 text-rose-700' },
  unknown:          { label: 'Unknown',          chip: 'bg-slate-100 text-slate-600' },
};

/**
 * Admin-facing monitoring for AI lesson-plan reviews.
 * Makes recurring failures visible without waiting for a teacher to report them.
 */
export function AiReviewLogs() {
  const { data: logs, isLoading, refetch, isFetching } = useAiReviewLogs(200);
  const [outcomeFilter, setOutcomeFilter] = useState<AiReviewOutcome | 'all' | 'failures'>('failures');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of logs || []) c[l.outcome] = (c[l.outcome] || 0) + 1;
    return c;
  }, [logs]);

  const total = logs?.length || 0;
  const successes = counts.success || 0;
  const failures = total - successes;
  const failureRate = total ? Math.round((failures / total) * 100) : 0;

  const filtered = useMemo(() => {
    if (!logs) return [];
    if (outcomeFilter === 'all') return logs;
    if (outcomeFilter === 'failures') return logs.filter((l) => l.outcome !== 'success');
    return logs.filter((l) => l.outcome === outcomeFilter);
  }, [logs, outcomeFilter]);

  const avgLatency = useMemo(() => {
    const withLatency = (logs || []).filter((l) => typeof l.latency_ms === 'number');
    if (!withLatency.length) return null;
    return Math.round(withLatency.reduce((n, l) => n + (l.latency_ms || 0), 0) / withLatency.length);
  }, [logs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-100 text-indigo-700">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">AI Review Monitoring</h1>
            <p className="text-sm text-slate-500">Every lesson-plan AI review attempt, newest first.</p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Health summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Attempts logged" value={String(total)} tone="slate" icon={Activity} />
        <StatCard label="Successful" value={String(successes)} tone="emerald" icon={CheckCircle2} />
        <StatCard label="Failures" value={String(failures)} tone={failures ? 'rose' : 'slate'} icon={AlertTriangle} />
        <StatCard
          label="Avg latency"
          value={avgLatency !== null ? `${(avgLatency / 1000).toFixed(1)}s` : '—'}
          tone="indigo"
          icon={Clock}
        />
      </div>

      {failures > 0 && (
        <div className={cn(
          'rounded-2xl border p-4 flex items-start gap-3',
          failureRate >= 25 ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200'
        )}>
          <AlertTriangle className={cn('w-5 h-5 shrink-0 mt-0.5', failureRate >= 25 ? 'text-rose-600' : 'text-amber-600')} />
          <div>
            <p className={cn('text-sm font-semibold', failureRate >= 25 ? 'text-rose-900' : 'text-amber-900')}>
              {failureRate}% of recent AI reviews failed
            </p>
            <p className={cn('text-sm mt-0.5', failureRate >= 25 ? 'text-rose-800' : 'text-amber-800')}>
              {failureRate >= 25
                ? 'That is high enough to suggest a systemic problem — check the API key, quota, and model availability.'
                : 'Individual failures can be retried from the supervisor’s Lesson Plan Review page.'}
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {(['failures', 'all', ...Object.keys(OUTCOME_META)] as const).map((key) => {
          const label = key === 'all' ? 'All' : key === 'failures' ? 'Failures only' : OUTCOME_META[key as AiReviewOutcome].label;
          const n = key === 'all' ? total : key === 'failures' ? failures : counts[key] || 0;
          return (
            <button
              key={key}
              onClick={() => setOutcomeFilter(key as any)}
              className={cn(
                'px-3.5 py-1.5 rounded-xl text-sm font-medium border transition-all',
                outcomeFilter === key
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200 ring-2 ring-offset-1 ring-indigo-100'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
              )}
            >
              {label} <span className="text-xs opacity-60">({n})</span>
            </button>
          );
        })}
      </div>

      {/* Log table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading logs…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-300 mb-3" />
            <p className="font-medium text-slate-600">
              {outcomeFilter === 'failures' ? 'No AI failures recorded' : 'No log entries yet'}
            </p>
            <p className="text-sm text-slate-400 mt-1">
              Entries appear here as teachers submit plans for review.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">When</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Outcome</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Plan</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Details</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((log) => {
                  const meta = OUTCOME_META[log.outcome] || OUTCOME_META.unknown;
                  return (
                    <tr key={log.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap', meta.chip)}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600 break-all max-w-[220px]">
                        {log.plan_id || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 max-w-md">
                        {log.error_code && (
                          <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono mr-1.5">
                            {log.error_code}
                          </span>
                        )}
                        <span className="break-words">{log.message || '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 text-right whitespace-nowrap">
                        {log.latency_ms != null ? `${(log.latency_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  slate: 'bg-slate-50 border-slate-200 text-slate-700',
  emerald: 'bg-emerald-50 border-emerald-100 text-emerald-700',
  rose: 'bg-rose-50 border-rose-100 text-rose-700',
  indigo: 'bg-indigo-50 border-indigo-100 text-indigo-700',
};

function StatCard({ label, value, tone, icon: Icon }: { label: string; value: string; tone: keyof typeof TONES; icon: typeof Activity }) {
  return (
    <div className={cn('rounded-2xl border p-4', TONES[tone])}>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-4 h-4 opacity-70" />
        <p className="text-xs font-medium opacity-80">{label}</p>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
