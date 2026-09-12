// @vitest-environment jsdom
//
// The live preview runs on the in-browser demo client (no VITE_SUPABASE_*),
// so this test mounts the REAL LessonPlanReview against that REAL client —
// deliberately NOT vi.mock('../supabase') — and replays the flow reported
// broken from the preview: the submission tracker's View action parks a plan
// id and navigates to the review page, which must open that plan.
//
// REGRESSION: the preview client used to expose no realtime methods, so
// usePlanWithPeriods crashed with "supabase.channel is not a function" the
// moment any plan was selected — the View button looked dead (the review
// page white-screened). Same for selecting a plan directly on the review
// page. The demo client now provides inert no-op channels.
//
// Assertions use the demo seed's known plans (see src/lib/supabase.ts):
//   plan-2026-W04-1 — Ms. Fatima, Grade 1-A, approved
//   plan-2026-W15-1 — Ms. Fatima, Grade 1-A, submitted (newest submitted week)

import { describe, expect, it, vi, beforeEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The PDF path is exercised by lesson-plan-pdf-export.test.tsx; keep it out
// of this preview-client test so assertions stay on the plan opening.
vi.mock('../../components/lesson-planner/ExportLessonPlanPdfButton', () => ({
  ExportLessonPlanPdfButton: () => <button type="button">Export PDF</button>,
}));
vi.mock('../../pages/shared/LessonPlanPdfDocument', () => ({
  LessonPlanPdfDocument: () => null,
}));

import { LessonPlanReview } from '../../pages/supervisor/LessonPlanReview';
import { I18nProvider } from '../i18n/AppLanguageContext';
import { ToastProvider } from '../../context/ToastContext';
import { setPendingLessonPlanReview } from '../lessonPlanDeepLink';

async function mountReview() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <I18nProvider>
            <LessonPlanReview />
          </I18nProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  });
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

function weekSelect(host: HTMLElement): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>('#lesson-review-week');
  if (!select) throw new Error('week selector not rendered');
  return select;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('LessonPlanReview on the preview client (real mock supabase, no vi.mock)', () => {
  it('opens the plan parked by the submission tracker’s View action', async () => {
    // Exactly what handleView() on LessonPlanSubmissions does.
    setPendingLessonPlanReview('plan-2026-W04-1', 'Ms. Fatima');
    const { host } = await mountReview();

    // The detail panel renders — no white screen from a realtime crash.
    await waitFor(host, () => text(host).includes('Supervisor Decision'), 'the parked plan to open');
    // The week selector aligns with the plan's own week (2026-W04), not the
    // newest submitted week (2026-W15).
    await waitFor(host, () => weekSelect(host).value === '2026#4', 'the week selector to align');
    expect(text(host)).toContain('Week 2026-W04');
    expect(text(host)).toContain('Ms. Fatima');
  });

  it('survives selecting a plan directly from the week list', async () => {
    const { host } = await mountReview();
    // The dropdown options mention the week immediately; the plan rows do not
    // arrive until the week query settles, so wait for a real plan title.
    await waitFor(host, () => text(host).includes('Week 2026-W15 - Grade'), 'the newest week’s plans');

    const firstPlan = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Week 2026-W15 - Grade')
    );
    if (!firstPlan) throw new Error('no plan row rendered for the newest week');
    await act(async () => {
      firstPlan.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The decision panel appears — previously this click crashed the page.
    await waitFor(host, () => text(host).includes('Supervisor Decision'), 'the clicked plan to open');
    expect(text(host)).toContain('Week 2026-W15');
  });
});
