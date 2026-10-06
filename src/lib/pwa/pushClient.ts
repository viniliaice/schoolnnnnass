/**
 * Browser side of the Web Push subscription flow.
 *
 * The server endpoint is the single source of truth for the current VAPID
 * public key. Subscriptions are stored by endpoint and always scoped to the
 * signed-in profile id; a stale key is retired only for this browser endpoint.
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

function bufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesFromBufferSource(value: ArrayBuffer | ArrayBufferView | null): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function endpointHostname(endpoint: string | null | undefined): string | null {
  try {
    return endpoint ? new URL(endpoint).hostname : null;
  } catch {
    return null;
  }
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

/** A VAPID application server key is a base64url 65-byte P-256 point. */
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

/** Fetch the current server key; do not trust a baked key across rotations. */
export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
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
  /** null means the server key or browser applicationServerKey could not be read. */
  browserKeyMatchesServer: boolean | null;
  endpointHost: string | null;
}

/** Compare this browser's actual subscription key with the key served by the API. */
export async function getPushSubscriptionState(): Promise<PushSubscriptionState> {
  const supported = pushSupported();
  const permission = currentPermission();
  if (!supported) {
    return { supported: false, permission: 'unsupported', hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return { supported, permission, hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null };
    }

    const serverKey = await getVapidPublicKey();
    const browserKey = bytesFromBufferSource(subscription.options.applicationServerKey);
    let browserKeyMatchesServer: boolean | null = null;
    if (serverKey && browserKey) {
      browserKeyMatchesServer = equalBytes(browserKey, urlBase64ToUint8Array(serverKey));
    }
    return {
      supported,
      permission,
      hasBrowserSubscription: true,
      browserKeyMatchesServer,
      endpointHost: endpointHostname(subscription.endpoint),
    };
  } catch {
    return { supported, permission, hasBrowserSubscription: false, browserKeyMatchesServer: null, endpointHost: null };
  }
}

export interface EnablePushResult {
  ok: boolean;
  outcome?: 'subscribed' | 'resubscribed' | 'preview-subscribed';
  error?: 'unsupported' | 'denied' | 'not-configured' | 'failed' | string;
}

export interface ResyncPushResult {
  ok: boolean;
  action: 'reused' | 'resubscribed' | 'none' | 'failed';
  error?: string;
}

interface StoreSubscriptionResult {
  ok: boolean;
  retired?: boolean;
  error?: string;
}

/**
 * Upsert one device row by endpoint without duplicating rows or taking over a
 * row belonging to another profile. RLS remains the authority for ownership.
 */
export async function storeSubscription(
  userId: string,
  subscription: PushSubscription,
  deviceType: string,
  browser: string,
  allowReactivation = false,
): Promise<StoreSubscriptionResult> {
  const endpoint = subscription.endpoint;
  const p256dh = bufferToBase64Url(subscription.getKey('p256dh'));
  const auth = bufferToBase64Url(subscription.getKey('auth'));
  if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Subscription is missing endpoint or key material.' };

  const { data: existing, error: lookupError } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, is_active')
    .eq('endpoint', endpoint)
    .maybeSingle();
  if (lookupError) return { ok: false, error: 'Could not check this device subscription.' };

  const values = {
    p256dh,
    auth,
    device_type: deviceType,
    browser,
    user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    is_active: true,
  };
  if (existing) {
    if (existing.user_id !== userId) return { ok: false, error: 'This device subscription belongs to a different account.' };
    if (existing.is_active === false && !allowReactivation) {
      return { ok: false, retired: true, error: 'This registration was retired by the push service.' };
    }
    const { error } = await supabase
      .from('push_subscriptions')
      .update(values)
      .eq('id', existing.id)
      .eq('user_id', userId);
    return error ? { ok: false, error: 'Could not update this device subscription.' } : { ok: true };
  }

  const { error } = await supabase.from('push_subscriptions').insert({
    id: crypto.randomUUID(),
    user_id: userId,
    endpoint,
    ...values,
  });
  return error ? { ok: false, error: 'Could not save this device subscription.' } : { ok: true };
}

async function deleteEndpointRow(userId: string, endpoint: string): Promise<string | null> {
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint);
  return error ? 'Could not remove the previous device subscription.' : null;
}

async function subscribeDevice(userId: string, vapidKey: string): Promise<ResyncPushResult> {
  try {
    const registration = await navigator.serviceWorker.ready;
    let existing = await registration.pushManager.getSubscription();
    if (existing) {
      const storedKey = bytesFromBufferSource(existing.options.applicationServerKey);
      const desiredKey = urlBase64ToUint8Array(vapidKey);
      if (equalBytes(storedKey, desiredKey)) {
        const { deviceType, browser } = detectDevice();
        const stored = await storeSubscription(userId, existing, deviceType, browser);
        if (stored.ok) return { ok: true, action: 'reused' };
        if (!stored.retired) return { ok: false, action: 'failed', error: stored.error };
      }

      // A key mismatch or a row previously retired after 404/410 means the
      // browser endpoint must be replaced, not simply reactivated in the DB.
      const staleEndpoint = existing.endpoint;
      const unsubscribed = await existing.unsubscribe();
      if (!unsubscribed) return { ok: false, action: 'failed', error: 'Could not retire the old push registration.' };
      const deleteError = await deleteEndpointRow(userId, staleEndpoint);
      if (deleteError) return { ok: false, action: 'failed', error: deleteError };
      existing = null;
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
    });
    const { deviceType, browser } = detectDevice();
    const stored = await storeSubscription(userId, subscription, deviceType, browser, true);
    if (!stored.ok) {
      await subscription.unsubscribe().catch(() => false);
      return { ok: false, action: 'failed', error: stored.error };
    }
    return { ok: true, action: 'resubscribed' };
  } catch (err) {
    return { ok: false, action: 'failed', error: 'Could not subscribe this device. Please try again.' };
  }
}

/** Request permission (only from an explicit user action), subscribe, and store. */
export async function enablePush(userId: string): Promise<EnablePushResult> {
  try {
    if (!pushSupported()) return { ok: false, error: 'unsupported' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: 'denied' };

    const { deviceType, browser } = detectDevice();
    if (isPlaceholderEnv) {
      // Preview mode only: this deliberately fake endpoint is never a real device.
      const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const rawPublic = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
      const authBytes = crypto.getRandomValues(new Uint8Array(16));
      const endpoint = `https://preview.push.local/subscribe/${crypto.randomUUID()}`;
      const { error } = await supabase.from('push_subscriptions').insert({
        id: crypto.randomUUID(),
        user_id: userId,
        endpoint,
        p256dh: bufferToBase64Url(rawPublic),
        auth: bufferToBase64Url(authBytes.buffer),
        device_type: deviceType,
        browser,
        user_agent: navigator.userAgent,
        is_active: true,
      });
      if (error) return { ok: false, error: 'Could not save this preview subscription.' };
      return { ok: true, outcome: 'preview-subscribed' };
    }

    const vapidKey = await getVapidPublicKey();
    if (!vapidKey) return { ok: false, error: 'not-configured' };
    const result = await subscribeDevice(userId, vapidKey);
    return result.ok
      ? { ok: true, outcome: result.action === 'reused' ? 'subscribed' : 'resubscribed' }
      : { ok: false, error: result.error || 'failed' };
  } catch {
    return { ok: false, error: 'Could not enable notifications. Please try again.' };
  }
}

/**
 * Self-healing check used by the teacher UI. It does not prompt for permission
 * and is a no-op in placeholder/preview environments.
 */
export async function resyncPushSubscription(userId: string): Promise<ResyncPushResult> {
  if (!pushSupported() || isPlaceholderEnv || currentPermission() !== 'granted') {
    return { ok: false, action: 'none' };
  }
  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, action: 'failed', error: 'Could not load the current server push key.' };
  return subscribeDevice(userId, vapidKey);
}

/** Unsubscribe and delete only this browser's row (never other devices). */
export async function unsubscribeCurrentDevice(userId: string): Promise<void> {
  let endpoint: string | null = null;
  let subscriptionRead = false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    subscriptionRead = true;
    if (subscription) {
      endpoint = subscription.endpoint;
      await subscription.unsubscribe().catch(() => false);
    }
  } catch {
    // Only an unreadable browser subscription justifies broad user-row cleanup.
  }

  if (endpoint) {
    await deleteEndpointRow(userId, endpoint);
  } else if (!subscriptionRead) {
    await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  }
}
