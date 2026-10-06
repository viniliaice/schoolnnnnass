/**
 * POST /api/push/diagnostics
 * Admin-only inspection of stored teacher Web Push subscriptions. By default
 * this is a dry run. A non-dry-run request performs one real test push per
 * active device. The response never includes endpoint paths or key material.
 */

import { inspectSubscription, summarizeDiagnostics, type DiagnosticAttempt, type SubscriptionDiagnosticRow } from '../../server/lib/pushDiagnostics.js';
import {
  base64UrlDecode,
  derivePublicKeyB64,
  describePushFailure,
  generateVapidKeys,
  sanitizePushResponseText,
  sendWebPush,
  validateVapidConfig,
  type VapidConfig,
} from '../../server/lib/webpush.js';
import { SupabaseRest } from '../../server/lib/supabaseRest.js';

let devVapid: VapidConfig | null = null;

function safeError(res: any, scope: string) {
  try {
    console.error(`[${scope}] unhandled failure`);
  } catch {
    /* logging must not interfere with the JSON response */
  }
  try {
    if (typeof res?.status === 'function' && typeof res?.json === 'function') {
      return res.status(500).json({ error: 'Could not inspect push subscriptions.', code: 'HANDLER_EXCEPTION' });
    }
    res.statusCode = 500;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    if (typeof res.end === 'function') return res.end(JSON.stringify({ error: 'Could not inspect push subscriptions.', code: 'HANDLER_EXCEPTION' }));
  } catch {
    /* best effort */
  }
  return undefined;
}

function getVapidConfig(): VapidConfig {
  if (process.env.VAPID_PRIVATE_KEY) {
    return {
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || (process.env.NODE_ENV !== 'production' ? 'mailto:dev@localhost' : ''),
    };
  }
  if (process.env.NODE_ENV !== 'production') {
    if (!devVapid) {
      const keys = generateVapidKeys();
      devVapid = { privateKey: keys.privateKey, subject: 'mailto:dev@localhost' };
    }
    return devVapid;
  }
  return { privateKey: '', subject: process.env.VAPID_SUBJECT || '' };
}

async function handlerImpl(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: 'Missing required Supabase server environment variables.', code: 'SUPABASE_CONFIG_INVALID' });
  }

  const authHeader = String(req.headers?.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!token) return res.status(401).json({ error: 'Missing Authorization bearer token.' });

  const callerRest = new SupabaseRest(supabaseUrl, anonKey, token);
  const context = await callerRest.rpc<{ profile_id: string | null; role: string | null }>('current_session_context');
  if (context.error || !context.data?.profile_id) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
  const role = String(context.data.role || '');
  if (role !== 'admin' && role !== 'supervisor') {
    return res.status(403).json({ error: 'Only administrators or supervisors may inspect push subscriptions.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const teacherId = typeof body.teacherId === 'string' ? body.teacherId.trim() : '';
  const vapid = getVapidConfig();
  const vapidCheck = validateVapidConfig(vapid);
  const dryRun = body.dryRun !== false || !vapidCheck.ok;

  let publicKeyServable = false;
  try {
    const publicKey = base64UrlDecode(derivePublicKeyB64(vapid));
    publicKeyServable = publicKey.length === 65 && publicKey[0] === 0x04;
  } catch {
    publicKeyServable = false;
  }

  // The service-role key is used only for this bounded read. Caller identity
  // and role are validated above with the anon key + caller bearer token.
  const serviceRest = new SupabaseRest(supabaseUrl, serviceKey, serviceKey);
  const filters = [
    'select=id,user_id,endpoint,p256dh,auth,is_active,device_type,browser,created_at',
    'order=created_at.desc',
    'limit=50',
  ];
  if (teacherId) filters.push(`user_id=eq.${encodeURIComponent(teacherId)}`);
  const result = await serviceRest.select<SubscriptionDiagnosticRow[]>(
    'push_subscriptions',
    filters.join('&'),
  );
  if (result.error) {
    return res.status(500).json({ error: 'Could not read push subscription diagnostics.', code: 'DIAGNOSTICS_READ_FAILED' });
  }

  const rows = result.data || [];
  const inspections = rows.map((row) => inspectSubscription(row));
  const attempts: DiagnosticAttempt[] = [];
  const attemptById = new Map<string, DiagnosticAttempt>();

  if (!dryRun) {
    for (const row of rows) {
      if (row.is_active !== true) continue;
      const inspection = inspectSubscription(row);
      let attempt: DiagnosticAttempt;
      try {
        const pushResult = await sendWebPush({
          endpoint: String(row.endpoint || ''),
          keys: { p256dh: String(row.p256dh || ''), auth: String(row.auth || '') },
          payload: {
            title: 'Push diagnostics test',
            body: 'A test notification from Teacher Notifications.',
            url: '/teacher/notifications',
            category: 'general',
            tag: `push-diagnostics-${Date.now()}`,
          },
          vapid,
        });
        const failure = describePushFailure(pushResult);
        let retired = false;
        let retirementFailed = false;
        if (pushResult.expired) {
          if (!inspection.id) {
            retirementFailed = true;
          } else {
            try {
              const cleanup = await serviceRest.update(
                'push_subscriptions',
                `id=eq.${encodeURIComponent(inspection.id)}&is_active=is.true`,
                { is_active: false },
              );
              retirementFailed = Boolean(cleanup.error);
              retired = !cleanup.error;
            } catch {
              retirementFailed = true;
            }
          }
        }
        attempt = {
          subscriptionId: inspection.id,
          status: pushResult.status,
          ok: pushResult.ok,
          expired: pushResult.expired,
          failureCode: failure.code,
          detail: pushResult.ok ? null : failure.message,
          networkError: pushResult.networkError ? sanitizePushResponseText(pushResult.networkError) : null,
          retired,
          retirementFailed,
        };
      } catch (err) {
        const detail = sanitizePushResponseText(err instanceof Error ? err.message : String(err));
        attempt = {
          subscriptionId: inspection.id,
          status: 0,
          ok: false,
          expired: false,
          failureCode: 'bad_request',
          detail: `push pre-flight validation failed${detail ? ` — ${detail}` : ''}`,
          networkError: null,
        };
      }
      attempts.push(attempt);
      attemptById.set(inspection.id, attempt);
    }
  }

  const summary = summarizeDiagnostics(inspections, attempts, vapidCheck);
  const vapidResponse = {
    ok: vapidCheck.ok,
    subjectValid: vapidCheck.subjectValid,
    subjectScheme: vapidCheck.subjectScheme,
    privateKeyBytes: vapidCheck.privateKeyBytes,
    publicKeyBytes: vapidCheck.publicKeyBytes,
    problems: vapidCheck.problems,
    publicKeyServable,
  };
  const subscriptions = inspections.map((inspection) => {
    const attempt = attemptById.get(inspection.id);
    return {
      ...inspection,
      status: attempt?.status ?? null,
      ok: attempt?.ok ?? null,
      expired: attempt?.expired ?? false,
      retired: attempt?.retired ?? false,
      retirementFailed: attempt?.retirementFailed ?? false,
      failureCode: attempt?.failureCode ?? null,
      detail: attempt?.detail ?? null,
      networkError: attempt?.networkError ?? null,
    };
  });

  const deliveryOk = !dryRun && summary.attempted > 0 && summary.delivered === summary.attempted;
  return res.status(200).json({
    ok: vapidCheck.ok && (dryRun || deliveryOk),
    deliveryOk,
    vapid: vapidResponse,
    dryRun,
    subscriptions,
    summary,
    note: dryRun ? 'Dry run: no push was sent.' : 'A real test push was attempted for each active subscription in this result set (maximum 50 rows).',
  });
}

export default async function handler(req: any, res: any) {
  try {
    return await handlerImpl(req, res);
  } catch {
    return safeError(res, 'push/diagnostics');
  }
}
