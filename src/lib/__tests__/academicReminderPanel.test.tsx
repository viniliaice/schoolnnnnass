// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useRole, api } = vi.hoisted(() => ({
  useRole: vi.fn(),
  api: vi.fn(),
}));

vi.mock('../../context/RoleContext', () => ({ useRole }));
vi.mock('../academicRemindersApi', () => ({ academicReminderApi: api }));

import { AcademicReminderPanel } from '../../components/academic-reminders/AcademicReminderPanel';

const lessonTask = (teacherId: string, eligible: boolean) => ({
  reminderType: 'lesson_plan_reminder' as const,
  teacherId,
  teacherName: teacherId === 'teacher-1' ? 'Teacher One' : 'Teacher Two',
  academicPeriod: 'year-2026:2026-W10',
  periodLabel: 'Week 2026-W10',
  eligible,
  completionStatus: eligible ? 'incomplete' as const : 'complete' as const,
  completionPercent: eligible ? 80 : 100,
  outstandingCount: eligible ? 1 : 0,
  outstandingUnits: eligible ? 1 : 0,
  outstandingSummary: eligible ? '1 outstanding plan, 1 missing period' : '0 outstanding plans',
  eligibilityReason: eligible ? 'One required topic is missing.' : 'All current-week plans are complete.',
  assignedClasses: ['Grade 8-A'],
  lessonPlanDetails: eligible ? [{ planId: 'plan-1', className: 'Grade 8-A', status: 'draft', missingPeriods: 1, completionPercent: 80 }] : [],
  lastReminder: null,
});

const marksTask = (teacherId: string, eligible: boolean) => ({
  reminderType: 'marks_entry_reminder' as const,
  teacherId,
  teacherName: teacherId === 'teacher-1' ? 'Teacher One' : 'Teacher Two',
  academicPeriod: 'year-2026:term-1:monthly:October',
  periodLabel: 'October · Term 1',
  eligible,
  completionStatus: eligible ? 'in_progress' as const : 'no_task' as const,
  completionPercent: eligible ? 50 : null,
  outstandingCount: eligible ? 1 : 0,
  outstandingUnits: eligible ? 1 : 0,
  outstandingSummary: eligible ? '1 outstanding assignment, 1 missing student' : '0 outstanding assignments',
  eligibilityReason: eligible ? 'One student still needs marks.' : 'No active selected-term class/subject roster requires marks entry.',
  assignedClasses: ['Grade 8-A'],
  examScope: 'monthly',
  month: 'October',
  outstandingAssignments: eligible ? [{ assignmentId: 'cs-1', className: 'Grade 8-A', subjectId: 'english', subjectName: 'English', expectedStudents: 2, enteredStudents: 1, completionPercent: 50, status: 'in_progress', missingCount: 1 }] : [],
  lastReminder: null,
});

const schedules = [
  { reminderType: 'lesson_plan_reminder' as const, enabled: true, timezone: 'Africa/Mogadishu', daysOfWeek: [1, 2, 3, 4, 5], sendTime: '16:00', examScope: 'monthly' },
  { reminderType: 'marks_entry_reminder' as const, enabled: true, timezone: 'Africa/Mogadishu', daysOfWeek: [1, 2, 3, 4, 5], sendTime: '16:00', examScope: 'monthly' },
];

function taskResponse(staff: boolean) {
  return {
    timezone: 'Africa/Mogadishu',
    schedules: staff ? schedules : [],
    lesson_plan_reminder: { academicPeriod: 'year-2026:2026-W10', periodLabel: 'Week 2026-W10', tasks: [lessonTask('teacher-1', true), ...(staff ? [lessonTask('teacher-2', false)] : [])] },
    marks_entry_reminder: { academicPeriod: 'year-2026:term-1:monthly:October', periodLabel: 'October · Term 1', tasks: [marksTask('teacher-1', true), ...(staff ? [marksTask('teacher-2', false)] : [])] },
  };
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><AcademicReminderPanel /></QueryClientProvider>);
  });
  await flush(() => host.textContent?.includes('Lesson plans') && !host.textContent?.includes('Loading current academic tasks'));
}

async function flush(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  if (!predicate()) throw new Error('Timed out waiting for reminder panel update.');
}

function findButton(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (path: string, init: RequestInit = {}) => {
    if (path === '/api/academic-reminders/tasks') return taskResponse(useRole().session.role !== 'teacher');
    if (path === '/api/academic-reminders/send') return {
      reminderType: 'marks_entry_reminder',
      deliveryOk: true,
      message: 'All eligible reminders accepted by the push service.',
      summary: { sent: 1, failed: 0, noSubscription: 0, alreadyReminded: 0 },
    };
    if (path === '/api/academic-reminders/schedules') {
      const body = JSON.parse(String(init.body));
      return { schedule: { ...body, reminder_type: body.reminderType, days_of_week: body.daysOfWeek, send_time: body.sendTime, exam_scope: body.examScope } };
    }
    throw new Error(`unexpected API path ${path}`);
  });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  queryClient?.clear();
});

describe('AcademicReminderPanel', () => {
  it('shows only the teacher’s own tasks with distinct reminder tabs and no staff controls', async () => {
    useRole.mockReturnValue({ session: { role: 'teacher', userId: 'teacher-1' } });
    await mount();

    expect(host.textContent).toContain('My academic task');
    expect(host.textContent).toContain('One required topic is missing.');
    expect(host.textContent).not.toContain('Manual send');
    expect(host.textContent).not.toContain('Schedule settings');
    expect(host.querySelectorAll('[data-testid^="academic-reminder-task-"]')).toHaveLength(1);

    await click(findButton('Marks entry'));
    expect(host.textContent).toContain('One student still needs marks.');
    expect(host.textContent).not.toContain('Manual send');
  });

  it('lets staff select eligible teachers and send the selected type through the manual API', async () => {
    useRole.mockReturnValue({ session: { role: 'admin', userId: 'admin-1' } });
    await mount();
    await click(findButton('Marks entry'));
    const checkbox = host.querySelector<HTMLInputElement>('input[aria-label="Select Teacher One for Marks entry reminder"]');
    expect(checkbox).not.toBeNull();
    await click(checkbox!);
    await click(findButton('Send to 1 selected teacher(s)'));
    await flush(() => host.textContent?.includes('All eligible reminders accepted by the push service.'));

    const sendCall = api.mock.calls.find(([path]) => path === '/api/academic-reminders/send');
    expect(sendCall).toBeDefined();
    const sendPayload = JSON.parse(String(sendCall?.[1]?.body));
    expect(sendPayload).toMatchObject({ reminderType: 'marks_entry_reminder', teacherIds: ['teacher-1'], examScope: 'monthly' });
    expect(sendPayload.requestId.length).toBeGreaterThanOrEqual(8);

    const summary = [...host.querySelectorAll('summary')].find((item) => item.textContent?.includes('Schedule settings · Marks entry'));
    expect(summary).toBeDefined();
    await click(summary!);
    await click(findButton('Save schedule'));
    await flush(() => api.mock.calls.some(([path, init]) => path === '/api/academic-reminders/schedules' && init?.method === 'PUT'));
    const scheduleCall = api.mock.calls.filter(([path]) => path === '/api/academic-reminders/schedules').at(-1);
    expect(JSON.parse(String(scheduleCall?.[1]?.body))).toMatchObject({ reminderType: 'marks_entry_reminder', timezone: 'Africa/Mogadishu', sendTime: '16:00' });
  });
});
