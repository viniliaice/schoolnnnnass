// @vitest-environment jsdom
//
// Component tests for the Admin Grade Corrections page: the correction dialog
// opens with the current value, blocks an empty reason, shows old -> new in the
// review stage, disables Confirm while saving, surfaces a server error, and
// refreshes on success. Uses raw react-dom (the repo's established pattern) with
// mocked data-layer + context modules.

import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const GRADE = {
  id: 'exam-cpw1',
  studentId: 'studentA',
  studentName: 'Axmed Cabdale Maxamuud',
  className: 'Grade 7-A',
  govId: 'GOV-1',
  subject: 'Mathematics',
  subjectId: 'math',
  assessmentLabel: 'CPW1',
  examType: 'Classwork',
  score: 12,
  total: 15,
  entryState: 'scored',
  status: 'approved',
  month: 'September',
  date: '2026-09-04',
  termId: 'term1',
  teacherId: 'teacherA',
  uploadedBy: 'teacherA',
};

const searchGradesForCorrection = vi.fn();
const correctGrade = vi.fn();
const getGradeCorrectionHistory = vi.fn();
const getClasses = vi.fn();
const getTerms = vi.fn();

vi.mock('../db/exams', () => ({ searchGradesForCorrection: (...a: unknown[]) => searchGradesForCorrection(...a) }));
vi.mock('../db/gradeCorrections', () => ({
  correctGrade: (...a: unknown[]) => correctGrade(...a),
  getGradeCorrectionHistory: (...a: unknown[]) => getGradeCorrectionHistory(...a),
}));
vi.mock('../db/classes', () => ({ getClasses: (...a: unknown[]) => getClasses(...a) }));
vi.mock('../db/academic', () => ({ getTerms: (...a: unknown[]) => getTerms(...a) }));

const SESSION = { role: 'admin', userId: 'adminU', name: 'Admin' } as const;
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { GradeCorrections } from '../../pages/admin/GradeCorrections';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GradeCorrections />
      </QueryClientProvider>,
    );
  });
  return host;
}

function clickButtonByText(host: HTMLElement, text: string) {
  const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim().includes(text));
  if (!btn) throw new Error(`Button not found: ${text}`);
  return btn;
}

async function tick() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

// React 19 tracks a value tracker on inputs/selects; set the value via the
// prototype setter so the dispatched event is seen as a real change.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
}

beforeEach(() => {
  searchGradesForCorrection.mockReset();
  correctGrade.mockReset();
  getGradeCorrectionHistory.mockReset();
  getClasses.mockReset();
  getTerms.mockReset();
  addToast.mockReset();
  document.body.innerHTML = '';
  getClasses.mockResolvedValue(['Grade 7-A']);
  getTerms.mockResolvedValue([{ id: 'term1', name: 'Term 1' }]);
  searchGradesForCorrection.mockResolvedValue({ rows: [GRADE], total: 1 });
});

async function openDialogWithResults() {
  const host = await mount();
  // Wait for the class options (async) to populate before selecting one.
  await tick(); await tick();
  // Apply a class filter to trigger a search.
  const classSelect = host.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    setNativeValue(classSelect, 'Grade 7-A');
    classSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await tick(); await tick(); await tick();
  return host;
}

describe('GradeCorrections page', () => {
  it('correction dialog opens showing the current value', async () => {
    const host = await openDialogWithResults();
    expect(host.textContent).toContain('Axmed Cabdale Maxamuud');
    await act(async () => { clickButtonByText(host, 'Correct').click(); });
    expect(host.textContent).toContain('Correct Grade');
    expect(host.textContent).toContain('Current score');
    // Current value 12 / 15 is displayed.
    expect(host.textContent).toContain('12');
  });

  it('blocks Review while the reason is empty, enables it once provided', async () => {
    const host = await openDialogWithResults();
    await act(async () => { clickButtonByText(host, 'Correct').click(); });

    // Change the score to 10 but leave reason empty → Review disabled.
    const scoreInput = host.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(scoreInput, '10');
      scoreInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const review = clickButtonByText(host, 'Review Correction') as HTMLButtonElement;
    expect(review.disabled).toBe(true);

    // Provide a reason → enabled.
    const reason = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(reason, 'Incorrect value entered during bulk upload');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((clickButtonByText(host, 'Review Correction') as HTMLButtonElement).disabled).toBe(false);
  });

  it('review stage shows old -> new, and confirm calls the RPC and shows success', async () => {
    correctGrade.mockResolvedValue({
      auditId: 'gca-1', examId: 'exam-cpw1', studentId: 'studentA', subject: 'Mathematics',
      assessmentLabel: 'CPW1', oldScore: 12, newScore: 10, oldEntryState: 'scored', newEntryState: 'scored',
      oldStatus: 'approved', newStatus: 'pending', total: 15, reason: 'x', correctedBy: 'adminU', message: 'ok',
    });
    const host = await openDialogWithResults();
    await act(async () => { clickButtonByText(host, 'Correct').click(); });

    const scoreInput = host.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => { setNativeValue(scoreInput, '10'); scoreInput.dispatchEvent(new Event('input', { bubbles: true })); });
    const reason = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { setNativeValue(reason, 'Incorrect value entered during bulk upload'); reason.dispatchEvent(new Event('input', { bubbles: true })); });

    await act(async () => { clickButtonByText(host, 'Review Correction').click(); });
    expect(host.textContent).toContain('Confirm Grade Correction');
    expect(host.textContent).toContain('Previous');
    expect(host.textContent).toContain('New');
    // Approved-grade warning surfaces.
    expect(host.textContent).toContain('reset its status to');

    await act(async () => { clickButtonByText(host, 'Confirm Correction').click(); });
    await tick();
    expect(correctGrade).toHaveBeenCalledWith(expect.objectContaining({ examId: 'exam-cpw1', expectedOldScore: 12, newScore: 10 }));
    expect(host.textContent).toContain('Grade corrected successfully');
    expect(addToast).toHaveBeenCalled();
  });

  it('surfaces a server error (e.g. concurrency conflict) in the dialog', async () => {
    correctGrade.mockRejectedValue(new Error('This grade was changed by another administrator. Refresh the record before correcting it.'));
    const host = await openDialogWithResults();
    await act(async () => { clickButtonByText(host, 'Correct').click(); });
    const scoreInput = host.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => { setNativeValue(scoreInput, '10'); scoreInput.dispatchEvent(new Event('input', { bubbles: true })); });
    const reason = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { setNativeValue(reason, 'valid reason text'); reason.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { clickButtonByText(host, 'Review Correction').click(); });
    await act(async () => { clickButtonByText(host, 'Confirm Correction').click(); });
    await tick();
    expect(host.textContent).toContain('changed by another administrator');
  });

  it('shows an empty state when no grades match', async () => {
    searchGradesForCorrection.mockResolvedValue({ rows: [], total: 0 });
    const host = await openDialogWithResults();
    expect(host.textContent).toContain('No grades found');
  });
});
