/**
 * NotificationDb implementation backed by the project's Supabase REST API,
 * used by the Vercel send function with the service-role key (RLS bypass —
 * the function enforces its own authorization before calling into the sender).
 */

import type {
  NotificationDb,
  PushSubRow,
  PreferenceRow,
  RecipientStatus,
  ReminderRecipientInsert,
  TeacherProfile,
} from './notificationSender.js';
import { inFilter, SupabaseRest } from './supabaseRest.js';

const TEACHER_ID_QUERY_BATCH_SIZE = 100;

export function createSupabaseNotificationDb(rest: SupabaseRest): NotificationDb {
  return {
    async listTeachers(filter) {
      if (filter.audience === 'teachers') {
        const teacherIds = [...new Set(filter.teacherIds ?? [])];
        if (teacherIds.length === 0) return [];

        // Reminder sends already know their eligible teachers. Filter by those
        // IDs in bounded batches rather than loading the first 1,000 profiles
        // and accidentally dropping eligible teachers beyond that page.
        const batches: string[][] = [];
        for (let index = 0; index < teacherIds.length; index += TEACHER_ID_QUERY_BATCH_SIZE) {
          batches.push(teacherIds.slice(index, index + TEACHER_ID_QUERY_BATCH_SIZE));
        }
        const results = await Promise.all(batches.map((batch) => rest.select<TeacherProfile[]>(
          'profiles',
          `select=id,name,"assignedClasses"&role=eq.teacher&id=${encodeURIComponent(`in.${inFilter(batch)}`)}&limit=1000`,
        )));
        const byId = new Map<string, TeacherProfile>();
        for (const { data, error } of results) {
          if (error) throw new Error(`listTeachers: ${error.message}`);
          for (const teacher of data ?? []) byId.set(teacher.id, teacher);
        }
        return teacherIds.flatMap((teacherId) => {
          const teacher = byId.get(teacherId);
          return teacher ? [teacher] : [];
        });
      }

      const { data, error } = await rest.select<TeacherProfile[]>(
        'profiles',
        'select=id,name,"assignedClasses"&role=eq.teacher&limit=1000',
      );
      if (error) throw new Error(`listTeachers: ${error.message}`);
      const teachers = data ?? [];
      if (filter.audience === 'class_group' && filter.className) {
        return teachers.filter((teacher) =>
          Array.isArray(teacher.assignedClasses) ? teacher.assignedClasses.includes(filter.className as string) : false,
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
        `select=user_id,push_enabled,announcements,messages,lesson_plan_reminders,marks_entry_reminders,admin_alerts&user_id=${encodeURIComponent(`in.${inFilter(userIds)}`)}`,
      );
      if (error) throw new Error(`getPreferences: ${error.message}`);
      return data ?? [];
    },

    async insertNotification(row) {
      const { error } = await rest.insert('notifications', row);
      if (error) throw new Error(`insertNotification: ${error.message}`);
    },

    async insertRecipients(rows: ReminderRecipientInsert[]) {
      if (rows.length === 0) return;
      const { error } = await rest.insert('notification_recipients', rows);
      if (error) throw new Error(`insertRecipients: ${error.message}`);
    },

    async claimReminderRecipients(rows: ReminderRecipientInsert[]) {
      if (rows.length === 0) return [];
      const { data, error } = await rest.rpc<Array<Pick<ReminderRecipientInsert, 'id' | 'user_id' | 'deduplication_key'>>>(
        'claim_academic_reminder_recipients',
        { p_rows: rows },
      );
      if (error) {
        const failure = new Error(`claimReminderRecipients: ${error.message}`) as Error & { status?: number };
        failure.status = error.status;
        throw failure;
      }
      return data ?? [];
    },

    async updateRecipient(notificationId, userId, patch) {
      const body: Record<string, unknown> = { status: patch.status };
      if (typeof patch.delivered_devices === 'number') body.delivered_devices = patch.delivered_devices;
      if (typeof patch.failed_devices === 'number') body.failed_devices = patch.failed_devices;
      if (typeof patch.expired_devices === 'number') body.expired_devices = patch.expired_devices;
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

    async deleteNotification(notificationId) {
      const { error } = await rest.delete('notifications', `id=eq.${encodeURIComponent(notificationId)}`);
      if (error) throw new Error(`deleteNotification: ${error.message}`);
    },
  };
}

export type { RecipientStatus };
