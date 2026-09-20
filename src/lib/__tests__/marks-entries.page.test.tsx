// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../i18n/AppLanguageContext';
import type { MarksEntryRow } from '../marksEntryTracking';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { getAcademicYears, getTerms, useMarksEntryTracking } = vi.hoisted(() => ({
  getAcademicYears: vi.fn(),
  getTerms: vi.fn(),
  useMarksEntryTracking: vi.fn(),
}));

vi.mock('../db/academic', () => ({
  getAcademicYears: (...args: unknown[]) => getAcademicYears(...args),
  getTerms: (...args: unknown[]) => getTerms(...args),
}));

vi.mock('../hooks/useMarksEntryTracking', () => ({
  useMarksEntryTracking: (...args: unknown[]) => useMarksEntryTracking(...args),
}));

import { MonitorMarksEntries } from '../../pages/supervisor/MonitorMarksEntries';

function monitorRow(overrides: Partial<MarksEntryRow> = {}): MarksEntryRow {
  return {
    assignmentId: 'cs-english',
    teacherId: 'teacher-1',
    teacherName: 'Hodan Ali',
    className: 'Grade 5-A',
    subjectId: 'english',
    subjectName: 'English',
    academicYearId: 'ay-1',
    termId: 'term-1',
    examScope: 'final',
    month: null,
    expectedStudents: 3,
    enteredStudents: 2,
    missingStudents: [{ id: 's-3', name: 'Student Three' }],
    percentage: 66.67,
    status: 'in_progress',
    lastUpdated: '2026-09-18T12:00:00Z',
    homeworkEntered: 0,
    classworkEntered: 0,
    quizEntered: 0,
    attendanceEntered: 0,
    courseworkComplete: false,
    quizComplete: false,
    monthlyCompleteStudents: 2,
    ...overrides,
  };
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MonitorMarksEntries />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 80; i += 1) {
    const content = host.textContent ?? '';
    if ((content.includes('2026/2027') && content.includes('View details')) || content.includes('No assigned class-subjects') || content.includes('Could not load')) break;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return { host, root };
}

function change(host: HTMLElement, id: string, value: string) {
  const element = host.querySelector<HTMLSelectElement>(`#${id}`);
  if (!element) throw new Error(`Missing select ${id}`);
  return act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  getAcademicYears.mockResolvedValue([
    { id: 'ay-1', name: '2026/2027', startDate: '2026-08-01', endDate: '2027-07-31', isCurrent: true, createdAt: '' },
  ]);
  getTerms.mockResolvedValue([
    { id: 'term-1', name: 'Term 1', academicYearId: 'ay-1', startDate: '2026-08-01', endDate: '2026-12-31', isCurrent: true, months: ['September', 'October'], createdAt: '' },
  ]);
  useMarksEntryTracking.mockReturnValue({ data: [monitorRow()], isLoading: false, error: null });
});

describe('MonitorMarksEntries', () => {
  it('shows assignment-first progress and the required status filters', async () => {
    const { host } = await mount();
    expect(host.textContent).toContain('Monitor Marks Entries');
    expect(host.textContent).toContain('Hodan Ali');
    expect(host.textContent).toContain('2/3 students');
    expect(host.textContent).toContain('In Progress');
    expect(host.querySelector('#marks-status-filter')).not.toBeNull();
    expect(host.textContent).toContain('Not Started');
    expect(host.textContent).toContain('Complete');
  });

  it('supports status filtering and opens missing-student detail without name-based matching', async () => {
    const second = monitorRow({
      assignmentId: 'cs-math',
      teacherId: 'teacher-2',
      teacherName: 'Ahmed Noor',
      subjectId: 'math',
      subjectName: 'Mathematics',
      status: 'complete',
      expectedStudents: 3,
      enteredStudents: 3,
      missingStudents: [],
      percentage: 100,
    });
    useMarksEntryTracking.mockReturnValue({ data: [monitorRow(), second], isLoading: false, error: null });
    const { host } = await mount();

    await change(host, 'marks-status-filter', 'complete');
    const tableRows = [...host.querySelectorAll('tbody tr')].map((entry) => entry.textContent ?? '');
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]).toContain('Mathematics');
    expect(tableRows[0]).not.toContain('English');

    const viewButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('View details'));
    expect(viewButton).toBeDefined();
    await act(async () => { viewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.textContent).toContain('Missing students');
    expect(host.textContent).toContain('Every active term-roster student has the required entry.');
  });

  it('does not apply a stale month filter to term-scoped midterm/final workflows', async () => {
    const { host } = await mount();
    await change(host, 'marks-exam-scope', 'final');
    expect((host.querySelector('#marks-month') as HTMLSelectElement).disabled).toBe(true);
    const latestQuery = useMarksEntryTracking.mock.calls.at(-1)?.[0] as { examScope: string; month: string | null };
    expect(latestQuery).toMatchObject({ examScope: 'final', month: null });
  });

  it('shows monthly Entry Details as Homework (CA), Classwork, Quiz, Attendance with the entered quiz count', async () => {
    // ENGLISH — Kayse Maxamad · Grade 2-C · August, after the RPC fix.
    const monthlyRow = monitorRow({
      assignmentId: 'cs-2c-english',
      teacherName: 'Kayse Maxamad',
      className: 'Grade 2-C',
      subjectName: 'ENGLISH',
      examScope: 'monthly',
      month: 'August',
      expectedStudents: 42,
      enteredStudents: 34,
      monthlyCompleteStudents: 34,
      missingStudents: Array.from({ length: 8 }, (_, index) => ({ id: `g2c-${35 + index}`, name: `Student ${35 + index}` })),
      percentage: 80.95,
      status: 'in_progress',
      homeworkEntered: 34,
      classworkEntered: 34,
      quizEntered: 34,
      attendanceEntered: 34,
    });
    useMarksEntryTracking.mockReturnValue({ data: [monthlyRow], isLoading: false, error: null });
    const { host } = await mount();

    const viewButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('View details'));
    expect(viewButton).toBeDefined();
    await act(async () => { viewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('ENGLISH');
    expect(dialog?.textContent).toContain('Kayse Maxamad · Grade 2-C');
    expect(dialog?.textContent).toContain('Monthly coursework + quiz · August');

    const components = dialog?.querySelector('[data-testid="monthly-components"]');
    expect(components).not.toBeNull();
    const tiles = [...(components?.children ?? [])].map((tile) => ({
      label: tile.querySelector('p')?.textContent ?? '',
      value: tile.querySelectorAll('p')[1]?.textContent ?? '',
    }));
    // Exactly four components: Homework is the CA component, no separate CA tile.
    expect(tiles).toEqual([
      { label: 'Homework (CA)', value: '34/42' },
      { label: 'Classwork', value: '34/42' },
      { label: 'Quiz', value: '34/42' },
      { label: 'Attendance', value: '34/42' },
    ]);
    expect(tiles.map((tile) => tile.label)).not.toContain('CA');
    expect(tiles.map((tile) => tile.label)).not.toContain('Homework');
    expect(dialog?.textContent).not.toContain('0/42');

    // Overall completion still follows the existing blended monitor rule.
    expect(dialog?.textContent).toContain('80.95%');
    expect(dialog?.textContent).toContain('34/42 students');
    expect(dialog?.textContent).toContain('8 not complete');
  });

  it('renders an explicit empty state when the secured query returns no assignments', async () => {
    useMarksEntryTracking.mockReturnValue({ data: [], isLoading: false, error: null });
    const { host } = await mount();
    expect(host.textContent).toContain('No assigned class-subjects found');
    expect(host.textContent).toContain('teacher profile without a class-subject assignment');
  });
});
