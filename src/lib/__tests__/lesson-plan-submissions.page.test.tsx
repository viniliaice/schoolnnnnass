// @vitest-environment jsdom
//
// Lesson Plan Submission — the supervisor's accountability page.
//
// These tests pin the behaviours the spec calls out:
//   * the page opens on the CURRENT school week (not the newest submitted one)
//     and shows that week's real date range,
//   * the summary cards are computed from the expected-teacher roster
//     (40-teacher-style maths), never from lesson-plan records alone,
//   * a teacher with no plan for the week appears as "Not Submitted",
//   * a teacher with several records for the week still counts once,
//   * switching weeks (W07 → W06) flips statuses per week,
//   * status / class / search filters narrow the selected week together,
//   * "Not Submitted" teachers sort first,
//   * View deep-links into the existing Lesson Plan Review page,
//   * Send Reminder stays a UI action (no messaging infrastructure).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  getCurrentAcademicYear,
  useSupervisorPlanWeeks,
  useLessonPlanSubmitters,
  useSubmissionTrackingPlans,
  setPendingLessonPlanReview,
  addToast,
} = vi.hoisted(() => ({
  getCurrentAcademicYear: vi.fn(),
  useSupervisorPlanWeeks: vi.fn(),
  useLessonPlanSubmitters: vi.fn(),
  useSubmissionTrackingPlans: vi.fn(),
  setPendingLessonPlanReview: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../db/academic', () => ({
  getCurrentAcademicYear: (...args: unknown[]) => getCurrentAcademicYear(...args),
}));

vi.mock('../hooks/useLessonPlans', () => ({
  useSupervisorPlanWeeks: (...args: unknown[]) => useSupervisorPlanWeeks(...args),
}));

vi.mock('../hooks/useLessonPlanSubmissions', () => ({
  useLessonPlanSubmitters: (...args: unknown[]) => useLessonPlanSubmitters(...args),
  useSubmissionTrackingPlans: (...args: unknown[]) => useSubmissionTrackingPlans(...args),
}));

vi.mock('../lessonPlanDeepLink', () => ({
  setPendingLessonPlanReview: (...args: unknown[]) => setPendingLessonPlanReview(...args),
  takePendingLessonPlanReview: vi.fn(() => null),
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast, removeToast: vi.fn(), toasts: [] }),
}));

import { LessonPlanSubmissions } from '../../pages/supervisor/LessonPlanSubmissions';
import { I18nProvider } from '../i18n/AppLanguageContext';
import type { ExpectedSubmitter, SubmissionTrackingPlan } from '../lessonPlanSubmissionTracking';

// Academic year starts Saturday 1 Aug 2026 → week 7 = 12–16 Sep 2026, and the
// frozen "today" (12 Sep 2026) sits inside it.
const TODAY = new Date('2026-09-12T10:00:00');

const SUBMITTERS: ExpectedSubmitter[] = [
  { teacherId: 't-omar', teacherName: 'Omar Dahir', classes: ['Grade 1-A'] },
  { teacherId: 't-huda', teacherName: 'Huda Cali Xasan', classes: ['Grade 2-B'] },
  { teacherId: 't-ahmed', teacherName: 'Ahmed Hassan', classes: ['Grade 1-C'] },
  { teacherId: 't-ayan', teacherName: 'Ayan Warsame', classes: ['Grade 5-A'] },
  { teacherId: 't-halima', teacherName: 'Halima Aden', classes: ['Grade 5-A'] },
];

function plan(
  id: string,
  teacherId: string,
  className: string,
  status: SubmissionTrackingPlan['status'],
  stamp: string,
  weekLabel: string
): SubmissionTrackingPlan {
  const teacher = SUBMITTERS.find((s) => s.teacherId === teacherId);
  return {
    id,
    teacher_id: teacherId,
    class_name: className,
    week_label: weekLabel,
    status,
    ai_started_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    teacher_name: teacher?.teacherName ?? null,
  };
}

// Week 7: Omar, Huda (twice — an accidental duplicate), Ayan. Ahmed and
// Halima have nothing. Week 6: only Halima submitted.
const PLANS: SubmissionTrackingPlan[] = [
  plan('plan-omar-7', 't-omar', 'Grade 1-A', 'approved', '2026-09-12T05:14:00Z', '2026-W07'),
  plan('plan-huda-7a', 't-huda', 'Grade 2-B', 'in_review', '2026-09-12T05:22:00Z', '2026-W07'),
  plan('plan-huda-7b', 't-huda', 'Grade 2-B', 'approved', '2026-09-12T06:05:00Z', '2026-W07'),
  plan('plan-ayan-7', 't-ayan', 'Grade 5-A', 'submitted', '2026-09-12T06:01:00Z', '2026-W07'),
  plan('plan-halima-6', 't-halima', 'Grade 5-A', 'approved', '2026-09-05T05:00:00Z', '2026-W06'),
];

const WEEK_COUNTS = [
  { week_label: '2026-W07', plan_count: 4 },
  { week_label: '2026-W06', plan_count: 1 },
];

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <LessonPlanSubmissions navigate={navigateSpy} />
        </I18nProvider>
      </QueryClientProvider>
    );
  });
  await waitFor(host, () => settled(host), 'the current week to load');
  return { host, root };
}

/** Flush React + react-query until `predicate` holds (or the wait times out). */
async function waitFor(host: HTMLElement, predicate: () => boolean, label: string) {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

const text = (host: HTMLElement) => host.textContent ?? '';
const settled = (host: HTMLElement) => !text(host).includes('Loading') && !text(host).includes('…');

async function flush(host: HTMLElement) {
  await waitFor(host, () => settled(host), 'the page to settle');
  return host;
}

const navigateSpy = vi.fn();

function select(host: HTMLElement, id: string): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) throw new Error(`selector #${id} not rendered`);
  return select;
}

async function changeSelect(host: HTMLElement, id: string, value: string) {
  const element = select(host, id);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush(host);
}

async function typeIn(host: HTMLElement, id: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`input #${id} not rendered`);
  await act(async () => {
    // React's value tracker must be bypassed for the change event to register.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush(host);
}

/** Teacher names in list order (the desktop table mirrors the mobile cards). */
function listedTeachers(host: HTMLElement): string[] {
  return [...host.querySelectorAll('tbody tr')].map(
    (row) => row.querySelector('td')?.textContent?.trim() ?? ''
  );
}

function clickButton(host: HTMLElement, label: string, rowText?: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) => {
    if (candidate.textContent?.trim() !== label) return false;
    if (!rowText) return true;
    return candidate.closest('tr')?.textContent?.includes(rowText) ?? false;
  });
  if (!button) throw new Error(`no button labelled "${label}"`);
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateSpy.mockReset();
  // Freeze only the clock the week maths reads; real timers keep react-query
  // and the act() flushes working.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);

  getCurrentAcademicYear.mockResolvedValue({
    id: 'ay-2026', name: '2026/2027', startDate: '2026-08-01', endDate: '2027-07-31', isCurrent: true,
  });
  useSupervisorPlanWeeks.mockReturnValue({ data: WEEK_COUNTS, isLoading: false });
  useLessonPlanSubmitters.mockReturnValue({ data: SUBMITTERS, isLoading: false, error: null });
  useSubmissionTrackingPlans.mockImplementation((_weekKey: string | null, weekLabels: string[] | undefined) => ({
    data: PLANS.filter((p) => (weekLabels ?? []).includes(p.week_label)),
    isLoading: false,
    error: null,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LessonPlanSubmissions — opening the page', () => {
  it('selects the current school week and shows its real date range', async () => {
    const { host } = await mount();
    expect(select(host, 'submission-week').value).toBe('2026#7');
    expect(text(host)).toContain('Week 2026-W07');
    expect(text(host)).toContain('12 Sep – 16 Sep 2026');
    expect(text(host)).toContain('Current week');
  });

  it('offers weeks with zero submissions too, newest first', async () => {
    const { host } = await mount();
    const options = [...select(host, 'submission-week').options].map((o) => o.value);
    expect(options[0]).toBe('2026#7'); // current week
    expect(options).toContain('2026#6');
    expect(options).toContain('2026#1');
  });

  it('summarises teachers — not plan records', async () => {
    const { host } = await mount();
    // 5 expected teachers, 3 submitted (Huda's duplicate is one teacher),
    // 2 missing, 60%.
    expect(text(host)).toContain('Total Teachers');
    expect(text(host)).toContain('Submitted');
    expect(text(host)).toContain('Not Submitted');
    expect(text(host)).toContain('Submission Rate');
    expect(text(host)).toContain('3 of 5');
    expect(text(host)).toContain('60%');
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('60');
  });
});

describe('LessonPlanSubmissions — the teacher list', () => {
  it('shows every expected teacher, Not Submitted first', async () => {
    const { host } = await mount();
    expect(listedTeachers(host)).toEqual([
      'Ahmed Hassan', // missing — first
      'Halima Aden', // missing
      'Ayan Warsame', // then submitted, A–Z
      'Huda Cali Xasan',
      'Omar Dahir',
    ]);
  });

  it('marks roster teachers without a plan as Not Submitted with a reminder action', async () => {
    const { host } = await mount();
    const ahmedRow = [...host.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('Ahmed Hassan')
    );
    expect(ahmedRow?.textContent).toContain('Not Submitted');
    expect(ahmedRow?.textContent).toContain('Send Reminder');
    expect(ahmedRow?.textContent).not.toContain('View');
  });

  it('counts a teacher once despite duplicate plan records, and keeps a View action', async () => {
    const { host } = await mount();
    const hudaRow = [...host.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('Huda Cali Xasan')
    );
    expect(hudaRow?.textContent).toContain('Submitted');
    expect(hudaRow?.textContent).toContain('2 plans this week');
    expect(hudaRow?.textContent).toContain('View');
    // Still exactly 5 rows — one per teacher.
    expect(listedTeachers(host)).toHaveLength(5);
  });

  it('switching to the previous week updates the whole list', async () => {
    const { host } = await mount();
    await changeSelect(host, 'submission-week', '2026#6');
    // Week 6: only Halima submitted.
    expect(text(host)).toContain('1 of 5');
    expect(text(host)).toContain('20%');
    expect(listedTeachers(host)).toEqual([
      'Ahmed Hassan',
      'Ayan Warsame',
      'Huda Cali Xasan',
      'Omar Dahir',
      'Halima Aden', // the only submitted teacher — last under missing-first
    ]);
    // Halima submitted W06 but not W07 — both weeks must reflect their own truth.
    const halimaRow = [...host.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('Halima Aden')
    );
    expect(halimaRow?.textContent).toContain('Submitted');
  });
});

describe('LessonPlanSubmissions — filters narrow the selected week', () => {
  it('status filter: only missing teachers', async () => {
    const { host } = await mount();
    await changeSelect(host, 'submission-status-filter', 'not_submitted');
    expect(listedTeachers(host)).toEqual(['Ahmed Hassan', 'Halima Aden']);
  });

  it('status + class: Grade 5-A teachers who have not submitted', async () => {
    const { host } = await mount();
    await changeSelect(host, 'submission-status-filter', 'not_submitted');
    await changeSelect(host, 'submission-class-filter', 'Grade 5-A');
    expect(listedTeachers(host)).toEqual(['Halima Aden']);
  });

  it('search respects the selected week and the other filters', async () => {
    const { host } = await mount();
    await typeIn(host, 'submission-search', 'huda');
    expect(listedTeachers(host)).toEqual(['Huda Cali Xasan']);

    // The same search in week 6 still finds Huda (she is on the roster), but
    // her status now reflects week 6: she did not submit that week.
    await changeSelect(host, 'submission-week', '2026#6');
    expect(listedTeachers(host)).toEqual(['Huda Cali Xasan']);
    const hudaRow = [...host.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('Huda Cali Xasan')
    );
    expect(hudaRow?.textContent).toContain('Not Submitted');

    // A name that matches nobody leaves an explicit empty state.
    await typeIn(host, 'submission-search', 'nobody by this name');
    expect(listedTeachers(host)).toEqual([]);
    expect(text(host)).toContain('No teachers match these filters.');
  });
});

describe('LessonPlanSubmissions — actions', () => {
  it('View deep-links the submission into the Lesson Plan Review page', async () => {
    const { host } = await mount();
    await clickButton(host, 'View', 'Omar Dahir');
    expect(setPendingLessonPlanReview).toHaveBeenCalledWith('plan-omar-7', 'Omar Dahir');
    expect(navigateSpy).toHaveBeenCalledWith('/supervisor/lesson-plans');
  });

  it('Send Reminder stays a UI action — it explains instead of messaging', async () => {
    const { host } = await mount();
    await clickButton(host, 'Send Reminder', 'Ahmed Hassan');
    expect(setPendingLessonPlanReview).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    const toast = addToast.mock.calls[0][0];
    expect(toast.type).toBe('info');
    expect(toast.title).toContain('Reminders');
  });

  it('cross-links to the review page from the header', async () => {
    const { host } = await mount();
    await clickButton(host, 'Open Review');
    expect(navigateSpy).toHaveBeenCalledWith('/supervisor/lesson-plans');
  });
});

describe('LessonPlanSubmissions — narrow viewports (320px, 360px, 390px)', () => {
  it('gives the week selector the full width, a 48px tap target, and truncation', async () => {
    const { host } = await mount();
    const week = select(host, 'submission-week');
    expect(week.tagName).toBe('SELECT'); // native picker: usable at 320px
    expect(week.className).toContain('w-full');
    expect(week.className).toContain('min-w-0');
    expect(week.className).toContain('h-12');
    expect(week.className).toContain('truncate');
  });

  it('stacks the four filters on one column below 640px', async () => {
    const { host } = await mount();
    const filters = host.querySelector('[aria-label="Submission filters"]');
    expect(filters?.className).toContain('grid');
    expect(filters?.className).toContain('sm:grid-cols-2');
    // No unconditional multi-column grid: nothing is squeezed at 320px.
    expect(filters?.className ?? '').not.toMatch(/(^|\s)grid-cols-[2-9](\s|$)/);
    // Every filter control keeps a 44px tap target and truncation.
    for (const id of ['submission-status-filter', 'submission-class-filter', 'submission-sort']) {
      const element = select(host, id);
      expect(element.className).toContain('h-11');
      expect(element.className).toContain('min-w-0');
    }
  });

  it('swaps the table for compact per-teacher cards on mobile', async () => {
    const { host } = await mount();
    const table = host.querySelector('table')?.closest('div');
    expect(table?.className).toContain('hidden');       // no wide table on phones
    expect(table?.className).toContain('sm:block');     // …but tablets get it
    const cards = [...host.querySelectorAll('div.sm\\:hidden > div')];
    expect(cards.length).toBe(5);                       // one card per teacher
    for (const card of cards) {
      expect(card.querySelector('p.truncate')).not.toBeNull(); // teacher name never overflows
      expect(card.textContent).toContain('Submitted');  // status on the card
    }
    // A missing teacher’s card carries the reminder action, not a wide table row.
    expect(cards.some((card) => card.textContent?.includes('Ahmed Hassan'))).toBe(true);
  });

  it('keeps the summary cards in a 2×2 grid that fits 320px', async () => {
    const { host } = await mount();
    const cards = host.querySelector('.grid.grid-cols-2');
    expect(cards?.className).toContain('lg:grid-cols-4');
    expect(host.querySelectorAll('.grid.grid-cols-2 > div')).toHaveLength(4);
    // The progress bar stretches with its parent, never forces scroll.
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.className).toContain('w-full');
  });
});
