/**
 * POST /api/push/diagnostics
 *
 * Admin/supervisor-only, redacted push-subscription inspection. Dry-run is
 * the default; a real per-device diagnostic push is sent only when requested
 * and VAPID configuration is valid. The service-role client is read-only.
 */

import { inspectSubscription, isSyntheticPushEndpoint, summarizeDiagnostics, type DiagnosticPushAttempt } from '../../server/lib/pushDiagnostics.js';
import { SupabaseRest } from '../../server/lib/supabaseRest.js';
import {
  base64UrlDecode,
  derivePublicKeyB64,
  describePushFailure,
  sanitizePushResponseText,
  sendWebPush,
  validateVapidConfig,
  type PushFailureCode,
  type VapidConfig,
} from '../../server/lib/webpush.js';

interface StoredSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  is_active: boolean;
  device_type?: string | null;
  browser?: string | null;
  created_at?: string | null;
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return body == null ? {} : null;
}

function getVapidConfig(): VapidConfig {
  return {
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || '',
  };
}

function publicKeyServable(vapid: VapidConfig): boolean {
  try {
    const publicKey = derivePublicKeyB64(vapid);
    const raw = base64UrlDecode(publicKey);
    return raw.length === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

function jsonError(res: any, status: number, error: string, code?: string) {
  return res.status(status).json({ error, ...(code ? { code } : {}) });
}

async function handleDiagnostics(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonError(res, 405, 'Method Not Allowed');
  }

  const body = parseBody(req.body);
  if (!body) return jsonError(res, 400, 'Request body must be a JSON object.');
  const teacherId = body.teacherId;
  if (teacherId !== undefined && (typeof teacherId !== 'string' || !teacherId.trim() || teacherId.length > 200)) {
    return jsonError(res, 400, 'teacherId must be a non-empty string.');
  }

  const vapid = getVapidConfig();
  const vapidCheck = validateVapidConfig(vapid);
  const requestedDryRun = typeof body.dryRun === 'boolean' ? body.dryRun : true;
  const forcedDryRun = !vapidCheck.ok;
  const dryRun = requestedDryRun || forcedDryRun;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError(res, 500, 'Push diagnostics are not configured (Supabase server environment is incomplete).', 'DIAGNOSTICS_CONFIG_INVALID');
  }

  const authHeader = String(req.headers?.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!token) return jsonError(res, 401, 'Missing Authorization bearer token.');

  const callerRest = new SupabaseRest(supabaseUrl, anonKey, token);
  const ctx = await callerRest.rpc<{ profile_id: string | null; role: string | null }>('current_session_context');
  if (ctx.error || !ctx.data?.profile_id) return jsonError(res, 401, 'Invalid or expired session token.');
  const role = String(ctx.data.role || '');
  if (role !== 'admin' && role !== 'supervisor') {
    return jsonError(res, 403, 'Only administrators or supervisors may inspect push diagnostics.');
  }

  const serviceRest = new SupabaseRest(supabaseUrl, serviceKey, serviceKey);
  const teacherFilter = typeof teacherId === 'string'
    ? `&user_id=eq.${encodeURIComponent(teacherId.trim())}`
    : '';
  const selected = await serviceRest.select<StoredSubscription[]>(
    'push_subscriptions',
    `select=id,user_id,endpoint,p256dh,auth,is_active,device_type,browser,created_at&order=created_at.desc&limit=50${teacherFilter}`,
  );
  if (selected.error) {
    console.error('[push/diagnostics] subscription read failed:', sanitizePushResponseText(selected.error.message, 180));
    return jsonError(res, 502, 'Could not read push subscriptions for diagnostics.', 'DIAGNOSTICS_READ_FAILED');
  }

  const rows = selected.data ?? [];
  const inspections = rows.map((row) => inspectSubscription(row));
  const subscriptions = rows.map((row, index) => ({ ...inspections[index], push: null as null | {
    status: number;
    ok: boolean;
    expired: boolean;
    failureCode: PushFailureCode;
    detail: string;
    networkError: string | null;
  } }));
  const attempts: DiagnosticPushAttempt[] = [];

  if (!dryRun) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.is_active || isSyntheticPushEndpoint(row.endpoint)) continue;
      try {
        const result = await sendWebPush({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
          payload: {
            title: 'Push diagnostic test',
            body: 'This is a test notification from Teacher Notifications.',
            url: '/teacher/notifications',
            category: 'general',
            tag: `push-diagnostic-${Date.now()}`,
          },
          vapid,
        });
        const failure = result.ok
          ? { code: 'ok' as const, message: '' }
          : describePushFailure(result, row.endpoint);
        const attempt: DiagnosticPushAttempt = {
          subscriptionId: row.id,
          userId: row.user_id,
          status: result.status,
          ok: result.ok,
          expired: result.expired,
          failureCode: failure.code,
          networkError: result.networkError ? sanitizePushResponseText(result.networkError, 200, [row.endpoint]) : null,
        };
        attempts.push(attempt);
        subscriptions[index].push = {
          status: result.status,
          ok: result.ok,
          expired: result.expired,
          failureCode: failure.code,
          detail: sanitizePushResponseText(result.responseText || failure.message, 200, [row.endpoint]),
          networkError: attempt.networkError ?? null,
        };
      } catch (err) {
        const detail = sanitizePushResponseText(err instanceof Error ? err.message : String(err), 200, [row.endpoint]);
        const attempt: DiagnosticPushAttempt = {
          subscriptionId: row.id,
          userId: row.user_id,
          status: 0,
          ok: false,
          expired: false,
          failureCode: 'bad_request',
          networkError: null,
        };
        attempts.push(attempt);
        subscriptions[index].push = {
          status: 0,
          ok: false,
          expired: false,
          failureCode: 'bad_request',
          detail: detail || 'Push could not be prepared from the stored subscription.',
          networkError: null,
        };
      }
    }
  }

  const summary = summarizeDiagnostics(inspections, attempts, vapidCheck);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: vapidCheck.ok && (dryRun || summary.delivered > 0),
    vapid: {
      ok: vapidCheck.ok,
      subjectValid: vapidCheck.subjectValid,
      subjectScheme: vapidCheck.subjectScheme,
      privateKeyBytes: vapidCheck.privateKeyBytes,
      publicKeyBytes: vapidCheck.publicKeyBytes,
      problems: vapidCheck.problems,
      publicKeyServable: publicKeyServable(vapid),
    },
    dryRun,
    subscriptions,
    summary,
    note: forcedDryRun
      ? 'Real test push was disabled because VAPID configuration is invalid.'
      : dryRun
        ? 'No test push was sent.'
        : 'Test push attempted for each active subscription; acceptance by the push service does not guarantee the OS displayed it.',
  });
}

export default async function handler(req: any, res: any) {
  try {
    return await handleDiagnostics(req, res);
  } catch (err) {
    const detail = sanitizePushResponseText(err instanceof Error ? err.message : String(err), 180);
    console.error('[push/diagnostics] failed:', detail || 'unknown error');
    return jsonError(res, 500, 'Push diagnostics could not be completed.', 'DIAGNOSTICS_FAILED');
  }
}
