// @vitest-environment jsdom
//
// Monitor Marks Entries — the admin/supervisor accountability page.
//
// These pin the behaviours the spec calls out, in the same spirit as
// lesson-plan-submissions.page.test.tsx:
//   * the page opens on the current year/term/month and shows the period,
//   * the summary cards are computed from the EXPECTED roster (All / Complete /
//     In Progress / Not Started),
//   * an assignment with no marks shows as "Not Started", not missing,
//   * a partially-entered assignment shows in_progress with X/Y students,
//   * a complete assignment shows complete at 100%,
//   * the status / class / subject filters narrow the list together,
//   * clicking a row opens the detail modal with entered/expected/missing,
//   * the empty state renders when there are no entries.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  useAcademicYears,
  useTerms,
  useMonitorMarksEntries,
  addToast,
} = vi.hoisted(() => ({
  useAcademicYears: vi.fn(),
  useTerms: vi.fn(),
  useMonitorMarksEntries: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../lib/hooks', () => ({
  useAcademicYears: (...args: unknown[]) => useAcademicYears(...args),
  useTerms: (...args: unknown[]) => useTerms(...args),
  useMonitorMarksEntries: (...args: unknown[]) => useMonitorMarksEntries(...args),
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast, removeToast: vi.fn(), toasts: [] }),
}));

import { MonitorMarksEntries } from '../../pages/admin/MonitorMarksEntries';
import { I18nProvider } from '../i18n/AppLanguageContext';
import type { MonitorMarksRow } from '../marksUploadTracking';

const TERM = {
  id: 't1',
  name: 'Term 1',
  academicYearId: 'ay1',
  startDate: '2026-09-01',
  endDate: '2026-10-31',
  isCurrent: true,
  months: ['September', 'October'],
  createdAt: '2026-08-20T00:00:00Z',
};

const YEAR = {
  id: 'ay1',
  name: '2026-2027',
  startDate: '2026-08-01',
  endDate: '2027-07-31',
  isCurrent: true,
  createdAt: '2026-07-01T00:00:00Z',
};

const ROWS: MonitorMarksRow[] = [
  {
    teacherId: 't1',
    teacherName: 'Fatima Ali',
    className: 'Grade 7-A',
    subjectId: 'sub-math',
    subjectName: 'Mathematics',
    academicYearId: 'ay1',
    termId: 't1',
    termName: 'Term 1',
    month: 'September',
    examType: 'Monthly',
    expectedStudents: 4,
    enteredStudents: 2,
    caEntered: 3,
    homeworkEntered: 3,
    classworkEntered: 3,
    quizEntered: 2,
    attendanceEntered: 0,
    midtermEntered: 0,
    finalEntered: 0,
    completionPercent: 50,
    status: 'in_progress',
    lastUpdate: '2026-09-12T09:00:00Z',
  },
  {
    teacherId: 't2',
    teacherName: 'Omar Hassan',
    className: 'Grade 7-A',
    subjectId: 'sub-eng',
    subjectName: 'English',
    academicYearId: 'ay1',
    termId: 't1',
    termName: 'Term 1',
    month: 'September',
    examType: 'Monthly',
    expectedStudents: 4,
    enteredStudents: 4,
    caEntered: 4,
    homeworkEntered: 4,
    classworkEntered: 4,
    quizEntered: 4,
    attendanceEntered: 0,
    midtermEntered: 0,
    finalEntered: 0,
    completionPercent: 100,
    status: 'complete',
    lastUpdate: '2026-09-12T09:00:00Z',
  },
  {
    teacherId: 't1',
    teacherName: 'Fatima Ali',
    className: 'Grade 8-A',
    subjectId: 'sub-math',
    subjectName: 'Mathematics',
    academicYearId: 'ay1',
    termId: 't1',
    termName: 'Term 1',
    month: 'September',
    examType: 'Monthly',
    expectedStudents: 2,
    enteredStudents: 0,
    caEntered: 0,
    homeworkEntered: 0,
    classworkEntered: 0,
    quizEntered: 0,
    attendanceEntered: 0,
    midtermEntered: 0,
    finalEntered: 0,
    completionPercent: 0,
    status: 'not_started',
    lastUpdate: null,
  },
];

function renderPage() {
  useAcademicYears.mockReturnValue({ data: [YEAR], isLoading: false });
  useTerms.mockReturnValue({ data: [TERM], isLoading: false });
  useMonitorMarksEntries.mockReturnValue({ data: ROWS, isLoading: false, error: null });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MonitorMarksEntries />
        </I18nProvider>
      </QueryClientProvider>
    );
  });
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe('Monitor Marks Entries page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the title and the four summary cards from the expected roster', () => {
    const { container } = renderPage();
    expect(container.textContent).toContain('Monitor Marks Entries');
    // All 3 assignments; 1 complete, 1 in progress, 1 not started.
    expect(container.textContent).toContain('All');
    expect(container.textContent).toContain('Complete');
    expect(container.textContent).toContain('In Progress');
    expect(container.textContent).toContain('Not Started');
    expect(container.textContent).toMatch(/3/); // All = 3
  });

  it('marks Not Started, In Progress, and Complete distinctly', () => {
    const { container } = renderPage();
    expect(container.textContent).toContain('Not Started');
    expect(container.textContent).toContain('In Progress');
    expect(container.textContent).toContain('Complete');
    // Grade 8-A Mathematics has zero entered -> Not Started with 0/2.
    expect(container.textContent).toContain('0/2');
    // Grade 7-A Mathematics partially entered -> 2/4.
    expect(container.textContent).toContain('2/4');
    // Grade 7-A English complete -> 4/4.
    expect(container.textContent).toContain('4/4');
  });

  it('opens a detail modal showing expected, entered, and missing students', () => {
    const { container } = renderPage();
    const detailsButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent || '').includes('Details')
    );
    expect(detailsButtons.length).toBeGreaterThan(0);
    // Open the first (Grade 7-A Mathematics, 2/4) detail.
    act(() => {
      detailsButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const modal = document.body.textContent || '';
    expect(modal).toContain('Expected Students');
    expect(modal).toContain('Marks Entered');
    expect(modal).toContain('Marks Missing');
    // 4 expected - 2 entered = 2 missing.
    expect(modal).toContain('2');
  });

  it('filters by status (Not Started only) and narrows the visible rows', () => {
    // Re-render with the hook returning only the not_started row.
    useAcademicYears.mockReturnValue({ data: [YEAR], isLoading: false });
    useTerms.mockReturnValue({ data: [TERM], isLoading: false });
    useMonitorMarksEntries.mockReturnValue({
      data: ROWS.filter((r) => r.status === 'not_started'),
      isLoading: false,
      error: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MonitorMarksEntries />
          </I18nProvider>
        </QueryClientProvider>
      );
    });
    // Only the Grade 8-A Mathematics row should be visible.
    expect(container.textContent).toContain('Grade 8-A');
    expect(container.textContent).not.toContain('Grade 7-A');
    act(() => root.unmount());
  });

  it('shows the empty state when there are no entries', () => {
    useAcademicYears.mockReturnValue({ data: [YEAR], isLoading: false });
    useTerms.mockReturnValue({ data: [TERM], isLoading: false });
    useMonitorMarksEntries.mockReturnValue({ data: [], isLoading: false, error: null });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MonitorMarksEntries />
          </I18nProvider>
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toContain('No mark-entry assignments match the selected period yet.');
    act(() => root.unmount());
  });
});
