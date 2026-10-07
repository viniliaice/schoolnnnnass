// @vitest-environment node
//
// Executes the real fan-out orchestration (sendTeacherNotification) against an
// in-memory NotificationDb and a fake push transport, asserting the exact
// delivery plan: multi-device delivery, preference-based skipping, no-device
// handling and 410-driven deactivation.

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  categoryAllowedByPreferences,
  planDelivery,
  sendTeacherNotification,
  validateSendRequest,
  type NotificationDb,
  type PreferenceRow,
  type PushSubRow,
  type TeacherProfile,
} from '../../../server/lib/notificationSender';
import { base64UrlEncode, generateVapidKeys } from '../../../server/lib/webpush';

function validKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: base64UrlEncode(ecdh.getPublicKey()),
    auth: base64UrlEncode(crypto.randomBytes(16)),
  };
}

interface MemoryState {
  teachers: TeacherProfile[];
  subs: PushSubRow[];
  prefs: PreferenceRow[];
  notifications: any[];
  recipients: any[];
  deactivated: string[];
  updates: any[];
}

function makeDb(state: MemoryState): NotificationDb {
  return {
    async listTeachers(filter) {
      if (filter.audience === 'teachers' && filter.teacherIds?.length) {
        const wanted = new Set(filter.teacherIds);
        return state.teachers.filter((t) => wanted.has(t.id));
      }
      if (filter.audience === 'class_group' && filter.className) {
        return state.teachers.filter((t) => (t.assignedClasses ?? []).includes(filter.className!));
      }
      return state.teachers;
    },
    async getActiveSubscriptions(userIds) {
      return state.subs.filter((s) => userIds.includes(s.user_id) && s.is_active);
    },
    async getPreferences(userIds) {
      return state.prefs.filter((p) => userIds.includes(p.user_id));
    },
    async insertNotification(row) {
      state.notifications.push(row);
    },
    async insertRecipients(rows) {
      state.recipients.push(...rows);
    },
    async updateRecipient(notificationId, userId, patch) {
      state.updates.push({ notificationId, userId, patch });
    },
    async deactivateSubscription(endpoint) {
      state.deactivated.push(endpoint);
      const sub = state.subs.find((s) => s.endpoint === endpoint);
      if (sub) sub.is_active = false;
    },
  };
}

const vapid = generateVapidKeys();

function oneTeacherState(subs: PushSubRow[], teachers: TeacherProfile[] = [{ id: 'teacher-1', name: 'Teacher' }]): MemoryState {
  return { teachers, subs, prefs: [], notifications: [], recipients: [], deactivated: [], updates: [] };
}

describe('sendTeacherNotification orchestration', () => {
  it('delivers to every active device of each teacher', async () => {
    const keysA = validKeys();
    const keysB = validKeys();
    const state: MemoryState = {
      teachers: [{ id: 'teacher-1', name: 'Ms. Fatima', assignedClasses: ['Grade 2-C'] }],
      subs: [
        { id: 's1', user_id: 'teacher-1', endpoint: 'https://push/phone', ...keysA, is_active: true },
        { id: 's2', user_id: 'teacher-1', endpoint: 'https://push/laptop', ...keysB, is_active: true },
      ],
      prefs: [],
      notifications: [],
      recipients: [],
      deactivated: [],
      updates: [],
    };

    const posted: string[] = [];
    const fetchImpl = (async (url: any) => {
      posted.push(String(url));
      return { status: 201, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'Staff Meeting', body: 'Staff meeting tomorrow at 8:00 AM.', category: 'announcement' },
      senderId: 'admin-1',
      db: makeDb(state),
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });

    expect(posted.sort()).toEqual(['https://push/laptop', 'https://push/phone']);
    expect(summary.sent).toBe(1);
    expect(summary.devicesDelivered).toBe(2);
    expect(summary.devicesFailed).toBe(0);
    expect(state.notifications).toHaveLength(1);
    expect(state.recipients).toHaveLength(1);
    const update = state.updates[0];
    expect(update.patch.status).toBe('sent');
    expect(update.patch.delivered_devices).toBe(2);
  });

  it('skips teachers whose preferences disable the category', async () => {
    const keys = validKeys();
    const state: MemoryState = {
      teachers: [
        { id: 't-on', name: 'On', assignedClasses: [] },
        { id: 't-off', name: 'Off', assignedClasses: [] },
      ],
      subs: [
        { id: 's1', user_id: 't-on', endpoint: 'https://push/on', ...keys, is_active: true },
        { id: 's2', user_id: 't-off', endpoint: 'https://push/off', ...keys, is_active: true },
      ],
      prefs: [
        { user_id: 't-off', push_enabled: true, announcements: false, messages: true, lesson_plan_reminders: true, admin_alerts: true },
      ],
      notifications: [],
      recipients: [],
      deactivated: [],
      updates: [],
    };

    const posted: string[] = [];
    const fetchImpl = (async (url: any) => {
      posted.push(String(url));
      return { status: 201, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'announcement' },
      senderId: 'admin-1',
      db: makeDb(state),
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });

    expect(posted).toEqual(['https://push/on']);
    expect(summary.sent).toBe(1);
    expect(summary.skipped).toBe(1);
    const off = state.updates.find((u) => u.userId === 't-off');
    expect(off).toBeUndefined(); // skipped rows seeded at insert, never updated to sent
    const offRecipient = state.recipients.find((r) => r.user_id === 't-off');
    expect(offRecipient.status).toBe('skipped');
  });

  it('marks teachers with no devices as no_devices and does not call push', async () => {
    const state: MemoryState = {
      teachers: [{ id: 't-none', name: 'NoDevice', assignedClasses: [] }],
      subs: [],
      prefs: [],
      notifications: [],
      recipients: [],
      deactivated: [],
      updates: [],
    };
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { status: 201, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' },
      senderId: 'admin-1',
      db: makeDb(state),
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });

    expect(calls).toBe(0);
    expect(summary.noDevices).toBe(1);
    expect(summary.devicesDelivered).toBe(0);
  });

  it('deactivates subscriptions that the push service reports as 410', async () => {
    const good = validKeys();
    const dead = validKeys();
    const state: MemoryState = {
      teachers: [{ id: 't1', name: 'T', assignedClasses: [] }],
      subs: [
        { id: 's1', user_id: 't1', endpoint: 'https://push/good', ...good, is_active: true },
        { id: 's2', user_id: 't1', endpoint: 'https://push/dead', ...dead, is_active: true },
      ],
      prefs: [],
      notifications: [],
      recipients: [],
      deactivated: [],
      updates: [],
    };
    const fetchImpl = (async (url: any) => {
      const status = String(url).includes('dead') ? 410 : 201;
      return { status, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' },
      senderId: 'admin-1',
      db: makeDb(state),
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });

    expect(state.deactivated).toEqual(['https://push/dead']);
    expect(summary.deactivatedSubscriptions).toBe(1);
    expect(summary.devicesDelivered).toBe(1);
    expect(summary.devicesFailed).toBe(1);
  });

  it('validates the request shape', () => {
    expect(validateSendRequest({ audience: 'all_teachers', title: '', body: 'b', category: 'general' })).toMatch(/title/);
    expect(
      validateSendRequest({ audience: 'teachers', title: 't', body: 'b', category: 'general', teacherIds: [] }),
    ).toMatch(/teacherIds/);
    expect(
      validateSendRequest({ audience: 'all_teachers', title: 't', body: 'b', category: 'general', url: 'https://evil' }),
    ).toMatch(/url/);
    expect(validateSendRequest({ audience: 'all_teachers', title: 't', body: 'b', category: 'general' })).toBeNull();
  });

  it('planDelivery prefers explicit off over defaults', () => {
    const teachers = [{ id: 'a', name: 'A' }];
    const prefs = [
      { user_id: 'a', push_enabled: false, announcements: true, messages: true, lesson_plan_reminders: true, admin_alerts: true },
    ];
    const plan = planDelivery(teachers, prefs, [], 'announcement');
    expect(plan[0].status).toBe('skipped');
    expect(categoryAllowedByPreferences(undefined, 'announcement')).toBe(true);
  });

  it('records a sanitized HTTP 400 failure and keeps the subscription active', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/secret-path', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status: 400, text: async () => 'InvalidSubscription: Bad request' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.devicesFailed).toBe(1);
    expect(summary.deliveryOk).toBe(false);
    expect(summary.recipients[0]).toMatchObject({ status: 'failed', failureCode: 'bad_request' });
    expect(summary.recipients[0].lastError).toContain('HTTP 400');
    expect(summary.recipients[0].lastError).toContain('InvalidSubscription');
    expect(summary.recipients[0].lastError).not.toContain('secret-path');
    expect(state.deactivated).toEqual([]);
  });

  it('retires 404/410 subscriptions and records expired-device counts', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/dead', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status: 410, text: async () => 'Gone' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.devicesExpired).toBe(1);
    expect(summary.deactivatedSubscriptions).toBe(1);
    expect(summary.recipients[0].lastError).toContain('subscription expired (HTTP 410)');
    expect(state.subs[0].is_active).toBe(false);
  });

  it('keeps rows and blames VAPID when a push service reports BadJwtToken', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/jwt', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status: 403, text: async () => 'BadJwtToken' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.devicesRejected).toBe(1);
    expect(summary.deactivatedSubscriptions).toBe(0);
    expect(state.subs[0].is_active).toBe(true);
    expect(summary.recipients[0].lastError).toContain('check VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  });

  it.each([401, 403])('preserves subscriptions for HTTP %i because it may be a VAPID deployment failure', async (status) => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/rejected', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status, text: async () => 'subscription is not authorized' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.vapid.ok).toBe(true);
    expect(summary.devicesRejected).toBe(1);
    expect(summary.deactivatedSubscriptions).toBe(0);
    expect(state.subs[0].is_active).toBe(true);
    expect(summary.recipients[0].lastError).toContain('check VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  });

  it('keeps a subscription when invalid VAPID is reported, even if the service says 403', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/vapid', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status: 403, text: async () => 'Forbidden' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: '[mailto:a@b.c](mailto:a@b.c)' }, fetchImpl,
    });
    expect(summary.vapid.ok).toBe(false);
    expect(summary.deactivatedSubscriptions).toBe(0);
    expect(state.subs[0].is_active).toBe(true);
    expect(summary.recipients[0].lastError).toContain('VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  });

  it.each([429, 503])('does not retire subscriptions for retryable HTTP %i responses', async (status) => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/retry', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => ({ status, text: async () => 'try again' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.devicesFailed).toBe(1);
    expect(summary.deactivatedSubscriptions).toBe(0);
    expect(state.subs[0].is_active).toBe(true);
  });

  it('classifies DNS failure as network (not expired) and keeps the row', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/dns', ...validKeys(), is_active: true }]);
    const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND push.example.test'); }) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary.recipients[0].failureCode).toBe('network');
    expect(summary.devicesExpired).toBe(0);
    expect(summary.deactivatedSubscriptions).toBe(0);
    expect(state.subs[0].is_active).toBe(true);
  });

  it('handles malformed stored subscription keys as pre-flight failures without a request', async () => {
    const state = oneTeacherState([{ id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/bad-key', p256dh: 'bad', auth: 'bad', is_active: true }]);
    const fetchImpl = vi.fn(async () => ({ status: 201, text: async () => '' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary.devicesFailed).toBe(1);
    expect(summary.devicesExpired).toBe(0);
    expect(state.deactivated).toEqual([]);
    expect(summary.recipients[0].lastError).toContain('pre-flight');
  });

  it('reports partial multi-device success without losing per-device counts', async () => {
    const state = oneTeacherState([
      { id: 's1', user_id: 'teacher-1', endpoint: 'https://push/device/one', ...validKeys(), is_active: true },
      { id: 's2', user_id: 'teacher-1', endpoint: 'https://push/device/two', ...validKeys(), is_active: true },
    ]);
    let requestIndex = 0;
    const fetchImpl = (async () => ({ status: ++requestIndex === 1 ? 201 : 500, text: async () => 'Down' }) as Response) as unknown as typeof fetch;
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' }, fetchImpl,
    });
    expect(summary).toMatchObject({ deliveryOk: true, sent: 1, devicesDelivered: 1, devicesFailed: 1 });
    expect(state.updates[0].patch).toMatchObject({ status: 'sent', delivered_devices: 1, failed_devices: 1 });
  });

  it('returns an all-zero outcome for an empty audience', async () => {
    const state = oneTeacherState([], []);
    const summary = await sendTeacherNotification({
      request: { audience: 'all_teachers', title: 'T', body: 'B', category: 'general' }, senderId: 'admin',
      db: makeDb(state), vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
    });
    expect(summary.outcome).toEqual({ recipients: 0, devices: 0, sent: 0, failed: 0, expired: 0, rejected: 0, skipped: 0, noDevices: 0 });
    expect(summary.deliveryOk).toBe(false);
  });
});
