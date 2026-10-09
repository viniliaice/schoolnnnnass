// @vitest-environment jsdom
//
// Component tests for the Former Students / Student Cleanup page: the upload
// screen, the review table (with the columns and statuses the school asked for),
// the safety rails around selection, the review-confirmation dialog for a name
// mismatch, and the final typed confirmation before anything is written.
//
// Uses raw react-dom (the repo's established pattern, see
// gradeCorrectionsPage.test.tsx) with the data layer mocked. The preview rows
// are produced by the REAL pure evaluator so the wiring — not a hand-written
// fixture — is what gets asserted.

import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { evaluateFormerStudentRows } from '../import/formerStudents';
import type { Student } from '../../types';

const previewFormerStudentImport = vi.fn();
const applyFormerStudentImport = vi.fn();
const getStudents = vi.fn();

// Keep the real label/phrase helpers (they are what the admin reads on screen)
// and replace only the two RPC calls.
vi.mock('../db/formerStudents', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    previewFormerStudentImport: (...args: unknown[]) => previewFormerStudentImport(...args),
    applyFormerStudentImport: (...args: unknown[]) => applyFormerStudentImport(...args),
  };
});
vi.mock('../db/students', () => ({
  getStudents: (...args: unknown[]) => getStudents(...args),
}));

const SESSION: { role: string } = { role: 'admin' };
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FormerStudentCleanup } from '../../pages/admin/FormerStudentCleanup';

const STUDENTS: Student[] = [
  { id: 'student-123456', name: 'Example Student', className: 'Grade 4-B', parentId: null, createdAt: '2026-01-01', status: 'active', transport: 'WALKER' },
  { id: 'student-789012', name: 'Aisha Hassan Ali', className: 'Grade 2-C', parentId: null, createdAt: '2026-01-01', status: 'active', transport: '7' },
  { id: 'student-former-1', name: 'Already Gone', className: 'Grade 9-A', parentId: null, createdAt: '2026-01-01', status: 'former', transport: 'LEFT' },
];

const CSV = [
  'Student Name,System ID',
  'Example Student,student-123456',      // ✅ exact match
  'Wrong Person,student-789012',         // ⚠️ id match, name differs
  'Ghost Child,student-000000',          // ❌ not found
  'No Id Child,',                        // ⚠️ missing System ID
  'Already Gone,student-former-1',       // ℹ️ already former
].join('\n');

function previewFor(csv: string) {
  const rows = csv.split('\n').slice(1).filter(Boolean).map((line, i) => {
    const [name, systemId] = line.split(',');
    return { rowNumber: i + 2, name: name ?? '', systemId: systemId ?? '' };
  });
  const evaluation = evaluateFormerStudentRows(rows, STUDENTS);
  return { dryRun: true, writesPerformed: 0, evaluatedAt: new Date().toISOString(), ...evaluation };
}

let host: HTMLElement;
let root: Root;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><FormerStudentCleanup /></QueryClientProvider>);
  });
  return host;
}

async function unmount() {
  await act(async () => { root.unmount(); });
  host.remove();
}

/** jsdom has no File.arrayBuffer, so the page is handed a file-shaped object. */
async function uploadCsv(csv = CSV, name = 'leavers-october.csv') {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  const fakeFile = {
    name,
    size: csv.length,
    arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
  };
  Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 5));
  });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').trim().includes(text));
  if (!found) throw new Error(`Button not found: "${text}". Buttons: ${Array.from(host.querySelectorAll('button')).map(b => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
}

async function typeInto(placeholder: string, value: string) {
  const input = Array.from(host.querySelectorAll('input')).find(i => i.placeholder?.includes(placeholder)) as HTMLInputElement;
  if (!input) throw new Error(`Input not found: ${placeholder}`);
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  SESSION.role = 'admin';
  previewFormerStudentImport.mockImplementation(async (rows: unknown) => ({ data: null, error: null, rows }));
  previewFormerStudentImport.mockResolvedValue(previewFor(CSV));
  getStudents.mockResolvedValue(STUDENTS);
  applyFormerStudentImport.mockResolvedValue({
    importId: 'fsi-1', importNumber: 12, committed: true, atomic: true,
    fileName: 'leavers-october.csv', adminId: 'admin-1', adminName: 'Ayaan Admin',
    deactivated: 1, skipped: 1, keptActive: 0, blocked: 2, deleted: 0,
    formerStudentIds: ['student-123456'],
    skippedRows: [
      { rowNumber: 3, uploadedSystemId: 'student-789012', reason: 'requires_manual_review' },
      { rowNumber: 4, uploadedSystemId: 'student-000000', reason: 'system_id_not_found' },
    ],
    summary: previewFor(CSV).summary,
    completedAt: new Date().toISOString(),
  });
});

describe('FormerStudentCleanup — access and upload screen', () => {
  it('refuses everyone who is not an administrator', async () => {
    SESSION.role = 'supervisor';
    await mount();
    expect(host.textContent).toContain('Administrators only');
    expect(host.querySelector('input[type="file"]')).toBeNull();
    await unmount();
  });

  it('explains the safety contract before anything is uploaded', async () => {
    await mount();
    expect(host.textContent).toContain('Former Students / Student Cleanup');
    expect(host.textContent).toContain('System ID is the only match key');
    expect(host.textContent).toContain('Nothing is deleted');
    expect(host.textContent).toContain('Students not in the file are never touched');
    expect(host.querySelector('input[type="file"]')).toBeTruthy();
    await unmount();
  });

  it('rejects an unsupported file type without calling the database', async () => {
    await mount();
    await uploadCsv('Student Name,System ID\nA,student-1', 'list.pdf');
    expect(host.textContent).toContain('Unsupported file type');
    expect(previewFormerStudentImport).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('FormerStudentCleanup — review screen', () => {
  it('sends the parsed rows to the server preview and shows the required columns', async () => {
    await mount();
    await uploadCsv();

    expect(previewFormerStudentImport).toHaveBeenCalledTimes(1);
    const sent = previewFormerStudentImport.mock.calls[0][0] as Array<{ rowNumber: number; name: string; systemId: string }>;
    expect(sent).toHaveLength(5);
    expect(sent[0]).toEqual({ rowNumber: 2, name: 'Example Student', systemId: 'student-123456' });

    for (const column of [
      'Uploaded Name', 'Uploaded System ID', 'Database Name', 'Database System ID',
      'Class / Section', 'Match Status', 'Name Match', 'Action',
    ]) {
      expect(host.textContent, column).toContain(column);
    }
    await unmount();
  });

  it('shows the dashboard counts the school asked for', async () => {
    await mount();
    await uploadCsv();
    const text = host.textContent ?? '';
    expect(text).toContain('Uploaded');
    expect(text).toContain('Matched');
    expect(text).toContain('Needs review');
    expect(text).toContain('Not found');
    expect(text).toContain('Ready to deactivate');
    expect(text).toContain('leavers-october.csv');
    await unmount();
  });

  it('pre-selects only the automatically safe row', async () => {
    await mount();
    await uploadCsv();
    // One row is an exact match; the others are conflict / not found / no id / already former.
    expect(host.textContent).toContain('1 student(s) selected');
    expect(buttonByText('Deactivate Selected').disabled).toBe(false);
    await unmount();
  });

  it('never offers a Deactivate action for a not-found or missing-ID row', async () => {
    await mount();
    await uploadCsv();
    const rows = Array.from(host.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(5);
    const notFound = rows[2].textContent ?? '';
    const missingId = rows[3].textContent ?? '';
    expect(notFound).toContain('Cannot be applied');
    expect(missingId).toContain('Cannot be applied');
    expect(rows[4].textContent).toContain('No action needed'); // already former
    await unmount();
  });

  it('Select All Safe Matches keeps the unsafe rows out', async () => {
    await mount();
    await uploadCsv();
    await act(async () => { buttonByText('Clear selection').click(); });
    expect(host.textContent).toContain('0 student(s) selected');

    await act(async () => { buttonByText('Select All Safe Matches').click(); });
    expect(host.textContent).toContain('1 student(s) selected');
    await unmount();
  });

  it('asks for an individual confirmation before a name-mismatch row can be selected', async () => {
    await mount();
    await uploadCsv();
    const rows = Array.from(host.querySelectorAll('tbody tr'));
    const conflictRow = rows[1];
    expect(conflictRow.textContent).toContain('ID Match but Name Different');

    const reviewButton = Array.from(conflictRow.querySelectorAll('button'))
      .find(b => (b.textContent ?? '').includes('Review')) as HTMLButtonElement;
    expect(reviewButton).toBeTruthy();
    await act(async () => { reviewButton.click(); });

    // The dialog warns and cannot be confirmed without the explicit checkbox.
    expect(host.textContent).toContain('Review this match before deactivating');
    const confirmButton = buttonByText('Confirm this student');
    expect(confirmButton.disabled).toBe(true);

    const checkbox = Array.from(host.querySelectorAll('input[type="checkbox"]')).pop() as HTMLInputElement;
    // A real click: jsdom runs the activation behaviour (toggling `checked`),
    // which is what React's onChange is synthesized from.
    await act(async () => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(checkbox.checked).toBe(true);
    expect(buttonByText('Confirm this student').disabled).toBe(false);

    await act(async () => { buttonByText('Confirm this student').click(); });
    expect(host.textContent).toContain('2 student(s) selected');
    await unmount();
  });

  it('warns loudly before selecting every found row', async () => {
    await mount();
    await uploadCsv();
    await act(async () => { buttonByText('Select every found row').click(); });
    expect(host.textContent).toContain('You are selecting rows that have NOT been individually checked');
    await act(async () => { buttonByText('I understand — select them').click(); });
    // Exact match + the individually reviewable conflict row; never the blocked ones.
    expect(host.textContent).toContain('2 student(s) selected');
    await unmount();
  });

  it('falls back to a browser-side preview when the RPC is missing, and says so', async () => {
    previewFormerStudentImport.mockRejectedValue(new Error('Mock RPC preview_former_student_import not implemented'));
    await mount();
    await uploadCsv();
    expect(getStudents).toHaveBeenCalledWith(undefined, 'all');
    expect(host.textContent).toContain('matched in the browser');
    expect(host.textContent).toContain('Example Student');
    await unmount();
  });

  it('surfaces a permission error instead of silently previewing', async () => {
    previewFormerStudentImport.mockRejectedValue(new Error('Only admins may preview a former-student import.'));
    await mount();
    await uploadCsv();
    expect(host.textContent).toContain('Only admins may preview');
    expect(getStudents).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('FormerStudentCleanup — confirmation and completion', () => {
  it('requires the exact phrase before the import can run', async () => {
    await mount();
    await uploadCsv();
    await act(async () => { buttonByText('Deactivate Selected').click(); });

    const text = host.textContent ?? '';
    expect(text).toContain('You are about to mark 1 students as Former Students.');
    expect(text).toContain('No student records will be deleted.');
    expect(text).toContain('Historical records will be preserved.');
    expect(text).toContain('These students will no longer appear in active student lists.');
    expect(text).toContain('leavers-october.csv');

    const confirm = buttonByText('Mark 1 as Former Students');
    expect(confirm.disabled).toBe(true);

    await typeInto('MARK AS FORMER STUDENTS', 'mark as former');
    expect(buttonByText('Mark 1 as Former Students').disabled).toBe(true);

    await typeInto('MARK AS FORMER STUDENTS', 'MARK AS FORMER STUDENTS');
    expect(buttonByText('Mark 1 as Former Students').disabled).toBe(false);
    await unmount();
  });

  it('sends the admin decisions to the single atomic RPC and shows the result', async () => {
    await mount();
    await uploadCsv();
    await act(async () => { buttonByText('Deactivate Selected').click(); });
    await typeInto('MARK AS FORMER STUDENTS', 'MARK AS FORMER STUDENTS');
    await act(async () => { buttonByText('Mark 1 as Former Students').click(); await new Promise(r => setTimeout(r, 5)); });

    expect(applyFormerStudentImport).toHaveBeenCalledTimes(1);
    const [rows, fileName] = applyFormerStudentImport.mock.calls[0];
    expect(fileName).toBe('leavers-october.csv');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ rowNumber: 2, systemId: 'student-123456', action: 'deactivate', adminConfirmed: true });
    expect(rows[1]).toMatchObject({ rowNumber: 3, systemId: 'student-789012', action: 'review' });
    expect(rows[2]).toMatchObject({ rowNumber: 4, systemId: 'student-000000', action: 'review' });

    expect(host.textContent).toContain('Import #12 completed');
    expect(host.textContent).toContain('0 student records were deleted');
    expect(host.textContent).toContain('Rows that were refused');
    expect(addToast).toHaveBeenCalled();
    await unmount();
  });

  it('reports a failed import without pretending it worked', async () => {
    applyFormerStudentImport.mockRejectedValue(new Error('Only admins may mark students as former.'));
    await mount();
    await uploadCsv();
    await act(async () => { buttonByText('Deactivate Selected').click(); });
    await typeInto('MARK AS FORMER STUDENTS', 'MARK AS FORMER STUDENTS');
    await act(async () => { buttonByText('Mark 1 as Former Students').click(); await new Promise(r => setTimeout(r, 5)); });

    expect(host.textContent).toContain('Only admins may mark students as former');
    expect(host.textContent).not.toContain('Import #12 completed');
    await unmount();
  });
});
