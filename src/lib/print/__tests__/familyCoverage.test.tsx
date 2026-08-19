// @vitest-environment jsdom
//
// REPORTED: the page showed "443 of 200 — 100% complete".
//
// Three bugs in one widget:
//   1. 200 was a hardcoded guess at school size (from PR #18). Any school with
//      more families produced a current > target.
//   2. percent was clamped to 100, so an impossible ratio still read "100%".
//   3. The label claimed "print and verify", but nothing in this app records
//      that a card was ever printed.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { Student } from '../../../types';

const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: null, createdAt: '', transport: 'WALKER',
  parentPhone: '', familyId: '0001', ...o });

let ROSTER: Student[] = [];
const getStudents = vi.fn(async () => ROSTER);
vi.mock('../../db/students', () => ({ getStudents: () => getStudents() }));
vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../db/familyIds', async () => {
  const actual = await vi.importActual<typeof import('../../db/familyIds')>('../../db/familyIds');
  return { ...actual, getParentNames: async () => new Map() };
});
const SESSION = { role: 'admin', id: 'u1', name: 'Admin' } as const;
vi.mock('../../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FamilyIds } from '../../../pages/admin/FamilyIds';

let host: HTMLDivElement;
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<FamilyIds mode="browse" navigate={() => {}} />); });
}
const bar = () =>
  (host.querySelector('[aria-label="Family ID coverage"]') as HTMLElement | null)?.textContent ?? '';

beforeEach(() => { document.body.innerHTML = ''; });

describe('a large school no longer shows an impossible ratio', () => {
  it('never reports more covered than the total', async () => {
    // 443 families, every student covered — the reported situation.
    ROSTER = Array.from({ length: 443 }, (_, i) =>
      s({ id: `s${i}`, name: `Student ${i}`, familyId: String(i + 1).padStart(4, '0') }));
    await mount();

    expect(bar()).not.toContain('of 200');
    expect(bar()).not.toContain('443 of 200');
    expect(bar()).toContain('443 of 443 students');
    expect(bar()).toContain('100%');
    expect(bar()).toContain('443 families');
  });

  it('reports partial coverage honestly', async () => {
    ROSTER = [
      s({ id: 'a', name: 'Has ID',  familyId: '0001' }),
      s({ id: 'b', name: 'Has ID2', familyId: '0001' }),
      s({ id: 'c', name: 'No ID',   familyId: null }),
      s({ id: 'd', name: 'No ID 2', familyId: null }),
    ];
    await mount();
    expect(bar()).toContain('2 of 4 students');
    expect(bar()).toContain('50%');
    expect(bar()).toContain('2 active students still need a Family ID');
  });

  it('is 100% only when nobody is left', async () => {
    ROSTER = [s({ id: 'a', name: 'A', familyId: '0001' })];
    await mount();
    expect(bar()).toContain('1 of 1 students');
    expect(bar()).toContain('100%');
    expect(bar()).toContain('Every active student has a Family ID');
  });
});

describe('edge cases', () => {
  it('does not divide by zero on an empty roster', async () => {
    ROSTER = [];
    await mount();
    expect(bar()).toContain('0 of 0 students');
    expect(bar()).toContain('0%');
    expect(bar()).not.toContain('NaN');
    expect(bar()).toContain('No active students loaded yet');
  });

  it('excludes students who LEFT from both sides', async () => {
    ROSTER = [
      s({ id: 'a', name: 'Active',  familyId: '0001' }),
      s({ id: 'z', name: 'Gone',    familyId: '0099', transport: 'LEFT' }),
      s({ id: 'y', name: 'Gone2',   familyId: null,   transport: 'LEFT' }),
    ];
    await mount();
    // Only the active student counts, on both numerator and denominator.
    expect(bar()).toContain('1 of 1 students');
    expect(bar()).toContain('100%');
  });
});

describe('the widget does not claim printing was verified', () => {
  it('drops the unbacked "print and verify" target language', async () => {
    ROSTER = [s({ id: 'a', name: 'A', familyId: '0001' })];
    await mount();
    // Nothing records that a card was printed, so the UI must not imply it.
    expect(bar()).not.toContain('print and verify');
    expect(bar()).not.toContain('Target');
    expect(bar()).toContain('Family ID coverage');
  });
});
