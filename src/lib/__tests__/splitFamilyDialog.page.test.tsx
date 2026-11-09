// @vitest-environment jsdom
//
// Full UI path for the reported bug: MBK-0305 holds two parent accounts, the
// admin opens Split, picks the students of the other household, and the new
// Family ID is requested. This locks the wiring between the table row badge,
// the dialog's parent grouping and the split RPC call.

import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// The reported family, verbatim (8 students, two parent accounts, one unparented).
const STUDENTS = [
  { id: 's-akram', name: 'Akram salebaan cabdi', className: 'Grade 2-B', parentId: 'parent-b',
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 's-safa', name: 'Safa sulayman cabdi', className: 'Grade 9-A', parentId: 'parent-b',
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 's-sudaysi', name: 'Sudaysi sulayman cabdi', className: 'Grade 9-B', parentId: 'parent-b',
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 's-marwa', name: 'Marwa suleban cabdi', className: 'Grade 6-B', parentId: null,
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 's-barwaaqo', name: 'barwaaqo maxamed heeban', className: 'Grade 2-C', parentId: 'parent-a',
    createdAt: '', transport: 'DRIVER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 's-cabdiraxmaan', name: 'Cabdiraxmaan Maxamed Heebaan', className: 'Grade 6-A', parentId: 'parent-a',
    createdAt: '', transport: 'DRIVER', parentPhone: '4474422', familyId: '0305', status: 'active' },
];

const getStudents = vi.fn();
const getParentNames = vi.fn();
const splitFamilyMembers = vi.fn();

vi.mock('../db/students', () => ({ getStudents: (...a: unknown[]) => getStudents(...a) }));
vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../db/familyCards', () => ({ getFamilyCards: vi.fn() }));
vi.mock('../db/familyIds', async () => {
  const actual = await vi.importActual<typeof import('../db/familyIds')>('../db/familyIds');
  return {
    ...actual,
    getParentNames: (...a: unknown[]) => getParentNames(...a),
    splitFamilyMembers: (...a: unknown[]) => splitFamilyMembers(...a),
  };
});
const SESSION = { role: 'admin', id: 'admin-1', name: 'Admin' } as const;
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FamilyIds } from '../../pages/admin/FamilyIds';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FamilyIds mode="browse" navigate={() => {}} />);
  });
  return host;
}

const buttonByText = (host: HTMLElement, pattern: RegExp) =>
  Array.from(host.querySelectorAll('button')).find(b => pattern.test((b.textContent ?? '').trim())) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  getStudents.mockReset();
  getParentNames.mockReset();
  splitFamilyMembers.mockReset();
  document.body.innerHTML = '';
});

describe('Family IDs — Split a merged family (MBK-0305)', () => {
  it('flags the multi-parent family and splits the chosen students onto a new ID', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map([
      ['parent-a', 'ikraan cabdi khaliif'],
      ['parent-b', 'ikraanmaxmedaxmed'],
    ]));
    splitFamilyMembers.mockResolvedValue({
      familyId: '0305', newFamilyId: '0679', studentsMoved: 3, remaining: 3,
    });

    const host = await mount();

    // The exact merge signal is visible before any click.
    expect(host.textContent).toContain('2 parents');

    const splitButton = buttonByText(host, /^Split$/);
    expect(splitButton, 'row Split button').toBeTruthy();
    await act(async () => { splitButton!.click(); });

    // Dialog names the family and groups by parent account, not by surname.
    expect(document.body.textContent).toContain('Separate MBK-0305');
    expect(document.body.textContent).toContain('ikraan cabdi khaliif');
    expect(document.body.textContent).toContain('ikraanmaxmedaxmed');
    expect(document.body.textContent).toContain('No parent account');

    // Pick one student of the second household.
    const akram = Array.from(document.body.querySelectorAll('label')).find(l =>
      (l.textContent ?? '').includes('Akram salebaan cabdi'),
    );
    expect(akram, 'Akram row').toBeTruthy();
    const checkbox = akram!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });

    const confirm = buttonByText(document.body as HTMLElement, /Split 1 to a new ID/);
    expect(confirm, 'confirm button').toBeTruthy();
    await act(async () => { confirm!.click(); });

    expect(splitFamilyMembers).toHaveBeenCalledWith('0305', ['s-akram']);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('never lets the admin move the whole family out of its ID', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map());

    const host = await mount();
    await act(async () => { buttonByText(host, /^Split$/)!.click(); });

    const boxes = Array.from(document.body.querySelectorAll('label input[type="checkbox"]')) as HTMLInputElement[];
    await act(async () => { boxes.forEach(box => box.click()); });

    expect(document.body.textContent).toContain('Leave at least one student');
    const confirm = buttonByText(document.body as HTMLElement, /Split 6 to a new ID/);
    expect(confirm, 'confirm button is present but disabled').toBeTruthy();
    expect(confirm!.disabled).toBe(true);
    await act(async () => { confirm!.click(); });
    expect(splitFamilyMembers).not.toHaveBeenCalled();
  });

  it('hides the Split action from office users (SQL is the enforcement point)', async () => {
    // Re-mount with an office session by replacing the mocked role.
    vi.resetModules();
    vi.doMock('../../context/RoleContext', () => ({
      useRole: () => ({ session: { role: 'office', id: 'office-1', name: 'Office' } }),
    }));
    const { FamilyIds: OfficeFamilyIds } = await import('../../pages/admin/FamilyIds');

    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map());

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<OfficeFamilyIds mode="browse" navigate={() => {}} />); });

    expect(host.textContent).toContain('MBK-0305');
    expect(buttonByText(host, /^Split$/)).toBeUndefined();
  });
});
