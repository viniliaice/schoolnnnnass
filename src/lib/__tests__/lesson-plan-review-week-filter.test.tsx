// @vitest-environment jsdom
//
// Lesson Plan Review is a WEEKLY dashboard: the supervisor picks a week first
// and only that week's submissions are loaded, listed, and filterable.
//
// These tests pin the behaviour the old single-list page did not have:
//   * it opens on the most recent week that has submissions,
//   * it asks the database for that week's plans only (never the full history),
//   * switching weeks replaces the list instead of mixing weeks,
//   * the status filter only narrows the selected week,
//   * an empty week stays empty instead of falling back to another week,
//   * approve / reject / request-revisions still work from the list.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  fetchSupervisorPlanWeeks,
  fetchPlansBySupervisorForWeek,
  fetchPlanById,
  fetchReviewByPlanId,
  fetchPeriodAiReviews,
  fetchLessonPlanQuizPreviews,
  approvePlan,
  rejectPlan,
  requestPlanRevision,
  retryAIReview,
  expireStuckAiReviews,
  getSubjects,
} = vi.hoisted(() => ({
  fetchSupervisorPlanWeeks: vi.fn(),
  fetchPlansBySupervisorForWeek: vi.fn(),
  fetchPlanById: vi.fn(),
  fetchReviewByPlanId: vi.fn(),
  fetchPeriodAiReviews: vi.fn(),
  fetchLessonPlanQuizPreviews: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  requestPlanRevision: vi.fn(),
  retryAIReview: vi.fn(),
  expireStuckAiReviews: vi.fn(),
  getSubjects: vi.fn(),
}));

vi.mock('../supabase', () => {
  // Every realtime hook chains .on(...).on(...).subscribe(), so the stub has to
  // be chainable at any depth.
  const makeChannel = () => {
    const builder: Record<string, unknown> = {};
    builder.on = () => builder;
    builder.subscribe = () => undefined;
    return builder;
  };
  return {
    supabase: { channel: () => makeChannel(), removeChannel: async () => undefined },
  };
});

vi.mock('../db/lessonPlans', () => ({
  fetchPlansByTeacher: vi.fn(),
  fetchPlansBySupervisor: vi.fn(),
  fetchPlansBySupervisorForWeek: (...args: unknown[]) => fetchPlansBySupervisorForWeek(...args),
  fetchSupervisorPlanWeeks: (...args: unknown[]) => fetchSupervisorPlanWeeks(...args),
  fetchPlanById: (...args: unknown[]) => fetchPlanById(...args),
  fetchReviewByPlanId: (...args: unknown[]) => fetchReviewByPlanId(...args),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  savePeriods: vi.fn(),
  submitForReview: vi.fn(),
  approvePlan: (...args: unknown[]) => approvePlan(...args),
  rejectPlan: (...args: unknown[]) => rejectPlan(...args),
  retryAIReview: (...args: unknown[]) => retryAIReview(...args),
  requestPlanRevision: (...args: unknown[]) => requestPlanRevision(...args),
  findPlanForWeek: vi.fn(),
  expireStuckAiReviews: (...args: unknown[]) => expireStuckAiReviews(...args),
  fetchAiReviewLogs: vi.fn(),
  AI_REVIEW_TIMEOUT_MINUTES: 3,
}));

vi.mock('../db/lessonPeriodAiReviews', () => ({
  fetchPeriodAiReviews: (...args: unknown[]) => fetchPeriodAiReviews(...args),
  regeneratePeriodAiReviews: vi.fn(),
}));

vi.mock('../db/lessonPlanQuizzes', () => ({
  fetchLessonPlanQuizPreviews: (...args: unknown[]) => fetchLessonPlanQuizPreviews(...args),
  generateLessonPlanQuizzes: vi.fn(),
  addGeneratedQuizToBank: vi.fn(),
}));

vi.mock('../db/academic', () => ({
  getCurrentAcademicYear: async () => ({ id: 'ay-2026', name: '2026/2027', startDate: '2026-08-01', endDate: '2027-07-31', isCurrent: true }),
}));

vi.mock('../db/subjects', () => ({ getSubjects: (...args: unknown[]) => getSubjects(...args) }));
vi.mock('../hooks/useUnitPlans', () => ({ useUnitPlansByClass: () => ({ data: [] }) }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
// The PDF path is exercised by lesson-plan-pdf-export.test.tsx; keep it out of
// this page-level test so the assertions stay on the week filtering.
vi.mock('../../components/lesson-planner/ExportLessonPlanPdfButton', () => ({
  ExportLessonPlanPdfButton: () => <button type="button">Export PDF</button>,
}));
vi.mock('../../pages/shared/LessonPlanPdfDocument', () => ({
  LessonPlanPdfDocument: () => null,
}));

import { LessonPlanReview } from '../../pages/supervisor/LessonPlanReview';
import { I18nProvider } from '../i18n/AppLanguageContext';
import { setPendingLessonPlanReview, takePendingLessonPlanReview } from '../lessonPlanDeepLink';
import type { PlanStatus } from '../../types';

const TEACHERS = ['Ms. Fatima', 'Mr. Omar', 'Ms. Hodan'];

type PlanRow = {
  id: string;
  teacher_id: string;
  subject_id: null;
  class_name: string;
  week_label: string;
  title: string;
  status: PlanStatus;
  period_count: number;
  previous_score: null;
  previous_reviewed_at: null;
  created_at: string;
  updated_at: string;
  ai_started_at: string;
  ai_failure_reason: null;
  teacher_name: string;
};

function makePlan(weekLabel: string, index: number, status: PlanStatus): PlanRow {
  return {
    id: `${weekLabel}-plan-${String(index).padStart(2, '0')}`,
    teacher_id: `teacher-${index % TEACHERS.length}`,
    subject_id: null,
    class_name: `Grade ${(index % 4) + 1}-${String.fromCharCode(65 + (index % 3))}`,
    week_label: weekLabel,
    title: `${weekLabel} Plan ${String(index).padStart(2, '0')}`,
    status,
    period_count: 5,
    previous_score: null,
    previous_reviewed_at: null,
    created_at: '2026-09-12T07:00:00.000Z',
    updated_at: '2026-09-12T07:00:00.000Z',
    ai_started_at: new Date().toISOString(),
    ai_failure_reason: null,
    teacher_name: TEACHERS[index % TEACHERS.length],
  };
}

function plansFor(weekLabel: string, statuses: PlanStatus[]): PlanRow[] {
  return statuses.map((status, i) => makePlan(weekLabel, i + 1, status));
}

// Week 7 is a mixture of approved / in-review / rejected; week 6 is all
// rejected; week 5 is a mixture; week 3 is listed but has no submissions left.
const ALL_PLANS: PlanRow[] = [
  ...plansFor('2026-W07', [
    'in_review', 'in_review', 'in_review', 'in_review', 'in_review', 'in_review', 'in_review', 'in_review',
    'approved', 'approved', 'approved', 'approved', 'approved', 'approved',
    'rejected', 'rejected', 'rejected',
    'submitted',
  ]),
  ...plansFor('2026-W06', ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']),
  ...plansFor('2026-W05', ['approved', 'approved', 'in_review', 'in_review']),
  ...plansFor('2026-W04', ['approved', 'approved', 'approved', 'in_review', 'in_review', 'rejected']),
];

const WEEK_ROWS = [
  { week_label: '2026-W04', plan_count: 6 },
  { week_label: '2026-W06', plan_count: 9 },
  { week_label: '2026-W03', plan_count: 0 },
  { week_label: '2026-W07', plan_count: 18 },
  { week_label: '2026-W05', plan_count: 4 },
];

function reviewFor(planId: string) {
  const score = { score: 8, explanation: 'Clear and measurable.' };
  return {
    id: `review-${planId}`,
    plan_id: planId,
    scores: {
      learning_objectives: score,
      lesson_structure: score,
      student_engagement: score,
      teaching_strategies: score,
      differentiation: score,
      assessment_methods: score,
      curriculum_alignment: score,
      classroom_management: score,
      resources_materials: score,
      overall_quality: score,
    },
    executive_summary: 'Solid plan.',
    total_score: 80,
    percentage: 80,
    performance_level: 'Good',
    strengths: ['Clear objectives'],
    improvements: [{ area: 'Assessment', why: 'Thin', recommendation: 'Add an exit ticket' }],
    ai_summary_notes: { status_recommendation: 'approve', reasoning: 'Meets the bar.' },
    additional_data: { latency_ms: 1200, model_used: 'test-model' },
    status: 'reviewed',
    supervisor_comment: null,
    created_at: '2026-09-12T07:05:00.000Z',
    updated_at: '2026-09-12T07:05:00.000Z',
  };
}

function periodsFor(planId: string) {
  return [
    {
      id: `${planId}-p1`,
      plan_id: planId,
      day: 'Saturday',
      period_number: 1,
      class_name: 'Grade 1-A',
      subject: 'Mathematics',
      is_free: false,
      topic: 'Fractions intro',
      objective: 'Identify halves and quarters',
      activities: '1. Warm-up (10min)',
      slide_number: null,
      details: [{ activity: 'Warm-up', time: '10min', resource: '', place: 'Desks' }],
      sort_order: 0,
      created_at: '2026-09-12T07:00:00.000Z',
      updated_at: '2026-09-12T07:00:00.000Z',
    },
  ];
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <LessonPlanReview />
        </I18nProvider>
      </QueryClientProvider>
    );
  });
  // Let the default-week selection and its query settle.
  await waitFor(host, () => isSettled(host) && text(host).includes('Week 2026-W07'), 'the default week');
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
const isSettled = (host: HTMLElement) => !text(host).includes('Loading');

async function flush(host: HTMLElement) {
  await waitFor(host, () => isSettled(host), 'the selected week to load');
  return host;
}

function weekSelect(host: HTMLElement): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>('#lesson-review-week');
  if (!select) throw new Error('week selector not rendered');
  return select;
}

function statusSelect(host: HTMLElement): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>('#lesson-review-status');
  if (!select) throw new Error('status selector not rendered');
  return select;
}

async function selectWeek(host: HTMLElement, key: string) {
  const select = weekSelect(host);
  await act(async () => {
    select.value = key;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush(host);
}

async function selectStatus(host: HTMLElement, status: string) {
  const select = statusSelect(host);
  await act(async () => {
    select.value = status;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush(host);
}

function listedTitles(host: HTMLElement): string[] {
  return ALL_PLANS.filter((plan) => host.textContent?.includes(plan.title)).map((plan) => plan.title);
}

function clickButton(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!button) throw new Error(`no button labelled "${text}"`);
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickPlan(host: HTMLElement, title: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(title)
  );
  if (!button) throw new Error(`no plan row for "${title}"`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // The detail panel (and its decision buttons) appears once the plan loads.
  await waitFor(host, () => text(host).includes('Supervisor Decision'), `"${title}" to open`);
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  fetchSupervisorPlanWeeks.mockResolvedValue(WEEK_ROWS);
  // The mock behaves like the database: it only ever returns the rows stored
  // under the labels the page asked for.
  fetchPlansBySupervisorForWeek.mockImplementation(async (labels: string[]) =>
    ALL_PLANS.filter((plan) => labels.includes(plan.week_label))
  );
  fetchPlanById.mockImplementation(async (id: string) => ({
    plan: ALL_PLANS.find((plan) => plan.id === id) ?? null,
    periods: periodsFor(id),
  }));
  fetchReviewByPlanId.mockImplementation(async (id: string) => reviewFor(id));
  fetchPeriodAiReviews.mockResolvedValue([]);
  fetchLessonPlanQuizPreviews.mockResolvedValue([]);
  getSubjects.mockResolvedValue([]);
  expireStuckAiReviews.mockResolvedValue([]);
  approvePlan.mockResolvedValue(undefined);
  rejectPlan.mockResolvedValue(undefined);
  requestPlanRevision.mockResolvedValue(undefined);
  retryAIReview.mockResolvedValue({ plan_id: 'x', status: 'submitted', ai_started_at: null });
});

describe('Lesson Plan Review — week-first dashboard', () => {
  it('opens on the most recent week with submissions and lists only that week', async () => {
    const { host } = await mount();

    expect(weekSelect(host).value).toBe('2026#7');
    expect([...weekSelect(host).options].map((option) => option.value)).toEqual([
      '2026#7', '2026#6', '2026#5', '2026#4', '2026#3',
    ]);
    expect(host.textContent).toContain('Week 2026-W07');
    expect(host.textContent).toContain('12 Sep – 16 Sep 2026');
    expect(host.textContent).toContain('18 Lesson Plans');

    // Exactly the 18 plans stored under 2026-W07, and nothing from other weeks.
    expect(listedTitles(host).filter((title) => title.startsWith('2026-W07'))).toHaveLength(18);
    expect(host.textContent).not.toContain('2026-W06 Plan');
    expect(host.textContent).not.toContain('2026-W05 Plan');
    expect(host.textContent).not.toContain('2026-W04 Plan');
  });

  it('asks the database for the selected week only — never the whole history', async () => {
    const { host } = await mount();

    expect(fetchPlansBySupervisorForWeek).toHaveBeenCalledTimes(1);
    expect(fetchPlansBySupervisorForWeek).toHaveBeenCalledWith(['2026-W07']);
    // The weeks dropdown is built from counts, not from downloaded plan rows.
    expect(fetchSupervisorPlanWeeks).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('18 Lesson Plans');
  });

  it('replaces the list when another week is selected', async () => {
    const { host } = await mount();

    await selectWeek(host, '2026#5');

    expect(fetchPlansBySupervisorForWeek).toHaveBeenLastCalledWith(['2026-W05']);
    expect(host.textContent).toContain('Week 2026-W05');
    expect(host.textContent).toContain('29 Aug – 2 Sep 2026');
    expect(host.textContent).toContain('4 Lesson Plans');
    expect(listedTitles(host)).toEqual([
      '2026-W05 Plan 01', '2026-W05 Plan 02', '2026-W05 Plan 03', '2026-W05 Plan 04',
    ]);
    expect(host.textContent).not.toContain('2026-W07 Plan');
  });

  it('shows a week that only holds rejected submissions', async () => {
    const { host } = await mount();

    await selectWeek(host, '2026#6');

    expect(fetchPlansBySupervisorForWeek).toHaveBeenLastCalledWith(['2026-W06']);
    expect(host.textContent).toContain('9 Lesson Plans');
    expect(listedTitles(host)).toHaveLength(9);
    expect(listedTitles(host).every((title) => title.startsWith('2026-W06'))).toBe(true);

    await selectStatus(host, 'rejected');
    expect(host.textContent).toContain('9 of 9 Lesson Plans');
    expect(listedTitles(host)).toHaveLength(9);
  });

  it('applies the status filter inside the selected week without refetching', async () => {
    const { host } = await mount();
    const callsAfterOpen = fetchPlansBySupervisorForWeek.mock.calls.length;

    await selectStatus(host, 'rejected');

    expect(fetchPlansBySupervisorForWeek.mock.calls.length).toBe(callsAfterOpen);
    expect(host.textContent).toContain('3 of 18 Lesson Plans');
    expect(listedTitles(host)).toEqual([
      '2026-W07 Plan 15', '2026-W07 Plan 16', '2026-W07 Plan 17',
    ]);

    await selectStatus(host, 'approved');
    expect(host.textContent).toContain('6 of 18 Lesson Plans');
    expect(listedTitles(host)).toHaveLength(6);

    await selectStatus(host, 'all');
    expect(host.textContent).toContain('18 Lesson Plans');
    expect(listedTitles(host)).toHaveLength(18);
  });

  it('keeps an empty week empty instead of falling back to another week', async () => {
    const { host } = await mount();

    await selectWeek(host, '2026#3');

    expect(fetchPlansBySupervisorForWeek).toHaveBeenLastCalledWith(['2026-W03']);
    expect(host.textContent).toContain('No lesson plans submitted for this week.');
    expect(listedTitles(host)).toEqual([]);
  });

  it('says so when the status filter hides every plan in the week', async () => {
    const { host } = await mount();

    await selectStatus(host, 'ai_failed');

    expect(host.textContent).toContain('No plans with this status in the selected week.');
    expect(host.textContent).toContain('0 of 18 Lesson Plans');
  });

  it('closes the open plan when the week changes', async () => {
    const { host } = await mount();

    await clickPlan(host, '2026-W07 Plan 01');
    expect(host.textContent).toContain('Supervisor Decision');

    await selectWeek(host, '2026#5');

    expect(host.textContent).toContain('Select a plan to review');
    expect(host.textContent).not.toContain('Supervisor Decision');
  });

  it('still approves, rejects, and requests revisions from the selected week', async () => {
    const { host } = await mount();

    await clickPlan(host, '2026-W07 Plan 09');
    await clickButton(host, 'Approve');
    await flush(host);
    expect(approvePlan).toHaveBeenCalledWith('2026-W07-plan-09', '');

    await clickPlan(host, '2026-W07 Plan 15');
    await clickButton(host, 'Reject');
    await flush(host);
    expect(rejectPlan).toHaveBeenCalledWith('2026-W07-plan-15', '');

    await clickPlan(host, '2026-W07 Plan 02');
    await clickButton(host, 'Request Revisions (unlock for editing)');
    await flush(host);
    expect(requestPlanRevision).toHaveBeenCalledWith('2026-W07-plan-02', undefined);
  });
});

describe('Lesson Plan Review — narrow viewports (320px, 360px, 390px)', () => {
  it('gives both selectors the full width, a 48px tap target, and truncation', async () => {
    const { host } = await mount();

    for (const select of [weekSelect(host), statusSelect(host)]) {
      expect(select.tagName).toBe('SELECT'); // native picker: usable at 320px
      expect(select.className).toContain('w-full');
      expect(select.className).toContain('min-w-0');
      expect(select.className).toContain('h-12');
      expect(select.className).toContain('truncate');
    }
  });

  it('stacks the selectors on one column below 640px', async () => {
    const { host } = await mount();
    const grid = weekSelect(host).closest('div[class*="grid"]');

    expect(grid?.className).toContain('sm:grid-cols-2');
    // No unconditional 2-column grid, so nothing is squeezed at 320px.
    expect(grid?.className ?? '').not.toMatch(/(^|\s)grid-cols-2(\s|$)/);
    expect(grid?.className).toContain('min-w-0');
  });

  it('lets the list column fill the viewport until the two-pane layout kicks in', async () => {
    const { host } = await mount();
    const listColumn = host.querySelector<HTMLElement>('[class*="xl:w-80"]');

    expect(listColumn?.className).toContain('w-full');
    expect(listColumn?.className).toContain('min-w-0');
    expect(listColumn?.className).toContain('shrink-0');
  });

  it('keeps teacher, class, and status readable by truncating rather than overflowing', async () => {
    const { host } = await mount();
    const rows = [...host.querySelectorAll('[class*="xl:w-80"] button')];

    expect(rows.length).toBe(18);
    for (const row of rows) {
      expect(row.className).toContain('w-full');
      const content = row.querySelector('.min-w-0');
      expect(content).not.toBeNull();
      expect(row.querySelector('p.truncate')).not.toBeNull(); // the title
    }
    // Teacher · class · week · status are all rendered for every plan.
    expect(host.textContent).toContain('Ms. Fatima · Grade 2-A');
    expect(host.textContent).toContain('12 Sep – 16 Sep 2026');
    expect(host.textContent).toContain('in review');
  });

  it('shows the date range in the selector without a second line of controls', async () => {
    const { host } = await mount();
    const week = weekSelect(host);

    expect(week.options[0].textContent).toBe('Week 2026-W07 — 12 Sep – 16 Sep 2026');
    // The week is the only thing the supervisor must touch first.
    expect(week.options.length).toBe(5);
  });
});

describe('Lesson Plan Review — deep-linked from the submission tracker', () => {
  it('opens the parked plan directly and aligns the week with the plan', async () => {
    // The submission tracker's View action parks a plan id and navigates here.
    setPendingLessonPlanReview('2026-W05-plan-02');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <LessonPlanReview />
          </I18nProvider>
        </QueryClientProvider>
      );
    });
    // The detail panel and the week selector both land on the plan's own week
    // (week 5), not the default newest week.
    await waitFor(host, () => text(host).includes('Supervisor Decision'), 'the parked plan to open');
    await waitFor(host, () => weekSelect(host).value === '2026#5', 'the week selector to align');
    expect(weekSelect(host).value).toBe('2026#5');
    expect(text(host)).toContain('2026-W05 Plan 02');
    expect(fetchPlansBySupervisorForWeek).toHaveBeenCalledWith(['2026-W05']);
    // The parked link is consumed — a later mount opens on the newest week again.
    expect(takePendingLessonPlanReview()).toBeNull();
  });

  it('consumes and drops the parked link when nothing can match it', async () => {
    setPendingLessonPlanReview('plan-that-does-not-exist');
    const { host } = await mount();
    // No crash, the default week behaviour is untouched…
    expect(weekSelect(host).value).toBe('2026#7');
    // …and the stale link does not linger for the next mount.
    expect(takePendingLessonPlanReview()).toBeNull();
    expect(host.textContent).toContain('18 Lesson Plans');
  });
});
