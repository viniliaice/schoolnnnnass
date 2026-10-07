// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const source = {
    getSchedules: vi.fn(),
    updateSchedule: vi.fn(),
    getCurrentAcademicYear: vi.fn(),
    getCurrentTerm: vi.fn(),
    getTeacherRoster: vi.fn(),
    getLessonPlanSnapshot: vi.fn(),
    getMarksMonitorRows: vi.fn(),
  };
  return {
    source,
    auth: vi.fn(),
    isAdminOrSupervisor: vi.fn((role: string) => role === 'admin' || role === 'supervisor'),
    parseJsonBody: vi.fn((body: unknown) => body && typeof body === 'object' ? body : null),
    readServerSupabaseConfig: vi.fn(() => ({ url: 'https://db.example.test', anonKey: 'anon', serviceKey: 'service' })),
    readServerSupabaseServiceConfig: vi.fn(() => ({ url: 'https://db.example.test', serviceKey: 'service' })),
    resolveAcademicReminderVapid: vi.fn(() => ({ privateKey: 'not-used-in-mocked-api-test', subject: 'mailto:test@example.test' })),
    cronAuthorizationMatches: vi.fn(() => true),
    safeInternalError: vi.fn((err: unknown) => err instanceof Error ? err.message : String(err)),
    createSource: vi.fn(),
    getStaffProfileScope: vi.fn(),
    getReminderDeliveryHistory: vi.fn(),
    getTeacherSubscriptionSummaries: vi.fn(),
    validateVapidConfig: vi.fn(() => ({ ok: true, problems: [] })),
    sanitizePushResponseText: vi.fn((value: unknown) => String(value ?? '')),
    loadContext: vi.fn(),
    evaluateTasks: vi.fn(),
    runReminder: vi.fn(),
    isScheduleDue: vi.fn(),
    manualOccurrence: vi.fn(),
    scheduledOccurrence: vi.fn(),
    createNotificationDb: vi.fn(() => ({})),
  };
});

vi.mock('../../../server/lib/academicReminderHttp.js', () => ({
  authenticateServerProfile: mocks.auth,
  isAdminOrSupervisor: mocks.isAdminOrSupervisor,
  parseJsonBody: mocks.parseJsonBody,
  readServerSupabaseConfig: mocks.readServerSupabaseConfig,
  readServerSupabaseServiceConfig: mocks.readServerSupabaseServiceConfig,
  resolveAcademicReminderVapid: mocks.resolveAcademicReminderVapid,
  cronAuthorizationMatches: mocks.cronAuthorizationMatches,
  safeInternalError: mocks.safeInternalError,
}));

vi.mock('../../../server/lib/academicReminderEngine.js', () => ({
  ACADEMIC_REMINDER_TYPES: ['lesson_plan_reminder', 'marks_entry_reminder'],
  DEFAULT_SCHOOL_TIMEZONE: 'Africa/Mogadishu',
  loadAcademicPeriodContext: mocks.loadContext,
  evaluateAcademicReminderTasks: mocks.evaluateTasks,
  runAcademicReminder: mocks.runReminder,
  isReminderScheduleDue: mocks.isScheduleDue,
  manualReminderOccurrence: mocks.manualOccurrence,
  scheduledReminderOccurrence: mocks.scheduledOccurrence,
  ReminderScopeError: class ReminderScopeError extends Error {},
}));

vi.mock('../../../server/lib/supabaseAcademicReminderDb.js', () => ({
  createSupabaseAcademicReminderDataSource: mocks.createSource,
  getStaffProfileScope: mocks.getStaffProfileScope,
  getReminderDeliveryHistory: mocks.getReminderDeliveryHistory,
  getTeacherSubscriptionSummaries: mocks.getTeacherSubscriptionSummaries,
  isReminderType: (value: unknown) => value === 'lesson_plan_reminder' || value === 'marks_entry_reminder',
}));

vi.mock('../../../server/lib/supabaseNotificationDb.js', () => ({
  createSupabaseNotificationDb: mocks.createNotificationDb,
}));

vi.mock('../../../server/lib/webpush.js', () => ({
  validateVapidConfig: mocks.validateVapidConfig,
  sanitizePushResponseText: mocks.sanitizePushResponseText,
}));

import tasksHandler from '../../../api/academic-reminders/tasks.js';
import sendHandler from '../../../api/academic-reminders/send.js';
import schedulesHandler from '../../../api/academic-reminders/schedules.js';
import cronHandler from '../../../api/academic-reminders/cron.js';

function setAuth(role: string, profileId = `${role}-1`) {
  mocks.auth.mockResolvedValue({
    ok: true,
    profile: { profileId, role, token: 'caller-token', callerRest: { kind: 'caller' }, serviceRest: { kind: 'service' } },
  });
}

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
}

function task(reminderType: string, teacherId: string) {
  return {
    reminderType,
    teacherId,
    teacherName: teacherId === 'teacher-1' ? 'Teacher One' : 'Teacher Two',
    academicPeriod: 'year-2026:term-1',
    periodLabel: 'October · Term 1',
    eligible: true,
    completionStatus: 'in_progress',
    completionPercent: 50,
    outstandingCount: 1,
    outstandingUnits: 2,
    outstandingSummary: '1 outstanding assignment',
    eligibilityReason: 'Two students still need entries.',
    assignedClasses: ['Grade 8-A'],
    relevantEntity: '["cs-grade8-english"]',
  };
}

const schedule = (reminderType: string, overrides: Record<string, unknown> = {}) => ({
  reminder_type: reminderType,
  enabled: true,
  timezone: 'Africa/Mogadishu',
  days_of_week: [1, 2, 3, 4, 5],
  send_time: '15:00',
  exam_scope: 'monthly',
  ...overrides,
});

function result(reminderType: string) {
  const eligible = task(reminderType, 'teacher-1');
  const summary = {
    notificationId: 'notification-1',
    totalRecipients: 1,
    sent: 1,
    skipped: 0,
    noDevices: 0,
    noSubscription: 0,
    alreadyReminded: 0,
    taskAlreadyCompleted: 0,
    failed: 0,
    expired: 0,
    devicesDelivered: 1,
    devicesFailed: 0,
    devicesExpired: 0,
    devicesRejected: 0,
    deactivatedSubscriptions: 0,
    deliveryOk: true,
    outcome: { recipients: 1, devices: 1, sent: 1 },
    recipients: [{ userId: 'teacher-1', teacherName: 'Teacher One', status: 'sent' }],
  };
  return {
    reminderType,
    academicPeriod: eligible.academicPeriod,
    periodLabel: eligible.periodLabel,
    reminderOccurrence: 'manual:request-12345',
    tasks: [eligible],
    selectedTeacherIds: ['teacher-1'],
    eligibleTeacherIds: ['teacher-1'],
    alreadyCompleteTeacherIds: [],
    noTaskTeacherIds: [],
    summary,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSource.mockReturnValue(mocks.source);
  mocks.source.getSchedules.mockResolvedValue([
    schedule('lesson_plan_reminder'),
    schedule('marks_entry_reminder'),
  ]);
  mocks.source.updateSchedule.mockResolvedValue(schedule('marks_entry_reminder', { enabled: false }));
  mocks.getStaffProfileScope.mockResolvedValue({ role: 'supervisor', assignedClasses: ['Grade 8-A'] });
  mocks.getReminderDeliveryHistory.mockResolvedValue([]);
  mocks.getTeacherSubscriptionSummaries.mockResolvedValue(new Map([
    ['teacher-1', { activeSubscriptions: 2, realActiveSubscriptions: 1, hasRealDevice: true }],
  ]));
  mocks.loadContext.mockResolvedValue({ timezone: 'Africa/Mogadishu', year: { id: 'year-2026' }, term: { id: 'term-1' } });
  mocks.evaluateTasks.mockImplementation(async (input: any) => ({
    academicPeriod: 'year-2026:term-1',
    periodLabel: 'October · Term 1',
    tasks: [task(input.reminderType, input.teacherId || 'teacher-1'), ...(input.teacherId ? [] : [task(input.reminderType, 'teacher-2')])],
  }));
  mocks.runReminder.mockImplementation(async (input: any) => result(input.reminderType));
  mocks.manualOccurrence.mockReturnValue('manual:marks_entry_reminder:request-12345');
  mocks.scheduledOccurrence.mockReturnValue('scheduled:marks_entry_reminder:2026-10-07:15:00@Africa/Mogadishu');
  mocks.isScheduleDue.mockImplementation((item: any) => item.enabled && item.reminder_type === 'marks_entry_reminder');
});

describe('academic reminder API authorization and routing', () => {
  it('returns only the authenticated teacher’s task state and omits other teachers’ subscription status', async () => {
    setAuth('teacher', 'teacher-1');
    const req = { method: 'GET', headers: { authorization: 'Bearer teacher-token' } };
    const res = response();
    await tasksHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.evaluateTasks).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateTasks.mock.calls.every(([input]) => input.teacherId === 'teacher-1')).toBe(true);
    expect(res.body.lesson_plan_reminder.tasks).toHaveLength(1);
    expect(res.body.lesson_plan_reminder.tasks[0].teacherId).toBe('teacher-1');
    expect(res.body.lesson_plan_reminder.tasks[0].subscription).toBeUndefined();
    expect(res.body.schedules).toEqual([]);
    expect(res.body.timezone).toBeUndefined();
    expect(mocks.getTeacherSubscriptionSummaries).not.toHaveBeenCalled();
    expect(mocks.getReminderDeliveryHistory).toHaveBeenCalledWith({ kind: 'service' }, ['teacher-1']);
  });

  it('denies parent and office roles from reminder tasks', async () => {
    setAuth('parent', 'parent-1');
    const res = response();
    await tasksHandler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(403);
  });

  it('allows a supervisor manual send only within authorized classes and forwards the selected reminder type', async () => {
    setAuth('supervisor', 'supervisor-1');
    const req = {
      method: 'POST',
      headers: {},
      body: {
        reminderType: 'marks_entry_reminder',
        teacherIds: ['teacher-1'],
        requestId: 'request-12345',
        examScope: 'monthly',
      },
    };
    const res = response();
    await sendHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.getStaffProfileScope).toHaveBeenCalledWith({ kind: 'service' }, 'supervisor-1');
    expect(mocks.runReminder).toHaveBeenCalledWith(expect.objectContaining({
      reminderType: 'marks_entry_reminder',
      teacherIds: ['teacher-1'],
      allowedClasses: ['Grade 8-A'],
      senderId: 'supervisor-1',
      examScope: 'monthly',
      reminderOccurrence: 'manual:marks_entry_reminder:request-12345',
    }));
    expect(res.body.deliveryOk).toBe(true);
    expect(res.body.eligibleTasks).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('VAPID_PRIVATE_KEY');
  });

  it('rejects teacher manual sends before task evaluation or VAPID delivery', async () => {
    setAuth('teacher', 'teacher-1');
    const res = response();
    await sendHandler({ method: 'POST', headers: {}, body: { reminderType: 'lesson_plan_reminder', teacherIds: ['teacher-2'], requestId: 'request-12345' } }, res);
    expect(res.statusCode).toBe(403);
    expect(mocks.runReminder).not.toHaveBeenCalled();
    expect(mocks.validateVapidConfig).not.toHaveBeenCalled();
  });

  it('validates schedule settings and persists independent schedule fields for authorized staff', async () => {
    setAuth('admin', 'admin-1');
    const req = {
      method: 'PUT',
      headers: {},
      body: {
        reminderType: 'marks_entry_reminder',
        enabled: false,
        timezone: 'Africa/Mogadishu',
        daysOfWeek: [1, 3, 5],
        sendTime: '14:30',
        examScope: 'final',
      },
    };
    const res = response();
    await schedulesHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.source.updateSchedule).toHaveBeenCalledWith('marks_entry_reminder', {
      enabled: false,
      timezone: 'Africa/Mogadishu',
      days_of_week: [1, 3, 5],
      send_time: '14:30',
      exam_scope: 'final',
    }, 'admin-1');

    const invalid = response();
    await schedulesHandler({ method: 'PUT', headers: {}, body: { ...req.body, timezone: 'Moon/Base' } }, invalid);
    expect(invalid.statusCode).toBe(400);
  });

  it('runs only due enabled schedules through the cron-only authorization path', async () => {
    mocks.cronAuthorizationMatches.mockReturnValue(true);
    const req = { method: 'GET', headers: { authorization: 'Bearer cron-secret' } };
    const res = response();
    await cronHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.createSource).toHaveBeenCalledWith(expect.anything());
    expect(mocks.runReminder).toHaveBeenCalledTimes(1);
    expect(mocks.runReminder).toHaveBeenCalledWith(expect.objectContaining({
      reminderType: 'marks_entry_reminder',
      senderId: null,
      timezone: 'Africa/Mogadishu',
      reminderOccurrence: 'scheduled:marks_entry_reminder:2026-10-07:15:00@Africa/Mogadishu',
    }));
  });

  it('continues with the other reminder type when one schedule is invalid', async () => {
    mocks.isScheduleDue.mockImplementation((item: any) => {
      if (item.reminder_type === 'lesson_plan_reminder') throw new Error('invalid timezone');
      return true;
    });
    const res = response();
    await cronHandler({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res);

    expect(res.statusCode).toBe(502);
    expect(mocks.runReminder).toHaveBeenCalledTimes(1);
    expect(mocks.runReminder).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'marks_entry_reminder' }));
    expect(res.body.failures).toEqual(['lesson_plan_reminder']);
  });

  it('refuses cron requests without the configured secret', async () => {
    mocks.cronAuthorizationMatches.mockReturnValue(false);
    const res = response();
    await cronHandler({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mocks.createSource).not.toHaveBeenCalled();
  });
});
