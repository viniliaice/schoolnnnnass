import { useCallback, useEffect, useState } from 'react';
import { BellRing, RefreshCw, Smartphone, Laptop, Tablet, Trash2 } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { EnableNotificationsCard } from '../../components/pwa/EnableNotificationsCard';
import { InstallAppCard } from '../../components/pwa/InstallAppCard';
import {
  getMyNotifications,
  getMyPreferences,
  listMyDevices,
  markMyNotificationsRead,
  removeDevice,
  saveMyPreferences,
  type MyDevice,
  type MyNotification,
  type NotificationPrefs,
} from '../../lib/db/notifications';
import { timeAgo } from '../../utils/timeAgo';
import { navigateApp } from '../../lib/pwa/appNavigate';

/**
 * Teacher notification centre: enable push, manage per-category settings,
 * see registered devices and read the notification history. All data access
 * is RLS-scoped to the signed-in teacher.
 */
export function TeacherNotifications() {
  const { user } = useRole();
  const { addToast } = useToast();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [devices, setDevices] = useState<MyDevice[]>([]);
  const [items, setItems] = useState<MyNotification[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [prefsRow, deviceRows, history] = await Promise.all([
        getMyPreferences(user.id),
        listMyDevices(user.id),
        getMyNotifications(user.id),
      ]);
      setPrefs(prefsRow);
      setDevices(deviceRows);
      setItems(history);
      setSubscribed(deviceRows.some((d) => d.is_active));
      // Mark as read after rendering the unread state briefly is complex;
      // instead mark read once we've fetched (dots reflect the fetch).
      if (history.some((h) => !h.read_at)) {
        await markMyNotificationsRead(user.id);
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Notifications unavailable',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [user, addToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live refresh when a push arrives while the app is open.
  useEffect(() => {
    const onPush = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string } | undefined;
      if (detail?.type === 'PUSH_RECEIVED') refresh();
    };
    const onFocus = () => refresh();
    window.addEventListener('mbk-pwa-event', onPush);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('mbk-pwa-event', onPush);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const togglePref = async (key: keyof NotificationPrefs) => {
    if (!user || !prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    if (key !== 'push_enabled' && !next.push_enabled) {
      // Master switch off means off; keep category toggles independent.
    }
    setPrefs(next);
    try {
      await saveMyPreferences(user.id, next);
    } catch (err) {
      setPrefs(prefs);
      addToast({ type: 'error', title: 'Could not save settings', description: String(err) });
    }
  };

  const handleRemoveDevice = async (device: MyDevice) => {
    if (!user) return;
    try {
      await removeDevice(user.id, device.id);
      addToast({ type: 'success', title: 'Device removed' });
      refresh();
    } catch (err) {
      addToast({ type: 'error', title: 'Could not remove device', description: String(err) });
    }
  };

  const prefRows: { key: keyof NotificationPrefs; label: string }[] = [
    { key: 'push_enabled', label: 'Push Notifications' },
    { key: 'announcements', label: 'School Announcements' },
    { key: 'messages', label: 'Messages' },
    { key: 'lesson_plan_reminders', label: 'Lesson Plan Reminders' },
    { key: 'marks_entry_reminders', label: 'Marks Entry Reminders' },
    { key: 'admin_alerts', label: 'Administrative Alerts' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Notifications</h1>
        <p className="mt-1 text-slate-500">Push notifications, preferences, devices and history.</p>
      </div>

      <EnableNotificationsCard subscribed={subscribed} onSubscribed={refresh} />
      <InstallAppCard />

      {/* Preferences */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6" data-testid="notification-settings">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-slate-900">
          <BellRing className="h-5 w-5 text-teal-600" /> Notification Settings
        </h2>
        {!prefs ? (
          <p className="text-sm text-slate-400">{loading ? 'Loading…' : 'Settings unavailable.'}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {prefRows.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm font-medium text-slate-700">{row.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={prefs[row.key]}
                  onClick={() => togglePref(row.key)}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
                    prefs[row.key] ? 'bg-teal-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                      prefs[row.key] ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                  <span className="sr-only">{prefs[row.key] ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Devices */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-slate-900">Your Devices</h2>
        {devices.length === 0 ? (
          <p className="text-sm text-slate-400">No devices registered for push notifications yet.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                {device.device_type === 'mobile' ? (
                  <Smartphone className="h-4 w-4 shrink-0 text-slate-500" />
                ) : device.device_type === 'tablet' ? (
                  <Tablet className="h-4 w-4 shrink-0 text-slate-500" />
                ) : (
                  <Laptop className="h-4 w-4 shrink-0 text-slate-500" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium capitalize text-slate-700">
                    {device.device_type || 'device'} · {device.browser || 'browser'}
                  </p>
                  <p className="text-xs text-slate-400">Added {timeAgo(device.created_at)}</p>
                </div>
                {!device.is_active && <span className="text-xs text-amber-600">inactive</span>}
                <button
                  type="button"
                  onClick={() => handleRemoveDevice(device)}
                  aria-label="Remove device"
                  className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* History */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6" data-testid="notification-history">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Notification History</h2>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh notifications"
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">No notifications yet.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => item.url && navigateApp(item.url)}
                  className={`w-full rounded-xl p-3 text-left transition hover:bg-slate-50 ${
                    item.read_at ? 'opacity-80' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.read_at ? 'bg-slate-300' : 'bg-teal-500'}`}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                      <p className="mt-0.5 text-sm text-slate-600">{item.body}</p>
                      <p className="mt-1 text-xs text-slate-400">{timeAgo(item.created_at)}</p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
