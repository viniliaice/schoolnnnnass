/**
 * PWA install-prompt state machine.
 *
 * Behaviour rules (from the product spec):
 *  - never re-nag after a dismissal: a dismissal is remembered for 7 days;
 *  - never show the prompt again once installed (standalone display mode);
 *  - when the browser has no install API (iOS Safari), expose instructions
 *    instead of a dead button.
 */

import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'mbk-install-dismissed-at';
const INSTALLED_KEY = 'mbk-app-installed';
export const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  subscribers.forEach((fn) => fn());
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Must preventDefault to be able to trigger the prompt later from our
    // own "Install App" button.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    try {
      localStorage.setItem(INSTALLED_KEY, '1');
    } catch {
      /* private mode */
    }
    emit();
  });
}

/** True when running as an installed app (PWA window / iOS home screen). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    window.matchMedia?.('(display-mode: window-controls-overlay)')?.matches === true ||
    nav.standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOS13Plus;
}

export function wasInstalledPreviously(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function installDismissedRecently(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && now - at < INSTALL_DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export function dismissInstall(now: number = Date.now()): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(now));
  } catch {
    /* ignore */
  }
  emit();
}

export function hasNativeInstallPrompt(): boolean {
  return deferredPrompt !== null;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export async function triggerInstallPrompt(): Promise<InstallOutcome> {
  if (!deferredPrompt) return 'unavailable';
  const prompt = deferredPrompt;
  deferredPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  emit();
  return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
}

export interface PwaInstallState {
  installed: boolean;
  canPrompt: boolean;
  ios: boolean;
  dismissed: boolean;
  /** Show the install affordance at all (not installed & not recently dismissed). */
  shouldShow: boolean;
}

export function usePwaInstall(): PwaInstallState & {
  promptInstall: () => Promise<InstallOutcome>;
  dismiss: () => void;
} {
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    subscribers.add(refresh);
    return () => {
      subscribers.delete(refresh);
    };
  }, []);

  const installed = isStandalone() || wasInstalledPreviously();
  const ios = isIOS();
  const canPrompt = hasNativeInstallPrompt();
  const dismissed = installDismissedRecently();
  const shouldShow = !installed && !dismissed && (canPrompt || ios);

  const promptInstall = useCallback(() => triggerInstallPrompt(), []);
  const dismiss = useCallback(() => dismissInstall(), []);

  return { installed, canPrompt, ios, dismissed, shouldShow, promptInstall, dismiss };
}

// Referenced for tests/devtools parity.
void version;
