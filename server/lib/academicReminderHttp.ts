import { timingSafeEqual } from 'node:crypto';
import { sanitizePushResponseText } from './webpush.js';
import { resolveVapidConfig } from './notificationRuntime.js';
import { SupabaseRest } from './supabaseRest.js';

export interface ServerSupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
}

export interface ServerSupabaseServiceConfig {
  url: string;
  serviceKey: string;
}

export function readServerSupabaseServiceConfig(): ServerSupabaseServiceConfig | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceKey ? { url, serviceKey } : null;
}

export function readServerSupabaseConfig(): ServerSupabaseConfig | null {
  const base = readServerSupabaseServiceConfig();
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  return base && anonKey ? { ...base, anonKey } : null;
}

/** Reminder endpoints share the existing notification sender's VAPID resolver. */
export const resolveAcademicReminderVapid = resolveVapidConfig;

export function bearerTokenFromRequest(req: any): string | null {
  const value = String(req?.headers?.authorization ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() || null : null;
}

export type AuthenticatedServerProfile = {
  profileId: string;
  role: string;
  token: string;
  callerRest: SupabaseRest;
  serviceRest: SupabaseRest;
};

export type ServerAuthResult =
  | { ok: true; profile: AuthenticatedServerProfile }
  | { ok: false; status: 401 | 500; message: string };

export async function authenticateServerProfile(req: any): Promise<ServerAuthResult> {
  const config = readServerSupabaseConfig();
  if (!config) {
    return { ok: false, status: 500, message: 'Supabase server environment is incomplete.' };
  }
  const token = bearerTokenFromRequest(req);
  if (!token) return { ok: false, status: 401, message: 'Missing Authorization bearer token.' };
  const callerRest = new SupabaseRest(config.url, config.anonKey, token);
  const session = await callerRest.rpc<{ profile_id: string | null; role: string | null }>('current_session_context');
  if (session.error || !session.data?.profile_id || !session.data.role) {
    return { ok: false, status: 401, message: 'Invalid or expired session token.' };
  }
  return {
    ok: true,
    profile: {
      profileId: session.data.profile_id,
      role: String(session.data.role),
      token,
      callerRest,
      serviceRest: new SupabaseRest(config.url, config.serviceKey, config.serviceKey),
    },
  };
}

export function parseJsonBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return body == null ? {} : null;
}

export function isAdminOrSupervisor(role: string): boolean {
  return role === 'admin' || role === 'supervisor';
}

export function cronAuthorizationMatches(req: any): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const authorization = String(req?.headers?.authorization ?? '');
  const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const secretBytes = Buffer.from(secret);
  if (candidateBytes.length !== secretBytes.length) return false;
  return timingSafeEqual(candidateBytes, secretBytes);
}

export function safeInternalError(err: unknown): string {
  return sanitizePushResponseText(err instanceof Error ? err.message : String(err), 180);
}
