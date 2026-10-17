import { useState } from 'react';
import { supabase } from '../../lib/supabase';

async function readApiJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Fingerprint API returned an empty response (HTTP ${response.status}). Check the Vercel function deployment and Preview environment variables.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Fingerprint API returned a non-JSON response (HTTP ${response.status}). Check the Vercel function logs.`);
  }
}

/** Manual-only interface. It never subscribes to the device or starts work on mount. */
export function FingerprintAttendance() {
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const refresh = async (jobId = result?.jobId) => {
    if (!jobId) return;
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(`/api/fingerprint-attendance/status?jobId=${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${session?.access_token || ''}` } });
    const data = await readApiJson(r); if (!r.ok) throw new Error(data.error || 'Unable to refresh status.');
    setResult((old: any) => ({ ...old, ...data, jobId }));
  };
  const retry = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/api/fingerprint-attendance/retry', { method:'POST', headers:{Authorization:`Bearer ${session?.access_token || ''}`,'Content-Type':'application/json'}, body:JSON.stringify({jobId:result.jobId}) });
    const data = await readApiJson(r); if (!r.ok) throw new Error(data.error || 'Retry request failed.');
    setResult((old:any)=>({...old,...data,status:'queued'}));
  };
  const download = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(`/api/fingerprint-attendance/export?jobId=${encodeURIComponent(result.jobId)}`, { headers: { Authorization: `Bearer ${session?.access_token || ''}` } });
    if (!r.ok) { const data = await readApiJson(r); throw new Error(data.error || 'Export download failed.'); }
    const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `fingerprint-${result.jobId}.${format}`; a.click(); URL.revokeObjectURL(url);
  };
  const start = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Sign in again to start an import.');
      const response = await fetch('/api/fingerprint-attendance/import', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ format, from: from || null, to: to || null }) });
      const body = await readApiJson(response);
      if (!response.ok) throw new Error(body.error || 'Import request failed.');
      setResult(body);
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed.'); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-4xl p-6">
    <header className="mb-6"><p className="text-sm text-slate-500">Administration</p><h1 className="text-2xl font-bold">Fingerprint Attendance</h1><p className="mt-2 text-slate-600">Manually request attendance events from the school’s K40. Device records are never modified.</p></header>
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3"><label className="text-sm">From date<input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label><label className="text-sm">To date<input type="date" value={to} onChange={e=>setTo(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label><label className="text-sm">Export format<select value={format} onChange={e=>setFormat(e.target.value as 'csv'|'xlsx')} className="mt-1 block w-full rounded border p-2"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label></div>
      <button onClick={start} disabled={busy} className="mt-5 rounded-lg bg-blue-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Requesting import…' : 'Download Fingerprint Records'}</button>
      {busy && <p role="status" className="mt-3 text-sm">Creating a secure manual import request…</p>}
      {error && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-red-800">{error}</p>}
      {result && <div className="mt-5 rounded bg-slate-50 p-4 text-sm"><h2 className="font-semibold">Fingerprint import — {result.status || 'queued'}</h2><p>Job: {result.jobId}</p><p>{result.message || result.error_message || 'Use Refresh status to check the connector result. No background device retrieval is started from this page.'}</p><p className="mt-2">Retrieved {result.retrieved_count ?? 0} · inserted {result.inserted_count ?? 0} · duplicates {result.duplicate_count ?? 0} · rejected {result.rejected_count ?? 0} · mapping review {result.unmatched_count ?? 0}</p>{result.requested_at && <p>Requested: {new Date(result.requested_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'})}</p>}{['completed','partial_failed','failed'].includes(result.status) && <p>Completed: {result.completed_at ? new Date(result.completed_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'}) : '—'}</p>}<button className="mt-3 mr-3 rounded border px-3 py-2" onClick={()=>refresh().catch(e=>setError(e.message))}>Refresh status</button>{result.status === 'completed' && <button className="mt-3 rounded bg-emerald-700 px-3 py-2 text-white" onClick={()=>download().catch(e=>setError(e.message))}>Download completed {String(result.export_format || format).toUpperCase()} export</button>}{['failed','expired'].includes(result.status) && <button className="mt-3 rounded border px-3 py-2" onClick={()=>retry().catch(e=>setError(e.message))}>Explicitly retry this job</button>}</div>}
      <p className="mt-5 text-xs text-slate-500">The connector must be running on the school LAN. Opening this page does not contact the device.</p>
    </section>
  </div>;
}
