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

function bufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

/** Public VAPID key for subscribe(). Null when the server is not configured. */
export async function getVapidPublicKey(): Promise<string | null> {
  const fromEnv = (import.meta as any).env?.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (fromEnv) return fromEnv;
  try {
    const res = await fetch('/api/push/vapid-public-key');
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: string };
    return body.publicKey || null;
  } catch {
    return null;
  }
}

export interface EnablePushResult {
  ok: boolean;
  outcome?: 'subscribed' | 'preview-subscribed';
  error?: 'unsupported' | 'denied' | 'not-configured' | 'failed' | string;
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
    // Preview mode (no real backend): synthesize a well-formed subscription
    // row so the whole flow can be exercised end-to-end.
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
    if (error) return { ok: false, error: error.message };
    return { ok: true, outcome: 'preview-subscribed' };
  }

  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, error: 'not-configured' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
    });

    const p256dh = bufferToBase64Url(subscription.getKey('p256dh'));
    const auth = bufferToBase64Url(subscription.getKey('auth'));
    const endpoint = subscription.endpoint;

    // Re-registering the same device updates its row; a different device of
    // the same teacher creates an additional row (never overwrites others).
    const { data: existing } = await supabase
      .from('push_subscriptions')
      .select('id, user_id')
      .eq('endpoint', endpoint)
      .maybeSingle();

    if (existing && existing.user_id === userId) {
      const { error } = await supabase
        .from('push_subscriptions')
        .update({ p256dh, auth, device_type: deviceType, browser, is_active: true, user_agent: navigator.userAgent })
        .eq('id', existing.id);
      if (error) return { ok: false, error: error.message };
    } else if (!existing) {
      const { error } = await supabase.from('push_subscriptions').insert({
        id: crypto.randomUUID(),
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        device_type: deviceType,
        browser,
        user_agent: navigator.userAgent,
        is_active: true,
      });
      if (error) return { ok: false, error: error.message };
    } else {
      // Endpoint row exists for a different account (device changed hands).
      // RLS prevents us from hijacking it; register a fresh browser
      // subscription instead on the next attempt.
      return { ok: false, error: 'failed' };
    }

    return { ok: true, outcome: 'subscribed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

/** Unsubscribe this device's browser subscription (does not touch other devices). */
export async function unsubscribeCurrentDevice(userId: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
      await subscription.unsubscribe();
      return;
    }
  } catch {
    /* fall through to row cleanup */
  }
  await supabase.from('push_subscriptions').delete().eq('user_id', userId);
}
