import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { encryptDeviceCredential } from './credential-crypto.js';

function clients(token: string) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !anon || !service) throw new Error('server_config');
  const auth = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  return { auth, db };
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'GET, PUT or DELETE required.' });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const { auth, db } = clients(token);
    const { data: { user }, error: authError } = await auth.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Authentication required.' });
    const { data: profile, error: profileError } = await auth.from('profiles').select('role').eq('auth_id', user.id).single();
    if (profileError || profile?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const serial = process.env.ZK_DEVICE_SERIAL || '';
    if (!serial) return res.status(503).json({ error: 'Explicit K40 serial must be configured server-side.' });

    if (req.method === 'GET') {
      const [{ data, error }, { data: candidate, error: candidateError }] = await Promise.all([
        db.from('fingerprint_device_credentials').select('updated_at').eq('device_serial', serial).maybeSingle(),
        db.from('fingerprint_device_credential_candidates').select('updated_at').eq('device_serial', serial).maybeSingle(),
      ]);
      if (error || candidateError) return res.status(503).json({ error: 'Credential storage is not available.' });
      return res.status(200).json({ configured: !!data, updated_at: data?.updated_at || null, pending_rotation: !!candidate, pending_updated_at: candidate?.updated_at || null, device_serial: serial });
    }

    if (req.method === 'DELETE') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (body.discard_pending_only === true) {
        const { error } = await db.from('fingerprint_device_credential_candidates').delete().eq('device_serial', serial);
        if (error) return res.status(503).json({ error: 'Could not discard the pending rotation.' });
        const { data: active, error: activeError } = await db.from('fingerprint_device_credentials').select('updated_at').eq('device_serial', serial).maybeSingle();
        if (activeError) return res.status(503).json({ error: 'Could not verify the active credential status.' });
        return res.status(200).json({ configured: !!active, updated_at: active?.updated_at || null, pending_rotation: false, removed_pending: true });
      }
      const [{ error }, { error: pendingError }] = await Promise.all([
        db.from('fingerprint_device_credentials').delete().eq('device_serial', serial),
        db.from('fingerprint_device_credential_candidates').delete().eq('device_serial', serial),
      ]);
      if (error || pendingError) return res.status(503).json({ error: 'Could not remove the saved device credential.' });
      return res.status(200).json({ configured: false, pending_rotation: false, removed: true });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const credential = body.credential;
    if (typeof credential !== 'string' || credential.length < 1 || credential.length > 128 || /[\r\n\0]/.test(credential)) {
      return res.status(400).json({ error: 'Enter a valid device credential.' });
    }
    let encrypted: ReturnType<typeof encryptDeviceCredential>;
    try { encrypted = encryptDeviceCredential(credential); }
    catch { return res.status(503).json({ error: 'Secure credential storage is not configured on this Preview deployment.' }); }
    // Atomic upsert preserves the previous credential if encryption or the write fails.
    const stagedAt = new Date().toISOString();
    const { error } = await db.from('fingerprint_device_credential_candidates').upsert({
      device_serial: serial, revision_id: randomUUID(), ...encrypted, updated_at: stagedAt, updated_by: user.id,
    }, { onConflict: 'device_serial' });
    if (error) return res.status(503).json({ error: 'Could not save the encrypted credential candidate.' });
    const { data: active, error: activeError } = await db.from('fingerprint_device_credentials').select('updated_at').eq('device_serial', serial).maybeSingle();
    if (activeError) return res.status(503).json({ error: 'Credential staged, but active credential status could not be verified. Refresh status before proceeding.' });
    return res.status(200).json({ configured: !!active, updated_at: active?.updated_at || null, pending_rotation: true, pending_updated_at: stagedAt, device_serial: serial, message: 'Encrypted candidate staged. Run Test connection; it becomes active only after successful authentication.' });
  } catch {
    return res.status(500).json({ error: 'Fingerprint credential operation failed.' });
  }
}
