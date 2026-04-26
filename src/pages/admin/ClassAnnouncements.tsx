import { useEffect, useState } from 'react';
import { CLASSES } from '../../types';
import { broadcastClassAnnouncement, deleteAnnouncement, getAnnouncementsByCreator } from '../../lib/database';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { supabase } from '../../lib/supabase';

export function ClassAnnouncements() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [className, setClassName] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ recipients: number } | null>(null);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    if (!session) return;
    getAnnouncementsByCreator(session.userId).then(setHistory).catch(() => null);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel(`announcement-manage-${session.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => {
        getAnnouncementsByCreator(session.userId).then(setHistory).catch(() => null);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  const handleBroadcast = async () => {
    if (!session || !className || !message.trim()) return;
    try {
      const data = await broadcastClassAnnouncement({
        className,
        message: message.trim(),
        createdBy: session.userId,
      });
      setResult({ recipients: data.recipients.length });
      setMessage('');
      addToast({ type: 'success', title: 'Announcement sent to parents' });
    } catch {
      addToast({ type: 'error', title: 'Failed to send announcement' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Class Announcement Board</h1>
        <p className="text-slate-500 mt-1">Admins/Teachers can broadcast and manage one-way reminders by class</p>
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <select
          value={className}
          onChange={e => setClassName(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
        >
          <option value="">Select class...</option>
          {CLASSES.map(cls => (
            <option key={cls} value={cls}>
              {cls}
            </option>
          ))}
        </select>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={5}
          placeholder="Write announcement..."
          className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
        />
        <button
          onClick={handleBroadcast}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700"
        >
          Broadcast
        </button>
        {result && <p className="text-sm text-emerald-700">Sent to {result.recipients} parent account(s).</p>}
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h2 className="font-semibold text-slate-900">Manage Announcements</h2>
        {history.map(item => (
          <div key={item.id} className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-lg">
            <div>
              <p className="text-xs text-slate-500">{item.className}</p>
              <p className="text-sm text-slate-800">{item.message}</p>
            </div>
            <button
              onClick={async () => {
                try {
                  await deleteAnnouncement(item.id);
                  setHistory(prev => prev.filter(row => row.id !== item.id));
                  addToast({ type: 'success', title: 'Announcement deleted' });
                } catch {
                  addToast({ type: 'error', title: 'Failed to delete announcement' });
                }
              }}
              className="px-3 py-1.5 rounded-md bg-rose-50 text-rose-700 text-xs font-semibold"
            >
              Delete
            </button>
          </div>
        ))}
        {history.length === 0 && <p className="text-sm text-slate-400">No announcements yet.</p>}
      </div>
    </div>
  );
}
