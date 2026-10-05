import { useCallback, useEffect, useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { currentPermission, enablePush, pushSupported } from '../../lib/pwa/pushClient';

const DENIED_KEY = 'mbk-notifications-dismissed-at';
const DISMISS_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function dismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DENIED_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Friendly in-app prompt for push notifications. The browser permission
 * request ONLY fires from the "Enable Notifications" button — never on page
 * load. Handles granted / denied / default / unsupported / failure states.
 */
export function EnableNotificationsCard({
  subscribed,
  onSubscribed,
}: {
  /** True when the caller knows this device already has an active subscription. */
  subscribed: boolean;
  onSubscribed?: () => void;
}) {
  const { user } = useRole();
  const { addToast } = useToast();
  const [permission, setPermission] = useState<string>(currentPermission());
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedRecently());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setPermission(currentPermission());
  }, [subscribed]);

  const handleEnable = useCallback(async () => {
    if (!user || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await enablePush(user.id);
    setBusy(false);
    setPermission(currentPermission());

    if (result.ok) {
      addToast({ type: 'success', title: 'Notifications enabled', description: 'This device will receive school announcements.' });
      onSubscribed?.();
      return;
    }

    switch (result.error) {
      case 'denied':
        setMessage('Notifications are blocked. Allow them in your browser’s site settings, then try again.');
        break;
      case 'unsupported':
        setMessage('This browser does not support push notifications.');
        break;
      case 'not-configured':
        setMessage('Push is not configured on the server yet (VAPID keys missing). Contact your administrator.');
        break;
      default:
        setMessage(`Could not enable notifications (${result.error}). Please try again.`);
    }
  }, [user, busy, addToast, onSubscribed]);

  if (!pushSupported()) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        This browser does not support push notifications.
      </div>
    );
  }

  if (subscribed && permission === 'granted') {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <BellRing className="h-4 w-4 shrink-0" /> Push notifications are ON for this device.
      </div>
    );
  }

  if (permission === 'denied') {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <BellOff className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Notifications are blocked for this site. To receive school announcements, allow notifications for
          this site in your browser settings, then reload.
        </span>
      </div>
    );
  }

  if (dismissed) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="enable-notifications-card">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white">
          <BellRing className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-slate-900">Enable Notifications</h3>
          <p className="mt-1 text-sm text-slate-500">
            Get important school announcements, lesson-plan reminders, messages and administrative updates
            directly on your device.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleEnable}
              disabled={busy}
              className="min-h-11 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:opacity-60"
            >
              {busy ? 'Enabling…' : 'Enable Notifications'}
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.setItem(DENIED_KEY, String(Date.now()));
                } catch {
                  /* ignore */
                }
                setDismissed(true);
              }}
              className="min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
            >
              Not Now
            </button>
          </div>
          {message && <p className="mt-2 text-xs text-rose-600">{message}</p>}
        </div>
      </div>
    </div>
  );
}
