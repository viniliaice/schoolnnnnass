import { useEffect, useState } from 'react';
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
  const [credential, setCredential] = useState('');
  const [showCredential, setShowCredential] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<any>({ loading: true, configured: false });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [deviceTest, setDeviceTest] = useState<any>(null);
  const [deviceTestBusy, setDeviceTestBusy] = useState(false);
  const adminToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Sign in again with an administrator account.');
    return session.access_token;
  };
  const loadCredentialStatus = async () => {
    const token = await adminToken();
    const response = await fetch('/api/fingerprint-attendance/credential', { headers: { Authorization: `Bearer ${token}` } });
    const body = await readApiJson(response);
    if (!response.ok) throw new Error(body.error || 'Could not check credential status.');
    setCredentialStatus({ ...body, loading: false });
  };
  useEffect(() => { void loadCredentialStatus().catch((e) => setCredentialStatus({ loading: false, configured: false, error: e.message })); }, []);
  const saveCredential = async () => {
    if (!credential) { setError('Enter the device communication password/key first.'); return; }
    setCredentialBusy(true); setError('');
    try {
      const token = await adminToken();
      const response = await fetch('/api/fingerprint-attendance/credential', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
      const body = await readApiJson(response);
      if (!response.ok) throw new Error(body.error || 'Could not save the encrypted device credential.');
      setCredential(''); setShowCredential(false); setCredentialStatus({ ...body, loading: false });
    } catch (e) { setError(e instanceof Error ? e.message : 'Credential save failed.'); }
    finally { setCredentialBusy(false); }
  };
  const removeCredential = async () => {
    if (!window.confirm('Remove the saved device credential? This does not change the password on the K40.')) return;
    setCredentialBusy(true); setError('');
    try {
      const token = await adminToken();
      const response = await fetch('/api/fingerprint-attendance/credential', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      const body = await readApiJson(response);
      if (!response.ok) throw new Error(body.error || 'Could not remove the saved credential.');
      setCredential(''); setCredentialStatus({ ...body, loading: false });
    } catch (e) { setError(e instanceof Error ? e.message : 'Credential removal failed.'); }
    finally { setCredentialBusy(false); }
  };
  const discardPendingCredential = async () => {
    if (!window.confirm('Discard only the pending replacement? The currently active device credential will remain unchanged.')) return;
    setCredentialBusy(true); setError('');
    try {
      const token = await adminToken();
      const response = await fetch('/api/fingerprint-attendance/credential', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ discard_pending_only: true }) });
      const body = await readApiJson(response);
      if (!response.ok) throw new Error(body.error || 'Could not discard the pending credential.');
      setCredentialStatus({ ...body, loading: false });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not discard pending credential.'); }
    finally { setCredentialBusy(false); }
  };
  const requestDeviceTest = async () => {
    setDeviceTestBusy(true); setError('');
    try {
      const token = await adminToken();
      const response = await fetch('/api/fingerprint-attendance/device-test', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      const body = await readApiJson(response);
      if (!response.ok) throw new Error(body.error || 'Could not queue the device test.');
      setDeviceTest(body);
    } catch (e) { setError(e instanceof Error ? e.message : 'Device test request failed.'); }
    finally { setDeviceTestBusy(false); }
  };
  const refreshDeviceTest = async () => {
    if (!deviceTest?.testId) return;
    const token = await adminToken();
    const response = await fetch(`/api/fingerprint-attendance/device-test?testId=${encodeURIComponent(deviceTest.testId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await readApiJson(response);
    if (!response.ok) throw new Error(body.error || 'Could not retrieve the test result.');
    setDeviceTest(body);
    if (body.status === 'success') await loadCredentialStatus();
  };
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
    if (!from || !to || from > to) {
      setError('Choose a valid start and end date before requesting an import.');
      return;
    }
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
    {error && <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-red-800">{error}</p>}
    <section aria-labelledby="device-credential-heading" className="mb-5 rounded-xl border bg-white p-6 shadow-sm">
      <h2 id="device-credential-heading" className="text-lg font-semibold">K40 device credential</h2>
      <p className="mt-1 text-sm text-slate-600">Encrypted on the server. A replacement remains pending and the current key stays active until the new key passes authenticated device verification. Saved values are never returned to this page.</p>
      <p role="status" className="mt-3 text-sm">{credentialStatus.loading ? 'Checking secure credential status…' : credentialStatus.error ? credentialStatus.error : credentialStatus.pending_rotation ? credentialStatus.configured ? 'Configured · replacement pending verification (current key remains active)' : 'Replacement pending verification · no active key yet' : credentialStatus.configured ? `Configured${credentialStatus.updated_at ? ` · updated ${new Date(credentialStatus.updated_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'})}` : ''}` : 'Not configured'}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="k40-credential">Device communication password/key</label>
        <input id="k40-credential" type={showCredential ? 'text' : 'password'} autoComplete="new-password" value={credential} onChange={e=>setCredential(e.target.value)} placeholder={credentialStatus.configured || credentialStatus.pending_rotation ? 'Enter replacement key to rotate' : 'Enter device communication key'} className="min-w-64 flex-1 rounded border p-2" />
        <button type="button" className="rounded border px-3" onClick={()=>setShowCredential(v=>!v)} aria-label={showCredential ? 'Hide credential' : 'Show credential'}>{showCredential ? 'Hide' : 'Show'}</button>
        <button type="button" disabled={credentialBusy || !credential} onClick={saveCredential} className="rounded bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">{credentialBusy ? 'Saving…' : credentialStatus.configured ? 'Save / rotate' : 'Save credential'}</button>
        {(credentialStatus.configured || credentialStatus.pending_rotation) && <button type="button" disabled={credentialBusy} onClick={removeCredential} className="rounded border border-red-300 px-4 py-2 text-red-700 disabled:opacity-50">Remove active and pending</button>}{credentialStatus.pending_rotation && <button type="button" disabled={credentialBusy} onClick={discardPendingCredential} className="rounded border px-4 py-2 disabled:opacity-50">Discard pending only</button>}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" disabled={deviceTestBusy || (!credentialStatus.configured && !credentialStatus.pending_rotation)} onClick={requestDeviceTest} className="rounded bg-slate-800 px-4 py-2 font-semibold text-white disabled:opacity-50">{deviceTestBusy ? 'Queueing test…' : 'Test connection'}</button>
        <span className="text-xs text-slate-500">Only the configured K40 address and port are tested. The connector must be online.</span>
      </div>
      {deviceTest && <div className="mt-3 rounded bg-slate-50 p-3 text-sm" aria-live="polite"><p className="font-medium">Connection test: {deviceTest.status}</p>{deviceTest.configured_target && <p>Configured K40 target: {deviceTest.configured_target}</p>}<p>{deviceTest.message || deviceTest.result_message || 'Waiting for the school LAN connector. No device contact has been confirmed yet.'}</p>{deviceTest.requested_at && <p>Requested {new Date(deviceTest.requested_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'})}</p>}{deviceTest.tested_at && <p>Tested {new Date(deviceTest.tested_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'})}</p>}{['queued','running'].includes(deviceTest.status) && <button type="button" className="mt-2 rounded border px-3 py-1" onClick={()=>refreshDeviceTest().catch(e=>setError(e.message))}>Refresh test status</button>}</div>}
    </section>
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3"><label className="text-sm">From date<input type="date" required max={to || undefined} value={from} onChange={e=>setFrom(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label><label className="text-sm">To date<input type="date" required min={from || undefined} value={to} onChange={e=>setTo(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label><label className="text-sm">Export format<select value={format} onChange={e=>setFormat(e.target.value as 'csv'|'xlsx')} className="mt-1 block w-full rounded border p-2"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label></div>
      <button onClick={start} disabled={busy || !from || !to || from > to} className="mt-5 rounded-lg bg-blue-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Requesting import…' : 'Download Fingerprint Records'}</button>
      {busy && <p role="status" className="mt-3 text-sm">Creating a secure manual import request…</p>}
      {result && <div className="mt-5 rounded bg-slate-50 p-4 text-sm"><h2 className="font-semibold">Fingerprint import — {result.status || 'queued'}</h2><p>Job: {result.jobId}</p><p>{result.message || result.error_message || 'Use Refresh status to check the connector result. No background device retrieval is started from this page.'}</p><p className="mt-2">Retrieved {result.retrieved_count ?? 0} · inserted {result.inserted_count ?? 0} · duplicates {result.duplicate_count ?? 0} · rejected {result.rejected_count ?? 0} · mapping review {result.unmatched_count ?? 0}</p>{result.requested_at && <p>Requested: {new Date(result.requested_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'})}</p>}{['completed','partial_failed','failed'].includes(result.status) && <p>Completed: {result.completed_at ? new Date(result.completed_at).toLocaleString('en-GB',{timeZone:'Africa/Mogadishu'}) : '—'}</p>}<button className="mt-3 mr-3 rounded border px-3 py-2" onClick={()=>refresh().catch(e=>setError(e.message))}>Refresh status</button>{result.status === 'completed' && <button className="mt-3 rounded bg-emerald-700 px-3 py-2 text-white" onClick={()=>download().catch(e=>setError(e.message))}>Download completed {String(result.export_format || format).toUpperCase()} export</button>}{['failed','expired'].includes(result.status) && <button className="mt-3 rounded border px-3 py-2" onClick={()=>retry().catch(e=>setError(e.message))}>Explicitly retry this job</button>}</div>}
      <p className="mt-5 text-xs text-slate-500">The connector must be running on the school LAN; it checks for requests every 10 seconds and contacts the device only for an authorized manual request. Opening this page does not contact the device.</p>
    </section>
  </div>;
}
