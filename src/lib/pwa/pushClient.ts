/**
 * Browser side of the Web Push subscription flow.
 *
 * The VAPID public key is fetched from the server (/api/push/vapid-public-key)
 * so the private key never reaches the browser. The subscription row is stored
 * against the signed-in teacher's existing profile id (profiles.id) — the RLS
 * policies guarantee a user can only write rows with their own user_id.
 */

import { supabase, isPlaceholderEnv } from '../supabase';

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView | null): string {
  if (!buffer) return '';
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesEqual(left: ArrayBuffer | ArrayBufferView | null, right: Uint8Array): boolean {
  if (!left) return false;
  const bytes = ArrayBuffer.isView(left)
    ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    : new Uint8Array(left);
  if (bytes.length !== right.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== right[index]) return false;
  }
  return true;
}

function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).hostname || null;
  } catch {
    return null;
  }
}

function isSyntheticEndpoint(endpoint: string | null | undefined): boolean {
  const host = endpointHost(endpoint)?.toLowerCase().replace(/\.$/, '') ?? '';
  return Boolean(host && (
    host.startsWith('preview.') || host.startsWith('localhost.') || host === 'localhost' ||
    host.startsWith('test.') || host === 'test' || host.startsWith('example.') ||
    host === 'example' || host.endsWith('.local')
  ));
}

function safePushError(error: unknown, sensitiveValues: string[] = []): string {
  let value = error instanceof Error ? error.message : String(error ?? 'Push operation failed.');
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive !== 'string' || sensitive.length === 0) continue;
    value = value.split(sensitive).join('<redacted>');
    try {
      const parsed = new URL(sensitive);
      const tokens = [parsed.href, parsed.pathname];
      for (const segment of parsed.pathname.split('/').filter((part) => part.length >= 8)) {
        tokens.push(segment);
        try { tokens.push(decodeURIComponent(segment)); } catch { /* retain encoded segment */ }
      }
      parsed.searchParams.forEach((part) => { if (part.length >= 8) tokens.push(part); });
      for (const token of new Set(tokens.filter(Boolean))) value = value.split(token).join('<redacted>');
    } catch {
      // A non-URL key/token has already been redacted by the exact-match pass.
    }
  }
  value = value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>');
  value = value.replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>');
  value = value.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try { return `${new URL(match).origin}/<redacted-path>`; } catch { return '<redacted-url>'; }
  });
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function detectDevice(): { deviceType: string; browser: string } {
  if (typeof navigator === 'undefined') return { deviceType: 'unknown', browser: 'unknown' };
  const ua = navigator.userAgent || '';
  let deviceType = 'desktop';
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
    deviceType = /iPad|Tablet/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'tablet'
      : 'mobile';
  }
  let browser = 'other';
  if (/Edg\//.test(ua)) browser = 'edge';
  else if (/OPR\//.test(ua)) browser = 'opera';
  else if (/Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua)) browser = 'safari';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  return { deviceType, browser };
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export type PushPermissionState = NotificationPermission | 'unsupported';

export function currentPermission(): PushPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * A VAPID application server key must be a 65-byte uncompressed P-256 point
 * (base64url, first byte 0x04). Anything else makes
 * pushManager.subscribe() throw "InvalidAccessError" in the browser.
 */
export function isValidVapidPublicKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  let bytes: Uint8Array;
  try {
    bytes = urlBase64ToUint8Array(trimmed);
  } catch {
    return false;
  }
  return bytes.length === 65 && bytes[0] === 0x04;
}

/**
 * The API is the single source of truth. Deliberately ignore
 * VITE_VAPID_PUBLIC_KEY: a stale build-time value silently binds devices to a
 * different application-server key and leads to push-service 401/403 errors.
 */
export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/vapid-public-key');
    if (!res.ok) {
      console.warn(`[push] /api/push/vapid-public-key responded ${res.status}; push stays disabled.`);
      return null;
    }
    const body = (await res.json()) as { publicKey?: string };
    if (!isValidVapidPublicKey(body?.publicKey)) {
      console.warn('[push] /api/push/vapid-public-key returned a malformed public key; push stays disabled.');
      return null;
    }
    return body.publicKey;
  } catch {
    return null;
  }
}

export interface PushSubscriptionState {
  supported: boolean;
  permission: PushPermissionState;
  hasBrowserSubscription: boolean;
  browserKeyMatchesServer: boolean | null;
  /** Hostname only; never return the endpoint's registration-token path. */
  endpointHost: string | null;
  endpointLooksSynthetic: boolean;
}

/** Compare this browser's real subscription key with the current server key. */
export async function getPushSubscriptionState(): Promise<PushSubscriptionState> {
  const supported = pushSupported();
  const permission = currentPermission();
  if (!supported) {
    return { supported, permission, hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null, endpointLooksSynthetic: false };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return { supported, permission, hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null, endpointLooksSynthetic: false };
    }
    const host = endpointHost(subscription.endpoint);
    const endpointLooksSynthetic = isSyntheticEndpoint(subscription.endpoint);
    if (isPlaceholderEnv) {
      return { supported, permission, hasBrowserSubscription: true, browserKeyMatchesServer: endpointLooksSynthetic ? false : null, endpointHost: host, endpointLooksSynthetic };
    }

    const serverKey = await getVapidPublicKey();
    if (!serverKey) {
      return { supported, permission, hasBrowserSubscription: true, browserKeyMatchesServer: endpointLooksSynthetic ? false : null, endpointHost: host, endpointLooksSynthetic };
    }
    const matches = bytesEqual(
      subscription.options?.applicationServerKey ?? null,
      urlBase64ToUint8Array(serverKey),
    );
    return {
      supported,
      permission,
      hasBrowserSubscription: true,
      browserKeyMatchesServer: endpointLooksSynthetic ? false : matches,
      endpointHost: host,
      endpointLooksSynthetic,
    };
  } catch {
    return { supported, permission, hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null, endpointLooksSynthetic: false };
  }
}

export interface EnablePushResult {
  ok: boolean;
  outcome?: 'subscribed' | 'preview-subscribed';
  error?: 'unsupported' | 'denied' | 'not-configured' | 'failed' | string;
}

export interface StoreSubscriptionResult {
  ok: boolean;
  error?: string;
}

/** Store/update one row keyed by the browser endpoint; never hijack another user's row. */
export async function storeSubscription(
  userId: string,
  subscription: PushSubscription,
  deviceType: string,
  browser: string,
): Promise<StoreSubscriptionResult> {
  const endpoint = subscription.endpoint;
  const p256dh = bufferToBase64Url(subscription.getKey('p256dh'));
  const auth = bufferToBase64Url(subscription.getKey('auth'));
  if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Browser subscription is missing required keys.' };

  const { data: existing, error: lookupError } = await supabase
    .from('push_subscriptions')
    .select('id, user_id')
    .eq('endpoint', endpoint)
    .maybeSingle();
  if (lookupError) return { ok: false, error: safePushError(lookupError.message, [endpoint, p256dh, auth]) };

  if (existing && existing.user_id !== userId) {
    return { ok: false, error: 'This browser endpoint is registered to a different account.' };
  }

  const metadata = {
    p256dh,
    auth,
    device_type: deviceType,
    browser,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    is_active: true,
  };
  if (existing) {
    const { error } = await supabase
      .from('push_subscriptions')
      .update(metadata)
      .eq('id', existing.id)
      .eq('user_id', userId);
    if (error) return { ok: false, error: safePushError(error.message, [endpoint, p256dh, auth]) };
    return { ok: true };
  }

  const { error } = await supabase.from('push_subscriptions').insert({
    id: crypto.randomUUID(),
    user_id: userId,
    endpoint,
    ...metadata,
  });
  if (error) return { ok: false, error: safePushError(error.message, [endpoint, p256dh, auth]) };
  return { ok: true };
}

async function removeSubscriptionRow(userId: string, endpoint: string): Promise<string | null> {
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint);
  return error?.message ? safePushError(error.message, [endpoint]) : null;
}

/** Deactivate this user's known preview/test endpoint rows during an explicit re-sync. */
async function deactivateSyntheticSubscriptions(userId: string, keepEndpoint: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) return safePushError(error.message);

  for (const row of (data ?? []) as Array<{ id: string; endpoint: string }>) {
    if (!row.id || row.endpoint === keepEndpoint || !isSyntheticEndpoint(row.endpoint)) continue;
    const { error: updateError } = await supabase
      .from('push_subscriptions')
      .update({ is_active: false })
      .eq('id', row.id)
      .eq('user_id', userId)
      .eq('is_active', true);
    if (updateError) return safePushError(updateError.message, [row.endpoint]);
  }
  return null;
}

function subscriptionMatchesKey(subscription: PushSubscription, vapidKey: string): boolean {
  return bytesEqual(
    subscription.options?.applicationServerKey ?? null,
    urlBase64ToUint8Array(vapidKey),
  );
}

/** Subscribe using the current server key, retiring a stale browser binding first. */
export async function subscribeDevice(userId: string, vapidKey: string): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, error: 'unsupported' };
  if (!isValidVapidPublicKey(vapidKey)) return { ok: false, error: 'not-configured' };

  let previousEndpoint: string | undefined;
  try {
    const registration = await navigator.serviceWorker.ready;
    const current = await registration.pushManager.getSubscription();
    if (current) previousEndpoint = current.endpoint;
    if (current && subscriptionMatchesKey(current, vapidKey) && !isSyntheticEndpoint(current.endpoint)) {
      const { deviceType, browser } = detectDevice();
      const stored = await storeSubscription(userId, current, deviceType, browser);
      if (!stored.ok) return { ok: false, error: stored.error || 'failed' };
      const cleanupError = await deactivateSyntheticSubscriptions(userId, current.endpoint);
      return cleanupError
        ? { ok: false, error: cleanupError }
        : { ok: true, outcome: 'subscribed' };
    }

    if (current) {
      const endpoint = current.endpoint;
      // Unsubscribe the stale VAPID binding, and remove only this endpoint's
      // row for this account. Other devices and other users are untouched.
      await current.unsubscribe();
      const deleteError = await removeSubscriptionRow(userId, endpoint);
      if (deleteError) return { ok: false, error: deleteError };
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
    });
    const { deviceType, browser } = detectDevice();
    const stored = await storeSubscription(userId, subscription, deviceType, browser);
    if (!stored.ok) return { ok: false, error: stored.error || 'failed' };
    const cleanupError = await deactivateSyntheticSubscriptions(userId, subscription.endpoint);
    return cleanupError
      ? { ok: false, error: cleanupError }
      : { ok: true, outcome: 'subscribed' };
  } catch (err) {
    return { ok: false, error: safePushError(err, previousEndpoint ? [previousEndpoint] : []) || 'failed' };
  }
}

/**
 * Request permission (caller should only invoke this from an explicit user
 * action), subscribe the device, and store the subscription for `userId`.
 */
export async function enablePush(userId: string): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, error: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, error: 'denied' };

  const { deviceType, browser } = detectDevice();

  if (isPlaceholderEnv) {
    // Preview mode (no real backend): synthesize a well-formed placeholder row
    // only so the mock UI can demonstrate the registration flow.
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const rawPublic = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
    const authBytes = crypto.getRandomValues(new Uint8Array(16));
    const endpoint = `https://preview.push.local/subscribe/${crypto.randomUUID()}`;
    const { error } = await supabase.from('push_subscriptions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      endpoint,
      p256dh: bufferToBase64Url(rawPublic),
      auth: bufferToBase64Url(authBytes),
      device_type: deviceType,
      browser,
      user_agent: navigator.userAgent,
      is_active: true,
    });
    if (error) return { ok: false, error: safePushError(error.message) };
    return { ok: true, outcome: 'preview-subscribed' };
  }

  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, error: 'not-configured' };
  return subscribeDevice(userId, vapidKey);
}

export type ResyncPushAction = 'reused' | 'resubscribed' | 'none' | 'failed';

export interface ResyncPushResult {
  ok: boolean;
  action: ResyncPushAction;
  error?: string;
}

/** Reuse a healthy subscription or repair stale-key, missing, and synthetic registrations. */
export async function resyncPushSubscription(userId: string): Promise<ResyncPushResult> {
  if (!pushSupported() || isPlaceholderEnv || currentPermission() !== 'granted') {
    return { ok: false, action: 'none' };
  }
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, action: 'failed', error: 'not-configured' };

  let currentEndpoint: string | undefined;
  try {
    const registration = await navigator.serviceWorker.ready;
    const current = await registration.pushManager.getSubscription();
    if (current) currentEndpoint = current.endpoint;
    if (current && subscriptionMatchesKey(current, vapidKey) && !isSyntheticEndpoint(current.endpoint)) {
      const { deviceType, browser } = detectDevice();
      const stored = await storeSubscription(userId, current, deviceType, browser);
      if (!stored.ok) return { ok: false, action: 'failed', error: stored.error || 'failed' };
      const cleanupError = await deactivateSyntheticSubscriptions(userId, current.endpoint);
      return cleanupError
        ? { ok: false, action: 'failed', error: cleanupError }
        : { ok: true, action: 'reused' };
    }

    const result = await subscribeDevice(userId, vapidKey);
    return result.ok
      ? { ok: true, action: 'resubscribed' }
      : { ok: false, action: 'failed', error: result.error || 'failed' };
  } catch (err) {
    return { ok: false, action: 'failed', error: safePushError(err, currentEndpoint ? [currentEndpoint] : []) || 'failed' };
  }
}

/** Unsubscribe this device's browser subscription (does not touch other devices). */
export async function unsubscribeCurrentDevice(userId: string): Promise<void> {
  let browserSubscriptionWasReadable = false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    browserSubscriptionWasReadable = true;
    if (!subscription) return;

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    const error = await removeSubscriptionRow(userId, endpoint);
    if (error) console.warn('[push] could not remove this device subscription row.');
    return;
  } catch {
    // Only use broad per-user cleanup if the browser could not be queried at
    // all. A successful "no subscription" read must not delete other devices.
  }
  if (!browserSubscriptionWasReadable) {
    await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  }
}
