// @vitest-environment jsdom
//
// REGRESSION: the families table must render as soon as STUDENTS arrive, even
// if the parent-name lookup is slow, hanging, or denied.
//
// This page shipped that bug once before (INVESTIGATION-FamilyIds-Performance
// finding 1: the eager parent fetch was awaited inside reload()), and Phase 2
// reintroduced it — the table sat on "Loading families…" forever whenever
// `profiles` did not answer. profiles is admin-readable ONLY, so for office
// and supervisor that is the NORMAL case, not an edge case.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const STUDENTS = [
  { id:'a', name:'Ahmed Sheikh', className:'Grade 7-A', parentId:'p1', createdAt:'', transport:'9',      parentPhone:'0612345678', familyId:'0042' },
  { id:'b', name:'Amina Sheikh', className:'Grade 4-B', parentId:'p1', createdAt:'', transport:'WALKER', parentPhone:'0612345678', familyId:'0042' },
];

const getStudents = vi.fn();
const getParentNames = vi.fn();

vi.mock('../db/students', () => ({ getStudents: (...a: unknown[]) => getStudents(...a) }));
vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../db/familyCards', () => ({ getFamilyCards: vi.fn() }));
vi.mock('../db/familyIds', async () => {
  const actual = await vi.importActual<typeof import('../db/familyIds')>('../db/familyIds');
  return { ...actual, getParentNames: (...a: unknown[]) => getParentNames(...a) };
});
const SESSION = { role: 'office', id: 'u1', name: 'Office' } as const;
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
// The mocked hook MUST return a stable addToast identity: reload() is a
// useCallback keyed on it, so a fresh function per render would spin the
// load effect forever (an artifact of the mock, not of the page).
const addToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FamilyIds } from '../../pages/admin/FamilyIds';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<FamilyIds mode="browse" navigate={() => {}} />); });
  return host;
}

beforeEach(() => { getStudents.mockReset(); getParentNames.mockReset(); document.body.innerHTML = ''; });

describe('Family IDs page — table must not wait on parent names', () => {
  it('renders families while the parent-name lookup NEVER resolves', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockReturnValue(new Promise(() => {}));   // hangs forever

    const host = await mount();

    expect(host.textContent).not.toContain('Loading families');
    expect(host.textContent).toContain('MBK-0042');
    expect(host.textContent).toContain('Ahmed Sheikh');
    expect(host.textContent).toContain('G7');
  });

  it('renders families when the parent-name lookup is DENIED', async () => {
    getStudents.mockResolvedValue(STUDENTS);
    getParentNames.mockRejectedValue(new Error('permission denied'));

    const host = await mount();

    expect(host.textContent).not.toContain('Loading families');
    expect(host.textContent).toContain('MBK-0042');
  });

  it('shows a retryable error, not a false "no families", when students fail', async () => {
    getStudents.mockRejectedValue(new Error('network down'));
    getParentNames.mockResolvedValue(new Map());

    const host = await mount();

    expect(host.textContent).toContain('Could not load families');
    expect(host.textContent).toContain('network down');
    expect(host.textContent).not.toContain('No families yet');
  });

  it('does not query parent names at all when no student has a parent link', async () => {
    getStudents.mockResolvedValue([{ ...STUDENTS[0], parentId: null }]);
    getParentNames.mockResolvedValue(new Map());

    await mount();

    expect(getParentNames).not.toHaveBeenCalled();
  });
});
