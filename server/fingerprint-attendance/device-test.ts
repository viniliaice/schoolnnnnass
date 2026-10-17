import { createClient } from '@supabase/supabase-js';
import { isIP } from 'node:net';

function getClients(token: string) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !anon || !service) throw new Error('server_config');
  return {
    auth: createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } }),
    db: createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } }),
  };
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST required.' });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const { auth, db } = getClients(token);
    const { data: { user }, error: authError } = await auth.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Authentication required.' });
    const { data: profile } = await auth.from('profiles').select('role').eq('auth_id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const serial = process.env.ZK_DEVICE_SERIAL || '';
    if (!serial || !isIP(process.env.ZK_DEVICE_IP || '') || !/^\d+$/.test(process.env.ZK_DEVICE_PORT || '') || Number(process.env.ZK_DEVICE_PORT) < 1 || Number(process.env.ZK_DEVICE_PORT) > 65535) return res.status(503).json({ error: 'Explicit K40 serial, address, and port must be configured server-side.' });

    if (req.method === 'POST') {
      const [{ data: active, error: activeError }, { data: candidate, error: candidateError }] = await Promise.all([
        db.from('fingerprint_device_credentials').select('device_serial').eq('device_serial', serial).maybeSingle(),
        db.from('fingerprint_device_credential_candidates').select('revision_id').eq('device_serial', serial).maybeSingle(),
      ]);
      if (activeError || candidateError) return res.status(503).json({ error: 'Secure device configuration is unavailable.' });
      if (!active && !candidate) return res.status(409).json({ error: 'Save a device credential before testing the connector.' });
      const { data, error } = await db.from('fingerprint_device_test_requests').insert({ requested_by: user.id, status: 'queued', credential_revision_id: candidate?.revision_id || null }).select('id, status, requested_at').single();
      if (error) return res.status(503).json({ error: 'Could not queue a connector test. Verify the preview migration.' });
      return res.status(202).json({ testId: data.id, status: data.status, requested_at: data.requested_at, configured_target: `${process.env.ZK_DEVICE_IP}:${process.env.ZK_DEVICE_PORT}`, message: 'Test queued for the LAN connector. It has not yet contacted the device.' });
    }

    const testId = String(req.query?.testId || '');
    if (!/^[0-9a-f-]{36}$/i.test(testId)) return res.status(400).json({ error: 'Invalid test id.' });
    const { data, error } = await db.from('fingerprint_device_test_requests').select('id,status,requested_at,tested_at,result_message').eq('id', testId).eq('requested_by', user.id).maybeSingle();
    if (error) return res.status(503).json({ error: 'Could not read the connector test result.' });
    if (!data) return res.status(404).json({ error: 'Test request not found.' });
    const connectorUnavailable = data.status === 'queued' && Date.now() - Date.parse(data.requested_at) > 30_000;
    return res.status(200).json({ testId: data.id, status: connectorUnavailable ? 'connector_unavailable' : data.status, requested_at: data.requested_at, tested_at: data.tested_at, configured_target: `${process.env.ZK_DEVICE_IP}:${process.env.ZK_DEVICE_PORT}`, result_message: connectorUnavailable ? 'No LAN connector claimed this request within 30 seconds. Check that the connector is online and its realtime subscription is healthy, then start a new test.' : data.result_message });
  } catch {
    return res.status(500).json({ error: 'Device connection test request failed.' });
  }
}
