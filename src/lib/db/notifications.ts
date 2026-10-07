/**
 * Client data access for the teacher notification system. All writes are
 * constrained by the RLS policies in 20261005_push_notifications.sql to the
 * caller's own profile — a teacher can never read or write another user's
 * rows, and the admin fan-out happens server-side with the service role.
 */

import { supabase } from '../supabase';

export interface MyDevice {
  id: string;
  endpoint: string;
  device_type: string | null;
  browser: string | null;
  created_at: string;
  is_active: boolean;
}

export interface NotificationPrefs {
  push_enabled: boolean;
  announcements: boolean;
  messages: boolean;
  lesson_plan_reminders: boolean;
  marks_entry_reminders: boolean;
  admin_alerts: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  push_enabled: true,
  announcements: true,
  messages: true,
  lesson_plan_reminders: true,
  marks_entry_reminders: true,
  admin_alerts: true,
};

export interface MyNotification {
  id: string; // recipient row id
  notification_id: string;
  title: string;
  body: string;
  url: string | null;
  category: string;
  read_at: string | null;
  created_at: string;
}

export async function listMyDevices(userId: string): Promise<MyDevice[]> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, device_type, browser, created_at, is_active')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as MyDevice[];
}

export async function removeDevice(userId: string, subscriptionId: string): Promise<void> {
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('id', subscriptionId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function getMyPreferences(userId: string): Promise<NotificationPrefs> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('push_enabled, announcements, messages, lesson_plan_reminders, marks_entry_reminders, admin_alerts')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(data || {}) } as NotificationPrefs;
}

export async function saveMyPreferences(userId: string, prefs: NotificationPrefs): Promise<void> {
  const { error } = await supabase.from('notification_preferences').upsert(
    {
      user_id: userId,
      push_enabled: prefs.push_enabled,
      announcements: prefs.announcements,
      messages: prefs.messages,
      lesson_plan_reminders: prefs.lesson_plan_reminders,
      marks_entry_reminders: prefs.marks_entry_reminders,
      admin_alerts: prefs.admin_alerts,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

export async function getMyNotifications(userId: string, limit = 100): Promise<MyNotification[]> {
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('id, notification_id, read_at, created_at, notifications(id, title, body, url, category)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data || []) as any[]).map((row) => {
    // Joined row in production; flat row in the preview mock client.
    const n = row.notifications ?? row;
    return {
      id: row.id,
      notification_id: row.notification_id,
      title: n?.title ?? 'Notification',
      body: n?.body ?? '',
      url: n?.url ?? null,
      category: n?.category ?? 'general',
      read_at: row.read_at,
      created_at: row.created_at,
    };
  });
}

/** Mark every unread notification of this user as read. */
export async function markMyNotificationsRead(userId: string): Promise<void> {
  const { error } = await supabase
    .from('notification_recipients')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null);
  if (error) throw error;
}
