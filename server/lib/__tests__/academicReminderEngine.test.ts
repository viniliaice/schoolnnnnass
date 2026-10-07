import { describe, expect, it } from 'vitest';
import { deviceKeys } from '../../../src/lib/__tests__/helpers/fakeNetwork.js';
import {
  DEFAULT_SCHOOL_TIMEZONE,
  getLessonPlanReminderTasks,
  getMarksEntryReminderTasks,
  getMarksEntryReminderStage,
  isLessonPlanDailyCronDue,
  isReminderScheduleDue,
  loadAcademicPeriodContext,
  loadPreviousMonthAcademicPeriodContext,
  marksEntryReminderStageForDate,
  previousCalendarMonth,
  localDateTimeParts,
  makeReminderDeduplicationKey,
  manualReminderOccurrence,
  runAcademicReminder,
  scheduledReminderOccurrence,
  type AcademicReminderDataSource,
  type LessonPlanReminderSnapshot,
  type ReminderSchedule,
} from '../academicReminderEngine.js';
import { generateVapidKeys } from '../webpush.js';
import type { NotificationDb, PushSubRow, ReminderRecipientInsert } from '../notificationSender.js';

const NOW = new Date('2026-10-07T09:00:00.000Z'); // 12:00 Africa/Mogadishu, Wednesday
const YEAR = { id: 'year-2026', name: '2026/2027', startDate: '2026-08-01', endDate: '2027-06-30', isCurrent: true };
const TERM = {
  id: 'term-1', name: 'Term 1', academicYearId: YEAR.id, startDate: '2026-08-01', endDate: '2026-12-31',
  months: ['September', 'October', 'November'], isCurrent: true,
};
const incompleteMarkRow = {
  assignment_id: 'cs-grade8-english',
  teacher_id: 'teacher-1',
  teacher_name: 'Teacher One',
  class_name: 'Grade 8-A',
  subject_id: 'english',
  subject_name: 'English',
  academic_year_id: YEAR.id,
  term_id: TERM.id,
  exam_scope: 'monthly',
  month: 'October',
  expected_students: 2,
  entered_students: 1,
  missing_students: [{ id: 'student-2', name: 'Student Two' }],
  percentage: 50,
  homework_ca_entered: 1,
  classwork_entered: 0,
  quiz_entered: 0,
  attendance_entered: 0,
  coursework_complete: false,
  quiz_complete: false,
  monthly_complete_students: 0,
};
const completeMarkRow = {
  ...incompleteMarkRow,
  assignment_id: 'cs-grade8-math',
  subject_id: 'math',
  subject_name: 'Mathematics',
  expected_students: 2,
  entered_students: 2,
  missing_students: [],
  percentage: 100,
  homework_ca_entered: 2,
  classwork_entered: 2,
  quiz_entered: 2,
  coursework_complete: true,
  quiz_complete: true,
  monthly_complete_students: 2,
};

function dataSource(overrides: Partial<AcademicReminderDataSource> = {}): AcademicReminderDataSource {
  const snapshot: LessonPlanReminderSnapshot = {
    submitters: [{ teacherId: 'teacher-1', teacherName: 'Teacher One', classes: ['Grade 8-A', 'Grade 8-B'] }],
    plans: [],
  };
  return {
    getCurrentAcademicYear: async () => YEAR,
    getCurrentTerm: async () => TERM,
    getAcademicPeriodForMonth: async () => ({ year: YEAR, term: TERM }),
    getTeacherRoster: async () => [
      { id: 'teacher-1', name: 'Teacher One', role: 'teacher', assignedClasses: ['Grade 8-A', 'Grade 8-B'] },
      { id: 'teacher-2', name: 'Teacher Two', role: 'teacher', assignedClasses: ['Grade 8-C'] },
    ],
    getLessonPlanSnapshot: async () => snapshot,
    getMarksMonitorRows: async () => [incompleteMarkRow, completeMarkRow],
    getSchedules: async () => [],
    updateSchedule: async (reminderType, patch, updatedBy) => ({
      reminder_type: reminderType,
      ...patch,
      updated_by: updatedBy,
    }),
    ...overrides,
  };
}

function oneIncompleteLessonPlan(): LessonPlanReminderSnapshot {
  const days = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];
  const periods = days.map((day, index) => ({
    id: `period-${index}`,
    plan_id: 'plan-1',
    day,
    period_number: 1,
    subject: 'English',
    is_free: false,
    topic: index === 0 ? '' : `Topic ${index}`,
  }));
  return {
    submitters: [{ teacherId: 'teacher-1', teacherName: 'Teacher One', classes: ['Grade 8-A', 'Grade 8-B'] }],
    plans: [{
      id: 'plan-1',
      teacher_id: 'teacher-1',
      teacher_name: 'Teacher One',
      class_name: 'Grade 8-A',
      week_label: '2026-W10',
      status: 'draft',
      period_count: 1,
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z',
      periods,
    }],
  };
}

function memoryNotificationDb(teachers: Array<{ id: string; name: string }>, subscriptions: PushSubRow[]) {
  const notifications: any[] = [];
  const recipients: any[] = [];
  const deactivated: string[] = [];
  let sequence = 0;
  const db: NotificationDb = {
    listTeachers: async ({ teacherIds }) => teachers.filter((teacher) => !teacherIds || teacherIds.includes(teacher.id)),
    getActiveSubscriptions: async (userIds) => subscriptions.filter((sub) => userIds.includes(sub.user_id) && sub.is_active),
    getPreferences: async (userIds) => userIds.map((user_id) => ({
      user_id,
      push_enabled: true,
      announcements: true,
      messages: true,
      lesson_plan_reminders: true,
      marks_entry_reminders: true,
      admin_alerts: true,
    })),
    insertNotification: async (row) => { notifications.push(row); },
    insertRecipients: async (rows) => { recipients.push(...rows); },
    claimReminderRecipients: async (rows) => {
      const claimed: Array<Pick<ReminderRecipientInsert, 'id' | 'user_id' | 'deduplication_key'>> = [];
      for (const row of rows) {
        if (recipients.some((existing) => existing.deduplication_key === row.deduplication_key)) continue;
        recipients.push({ ...row });
        claimed.push({ id: row.id, user_id: row.user_id, deduplication_key: row.deduplication_key });
      }
      return claimed;
    },
    updateRecipient: async (notificationId, userId, patch) => {
      const recipient = recipients.find((row) => row.notification_id === notificationId && row.user_id === userId);
      if (recipient) Object.assign(recipient, patch);
    },
    deactivateSubscription: async (endpoint) => { deactivated.push(endpoint); },
    deleteNotification: async (id) => {
      const index = notifications.findIndex((row) => row.id === id);
      if (index >= 0) notifications.splice(index, 1);
    },
  };
  return {
    db,
    notifications,
    recipients,
    deactivated,
    makeId: (prefix: string) => `${prefix}-${++sequence}`,
  };
}

const schedule: ReminderSchedule = {
  reminder_type: 'marks_entry_reminder',
  enabled: true,
  timezone: DEFAULT_SCHOOL_TIMEZONE,
  days_of_week: [3],
  send_time: '12:00',
  exam_scope: 'monthly',
};

describe('academic reminder scheduling and eligibility', () => {
  it('uses the configured school timezone, independent of the server timezone', () => {
    expect(localDateTimeParts(NOW, DEFAULT_SCHOOL_TIMEZONE)).toMatchObject({
      year: 2026, month: 10, day: 7, hour: 12, minute: 0, weekday: 3,
    });
    expect(isReminderScheduleDue(schedule, NOW)).toBe(true);
    expect(isReminderScheduleDue(schedule, new Date('2026-10-07T09:08:00.000Z'))).toBe(true);
    expect(isReminderScheduleDue(schedule, new Date('2026-10-07T09:10:00.000Z'))).toBe(false);
    expect(isReminderScheduleDue({ ...schedule, enabled: false }, NOW)).toBe(false);
    expect(isReminderScheduleDue({ ...schedule, days_of_week: [2] }, NOW)).toBe(false);
  });

  it('uses the daily Hobby cron window for lesson plans and the marks 5th/10th policy', () => {
    const lessonSchedule: ReminderSchedule = {
      ...schedule,
      reminder_type: 'lesson_plan_reminder',
      timezone: DEFAULT_SCHOOL_TIMEZONE,
      days_of_week: [3],
      send_time: '16:00',
    };
    expect(isLessonPlanDailyCronDue(lessonSchedule, new Date('2026-10-07T13:04:00.000Z'))).toBe(true);
    expect(isLessonPlanDailyCronDue(lessonSchedule, new Date('2026-10-07T14:00:00.000Z'))).toBe(false);
    expect(isLessonPlanDailyCronDue({ ...lessonSchedule, days_of_week: [2] }, new Date('2026-10-07T13:00:00.000Z'))).toBe(false);

    expect(marksEntryReminderStageForDate(new Date('2026-10-05T12:00:00.000Z'))).toBe('reminder');
    expect(marksEntryReminderStageForDate(new Date('2026-10-10T12:00:00.000Z'))).toBe('penalty');
    expect(marksEntryReminderStageForDate(new Date('2026-10-06T12:00:00.000Z'))).toBeNull();
    expect(getMarksEntryReminderStage({ ...schedule, days_of_week: [0] }, new Date('2026-10-05T12:00:00.000Z'))).toBe('reminder');
    expect(getMarksEntryReminderStage({ ...schedule, enabled: false }, new Date('2026-10-05T12:00:00.000Z'))).toBeNull();
  });

  it('resolves the previous calendar month in Africa/Mogadishu, including January rollover', async () => {
    expect(previousCalendarMonth(new Date('2026-01-05T12:00:00.000Z'))).toEqual({
      year: 2025, month: 12, monthName: 'December', key: '2025-12',
    });
    expect(previousCalendarMonth(new Date('2026-03-05T12:00:00.000Z'))).toMatchObject({
      year: 2026, month: 2, monthName: 'February', key: '2026-02',
    });
    const requested: Array<[number, string]> = [];
    const source = dataSource({
      getAcademicPeriodForMonth: async (year, month) => {
        requested.push([year, month]);
        return { year: YEAR, term: TERM };
      },
    });
    const context = await loadPreviousMonthAcademicPeriodContext(source, DEFAULT_SCHOOL_TIMEZONE, NOW);
    expect(requested).toEqual([[2026, 'September']]);
    expect(context).toMatchObject({ schoolMonth: 'September', year: YEAR, term: TERM, schoolDate: '2026-10-07' });
  });

  it('creates stable occurrence labels and separate per-type/entity/stage deduplication keys', () => {
    const occurrence = scheduledReminderOccurrence(schedule, NOW);
    expect(occurrence).toBe('scheduled:marks_entry_reminder:reminder:2026-10-07:12:00@Africa/Mogadishu');
    expect(manualReminderOccurrence('lesson_plan_reminder', 'request-12345'))
      .toBe('manual:lesson_plan_reminder:request-12345');
    const base = {
      reminderType: 'lesson_plan_reminder' as const,
      teacherId: 'teacher-1',
      academicPeriod: 'year-2026:2026-W10',
      relevantEntity: '[{"className":"Grade 8-A","planId":"plan-1"}]',
      reminderOccurrence: occurrence,
    };
    const key = makeReminderDeduplicationKey(base);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(makeReminderDeduplicationKey(base)).toBe(key);
    expect(makeReminderDeduplicationKey({ ...base, reminderType: 'marks_entry_reminder' })).not.toBe(key);
    expect(makeReminderDeduplicationKey({ ...base, teacherId: 'teacher-2' })).not.toBe(key);
    expect(makeReminderDeduplicationKey({ ...base, academicPeriod: 'year-2026:2026-W11' })).not.toBe(key);
    expect(makeReminderDeduplicationKey({ ...base, reminderOccurrence: 'manual:lesson_plan_reminder:request-99999' })).not.toBe(key);
    const penaltyOccurrence = scheduledReminderOccurrence(schedule, NOW, 'penalty');
    expect(penaltyOccurrence).not.toBe(occurrence);
    expect(makeReminderDeduplicationKey({ ...base, reminderOccurrence: penaltyOccurrence })).not.toBe(key);
  });

  it('does not remind merely because a teacher has assigned classes without a current-week plan', async () => {
    const source = dataSource();
    const context = await loadAcademicPeriodContext(source, DEFAULT_SCHOOL_TIMEZONE, NOW);
    const result = await getLessonPlanReminderTasks({ source, context, now: NOW });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      teacherId: 'teacher-1',
      assignedClasses: ['Grade 8-A', 'Grade 8-B'],
      completionStatus: 'no_task',
      outstandingCount: 0,
      eligible: false,
    });
  });

  it('uses actual incomplete lesson-plan rows, summarizeDay free-period rules, and submission state', async () => {
    const snapshot = oneIncompleteLessonPlan();
    const source = dataSource({ getLessonPlanSnapshot: async () => snapshot });
    const context = await loadAcademicPeriodContext(source, DEFAULT_SCHOOL_TIMEZONE, NOW);
    const result = await getLessonPlanReminderTasks({ source, context, now: NOW });
    expect(result.tasks[0]).toMatchObject({
      completionStatus: 'incomplete',
      eligible: true,
      submitted: false,
      outstandingPlans: 1,
      outstandingPeriods: 1,
      lessonPlanDetails: [{ planId: 'plan-1', className: 'Grade 8-A', status: 'draft', missingPeriods: 1 }],
    });
    expect(result.tasks[0].eligibilityReason).toContain('no submitted plan for this week');
  });

  it('delegates marks assignments and completion to monitor_marks_entries and ignores unassigned work', async () => {
    const source = dataSource();
    const context = await loadAcademicPeriodContext(source, DEFAULT_SCHOOL_TIMEZONE, NOW);
    const result = await getMarksEntryReminderTasks({ source, context, examScope: 'monthly' });
    expect(result.month).toBe('October');
    expect(result.academicPeriod).toBe('year-2026:term-1:monthly:October');
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.find((task) => task.teacherId === 'teacher-1')).toMatchObject({
      eligible: true,
      completionStatus: 'in_progress',
      outstandingCount: 1,
      outstandingUnits: 1,
      outstandingStudents: 1,
      outstandingAssignments: [{ assignmentId: 'cs-grade8-english', completionPercent: 50 }],
    });
    expect(result.tasks.find((task) => task.teacherId === 'teacher-2')).toMatchObject({
      eligible: false,
      completionStatus: 'no_task',
      outstandingCount: 0,
    });
  });
});

describe('academic reminder send orchestration', () => {
  it('claims one reminder per deterministic teacher/type/period/entity/occurrence key and never double-sends a retry', async () => {
    const source = dataSource();
    const sub: PushSubRow = {
      id: 'sub-1',
      user_id: 'teacher-1',
      endpoint: 'https://push.example.test/device/one',
      ...deviceKeys(),
      is_active: true,
    };
    const memory = memoryNotificationDb([{ id: 'teacher-1', name: 'Teacher One' }], [sub]);
    const vapid = { privateKey: generateVapidKeys().privateKey, subject: 'mailto:reminders@example.school' };
    let pushCount = 0;
    const fetchImpl = (async () => {
      pushCount += 1;
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const options = {
      source,
      notificationDb: memory.db,
      vapid,
      reminderType: 'marks_entry_reminder' as const,
      senderId: null,
      reminderOccurrence: scheduledReminderOccurrence(schedule, NOW),
      now: NOW,
      timezone: DEFAULT_SCHOOL_TIMEZONE,
      examScope: 'monthly' as const,
      makeId: memory.makeId,
      fetchImpl,
    };

    const first = await runAcademicReminder(options);
    const second = await runAcademicReminder(options);
    expect(first.summary).toMatchObject({ sent: 1, devicesDelivered: 1, deliveryOk: true });
    expect(second.summary).toMatchObject({ sent: 0, alreadyReminded: 1, deliveryOk: false });
    expect(pushCount).toBe(1);
    expect(memory.recipients).toHaveLength(1);
    expect(memory.recipients[0]).toMatchObject({
      reminder_type: 'marks_entry_reminder',
      status: 'sent',
      academic_period: 'year-2026:term-1:monthly:October',
      reminder_occurrence: 'scheduled:marks_entry_reminder:reminder:2026-10-07:12:00@Africa/Mogadishu',
    });

    const completedSource = dataSource({ getMarksMonitorRows: async () => [{
      ...incompleteMarkRow,
      entered_students: 2,
      missing_students: [],
      percentage: 100,
      homework_ca_entered: 2,
      classwork_entered: 2,
      quiz_entered: 2,
      coursework_complete: true,
      quiz_complete: true,
      monthly_complete_students: 2,
    }] });
    const complete = await runAcademicReminder({ ...options, source: completedSource });
    expect(complete.eligibleTeacherIds).toEqual([]);
    expect(complete.summary).toBeNull();
    expect(pushCount).toBe(1);
  });

  it('sends a previous-month penalty notice only while marks remain incomplete and records the penalty stage', async () => {
    const now = new Date('2026-10-10T13:00:00.000Z'); // October 10, 16:00 Africa/Mogadishu
    const context = await loadPreviousMonthAcademicPeriodContext(dataSource(), DEFAULT_SCHOOL_TIMEZONE, now);
    const sub: PushSubRow = {
      id: 'sub-1',
      user_id: 'teacher-1',
      endpoint: 'https://push.example.test/device/one',
      ...deviceKeys(),
      is_active: true,
    };
    const memory = memoryNotificationDb([{ id: 'teacher-1', name: 'Teacher One' }], [sub]);
    let pushCount = 0;
    const fetchImpl = (async () => {
      pushCount += 1;
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const options = {
      source: dataSource(),
      notificationDb: memory.db,
      vapid: { privateKey: generateVapidKeys().privateKey, subject: 'mailto:reminders@example.school' },
      reminderType: 'marks_entry_reminder' as const,
      reminderStage: 'penalty' as const,
      senderId: null,
      reminderOccurrence: scheduledReminderOccurrence(schedule, now, 'penalty'),
      now,
      timezone: DEFAULT_SCHOOL_TIMEZONE,
      context,
      examScope: 'monthly' as const,
      makeId: memory.makeId,
      fetchImpl,
    };

    const result = await runAcademicReminder(options);
    expect(result.academicPeriod).toBe('year-2026:term-1:monthly:September');
    expect(memory.notifications[0]).toMatchObject({
      title: 'Marks Entry Penalty',
      body: 'Your September marks entries were not completed by the required deadline. You have been penalized for September.',
    });
    expect(memory.recipients[0]).toMatchObject({ reminder_stage: 'penalty', status: 'sent' });
    expect(result.summary).toMatchObject({ sent: 1, deliveryOk: true });

    const completeMemory = memoryNotificationDb([{ id: 'teacher-1', name: 'Teacher One' }], [sub]);
    const completed = await runAcademicReminder({
      ...options,
      source: dataSource({ getMarksMonitorRows: async () => [completeMarkRow] }),
      notificationDb: completeMemory.db,
    });
    expect(completed.eligibleTeacherIds).toEqual([]);
    expect(completed.summary).toBeNull();
    expect(pushCount).toBe(1);
  });

  it('rejects a manually selected teacher outside the calculated role/class scope', async () => {
    const source = dataSource();
    const memory = memoryNotificationDb([], []);
    await expect(runAcademicReminder({
      source,
      notificationDb: memory.db,
      vapid: { privateKey: generateVapidKeys().privateKey, subject: 'mailto:reminders@example.school' },
      reminderType: 'marks_entry_reminder',
      senderId: 'admin-1',
      reminderOccurrence: manualReminderOccurrence('marks_entry_reminder', 'request-12345'),
      now: NOW,
      timezone: DEFAULT_SCHOOL_TIMEZONE,
      examScope: 'monthly',
      teacherIds: ['unassigned-teacher'],
      allowedClasses: ['Grade 8-A'],
    })).rejects.toThrow(/outside your authorized reminder scope/);
  });
});
