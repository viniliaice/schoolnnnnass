/**
 * Service worker registration + safe update flow + notification-click
 * navigation bridge.
 *
 * Update UX: when a new worker is installed while an old one controls the
 * page, we dispatch SW_UPDATE_EVENT and the UpdateBanner shows
 * "New version available — Update Now". Tapping Update Now posts
 * SKIP_WAITING; the reload happens on controllerchange. Users who ignore the
 * banner still pick up the new worker on their next cold start (they are
 * never force-reloaded mid-session).
 */

import { requestNavigation } from './navigationBus';

export const SW_UPDATE_EVENT = 'mbk-sw-update-available';

let updateReady = false;
let started = false;

// The worker broadcasts push events on the 'mbk-pwa' channel; relay them to a
// window event so any page (e.g. the notification history) can refresh.
if (typeof window !== 'undefined' && 'BroadcastChannel' in window && !(import.meta as any).env?.VITEST) {
  const channel = new BroadcastChannel('mbk-pwa');
  channel.addEventListener('message', (event: MessageEvent) => {
    window.dispatchEvent(new CustomEvent('mbk-pwa-event', { detail: event.data }));
  });
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if ((import.meta as any).env?.VITEST) return;
  if (started) return;
  started = true;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        watchForUpdates(registration);
      })
      .catch((err) => {
        console.warn('[pwa] service worker registration failed:', err);
      });

    // Notification clicks on an open window arrive as NAVIGATE messages.
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: string } | undefined;
      if (data && data.type === 'NAVIGATE' && typeof data.path === 'string') {
        requestNavigation(data.path);
      }
    });
  });

  // Only reload when a *new* worker we explicitly activated takes control.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateReady) return;
    window.location.reload();
  });
}

function watchForUpdates(registration: ServiceWorkerRegistration): void {
  const announceWaiting = () => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      updateReady = true;
      window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT, { detail: { registration } }));
    }
  };

  // A waiting worker may already exist when we get here (e.g. tab reopened
  // after a deploy).
  announceWaiting();

  registration.addEventListener('updatefound', () => {
    const incoming = registration.installing;
    if (!incoming) return;
    incoming.addEventListener('statechange', () => {
      if (incoming.state === 'installed') announceWaiting();
    });
  });

  // Check for new deploys periodically so long-open teacher sessions notice.
  window.setInterval(() => {
    registration.update().catch(() => undefined);
  }, 60 * 60 * 1000);
}

/** Called by the UpdateBanner's "Update Now" button. */
export function applyServiceWorkerUpdate(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration?.waiting) {
      updateReady = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  });
}
