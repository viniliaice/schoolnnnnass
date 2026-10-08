// @vitest-environment jsdom
//
// Component tests for the Former Students directory: search/filter passthrough,
// restore-to-Active, the preserved-history panel, the import history numbers the
// school asked for ("Import #12 — Uploaded 486, Exact matches 452 …"), and the
// typed phrase a rollback needs.

import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const listFormerStudents = vi.fn();
const listFormerStudentImports = vi.fn();
const getFormerStudentImport = vi.fn();
const setStudentFormerStatus = vi.fn();
const rollbackFormerStudentImport = vi.fn();
const getStudentStatusHistory = vi.fn();

vi.mock('../db/formerStudents', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listFormerStudents: (...a: unknown[]) => listFormerStudents(...a),
    listFormerStudentImports: (...a: unknown[]) => listFormerStudentImports(...a),
    getFormerStudentImport: (...a: unknown[]) => getFormerStudentImport(...a),
    setStudentFormerStatus: (...a: unknown[]) => setStudentFormerStatus(...a),
    rollbackFormerStudentImport: (...a: unknown[]) => rollbackFormerStudentImport(...a),
    getStudentStatusHistory: (...a: unknown[]) => getStudentStatusHistory(...a),
  };
});

const SESSION: { role: string } = { role: 'admin' };
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FormerStudents } from '../../pages/admin/FormerStudents';

const FORMER = {
  id: 'student-123456',
  name: 'Example Student',
  className: 'Grade 4-B',
  govId: 'MBK-4B-001',
  parentId: 'parent-1',
  parentName: 'Maxamed Heeban',
  parentPhone: '252634506719',
  transport: 'LEFT',
  familyId: '0001',
  status: 'former' as const,
  markedFormerAt: '2026-10-01T09:00:00Z',
  markedFormerBy: 'admin-1',
  markedFormerByName: 'Ayaan Admin',
  createdAt: '2026-01-01T00:00:00Z',
  lastChange: { reason: 'former_import', at: '2026-10-01T09:00:00Z', by: 'Ayaan Admin', fileName: 'leavers.csv', importId: 'fsi-1' },
};

const IMPORT = {
  id: 'fsi-1',
  importNumber: 12,
  fileName: 'leavers-october.csv',
  adminId: 'admin-1',
  adminName: 'Ayaan Admin',
  reason: 'Term cleanup',
  status: 'applied' as const,
  uploadedCount: 486,
  validCount: 480,
  missingNameCount: 2,
  missingSystemIdCount: 4,
  duplicateSystemIdCount: 0,
  duplicateNameCount: 1,
  foundCount: 460,
  notFoundCount: 26,
  exactMatchCount: 452,
  nameConflictCount: 8,
  possibleDuplicateCount: 1,
  reviewCount: 9,
  alreadyFormerCount: 3,
  readyCount: 452,
  deactivatedCount: 452,
  skippedCount: 34,
  restoredCount: 0,
  rollbackSkippedCount: 0,
  rolledBackAt: null,
  rolledBackByName: null,
  createdAt: '2026-10-01T09:00:00Z',
};

let host: HTMLElement;
let root: Root;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><FormerStudents /></QueryClientProvider>);
    await new Promise(r => setTimeout(r, 5));
  });
  return host;
}

async function unmount() {
  await act(async () => { root.unmount(); });
  host.remove();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button, a'))
    .find(b => (b.textContent ?? '').trim().includes(text));
  if (!found) throw new Error(`Button not found: "${text}"`);
  return found as HTMLButtonElement;
}

/** Exact label match: "History" must not match the "Import History" tab. */
function buttonByExactText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button, a'))
    .find(b => (b.textContent ?? '').trim() === text);
  if (!found) throw new Error(`Button not found (exact): "${text}"`);
  return found as HTMLButtonElement;
}

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  desc?.set?.call(el, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  SESSION.role = 'admin';
  listFormerStudents.mockResolvedValue({ total: 1, students: [FORMER], classes: ['Grade 4-B', 'Grade 2-C'] });
  listFormerStudentImports.mockResolvedValue({ total: 1, imports: [IMPORT] });
  getFormerStudentImport.mockResolvedValue({
    import: IMPORT,
    rowTotal: 1,
    rows: [{
      id: 'fsr-1', rowNumber: 2, uploadedName: 'Example Student', uploadedSystemId: 'student-123456',
      studentId: 'student-123456', studentName: 'Example Student', className: 'Grade 4-B',
      matchStatus: 'exact_match', nameMatch: 'exact', nameSimilarity: 1, reasons: [],
      requestedAction: 'deactivate', adminConfirmed: false, actionTaken: 'deactivated',
      actionReason: 'exact_system_id_match', previousStatus: 'active', newStatus: 'former', restoredAt: null,
    }],
  });
  setStudentFormerStatus.mockResolvedValue({ studentId: FORMER.id, status: 'active', changed: true });
  rollbackFormerStudentImport.mockResolvedValue({
    importId: 'fsi-1', restored: 452, skipped: 0, restoredStudentIds: [], skippedRows: [], importStatus: 'rolled_back',
  });
  getStudentStatusHistory.mockResolvedValue([{
    id: 'ssc-1', studentId: FORMER.id, studentName: FORMER.name, previousStatus: 'active', newStatus: 'former',
    reason: 'former_import', previousTransport: 'WALKER', changedBy: 'admin-1', changedByName: 'Ayaan Admin',
    importId: 'fsi-1', fileName: 'leavers-october.csv', note: null, createdAt: '2026-10-01T09:00:00Z',
  }]);
});

describe('FormerStudents — access', () => {
  it('is admin-only', async () => {
    SESSION.role = 'office';
    await mount();
    expect(host.textContent).toContain('Administrators only');
    expect(listFormerStudents).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('FormerStudents — directory', () => {
  it('lists former students with when/who/source', async () => {
    await mount();
    expect(listFormerStudents).toHaveBeenCalledWith(expect.objectContaining({ search: '', className: null }));
    const text = host.textContent ?? '';
    expect(text).toContain('Example Student');
    expect(text).toContain('student-123456');
    expect(text).toContain('Grade 4-B');
    expect(text).toContain('Ayaan Admin');
    expect(text).toContain('leavers.csv');
    expect(text).toContain('Former-student import');
    await unmount();
  });

  it('passes the search box and the class filter through to the RPC', async () => {
    await mount();
    const search = host.querySelector('input[placeholder*="Search by name"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(search, 'student-123');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
    });
    expect(listFormerStudents).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'student-123' }));

    const select = host.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      setNativeValue(select, 'Grade 2-C');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5));
    });
    expect(listFormerStudents).toHaveBeenLastCalledWith(expect.objectContaining({ className: 'Grade 2-C' }));
    await unmount();
  });

  it('restores a student to Active through the admin RPC', async () => {
    await mount();
    await act(async () => { buttonByExactText('Restore').click(); });
    expect(host.textContent).toContain('Restore to Active');
    expect(host.textContent).toContain('previous bus/transport setting is restored');

    const reason = host.querySelector('input[placeholder*="Re-enrolled"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(reason, 'Clerical error');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { buttonByText('Restore to Active').click(); await new Promise(r => setTimeout(r, 5)); });

    expect(setStudentFormerStatus).toHaveBeenCalledWith('student-123456', 'active', 'Clerical error');
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    await unmount();
  });

  it('opens the preserved historical record with the audit ledger', async () => {
    await mount();
    await act(async () => { buttonByExactText('History').click(); await new Promise(r => setTimeout(r, 5)); });
    const text = host.textContent ?? '';
    expect(text).toContain('Historical record');
    expect(text).toContain('MBK-4B-001');
    expect(text).toContain('Status history (audit ledger)');
    expect(text).toContain('active');
    expect(text).toContain('former');
    expect(text).toContain('previous transport WALKER');
    expect(text).toContain('Marks, attendance, homework');
    await unmount();
  });
});

describe('FormerStudents — import history and rollback', () => {
  it('shows the import line the school asked for', async () => {
    await mount();
    await act(async () => { buttonByText('Import History').click(); await new Promise(r => setTimeout(r, 5)); });
    const text = host.textContent ?? '';
    expect(text).toContain('Import #12');
    expect(text).toContain('Uploaded: 486');
    expect(text).toContain('Exact matches: 452');
    expect(text).toContain('ID/name conflicts: 8');
    expect(text).toContain('Not found: 26');
    expect(text).toContain('Deactivated: 452');
    expect(text).toContain('leavers-october.csv');
    expect(text).toContain('Ayaan Admin');
    await unmount();
  });

  it('expands an import to its per-row audit trail', async () => {
    await mount();
    await act(async () => { buttonByText('Import History').click(); await new Promise(r => setTimeout(r, 5)); });
    await act(async () => { buttonByText('Rows').click(); await new Promise(r => setTimeout(r, 5)); });
    expect(getFormerStudentImport).toHaveBeenCalledWith('fsi-1', 500, 0);
    const text = host.textContent ?? '';
    expect(text).toContain('Exact Match');
    expect(text).toContain('Marked as Former Student');
    expect(text).toContain('exact system id match');
    await unmount();
  });

  it('needs the typed phrase before a rollback runs', async () => {
    await mount();
    await act(async () => { buttonByText('Import History').click(); await new Promise(r => setTimeout(r, 5)); });
    await act(async () => { buttonByText('Rollback').click(); });

    expect(host.textContent).toContain('Only this import is undone');
    const confirm = buttonByText('Roll back this import');
    expect(confirm.disabled).toBe(true);

    const phrase = host.querySelector('input[placeholder="ROLLBACK IMPORT"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(phrase, 'ROLLBACK IMPORT');
      phrase.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(buttonByText('Roll back this import').disabled).toBe(false);

    await act(async () => { buttonByText('Roll back this import').click(); await new Promise(r => setTimeout(r, 5)); });
    expect(rollbackFormerStudentImport).toHaveBeenCalledWith('fsi-1', 'ROLLBACK IMPORT');
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    await unmount();
  });

  it('hides rollback for an import that was already rolled back', async () => {
    listFormerStudentImports.mockResolvedValue({ total: 1, imports: [{ ...IMPORT, status: 'rolled_back' }] });
    await mount();
    await act(async () => { buttonByText('Import History').click(); await new Promise(r => setTimeout(r, 5)); });
    expect(host.textContent).toContain('Rolled back');
    expect(buttonByText('Rollback').disabled).toBe(true);
    await unmount();
  });
});
