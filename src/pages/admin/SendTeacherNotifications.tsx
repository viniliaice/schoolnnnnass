import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, Send, Users } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { supabase, isPlaceholderEnv } from '../../lib/supabase';
import { readCurrentAccessToken } from '../../lib/auth';
import { getUsersByRole } from '../../lib/db/profiles';
import { PushDiagnosticsPanel } from '../../components/admin/PushDiagnosticsPanel';
import { CLASSES, type User } from '../../types';
import { timeAgo } from '../../utils/timeAgo';
import type { SendSummary } from '../../../server/lib/notificationSender';

const CATEGORIES = [
  { value: 'announcement', label: 'School Announcement' },
  { value: 'message', label: 'New Message' },
  { value: 'lesson_plan', label: 'Lesson Plan Reminder' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'admin_alert', label: 'Administrative Alert' },
  { value: 'general', label: 'General' },
] as const;

const DESTINATIONS = [
  { value: '/teacher/notifications', label: 'Notifications' },
  { value: '/teacher/announcements', label: 'Announcements' },
  { value: '/teacher/lesson-plans', label: 'Lesson Plans' },
  { value: '/teacher/students', label: 'My Classes' },
  { value: '/teacher/attendance', label: 'Record Attendance' },
  { value: '/teacher/all-results', label: 'My Submissions' },
  { value: '/dashboard', label: 'Dashboard' },
  { value: 'custom', label: 'Custom path…' },
];

type Audience = 'all_teachers' | 'class_group' | 'teachers';

interface HistoryRow {
  id: string;
  title: string;
  body: string;
  url: string | null;
  category: string;
  created_at: string;
  senderName: string;
  recipientSummary: string;
  failureDetail: string | null;
}

/**
 * Administration interface for teacher push notifications.
 * Recipients: all teachers / a class group / individually selected teachers.
 * Authorization is enforced server-side by /api/notifications/send (role
 * admin or supervisor); this page only exposes the controls.
 */
export function SendTeacherNotifications() {
  const { user } = useRole();
  const { addToast } = useToast();

  const [teachers, setTeachers] = useState<User[]>([]);
  const [audience, setAudience] = useState<Audience>('all_teachers');
  const [className, setClassName] = useState(CLASSES[6]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const [category, setCategory] = useState<string>('announcement');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [destination, setDestination] = useState(DESTINATIONS[0].value);
  const [customUrl, setCustomUrl] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendSummary | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  useEffect(() => {
    getUsersByRole('teacher', 1, 1000)
      .then(setTeachers)
      .catch((err) => addToast({ type: 'error', title: 'Could not load teachers', description: String(err) }));
  }, [addToast]);

  const loadHistory = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('notifications')
        .select('id, title, body, url, category, sender_id, created_at')
        .order('created_at', { ascending: false })
        .limit(30);
      if (err) throw err;
      const rows = (data || []) as any[];
      const senderIds = Array.from(new Set(rows.map((r) => r.sender_id).filter(Boolean)));
      const notifIds = rows.map((r) => r.id);

      const [senderRes, recipRes] = await Promise.all([
        senderIds.length
          ? supabase.from('profiles').select('id, name').in('id', senderIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        notifIds.length
          ? supabase
              .from('notification_recipients')
              .select('notification_id, status, last_error, delivered_devices, failed_devices')
              .in('notification_id', notifIds)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const senderNames = new Map(((senderRes.data || []) as any[]).map((p) => [p.id, p.name]));
      const byNotif = new Map<string, any[]>();
      for (const r of (recipRes.data || []) as any[]) {
        const list = byNotif.get(r.notification_id) ?? [];
        list.push(r);
        byNotif.set(r.notification_id, list);
      }

      setHistory(
        rows.map((row) => {
          const recipients = byNotif.get(row.id) ?? [];
          const sent = recipients.filter((r) => r.status === 'sent').length;
          const noDev = recipients.filter((r) => r.status === 'no_devices').length;
          const skipped = recipients.filter((r) => r.status === 'skipped').length;
          const failed = recipients.filter((r) => r.status === 'failed').length;
          const deliveredDevices = recipients.reduce((sum, r) => sum + (Number(r.delivered_devices) || 0), 0);
          const failedDevices = recipients.reduce((sum, r) => sum + (Number(r.failed_devices) || 0), 0);
          const failureDetail = recipients.find((r) => typeof r.last_error === 'string' && r.last_error.trim())?.last_error ?? null;
          return {
            id: row.id,
            title: row.title,
            body: row.body,
            url: row.url,
            category: row.category,
            created_at: row.created_at,
            senderName: senderNames.get(row.sender_id) || 'System',
            recipientSummary: `${recipients.length} recipient(s) · ${sent} sent · ${deliveredDevices} delivered / ${failedDevices} failed devices · ${noDev} no devices · ${skipped} skipped · ${failed} failed`,
            failureDetail,
          };
        }),
      );
    } catch (err) {
      // History is secondary; don't block the send UI.
      console.warn('[notifications] history load failed:', err);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const filteredTeachers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return teachers;
    return teachers.filter((t) => t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q));
  }, [teachers, search]);

  const resolvedUrl = destination === 'custom' ? customUrl.trim() : destination;

  const send = async () => {
    if (!title.trim() || !body.trim()) {
      setError('Title and message are required.');
      return;
    }
    if (audience === 'teachers' && selected.size === 0) {
      setError('Select at least one teacher.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);

    const request = {
      audience,
      className: audience === 'class_group' ? className : undefined,
      teacherIds: audience === 'teachers' ? Array.from(selected) : undefined,
      title: title.trim(),
      body: body.trim(),
      category,
      url: resolvedUrl || '/teacher/notifications',
    };

    try {
      if (isPlaceholderEnv) {
        const summary = await previewSimulatedSend(request, user?.id ?? 'preview-admin');
        setResult(summary);
        addToast({ type: 'info', title: 'Preview mode', description: 'Simulated send — deploy to Vercel for real push delivery.' });
      } else {
        const currentSession = await readCurrentAccessToken();
        if (currentSession.status !== 'ready') {
          setError(currentSession.status === 'unavailable'
            ? 'Could not validate your session. Please try again.'
            : 'Your session has expired — sign in again.');
          return;
        }
        const token = currentSession.accessToken;
        const res = await fetch('/api/notifications/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(json?.error || `Send failed (HTTP ${res.status}).`);
          return;
        }
        const summary = json as SendSummary;
        setResult(summary);
        const deliveryOk = summary.deliveryOk ?? summary.devicesDelivered > 0;
        const attemptedDevices = summary.outcome?.devices ?? (summary.devicesDelivered + summary.devicesFailed);
        const firstFailure = summary.recipients?.find((recipient) => recipient.lastError)?.lastError;
        if (deliveryOk) {
          addToast({ type: 'success', title: 'Notification delivered', description: `${summary.devicesDelivered} device(s) accepted the push.` });
        } else if (attemptedDevices > 0) {
          addToast({ type: 'error', title: 'Not delivered', description: firstFailure || 'The push service did not accept a device notification.' });
        } else {
          addToast({
            type: 'info',
            title: 'Nothing sent',
            description: 'No teacher in this audience has an active device subscription yet.',
          });
        }
      }
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Notification could not be sent.';
      setError(message);
      addToast({ type: 'error', title: 'Notification send failed', description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Teacher Notifications</h1>
        <p className="mt-1 text-slate-500">Send push notifications to teacher phones and computers.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recipients */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-slate-900">
            <Users className="h-5 w-5 text-indigo-600" /> Recipients
          </h2>
          <div className="space-y-2">
            {(
              [
                { value: 'all_teachers', label: 'All Teachers' },
                { value: 'class_group', label: 'Teachers of a class' },
                { value: 'teachers', label: 'Individual teachers' },
              ] as { value: Audience; label: string }[]
            ).map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="audience"
                  checked={audience === opt.value}
                  onChange={() => setAudience(opt.value)}
                  className="accent-indigo-600"
                />
                {opt.label}
              </label>
            ))}
          </div>

          {audience === 'class_group' && (
            <select
              value={className}
              onChange={(e) => setClassName(e.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}

          {audience === 'teachers' && (
            <div className="mt-3 space-y-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search teachers…"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-2">
                {filteredTeachers.map((teacher) => (
                  <label key={teacher.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selected.has(teacher.id)}
                      onChange={() => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(teacher.id)) next.delete(teacher.id);
                          else next.add(teacher.id);
                          return next;
                        });
                      }}
                      className="accent-indigo-600"
                    />
                    <span className="flex-1">{teacher.name}</span>
                    <span className="text-xs text-slate-400">{(teacher.assignedClasses || []).join(', ')}</span>
                  </label>
                ))}
                {filteredTeachers.length === 0 && <p className="p-2 text-sm text-slate-400">No teachers found.</p>}
              </div>
              <p className="text-xs text-slate-400">{selected.size} selected</p>
            </div>
          )}
        </section>

        {/* Notification */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-slate-900">
            <BellRing className="h-5 w-5 text-indigo-600" /> Notification
          </h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Staff Meeting"
                maxLength={200}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Message</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Staff meeting tomorrow at 8:00 AM."
                maxLength={1000}
                rows={3}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Opens (destination)</label>
              <select value={destination} onChange={(e) => setDestination(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                {DESTINATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              {destination === 'custom' && (
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="/teacher/lesson-plans"
                  className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              )}
            </div>
            <button
              type="button"
              onClick={send}
              disabled={busy}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
            >
              <Send className="h-4 w-4" /> {busy ? 'Sending…' : 'Send Notification'}
            </button>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            {result && (
              <div
                className={`rounded-lg border p-3 text-sm ${result.deliveryOk || result.devicesDelivered > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : result.devicesFailed > 0 ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`}
                data-testid="send-result-summary"
              >
                <p className="font-semibold">
                  {result.deliveryOk || result.devicesDelivered > 0 ? 'Delivery accepted' : result.devicesFailed > 0 ? 'Not delivered' : 'Nothing sent'} · {result.sent}/{result.totalRecipients} teacher(s) delivered.
                </p>
                <p className="mt-1">
                  Devices: {result.devicesDelivered} delivered · {result.devicesFailed} failed · {result.devicesExpired} expired · {result.devicesRejected} rejected · {result.noDevices} no devices · {result.skipped} skipped.
                </p>
                {(result.recipients?.find((recipient) => recipient.lastError)?.lastError || result.vapid?.problems?.[0]) && (
                  <p className="mt-1 break-words">Reason: {result.recipients?.find((recipient) => recipient.lastError)?.lastError || result.vapid?.problems?.[0]}</p>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <PushDiagnosticsPanel />

      {/* History */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6" data-testid="admin-notification-history">
        <h2 className="mb-4 text-lg font-bold text-slate-900">Send History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">No notifications sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Message</th>
                  <th className="py-2 pr-4">Recipients</th>
                  <th className="py-2 pr-4">Sender</th>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="py-3 pr-4 font-medium text-slate-800">{row.title}</td>
                    <td className="max-w-[240px] py-3 pr-4 text-slate-600">{row.body}</td>
                    <td className="py-3 pr-4 text-slate-600">
                      {row.recipientSummary}
                      {row.failureDetail && <p className="mt-1 max-w-[360px] break-words text-xs text-rose-700" data-testid="history-failure-detail">{row.failureDetail}</p>}
                    </td>
                    <td className="py-3 pr-4 text-slate-600">{row.senderName}</td>
                    <td className="whitespace-nowrap py-3 pr-4 text-slate-500">{timeAgo(row.created_at)}</td>
                    <td className="py-3 text-xs text-slate-500">{row.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Preview-only (no backend configured): writes the same history rows through
 * the mock client and shows a local OS notification so the flow can be
 * exercised. Clearly labelled as simulated.
 */
async function previewSimulatedSend(
  request: {
    audience: Audience;
    className?: string;
    teacherIds?: string[];
    title: string;
    body: string;
    category: string;
    url: string;
  },
  senderId: string,
): Promise<SendSummary> {
  const all = await getUsersByRole('teacher', 1, 1000);
  let targets = all;
  if (request.audience === 'teachers' && request.teacherIds?.length) {
    const wanted = new Set(request.teacherIds);
    targets = all.filter((t) => wanted.has(t.id));
  } else if (request.audience === 'class_group' && request.className) {
    targets = all.filter((t) => (t.assignedClasses || []).includes(request.className as string));
  }

  const notificationId = `ntf-preview-${Date.now().toString(36)}`;
  await supabase.from('notifications').insert({
    id: notificationId,
    title: request.title,
    body: request.body,
    url: request.url,
    category: request.category,
    sender_id: senderId,
  });
  for (const teacher of targets) {
    await supabase.from('notification_recipients').insert({
      id: `ntr-preview-${Math.random().toString(36).slice(2, 10)}`,
      notification_id: notificationId,
      user_id: teacher.id,
      status: 'sent',
      delivered_devices: 1,
    });
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(request.title, { body: request.body, icon: '/icons/icon-192.png' });
  } catch {
    /* no worker in this environment */
  }

  return {
    notificationId,
    totalRecipients: targets.length,
    sent: targets.length,
    skipped: 0,
    noDevices: 0,
    failed: 0,
    devicesDelivered: targets.length,
    devicesFailed: 0,
    devicesExpired: 0,
    devicesRejected: 0,
    deactivatedSubscriptions: 0,
    deliveryOk: targets.length > 0,
    vapid: {
      ok: true,
      subjectValid: true,
      subjectScheme: 'mailto' as const,
      privateKeyBytes: 0,
      publicKeyBytes: null,
      problems: [],
    },
    outcome: {
      recipients: targets.length,
      devices: targets.length,
      sent: targets.length,
      failed: 0,
      expired: 0,
      rejected: 0,
      skipped: 0,
      noDevices: 0,
    },
    recipients: targets.map((t) => ({
      userId: t.id,
      teacherName: t.name,
      status: 'sent' as const,
      deliveredDevices: 1,
      failedDevices: 0,
      expiredDevices: 0,
      rejectedDevices: 0,
      failureCode: null,
      lastError: null,
    })),
  };
}
