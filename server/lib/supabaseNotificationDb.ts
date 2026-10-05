/**
 * NotificationDb implementation backed by the project's Supabase REST API,
 * used by the Vercel send function with the service-role key (RLS bypass —
 * the function enforces its own authorization before calling into the sender).
 */

import type { NotificationDb, PushSubRow, PreferenceRow, RecipientStatus, TeacherProfile } from './notificationSender';
import { inFilter, SupabaseRest } from './supabaseRest';

export function createSupabaseNotificationDb(rest: SupabaseRest): NotificationDb {
  return {
    async listTeachers(filter) {
      const { data, error } = await rest.select<TeacherProfile[]>(
        'profiles',
        'select=id,name,"assignedClasses"&role=eq.teacher&limit=1000',
      );
      if (error) throw new Error(`listTeachers: ${error.message}`);
      let teachers = data ?? [];

      if (filter.audience === 'teachers' && filter.teacherIds?.length) {
        const wanted = new Set(filter.teacherIds);
        teachers = teachers.filter((t) => wanted.has(t.id));
      } else if (filter.audience === 'class_group' && filter.className) {
        teachers = teachers.filter((t) =>
          Array.isArray(t.assignedClasses) ? t.assignedClasses.includes(filter.className as string) : false,
        );
      }
      return teachers;
    },

    async getActiveSubscriptions(userIds) {
      if (userIds.length === 0) return [];
      const { data, error } = await rest.select<PushSubRow[]>(
        'push_subscriptions',
        `select=id,user_id,endpoint,p256dh,auth,is_active&user_id=${encodeURIComponent(`in.${inFilter(userIds)}`)}&is_active=is.true`,
      );
      if (error) throw new Error(`getActiveSubscriptions: ${error.message}`);
      return data ?? [];
    },

    async getPreferences(userIds) {
      if (userIds.length === 0) return [];
      const { data, error } = await rest.select<PreferenceRow[]>(
        'notification_preferences',
        `select=user_id,push_enabled,announcements,messages,lesson_plan_reminders,admin_alerts&user_id=${encodeURIComponent(`in.${inFilter(userIds)}`)}`,
      );
      if (error) throw new Error(`getPreferences: ${error.message}`);
      return data ?? [];
    },

    async insertNotification(row) {
      const { error } = await rest.insert('notifications', row);
      if (error) throw new Error(`insertNotification: ${error.message}`);
    },

    async insertRecipients(rows) {
      if (rows.length === 0) return;
      const { error } = await rest.insert('notification_recipients', rows);
      if (error) throw new Error(`insertRecipients: ${error.message}`);
    },

    async updateRecipient(notificationId, userId, patch) {
      const body: Record<string, unknown> = { status: patch.status };
      if (typeof patch.delivered_devices === 'number') body.delivered_devices = patch.delivered_devices;
      if (typeof patch.failed_devices === 'number') body.failed_devices = patch.failed_devices;
      if ('last_error' in patch) body.last_error = patch.last_error;
      const { error } = await rest.update(
        'notification_recipients',
        `notification_id=eq.${encodeURIComponent(notificationId)}&user_id=eq.${encodeURIComponent(userId)}`,
        body,
      );
      if (error) throw new Error(`updateRecipient: ${error.message}`);
    },

    async deactivateSubscription(endpoint) {
      const { error } = await rest.update(
        'push_subscriptions',
        `endpoint=eq.${encodeURIComponent(endpoint)}`,
        { is_active: false },
      );
      if (error) throw new Error(`deactivateSubscription: ${error.message}`);
    },
  };
}

export type { RecipientStatus };
