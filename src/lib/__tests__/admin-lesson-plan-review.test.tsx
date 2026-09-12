// @vitest-environment jsdom
//
// Admin must be able to review lesson plans exactly like a supervisor.
//
// The database has always granted both roles the same rights
// (`admin_all_plans` RLS plus the `('supervisor','admin')` checks in
// decide_lesson_plan_review / request_lesson_plan_revision /
// retry_lesson_plan_ai_review / the quiz-replacement RPC), but the app never
// gave admin a route or a sidebar entry — the admin switch fell through to
// AdminDashboard. This test drives the real <App />: sign in as admin, click
// the sidebar, land on the same week-first review page a supervisor gets.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const { sessionRef, fetchSupervisorPlanWeeks, fetchPlansBySupervisorForWeek } = vi.hoisted(() => ({
  sessionRef: { current: null as null | Record<string, unknown> },
  fetchSupervisorPlanWeeks: vi.fn(),
  fetchPlansBySupervisorForWeek: vi.fn(),
}));

vi.mock('../../context/RoleContext', () => ({
  RoleProvider: ({ children }: { children: React.ReactNode }) => children,
  useRole: () => ({
    session: sessionRef.current,
    isLoggedIn: !!sessionRef.current,
    loading: false,
    error: null,
    login: async () => undefined,
    logout: async () => undefined,
  }),
}));

// The page subscribes to realtime for the open plan; a chainable stub is enough.
vi.mock('../supabase', () => {
  const makeChannel = () => {
    const builder: Record<string, unknown> = {};
    builder.on = () => builder;
    builder.subscribe = () => undefined;
    return builder;
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.then = (onFulfilled: unknown, onRejected: unknown) =>
    Promise.resolve({ data: [], error: null }).then(onFulfilled as never, onRejected as never);
  return {
    supabase: {
      channel: () => makeChannel(),
      removeChannel: async () => undefined,
      from: () => chain,
      rpc: async () => ({ data: null, error: null }),
      functions: { invoke: async () => ({ data: null, error: null }) },
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    },
    isPlaceholderEnv: true,
  };
});

vi.mock('../db/lessonPlans', () => ({
  fetchPlansByTeacher: vi.fn(),
  fetchPlansBySupervisor: vi.fn(),
  fetchPlansBySupervisorForWeek: (...args: unknown[]) => fetchPlansBySupervisorForWeek(...args),
  fetchSupervisorPlanWeeks: (...args: unknown[]) => fetchSupervisorPlanWeeks(...args),
  fetchPlanById: vi.fn(async (id: string) => ({
    plan: PLANS.find((plan) => plan.id === id) ?? null,
    periods: [],
  })),
  fetchReviewByPlanId: vi.fn(async () => null),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  savePeriods: vi.fn(),
  submitForReview: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  retryAIReview: vi.fn(),
  requestPlanRevision: vi.fn(),
  findPlanForWeek: vi.fn(),
  expireStuckAiReviews: vi.fn(async () => []),
  fetchAiReviewLogs: vi.fn(),
  AI_REVIEW_TIMEOUT_MINUTES: 3,
}));
vi.mock('../db/lessonPeriodAiReviews', () => ({
  fetchPeriodAiReviews: vi.fn(async () => []),
  regeneratePeriodAiReviews: vi.fn(),
}));
vi.mock('../db/lessonPlanQuizzes', () => ({
  fetchLessonPlanQuizPreviews: vi.fn(async () => []),
  generateLessonPlanQuizzes: vi.fn(),
  addGeneratedQuizToBank: vi.fn(),
}));
vi.mock('../db/academic', () => ({
  getCurrentAcademicYear: async () => ({ id: 'ay-2026', name: '2026/2027', startDate: '2026-08-01', endDate: '2027-07-31', isCurrent: true }),
}));
vi.mock('../db/subjects', () => ({ getSubjects: vi.fn(async () => []) }));
vi.mock('../hooks/useUnitPlans', () => ({ useUnitPlansByClass: () => ({ data: [] }) }));
// Landing page only — this test is about routing, not the dashboard's widgets.
vi.mock('../../pages/admin/AdminDashboard', () => ({
  AdminDashboard: () => <div>admin dashboard stub</div>,
}));
vi.mock('../../pages/supervisor/SupervisorDashboard', () => ({
  SupervisorDashboard: () => <div>supervisor dashboard stub</div>,
}));
vi.mock('../../components/lesson-planner/ExportLessonPlanPdfButton', () => ({
  ExportLessonPlanPdfButton: () => <button type="button">Export PDF</button>,
}));
vi.mock('../../pages/shared/LessonPlanPdfDocument', () => ({ LessonPlanPdfDocument: () => null }));

import App from '../../App';
import { queryClient } from '../queryClient';
import { afterEach } from 'vitest';

const ADMIN = { role: 'admin', userId: 'admin-1', userName: 'Admin One', email: 'admin@mbk.edu' };
const SUPERVISOR = { role: 'supervisor', userId: 'sup-1', userName: 'Sup One', email: 'sup@mbk.edu' };
const TEACHER = { role: 'teacher', userId: 'tea-1', userName: 'Tea One', email: 'tea@mbk.edu' };

const PLANS = [
  { id: 'w7-1', week_label: '2026-W07', title: '2026-W07 Plan 01', class_name: 'Grade 1-A', status: 'in_review', teacher_name: 'Ms. Fatima', period_count: 5 },
  { id: 'w7-2', week_label: '2026-W07', title: '2026-W07 Plan 02', class_name: 'Grade 2-C', status: 'approved', teacher_name: 'Mr. Omar', period_count: 5 },
  { id: 'w5-1', week_label: '2026-W05', title: '2026-W05 Plan 01', class_name: 'Grade 1-A', status: 'rejected', teacher_name: 'Ms. Hodan', period_count: 5 },
];

const roots: Array<{ unmount: () => void }> = [];

async function mountApp() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<App />);
  });
  return host;
}

/** Wait for the selected week's plans to be on screen (not just its selector). */
async function waitForWeekLoaded(host: HTMLElement) {
  await waitFor(host, () => !!host.querySelector('#lesson-review-week'), 'the week selector');
  await waitFor(host, () => (host.textContent ?? '').includes('2 Lesson Plans'), 'the week to load');
}

async function waitFor(host: HTMLElement, predicate: () => boolean, label: string) {
  for (let i = 0; i < 60 && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

async function clickNav(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`no sidebar entry labelled "${label}"`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // App uses the module-level query client, so each test starts from a cold
  // cache — otherwise a previous test's week list answers the next one.
  queryClient.clear();
  document.body.innerHTML = '';
  sessionRef.current = ADMIN;
  fetchSupervisorPlanWeeks.mockResolvedValue([
    { week_label: '2026-W05', plan_count: 1 },
    { week_label: '2026-W07', plan_count: 2 },
  ]);
  fetchPlansBySupervisorForWeek.mockImplementation(async (labels: string[]) =>
    PLANS.filter((plan) => labels.includes(plan.week_label))
  );
});

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount();
    });
  }
  roots.length = 0;
});

describe('admin can review lesson plans like a supervisor', () => {
  it('has a Lesson Plans entry that opens the week-first review page', async () => {
    const host = await mountApp();

    await clickNav(host, 'Lesson Plans');
    await waitForWeekLoaded(host);

    expect(host.textContent).toContain('Lesson Plan Review');
    const select = host.querySelector<HTMLSelectElement>('#lesson-review-week')!;
    expect([...select.options].map((option) => option.value)).toEqual(['2026#7', '2026#5']);
    expect(select.value).toBe('2026#7');
    expect(select.options[0].textContent).toBe('Week 2026-W07 — 12 Sep – 16 Sep 2026');

    // Only the selected week, with the supervisor's status filter available.
    expect(fetchPlansBySupervisorForWeek).toHaveBeenCalledWith(['2026-W07']);
    expect(host.textContent).toContain('2 Lesson Plans');
    expect(host.textContent).toContain('2026-W07 Plan 01');
    expect(host.textContent).not.toContain('2026-W05 Plan 01');
    expect(host.querySelector('#lesson-review-status')).not.toBeNull();
  });

  it('gives admin the same review actions as a supervisor', async () => {
    const host = await mountApp();

    await clickNav(host, 'Lesson Plans');
    await waitForWeekLoaded(host);

    const row = [...host.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('2026-W07 Plan 01')
    );
    if (!row) throw new Error('plan row not listed');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(host, () => (host.textContent ?? '').includes('Supervisor Decision'), 'the decision panel');

    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toContain('Approve');
    expect(labels).toContain('Reject');
    expect(labels).toContain('Request Revisions (unlock for editing)');
  });

  it('keeps the supervisor entry point working at its own path', async () => {
    sessionRef.current = SUPERVISOR;
    const host = await mountApp();

    await clickNav(host, 'Lesson Plans');
    await waitForWeekLoaded(host);

    expect(host.textContent).toContain('Lesson Plan Review');
    expect(fetchPlansBySupervisorForWeek).toHaveBeenCalledWith(['2026-W07']);
  });

  it('does not offer the admin review route to a teacher', async () => {
    sessionRef.current = TEACHER;
    const host = await mountApp();

    // The teacher's own "Lesson Plans" entry is the planner, not the review page.
    await clickNav(host, 'Lesson Plans');
    await waitFor(host, () => !(host.textContent ?? '').includes('admin dashboard stub'), 'the planner');

    expect(host.querySelector('#lesson-review-week')).toBeNull();
    expect(host.textContent).not.toContain('Lesson Plan Review');
  });
});
