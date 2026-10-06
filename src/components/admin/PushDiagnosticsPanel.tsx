import { useState } from 'react';
import { Activity, Search, Send } from 'lucide-react';
import { isPlaceholderEnv, supabase } from '../../lib/supabase';

interface DiagnosticSubscription {
  id: string;
  userId: string;
  endpointHost: string | null;
  endpointLooksSynthetic: boolean;
  isActive: boolean;
  deviceType: string | null;
  browser: string | null;
  createdAt: string | null;
  p256dhBytes: number;
  p256dhLooksLikePoint: boolean;
  authBytes: number;
  authLooksValid: boolean;
  problems: string[];
  status: number | null;
  ok: boolean | null;
  expired: boolean;
  retired: boolean;
  retirementFailed: boolean;
  failureCode: string | null;
  detail: string | null;
  networkError: string | null;
}

interface DiagnosticResponse {
  ok: boolean;
  deliveryOk: boolean;
  dryRun: boolean;
  vapid: {
    ok: boolean;
    subjectValid: boolean;
    subjectScheme: string;
    privateKeyBytes: number;
    publicKeyBytes: number;
    problems: string[];
    publicKeyServable: boolean;
  };
  subscriptions: DiagnosticSubscription[];
  summary: {
    attempted: number;
    delivered: number;
    expired: number;
    retired: number;
    retirementFailed: number;
    rejected: number;
    otherFailures: number;
    hint: string;
  };
  note: string;
}

export function PushDiagnosticsPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosticResponse | null>(null);
  const [teacherId, setTeacherId] = useState('');

  if (isPlaceholderEnv) return null;

  const runDiagnostics = async (dryRun: boolean) => {
    if (busy) return;
    if (!dryRun) {
      const scope = teacherId.trim() ? 'the matching teacher devices' : 'up to 50 stored subscription rows';
      if (!window.confirm(`Send a real push diagnostics notification to ${scope}?`)) return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error('Your session could not be verified. Sign in again.');
      const token = data.session?.access_token;
      if (!token) throw new Error('Your session has expired — sign in again.');
      const response = await fetch('/api/push/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dryRun, teacherId: teacherId.trim() || undefined }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.error || `Diagnostics failed (HTTP ${response.status}).`);
      setResult(json as DiagnosticResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run push diagnostics.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6" data-testid="push-diagnostics-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <Activity className="h-5 w-5 text-indigo-600" /> Push Diagnostics
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Inspect subscription health without sending a push, or explicitly test active subscriptions in the matching result set (maximum 50 rows).
          </p>
        </div>
        <label className="w-full max-w-md text-xs font-semibold text-slate-600">
          Teacher profile ID filter (optional)
          <input
            value={teacherId}
            onChange={(event) => setTeacherId(event.target.value)}
            placeholder="Leave blank to inspect the latest 50 subscription rows"
            data-testid="diagnostics-teacher-id"
            className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal"
          />
          <span className="mt-1 block font-normal text-slate-500">A real test is limited to this teacher when an ID is entered; otherwise it may reach active devices across the school.</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => runDiagnostics(true)}
            disabled={busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <Search className="h-4 w-4" /> Inspect (no push sent)
          </button>
          <button
            type="button"
            onClick={() => runDiagnostics(false)}
            disabled={busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> Test push to matching devices
          </button>
        </div>
      </div>

      {busy && <p className="mt-4 text-sm text-slate-500">Checking push subscriptions…</p>}
      {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {result && (
        <div className="mt-5 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="diagnostics-vapid">
            <h3 className="text-sm font-bold text-slate-800">Server VAPID configuration</h3>
            <p className={`mt-1 text-sm ${result.vapid.ok && result.vapid.publicKeyServable ? 'text-emerald-700' : 'text-rose-700'}`}>
              {result.vapid.ok ? 'Valid' : 'Invalid'} · subject {result.vapid.subjectScheme} · private key {result.vapid.privateKeyBytes} bytes · public key {result.vapid.publicKeyBytes} bytes · public-key endpoint {result.vapid.publicKeyServable ? 'servable' : 'not servable'}
            </p>
            {result.vapid.problems.length > 0 && <ul className="mt-2 list-inside list-disc text-xs text-rose-700">{result.vapid.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4" data-testid="diagnostics-summary">
            <p className="text-sm font-semibold text-slate-800">
              {result.dryRun ? 'Dry run — no push sent' : `${result.summary.delivered} delivered / ${result.summary.attempted} attempted`} · {result.summary.expired} expired · {result.summary.retired} retired · {result.summary.retirementFailed} retirement failures · {result.summary.rejected} rejected · {result.summary.otherFailures} other failures
            </p>
            <p className="mt-1 text-xs text-slate-500">{result.note}</p>
            <p className="mt-3 text-sm text-slate-700" data-testid="diagnostics-hint">{result.summary.hint}</p>
          </div>

          {result.subscriptions.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500" data-testid="diagnostics-empty">
              No subscription rows were found.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3">Teacher ID</th>
                    <th className="py-2 pr-3">Endpoint host</th>
                    <th className="py-2 pr-3">Device / browser</th>
                    <th className="py-2 pr-3">Active</th>
                    <th className="py-2 pr-3">Key material</th>
                    <th className="py-2">Push service</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.subscriptions.map((subscription) => (
                    <tr key={subscription.id} className="align-top">
                      <td className="py-3 pr-3 font-mono text-slate-700">{subscription.userId || '—'}</td>
                      <td className="py-3 pr-3 font-mono text-slate-700">
                        {subscription.endpointHost || 'invalid endpoint'}
                        {subscription.endpointLooksSynthetic && <span className="ml-1 text-amber-700">(synthetic)</span>}
                      </td>
                      <td className="py-3 pr-3 text-slate-700">{subscription.deviceType || 'unknown'} / {subscription.browser || 'unknown'}</td>
                      <td className="py-3 pr-3 text-slate-700">{subscription.isActive ? 'Yes' : 'No'}</td>
                      <td className="max-w-64 py-3 pr-3 text-slate-600">
                        <span>{subscription.p256dhBytes}B p256dh · {subscription.authBytes}B auth</span>
                        {subscription.problems.length > 0 && <ul className="mt-1 list-inside list-disc text-amber-700">{subscription.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
                      </td>
                      <td className="max-w-72 py-3 text-slate-700">
                        {subscription.status === null ? 'Not tested' : `${subscription.ok ? 'Accepted' : subscription.failureCode} (HTTP ${subscription.status || 'network'})`}
                        {subscription.expired && <span className="ml-1 text-rose-700">· expired</span>}
                        {subscription.retired && <span className="ml-1 text-amber-700">· retired</span>}
                        {subscription.retirementFailed && <span className="ml-1 text-rose-700">· retirement failed</span>}
                        {subscription.detail && <p className="mt-1 break-words text-rose-700">{subscription.detail}</p>}
                        {subscription.networkError && <p className="mt-1 break-words text-rose-700">{subscription.networkError}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
