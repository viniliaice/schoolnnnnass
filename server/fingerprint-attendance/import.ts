import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

/** Authenticated admin-only job enqueue. The school LAN connector claims the job by polling. */
export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({error:'Method not allowed'}); }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return res.status(503).json({error:'Fingerprint import server configuration is incomplete.'});
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    if (!token) return res.status(401).json({error:'Authentication required.'});
    const authClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession:false, autoRefreshToken:false } });
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) return res.status(401).json({error:'Invalid session.'});
    const { data: profile } = await authClient.from('profiles').select('role').eq('auth_id', user.id).single();
    if (profile?.role !== 'admin') return res.status(403).json({error:'Administrator access required.'});
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const format = body.format === 'csv' ? 'csv' : body.format === 'xlsx' ? 'xlsx' : null;
    if (!format) return res.status(400).json({error:'Choose CSV or Excel format.'});
    const date = (v: unknown) => {
      if (v == null || v === '') return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
      const parsed = Date.parse(`${v}T00:00:00.000Z`);
      return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === v ? v : undefined;
    };
    const from = date(body.from);
    const to = date(body.to);
    if (typeof from !== 'string' || typeof to !== 'string' || from > to) {
      return res.status(400).json({error:'Choose a valid date range.'});
    }
    const id = randomUUID();
    const admin = createClient(url, service, {auth:{persistSession:false,autoRefreshToken:false}});
    const { error } = await admin.from('fingerprint_import_jobs').insert({ id, requested_by:user.id, status:'queued', last_dispatched_at:new Date().toISOString(), export_format:format, date_from:from, date_to:to });
    if (error) throw error;
    return res.status(202).json({jobId:id, message:'Queued. The school LAN connector will check for the request; no device work occurs until then.'});
  } catch (e) {
    console.error('[fingerprint import enqueue]', e);
    return res.status(500).json({error:'Unable to create the import job.'});
  }
}
