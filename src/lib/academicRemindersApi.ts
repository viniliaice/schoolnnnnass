import { supabase } from './supabase';

export interface AcademicReminderTaskView {
  reminderType: 'lesson_plan_reminder' | 'marks_entry_reminder';
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
  examScope?: string;
  month?: string | null;
  outstandingAssignments?: Array<{
    assignmentId: string;
    className: string;
    subjectId: string;
    subjectName: string;
    expectedStudents: number;
    enteredStudents: number;
    completionPercent: number;
    status: string;
    missingCount: number;
  }>;
  outstandingStudents?: number;
  lastReminder?: {
    status: string;
    attemptedAt: string;
    deliveredDevices: number;
    failedDevices: number;
    expiredDevices: number;
    lastError: string | null;
    occurrence: string | null;
    title: string | null;
  } | null;
  subscription?: {
    activeSubscriptions: number;
    realActiveSubscriptions: number;
    hasRealDevice: boolean;
  };
}

export interface AcademicReminderScheduleView {
  reminderType: 'lesson_plan_reminder' | 'marks_entry_reminder';
  enabled: boolean;
  timezone: string;
  daysOfWeek: number[];
  sendTime: string;
  examScope: string;
}

export interface AcademicReminderTypeSnapshot {
  academicPeriod?: string;
  periodLabel?: string;
  tasks: AcademicReminderTaskView[];
  error?: string;
}

export interface AcademicReminderTasksResponse {
  timezone?: string;
  schedules: AcademicReminderScheduleView[];
  lesson_plan_reminder: AcademicReminderTypeSnapshot;
  marks_entry_reminder: AcademicReminderTypeSnapshot;
}

export async function academicReminderApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error('Could not verify your signed-in session. Sign in again and retry.');
  const token = data.session?.access_token;
  if (!token) throw new Error('Your signed-in session has expired. Sign in again and retry.');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Reminder request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}
