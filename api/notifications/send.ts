/**
 * POST /api/notifications/send
 *
 * Admin/supervisor endpoint that fans a Web Push notification out to teacher
 * devices. Authorization is enforced SERVER-SIDE: the caller's Supabase access
 * token is validated through PostgREST (current_session_context RPC), and the
 * role must be admin or supervisor. Hiding the button in the UI is NOT the
 * security boundary — a teacher calling this endpoint gets 403.
 *
 * Required Vercel environment variables:
 *   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_ANON_KEY (or VITE_...),
 *   SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional).
 */

// NOTE: explicit .js extensions are REQUIRED. The Vercel Node builder transpiles
// each file individually (no bundling) and, because package.json has
// "type": "module", the output runs as ESM — Node's ESM loader cannot resolve
// extensionless relative specifiers, which made these routes 500 at load time.
import { sendTeacherNotification, validateSendRequest } from '../../server/lib/notificationSender.js';
import { createSupabaseNotificationDb } from '../../server/lib/supabaseNotificationDb.js';
import { SupabaseRest } from '../../server/lib/supabaseRest.js';
import { generateVapidKeys, type VapidConfig } from '../../server/lib/webpush.js';

let devVapid: VapidConfig | null = null;

/**
 * Last-resort error responder: guarantees a readable JSON body instead of
 * Vercel's opaque FUNCTION_INVOCATION_FAILED page. (Failures *before* the
 * handler runs — module resolution — cannot be caught here; that is what the
 * explicit .js import specifiers above prevent.)
 */
function sendJsonError(res: any, err: unknown, scope: string) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    console.error(`[${scope}] unhandled failure:`, message, err instanceof Error ? err.stack : '');
  } catch {
    /* logging must never mask the response */
  }
  const payload = { error: message || 'Internal Server Error', code: 'HANDLER_EXCEPTION' };
  try {
    if (typeof res?.status === 'function' && typeof res?.json === 'function') {
      return res.status(500).json(payload);
    }
    res.statusCode = 500;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    if (typeof res.end === 'function') return res.end(JSON.stringify(payload));
  } catch {
    /* nothing else we can do */
  }
  return undefined;
}

async function handleSend(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({
      error:
        'Missing Supabase server environment variables (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).',
    });
  }

  // ── VAPID config (private key stays server-side) ─────────────────────────
  let vapid: VapidConfig;
  if (process.env.VAPID_PRIVATE_KEY) {
    vapid = {
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@schoolnnnnass.vercel.app',
    };
  } else if (process.env.NODE_ENV !== 'production') {
    if (!devVapid) {
      const keys = generateVapidKeys();
      devVapid = { privateKey: keys.privateKey, subject: 'mailto:dev@localhost' };
    }
    vapid = devVapid;
  } else {
    return res.status(500).json({
      error: 'Missing VAPID_PRIVATE_KEY. Generate one with scripts/generate-vapid-keys.mjs.',
    });
  }

  // ── Authenticate + authorize the caller (server-side, not UI) ───────────
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization bearer token.' });
  }

  const callerRest = new SupabaseRest(supabaseUrl, anonKey, token);
  const ctx = await callerRest.rpc<{ profile_id: string | null; role: string | null }>('current_session_context');
  if (ctx.error || !ctx.data?.profile_id) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
  const role = String(ctx.data.role || '');
  if (role !== 'admin' && role !== 'supervisor') {
    return res.status(403).json({ error: 'Only administrators or supervisors may send teacher notifications.' });
  }

  // ── Validate + send ──────────────────────────────────────────────────────
  const request = (req.body || {}) as any;
  const invalid = validateSendRequest(request);
  if (invalid) return res.status(400).json({ error: invalid });

  const serviceRest = new SupabaseRest(supabaseUrl, serviceKey, serviceKey);
  const db = createSupabaseNotificationDb(serviceRest);

  try {
    const summary = await sendTeacherNotification({
      request,
      senderId: ctx.data.profile_id,
      db,
      vapid,
    });
    return res.status(200).json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notifications/send] failed:', message);
    return res.status(502).json({ error: message, code: 'SEND_FAILED' });
  }
}

export default async function handler(req: any, res: any) {
  try {
    return await handleSend(req, res);
  } catch (err) {
    return sendJsonError(res, err, 'notifications/send');
  }
}
