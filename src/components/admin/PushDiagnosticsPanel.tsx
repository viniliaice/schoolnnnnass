import { useState } from 'react';
import { Activity, Search, Send } from 'lucide-react';
import { supabase, isPlaceholderEnv } from '../../lib/supabase';

interface DiagnosticPushResult {
  status: number;
  ok: boolean;
  expired: boolean;
  failureCode: string;
  detail: string;
  networkError: string | null;
}

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
  push: DiagnosticPushResult | null;
}

interface DiagnosticsResponse {
  ok: boolean;
  vapid: {
    ok: boolean;
    subjectValid: boolean;
    subjectScheme: string;
    privateKeyBytes: number;
    publicKeyBytes: number | null;
    problems: string[];
    publicKeyServable: boolean;
  };
  dryRun: boolean;
  subscriptions: DiagnosticSubscription[];
  summary: {
    attempted: number;
    delivered: number;
    expired: number;
    rejected: number;
    otherFailures: number;
    hint: string;
  };
  note: string;
}

export function PushDiagnosticsPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosticsResponse | null>(null);

  if (isPlaceholderEnv) return null;

  const run = async (dryRun: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError('Your session has expired — sign in again.');
        return;
      }
      const response = await fetch('/api/push/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dryRun }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(json?.error || `Diagnostics failed (HTTP ${response.status}).`);
        return;
      }
      setResult(json as DiagnosticsResponse);
    } catch {
      setError('Diagnostics could not be reached. Check the network and try again.');
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
            Inspect active teacher subscriptions safely, or send one test push to each active device. Endpoint paths and key material are never shown.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run(true)}
            disabled={busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <Search className="h-4 w-4" /> Inspect (no push sent)
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> Test push to each device
          </button>
        </div>
      </div>

      {busy && <p className="mt-4 text-sm text-slate-500">Running diagnostics…</p>}
      {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {result && (
        <div className="mt-5 space-y-4">
          <div
            className={`rounded-xl border p-4 text-sm ${result.vapid.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}
            data-testid="diagnostics-vapid"
          >
            <p className="font-semibold">
              VAPID: {result.vapid.ok ? 'valid' : 'invalid'} · subject {result.vapid.subjectScheme} · private key {result.vapid.privateKeyBytes} bytes · public key {result.vapid.publicKeyBytes ?? 'unavailable'} bytes · public endpoint {result.vapid.publicKeyServable ? 'servable' : 'not verified'}
            </p>
            {result.vapid.problems.length > 0 && <p className="mt-1">{result.vapid.problems.join(' ')}</p>}
            {result.dryRun && !result.vapid.ok && <p className="mt-1 font-semibold">Real push was disabled because VAPID is invalid.</p>}
          </div>

          <div className="rounded-xl bg-slate-50 p-4" data-testid="diagnostics-summary">
            <p className="font-semibold text-slate-800">
              {result.dryRun ? 'Inspection only' : 'Test push'} · {result.summary.attempted} attempted · {result.summary.delivered} accepted · {result.summary.expired} expired · {result.summary.rejected} rejected · {result.summary.otherFailures} other failures
            </p>
            <p className="mt-1 text-sm text-slate-500">{result.note}</p>
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-950" data-testid="diagnostics-hint">
            <span className="font-semibold">Next step: </span>{result.summary.hint}
          </div>

          {result.subscriptions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 p-5 text-center text-sm text-slate-500" data-testid="diagnostics-empty">
              No subscription rows were returned.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 pr-3">Teacher</th>
                    <th className="py-2 pr-3">Endpoint host</th>
                    <th className="py-2 pr-3">Device / browser</th>
                    <th className="py-2 pr-3">Active</th>
                    <th className="py-2 pr-3">Key material</th>
                    <th className="py-2">Push-service result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.subscriptions.map((sub) => (
                    <tr key={sub.id} className="align-top">
                      <td className="py-3 pr-3 font-mono text-xs text-slate-600">{sub.userId}</td>
                      <td className="py-3 pr-3 text-slate-700">
                        {sub.endpointHost || 'invalid host'}{sub.endpointLooksSynthetic && <span className="ml-1 text-amber-700">(synthetic)</span>}
                      </td>
                      <td className="py-3 pr-3 capitalize text-slate-600">{sub.deviceType || 'unknown'} · {sub.browser || 'unknown'}</td>
                      <td className="py-3 pr-3">{sub.isActive ? 'Yes' : 'No'}</td>
                      <td className="py-3 pr-3 text-xs text-slate-600">
                        p256dh {sub.p256dhBytes} B {sub.p256dhLooksLikePoint ? '✓' : '✗'} · auth {sub.authBytes} B {sub.authLooksValid ? '✓' : '✗'}
                        {sub.problems.length > 0 && <p className="mt-1 text-amber-700">{sub.problems.join('; ')}</p>}
                      </td>
                      <td className="py-3 text-xs text-slate-600">
                        {sub.push ? (
                          <>
                            <p className={sub.push.ok ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>
                              {sub.push.ok ? 'accepted' : sub.push.failureCode} (HTTP {sub.push.status})
                            </p>
                            {sub.push.detail && <p className="mt-1 break-words">{sub.push.detail}</p>}
                            {sub.push.networkError && <p className="mt-1 break-words">{sub.push.networkError}</p>}
                          </>
                        ) : <span className="text-slate-400">Not tested</span>}
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
