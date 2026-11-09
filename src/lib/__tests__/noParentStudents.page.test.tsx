// @vitest-environment jsdom
//
// The "No parent" tab is the office worklist: it must show exactly the active
// students with no parent account, must never claim "0" when the roster failed
// to load, and must not alter anything (read-only surface).

import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const STUDENTS = [
  { id: 'a', name: 'Akram salebaan cabdi', className: 'Grade 2-B', parentId: null,
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 'b', name: 'Safa sulayman cabdi', className: 'Grade 9-A', parentId: null,
    createdAt: '', transport: 'WALKER', parentPhone: '634506719', familyId: '0305', status: 'active' },
  { id: 'c', name: 'Marwa suleban cabdi', className: 'Grade 6-B', parentId: null,
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: null, status: 'active' },
  { id: 'd', name: 'Cawale Maxamed Heebaan', className: 'Grade 8-B', parentId: 'parent-1',
    createdAt: '', transport: 'DRIVER', parentPhone: null, familyId: '0305', status: 'active' },
  { id: 'e', name: 'Left Student', className: 'Grade 5-A', parentId: null,
    createdAt: '', transport: 'LEFT', parentPhone: null, familyId: '0001', status: 'active' },
  { id: 'f', name: 'Former Student', className: 'Grade 5-B', parentId: null,
    createdAt: '', transport: 'WALKER', parentPhone: null, familyId: null, status: 'former' },
];

const getStudents = vi.fn();
const getParentNames = vi.fn();

vi.mock('../db/students', () => ({ getStudents: (...a: unknown[]) => getStudents(...a) }));
vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../db/familyCards', () => ({ getFamilyCards: vi.fn() }));
vi.mock('../db/familyIds', async () => {
  const actual = await vi.importActual<typeof import('../db/familyIds')>('../db/familyIds');
  return {
    ...actual,
    getParentNames: (...a: unknown[]) => getParentNames(...a),
    splitFamilyMembers: vi.fn(),
  };
});
const SESSION = { role: 'office', id: 'u1', name: 'Office' } as const;
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FamilyIds } from '../../pages/admin/FamilyIds';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FamilyIds mode="no-parent" navigate={() => {}} />);
  });
  return host;
}

beforeEach(() => {
  getStudents.mockReset();
  getParentNames.mockReset();
  document.body.innerHTML = '';
});

describe('Family IDs — "No parent" tab (office)', () => {
  it('lists only active students with no parent account, and excludes leavers/former', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map());

    const host = await mount();
    const text = host.textContent ?? '';

    expect(text).toContain('Akram salebaan cabdi');
    expect(text).toContain('Safa sulayman cabdi');
    expect(text).toContain('Marwa suleban cabdi');
    expect(text).not.toContain('Cawale Maxamed Heebaan'); // has a parent account
    expect(text).not.toContain('Left Student');
    expect(text).not.toContain('Former Student');
    expect(text).toContain('3 students');
  });

  it('flags the student who still has no Family ID, and shows the tab count', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map());

    const host = await mount();
    const text = host.textContent ?? '';

    expect(text).toContain('missing');
    expect(text).toContain('1 still need a Family ID');
    expect(text).toContain('No parent (3)');
    expect(text).toContain('2 already have a Family ID');
  });

  it('does not show the families print surface on this tab', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockResolvedValue(new Map());

    const host = await mount();
    const text = host.textContent ?? '';

    expect(text).not.toContain('Print selected');
    expect(text).not.toContain('Setup & Generate'); // office cannot generate anyway
  });
});
