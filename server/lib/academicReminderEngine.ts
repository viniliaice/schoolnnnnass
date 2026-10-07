/**
 * Shared server-side academic reminder engine.
 *
 * Eligibility is intentionally delegated to the existing lesson-plan helper
 * and `monitor_marks_entries` RPC. This module only derives one recipient per
 * teacher, creates a deterministic event key, and hands sends to the existing
 * Web Push notification sender.
 */

import { createHash } from 'node:crypto';
import {
  buildLessonPlanReminderProgress,
  type LessonPlanReminderPlan,
} from '../../src/lib/academicReminders.js';
import {
  marksScopeLabel,
  normalizeMarksEntryRows,
  summarizeMarksEntryRows,
  type MarksExamScope,
} from '../../src/lib/marksEntryTracking.js';
import type { ExpectedSubmitter } from '../../src/lib/lessonPlanSubmissionTracking.js';
import { makeWeekLabel, weekNumberForDate } from '../../src/utils/weekDates.js';
import {
  sendTeacherNotification,
  type AcademicReminderStage,
  type AcademicReminderType,
  type NotificationDb,
  type ReminderRecipientMetadata,
  type SendSummary,
  type TeacherProfile,
} from './notificationSender.js';
import type { VapidConfig } from './webpush.js';

export const DEFAULT_SCHOOL_TIMEZONE = 'Africa/Mogadishu';
export const DAILY_CRON_LOCAL_SEND_TIME = '16:00';
export const ACADEMIC_REMINDER_TYPES: AcademicReminderType[] = [
  'lesson_plan_reminder',
  'marks_entry_reminder',
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Sunday: 0, Mon: 1, Monday: 1, Tue: 2, Tuesday: 2,
  Wed: 3, Wednesday: 3, Thu: 4, Thursday: 4, Fri: 5, Friday: 5,
  Sat: 6, Saturday: 6,
};

export interface ReminderSchedule {
  reminder_type: AcademicReminderType;
  enabled: boolean;
  timezone: string;
  days_of_week: number[];
  send_time: string;
  exam_scope: MarksExamScope;
  updated_by?: string | null;
  updated_at?: string | null;
}

export interface AcademicYearRecord {
  id: string;
  name: string;
  startDate: string;
  endDate?: string | null;
  isCurrent?: boolean;
}

export interface AcademicTermRecord {
  id: string;
  name: string;
  academicYearId: string;
  startDate: string;
  endDate: string;
  months: string[];
  isCurrent?: boolean;
}

export interface AcademicPeriodContext {
  timezone: string;
  schoolDate: string;
  schoolMonth: string;
  schoolDayOfWeek: number;
  year: AcademicYearRecord;
  term: AcademicTermRecord | null;
}

export interface ReminderTeacherProfile extends TeacherProfile {
  role?: string | null;
}

export interface LessonPlanReminderSnapshot {
  submitters: ExpectedSubmitter[];
  plans: LessonPlanReminderPlan[];
}

export interface MarksMonitorQuery {
  academicYearId: string;
  termId: string;
  examScope: MarksExamScope;
  month: string | null;
  teacherId?: string | null;
}

export interface AcademicReminderDataSource {
  getCurrentAcademicYear(): Promise<AcademicYearRecord | null>;
  getCurrentTerm(academicYearId: string): Promise<AcademicTermRecord | null>;
  getAcademicPeriodForMonth?(calendarYear: number, month: string): Promise<{
    year: AcademicYearRecord;
    term: AcademicTermRecord | null;
  } | null>;
  getTeacherRoster(): Promise<ReminderTeacherProfile[]>;
  getLessonPlanSnapshot(weekLabel: string): Promise<LessonPlanReminderSnapshot>;
  getMarksMonitorRows(query: MarksMonitorQuery): Promise<unknown>;
  getSchedules(): Promise<ReminderSchedule[]>;
  updateSchedule(
    reminderType: AcademicReminderType,
    patch: Pick<ReminderSchedule, 'enabled' | 'timezone' | 'days_of_week' | 'send_time' | 'exam_scope'>,
    updatedBy: string,
  ): Promise<ReminderSchedule>;
}

export interface MarksAssignmentTaskDetail {
  assignmentId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  expectedStudents: number;
  enteredStudents: number;
  completionPercent: number;
  status: string;
  missingCount: number;
}

export interface AcademicReminderTask {
  reminderType: AcademicReminderType;
  teacherId: string;
  teacherName: string;
  academicPeriod: string;
  periodLabel: string;
  eligible: boolean;
  completionStatus: 'not_started' | 'incomplete' | 'in_progress' | 'complete' | 'no_task';
  completionPercent: number | null;
  outstandingCount: number;
  outstandingUnits: number;
  outstandingSummary: string;
  eligibilityReason: string;
  assignedClasses: string[];
  submitted?: boolean;
  submittedAt?: string | null;
  reviewStatus?: string | null;
  outstandingPlans?: number;
  outstandingPeriods?: number;
  lessonPlanDetails?: Array<{
    planId: string | null;
    className: string;
    status: string;
    missingPeriods: number;
    completionPercent: number | null;
  }>;
  examScope?: MarksExamScope;
  month?: string | null;
  outstandingAssignments?: MarksAssignmentTaskDetail[];
  outstandingStudents?: number;
  /** Canonical event entity; never contains endpoint or push-key data. */
  relevantEntity: string;
}

export class ReminderScopeError extends Error {
  constructor(message = 'One or more selected teachers are outside your authorized reminder scope.') {
    super(message);
    this.name = 'ReminderScopeError';
  }
}

export interface ReminderRunResult {
  reminderType: AcademicReminderType;
  reminderStage: AcademicReminderStage;
  academicPeriod: string;
  periodLabel: string;
  reminderOccurrence: string;
  tasks: AcademicReminderTask[];
  selectedTeacherIds: string[];
  eligibleTeacherIds: string[];
  alreadyCompleteTeacherIds: string[];
  noTaskTeacherIds: string[];
  summary: SendSummary | null;
}

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function localDateTimeParts(date: Date, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayText = byType.get('weekday') ?? '';
  const weekday = WEEKDAY_INDEX[weekdayText];
  if (weekday === undefined) throw new Error(`Unsupported weekday from timezone ${timezone}.`);
  return {
    year: Number(byType.get('year')),
    month: Number(byType.get('month')),
    day: Number(byType.get('day')),
    hour: Number(byType.get('hour')),
    minute: Number(byType.get('minute')),
    weekday,
  };
}

function localDateKey(parts: LocalDateTimeParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export interface CalendarMonth {
  year: number;
  month: number;
  monthName: string;
  key: string;
}

/** Previous calendar month by the school's wall clock, including year rollover. */
export function previousCalendarMonth(now: Date, timezone = DEFAULT_SCHOOL_TIMEZONE): CalendarMonth {
  const local = localDateTimeParts(now, timezone);
  const month = local.month === 1 ? 12 : local.month - 1;
  const year = local.month === 1 ? local.year - 1 : local.year;
  return {
    year,
    month,
    monthName: MONTH_NAMES[month - 1],
    key: `${year}-${String(month).padStart(2, '0')}`,
  };
}

/** Day-of-month policy for the monthly marks reminder: prompt on the 5th, penalty notice on the 10th. */
export function marksEntryReminderStageForDate(
  now: Date,
  timezone = DEFAULT_SCHOOL_TIMEZONE,
): AcademicReminderStage | null {
  const day = localDateTimeParts(now, timezone).day;
  if (day === 5) return 'reminder';
  if (day === 10) return 'penalty';
  return null;
}

/** Daily Hobby-plan Cron: lesson reminders run at 16:00 Mogadishu on configured weekdays. */
export function isLessonPlanDailyCronDue(schedule: ReminderSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (schedule.reminder_type !== 'lesson_plan_reminder') return false;
  const timezone = schedule.timezone || DEFAULT_SCHOOL_TIMEZONE;
  if (timezone !== DEFAULT_SCHOOL_TIMEZONE || timeString(schedule.send_time) !== DAILY_CRON_LOCAL_SEND_TIME) {
    throw new Error(`Lesson-plan Cron must use ${DAILY_CRON_LOCAL_SEND_TIME} ${DEFAULT_SCHOOL_TIMEZONE}.`);
  }
  if (!Array.isArray(schedule.days_of_week) || schedule.days_of_week.length === 0) return false;
  const local = localDateTimeParts(now, DEFAULT_SCHOOL_TIMEZONE);
  if (!schedule.days_of_week.includes(local.weekday)) return false;
  const [targetHour, targetMinute] = DAILY_CRON_LOCAL_SEND_TIME.split(':').map(Number);
  const elapsed = local.hour * 60 + local.minute - (targetHour * 60 + targetMinute);
  // Permit a delayed Cron delivery for up to 59 minutes after its daily slot.
  return elapsed >= 0 && elapsed < 60;
}

/** The marks schedule is daily, but only the local 5th and 10th have policy actions. */
export function getMarksEntryReminderStage(schedule: ReminderSchedule, now: Date): AcademicReminderStage | null {
  if (!schedule.enabled) return null;
  if (schedule.reminder_type !== 'marks_entry_reminder') return null;
  const timezone = schedule.timezone || DEFAULT_SCHOOL_TIMEZONE;
  if (timezone !== DEFAULT_SCHOOL_TIMEZONE) {
    throw new Error(`Marks-entry policy dates must use ${DEFAULT_SCHOOL_TIMEZONE}.`);
  }
  return marksEntryReminderStageForDate(now, DEFAULT_SCHOOL_TIMEZONE);
}

function timeString(value: string): string {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!match) throw new Error('Reminder send_time must use HH:mm or HH:mm:ss.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Reminder send_time is out of range.');
  return `${match[1]}:${match[2]}`;
}

export function isReminderScheduleDue(
  schedule: ReminderSchedule,
  now: Date,
  graceMinutes = 9,
): boolean {
  if (!schedule.enabled || !Array.isArray(schedule.days_of_week) || schedule.days_of_week.length === 0) return false;
  const parts = localDateTimeParts(now, schedule.timezone || DEFAULT_SCHOOL_TIMEZONE);
  if (!schedule.days_of_week.includes(parts.weekday)) return false;
  const [targetHour, targetMinute] = timeString(schedule.send_time).split(':').map(Number);
  const elapsed = parts.hour * 60 + parts.minute - (targetHour * 60 + targetMinute);
  return elapsed >= 0 && elapsed <= Math.max(0, graceMinutes);
}

export function scheduledReminderOccurrence(
  schedule: ReminderSchedule,
  now: Date,
  stage: AcademicReminderStage = 'reminder',
): string {
  const timezone = schedule.timezone || DEFAULT_SCHOOL_TIMEZONE;
  const parts = localDateTimeParts(now, timezone);
  return `scheduled:${schedule.reminder_type}:${stage}:${localDateKey(parts)}:${timeString(schedule.send_time)}@${timezone}`;
}

export function manualReminderOccurrence(reminderType: AcademicReminderType, requestId: string): string {
  const normalized = requestId.trim();
  if (normalized.length < 8 || normalized.length > 120) throw new Error('requestId must be 8–120 characters.');
  return `manual:${reminderType}:${normalized}`;
}

export function makeReminderDeduplicationKey(input: {
  reminderType: AcademicReminderType;
  teacherId: string;
  academicPeriod: string;
  relevantEntity: string;
  reminderOccurrence: string;
}): string {
  const canonical = JSON.stringify([
    input.reminderType,
    input.teacherId,
    input.academicPeriod,
    input.relevantEntity,
    input.reminderOccurrence,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function loadAcademicPeriodContext(
  source: AcademicReminderDataSource,
  timezone = DEFAULT_SCHOOL_TIMEZONE,
  now = new Date(),
): Promise<AcademicPeriodContext> {
  // Validate the timezone before database access.
  const local = localDateTimeParts(now, timezone);
  const year = await source.getCurrentAcademicYear();
  if (!year) throw new Error('There is no current academic year configured.');
  const term = await source.getCurrentTerm(year.id);
  return {
    timezone,
    schoolDate: localDateKey(local),
    schoolMonth: MONTH_NAMES[local.month - 1],
    schoolDayOfWeek: local.weekday,
    year,
    term,
  };
}

/** Context for the prior calendar month, used by the 5th/10th marks policy. */
export async function loadPreviousMonthAcademicPeriodContext(
  source: AcademicReminderDataSource,
  timezone = DEFAULT_SCHOOL_TIMEZONE,
  now = new Date(),
): Promise<AcademicPeriodContext> {
  const local = localDateTimeParts(now, timezone);
  const month = previousCalendarMonth(now, timezone);
  let period = source.getAcademicPeriodForMonth
    ? await source.getAcademicPeriodForMonth(month.year, month.monthName)
    : null;
  if (!period && !source.getAcademicPeriodForMonth) {
    const year = await source.getCurrentAcademicYear();
    if (year) period = { year, term: await source.getCurrentTerm(year.id) };
  }
  if (!period?.year) throw new Error(`No academic year is configured for ${month.monthName} ${month.year}.`);
  if (!period.term) throw new Error(`No academic term is configured for ${month.monthName} ${month.year}.`);
  return {
    timezone,
    schoolDate: localDateKey(local),
    schoolMonth: month.monthName,
    schoolDayOfWeek: local.weekday,
    year: period.year,
    term: period.term,
  };
}

function teacherNamesById(roster: ReminderTeacherProfile[]): Map<string, string> {
  return new Map(roster.map((teacher) => [teacher.id, teacher.name || 'Unknown teacher']));
}

function filteredSubmitters(
  submitters: ExpectedSubmitter[],
  teacherId?: string,
  allowedClasses?: string[] | null,
): ExpectedSubmitter[] {
  const allowed = allowedClasses ? new Set(allowedClasses) : null;
  return submitters
    .map((submitter) => ({
      ...submitter,
      classes: allowed ? submitter.classes.filter((className) => allowed.has(className)) : submitter.classes,
    }))
    .filter((submitter) => submitter.classes.length > 0 || !allowed)
    .filter((submitter) => !teacherId || submitter.teacherId === teacherId);
}

export async function getLessonPlanReminderTasks(input: {
  source: AcademicReminderDataSource;
  context: AcademicPeriodContext;
  now?: Date;
  teacherId?: string;
  allowedClasses?: string[] | null;
}): Promise<{ weekLabel: string; academicPeriod: string; tasks: AcademicReminderTask[] }> {
  const { source, context } = input;
  const now = input.now ?? new Date();
  const parts = localDateTimeParts(now, context.timezone);
  const localCalendarDate = new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const weekNumber = weekNumberForDate(context.year.startDate, localCalendarDate);
  const weekLabel = makeWeekLabel(context.year.startDate, weekNumber);
  const snapshot = await source.getLessonPlanSnapshot(weekLabel);
  const submitters = filteredSubmitters(snapshot.submitters, input.teacherId, input.allowedClasses);
  const allowedClasses = input.allowedClasses ? new Set(input.allowedClasses) : null;
  const plans = snapshot.plans.filter((plan) =>
    (!input.teacherId || plan.teacher_id === input.teacherId)
    && (!allowedClasses || allowedClasses.has(plan.class_name)),
  );
  const progressRows = buildLessonPlanReminderProgress(submitters, plans);
  const taskByTeacherPlans = new Map<string, LessonPlanReminderPlan[]>();
  for (const plan of plans) {
    const current = taskByTeacherPlans.get(plan.teacher_id) ?? [];
    current.push(plan);
    taskByTeacherPlans.set(plan.teacher_id, current);
  }
  const academicPeriod = `${context.year.id}:${weekLabel}`;

  const tasks = progressRows.map((row): AcademicReminderTask => {
    const relatedPlans = taskByTeacherPlans.get(row.teacherId) ?? [];
    const classes = [...new Set([
      ...row.assignedClasses,
      ...relatedPlans.map((plan) => plan.class_name),
    ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const details = row.outstandingDetails;
    const relevantEntity = JSON.stringify(details
      .map((detail) => ({ className: detail.className, planId: detail.planId }))
      .sort((a, b) => a.className.localeCompare(b.className) || String(a.planId).localeCompare(String(b.planId))));
    const reasonParts = [
      row.outstandingPlans > 0 ? `${row.outstandingPlans} plan(s) outstanding` : '',
      row.outstandingPeriods > 0 ? `${row.outstandingPeriods} required period(s) missing a topic` : '',
      !row.submitted ? 'no submitted plan for this week' : '',
    ].filter(Boolean);

    return {
      reminderType: 'lesson_plan_reminder',
      teacherId: row.teacherId,
      teacherName: row.teacherName,
      academicPeriod,
      periodLabel: `Week ${weekLabel}`,
      eligible: row.eligible,
      completionStatus: row.completionStatus,
      completionPercent: row.completionPercent,
      outstandingCount: row.outstandingPlans,
      outstandingUnits: row.outstandingPeriods,
      outstandingSummary: `${row.outstandingPlans} outstanding plan(s), ${row.outstandingPeriods} missing required period(s)`,
      eligibilityReason: row.eligible
        ? reasonParts.join('; ')
        : row.completionStatus === 'no_task'
          ? 'No current-week lesson plan exists; assigned classes alone do not create a reminder task.'
          : 'All current-week lesson plans are complete.',
      assignedClasses: classes,
      submitted: row.submitted,
      submittedAt: row.submittedAt,
      reviewStatus: row.reviewStatus,
      outstandingPlans: row.outstandingPlans,
      outstandingPeriods: row.outstandingPeriods,
      lessonPlanDetails: details,
      relevantEntity,
    };
  });

  return { weekLabel, academicPeriod, tasks };
}

function monthForTerm(context: AcademicPeriodContext): string {
  const configuredMonth = context.term?.months?.find((month) =>
    month.trim().toLocaleLowerCase() === context.schoolMonth.toLocaleLowerCase(),
  );
  return configuredMonth ?? context.schoolMonth;
}

export async function getMarksEntryReminderTasks(input: {
  source: AcademicReminderDataSource;
  context: AcademicPeriodContext;
  examScope: MarksExamScope;
  teacherId?: string;
  allowedClasses?: string[] | null;
}): Promise<{ academicPeriod: string; periodLabel: string; month: string | null; tasks: AcademicReminderTask[] }> {
  const { source, context, examScope } = input;
  if (!context.term) throw new Error('There is no current term in the current academic year.');
  const month = examScope === 'monthly' ? monthForTerm(context) : null;
  const rawRows = await source.getMarksMonitorRows({
    academicYearId: context.year.id,
    termId: context.term.id,
    examScope,
    month,
    teacherId: input.teacherId ?? null,
  });
  const rows = normalizeMarksEntryRows(rawRows);
  const allowed = input.allowedClasses ? new Set(input.allowedClasses) : null;
  const visibleRows = rows.filter((row) =>
    (!input.teacherId || row.teacherId === input.teacherId)
    && (!allowed || allowed.has(row.className)),
  );
  const assignmentsByTeacher = new Map<string, typeof visibleRows>();
  for (const row of visibleRows) {
    const group = assignmentsByTeacher.get(row.teacherId) ?? [];
    group.push(row);
    assignmentsByTeacher.set(row.teacherId, group);
  }
  const roster = (await source.getTeacherRoster())
    .filter((teacher) => !input.teacherId || teacher.id === input.teacherId)
    .filter((teacher) => !allowed || (teacher.assignedClasses ?? []).some((className) => allowed.has(className)));
  const nameByTeacher = teacherNamesById(roster);
  for (const row of visibleRows) {
    if (!nameByTeacher.has(row.teacherId)) nameByTeacher.set(row.teacherId, row.teacherName);
  }

  const academicPeriod = `${context.year.id}:${context.term.id}:${examScope}:${month ?? 'term'}`;
  const periodLabel = examScope === 'monthly'
    ? `${month} · ${context.term.name} · ${context.year.name}`
    : `${marksScopeLabel(examScope)} · ${context.term.name} · ${context.year.name}`;

  const tasks = [...nameByTeacher.entries()].map(([teacherId, teacherName]): AcademicReminderTask => {
    const teacherRows = assignmentsByTeacher.get(teacherId) ?? [];
    const activeRows = teacherRows.filter((row) => row.expectedStudents > 0);
    const outstandingRows = activeRows.filter((row) => row.status !== 'complete');
    const eligible = outstandingRows.length > 0;
    const outstandingStudents = outstandingRows.reduce(
      (sum, row) => sum + row.missingStudents.length,
      0,
    );
    const completionPercent = activeRows.length === 0
      ? null
      : summarizeMarksEntryRows(activeRows).averagePercentage;
    const completionStatus: AcademicReminderTask['completionStatus'] = activeRows.length === 0
      ? 'no_task'
      : !eligible
        ? 'complete'
        : activeRows.every((row) => row.status === 'not_started')
          ? 'not_started'
          : 'in_progress';
    const assignedClasses = [...new Set((roster.find((teacher) => teacher.id === teacherId)?.assignedClasses ?? [])
      .filter((className) => !allowed || allowed.has(className)))].sort();
    // Stable across progress changes inside the period: include all active
    // class_subject assignment IDs, not just currently incomplete rows.
    const relevantEntity = JSON.stringify(activeRows.map((row) => row.assignmentId).sort());
    const outstandingAssignments: MarksAssignmentTaskDetail[] = outstandingRows.map((row) => ({
      assignmentId: row.assignmentId,
      className: row.className,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      expectedStudents: row.expectedStudents,
      enteredStudents: row.enteredStudents,
      completionPercent: row.percentage,
      status: row.status,
      missingCount: row.missingStudents.length,
    }));
    const reason = outstandingRows.length > 0
      ? `${outstandingRows.length} assigned class/subject row(s) are incomplete (${outstandingStudents} student(s) still missing required entries).`
      : activeRows.length > 0
        ? 'All selected-term class/subject assignments are complete.'
        : 'No active selected-term class/subject roster requires marks entry.';

    return {
      reminderType: 'marks_entry_reminder',
      teacherId,
      teacherName,
      academicPeriod,
      periodLabel,
      eligible,
      completionStatus,
      completionPercent,
      outstandingCount: outstandingRows.length,
      outstandingUnits: outstandingStudents,
      outstandingSummary: `${outstandingRows.length} outstanding assignment(s), ${outstandingStudents} missing student(s)`,
      eligibilityReason: reason,
      assignedClasses,
      examScope,
      month,
      outstandingAssignments,
      outstandingStudents,
      relevantEntity,
    };
  }).sort((a, b) => a.teacherName.localeCompare(b.teacherName) || a.teacherId.localeCompare(b.teacherId));

  return { academicPeriod, periodLabel, month, tasks };
}

export async function evaluateAcademicReminderTasks(input: {
  source: AcademicReminderDataSource;
  reminderType: AcademicReminderType;
  timezone?: string;
  now?: Date;
  context?: AcademicPeriodContext;
  examScope?: MarksExamScope;
  teacherId?: string;
  allowedClasses?: string[] | null;
}): Promise<{ context: AcademicPeriodContext; periodLabel: string; academicPeriod: string; tasks: AcademicReminderTask[] }> {
  const now = input.now ?? new Date();
  const context = input.context ?? await loadAcademicPeriodContext(input.source, input.timezone, now);
  if (input.reminderType === 'lesson_plan_reminder') {
    const lesson = await getLessonPlanReminderTasks({
      source: input.source,
      context,
      now,
      teacherId: input.teacherId,
      allowedClasses: input.allowedClasses,
    });
    return { context, ...lesson, periodLabel: `Week ${lesson.weekLabel}` };
  }
  const marks = await getMarksEntryReminderTasks({
    source: input.source,
    context,
    examScope: input.examScope ?? 'monthly',
    teacherId: input.teacherId,
    allowedClasses: input.allowedClasses,
  });
  return { context, ...marks };
}

function reminderTitle(type: AcademicReminderType, stage: AcademicReminderStage): string {
  if (type === 'lesson_plan_reminder') return 'Lesson Plan Reminder';
  return stage === 'penalty' ? 'Marks Entry Penalty' : 'Marks Entry Reminder';
}

function reminderBody(task: AcademicReminderTask, stage: AcademicReminderStage): string {
  if (task.reminderType === 'lesson_plan_reminder') {
    return `Your lesson plans for ${task.periodLabel} are incomplete. Open the planner to complete your outstanding work.`;
  }
  const month = task.month ?? task.periodLabel;
  if (stage === 'penalty') {
    return `Your ${month} marks entries were not completed by the required deadline. You have been penalized for ${month}.`;
  }
  return `Your ${month} marks entries are incomplete. Open marks entry to complete them.`;
}

export async function runAcademicReminder(input: {
  source: AcademicReminderDataSource;
  notificationDb: NotificationDb;
  vapid: VapidConfig;
  reminderType: AcademicReminderType;
  reminderStage?: AcademicReminderStage;
  senderId: string | null;
  reminderOccurrence: string;
  now?: Date;
  timezone?: string;
  context?: AcademicPeriodContext;
  examScope?: MarksExamScope;
  teacherIds?: string[];
  teacherId?: string;
  allowedClasses?: string[] | null;
  makeId?: (prefix: string) => string;
  fetchImpl?: typeof fetch;
}): Promise<ReminderRunResult> {
  const reminderStage = input.reminderStage ?? 'reminder';
  if (input.reminderType === 'lesson_plan_reminder' && reminderStage !== 'reminder') {
    throw new Error('Lesson-plan reminders do not support a penalty stage.');
  }
  const evaluation = await evaluateAcademicReminderTasks({
    source: input.source,
    reminderType: input.reminderType,
    timezone: input.timezone,
    now: input.now,
    context: input.context,
    examScope: input.examScope,
    teacherId: input.teacherId,
    allowedClasses: input.allowedClasses,
  });
  const selectedIds = input.teacherIds ? new Set(input.teacherIds) : null;
  const selectedTasks = evaluation.tasks.filter((task) => !selectedIds || selectedIds.has(task.teacherId));
  if (selectedIds) {
    const visibleIds = new Set(evaluation.tasks.map((task) => task.teacherId));
    const unauthorized = [...selectedIds].filter((teacherId) => !visibleIds.has(teacherId));
    if (unauthorized.length > 0) throw new ReminderScopeError();
  }

  const eligibleTasks = selectedTasks.filter((task) => task.eligible);
  const alreadyCompleteTasks = selectedTasks.filter((task) => task.completionStatus === 'complete');
  const noTaskTasks = selectedTasks.filter((task) => task.completionStatus === 'no_task');
  const alreadyCompleteTeacherIds = alreadyCompleteTasks.map((task) => task.teacherId);
  const noTaskTeacherIds = noTaskTasks.map((task) => task.teacherId);
  const eligibleTeacherIds = eligibleTasks.map((task) => task.teacherId);
  let summary: SendSummary | null = null;

  if (eligibleTasks.length > 0) {
    const entries: Record<string, ReminderRecipientMetadata> = {};
    for (const task of eligibleTasks) {
      entries[task.teacherId] = {
        academicPeriod: task.academicPeriod,
        relevantEntity: task.relevantEntity,
        reminderOccurrence: input.reminderOccurrence,
        deduplicationKey: makeReminderDeduplicationKey({
          reminderType: input.reminderType,
          teacherId: task.teacherId,
          academicPeriod: task.academicPeriod,
          relevantEntity: task.relevantEntity,
          reminderOccurrence: input.reminderOccurrence,
        }),
      };
    }
    const request = {
      audience: 'teachers' as const,
      teacherIds: [...new Set([...eligibleTeacherIds, ...alreadyCompleteTeacherIds])],
      title: reminderTitle(input.reminderType, reminderStage),
      body: reminderBody(eligibleTasks[0], reminderStage),
      category: input.reminderType,
      url: input.reminderType === 'lesson_plan_reminder' ? '/teacher/lesson-plans' : '/teacher/results',
      reminder: {
        reminderType: input.reminderType,
        reminderStage,
        academicPeriod: eligibleTasks[0].academicPeriod,
        reminderOccurrence: input.reminderOccurrence,
        entries,
        taskAlreadyCompletedTeacherIds: alreadyCompleteTeacherIds,
      },
    };
    summary = await sendTeacherNotification({
      request,
      senderId: input.senderId,
      db: input.notificationDb,
      vapid: input.vapid,
      makeId: input.makeId,
      fetchImpl: input.fetchImpl,
    });
  }

  return {
    reminderType: input.reminderType,
    reminderStage,
    academicPeriod: evaluation.academicPeriod,
    periodLabel: evaluation.periodLabel,
    reminderOccurrence: input.reminderOccurrence,
    tasks: selectedTasks,
    selectedTeacherIds: selectedTasks.map((task) => task.teacherId),
    eligibleTeacherIds,
    alreadyCompleteTeacherIds,
    noTaskTeacherIds,
    summary,
  };
}
