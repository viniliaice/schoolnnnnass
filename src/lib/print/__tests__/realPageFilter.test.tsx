// @vitest-environment jsdom
//
// End-to-end through the REAL page component the router renders
// (<FamilyIds mode="browse">), not the FamiliesTable in isolation. This is the
// path the user's app actually takes: App.tsx -> FamilyIds -> FamiliesTable.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { Student } from '../../../types';

const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 11-A', parentId: 'p18', createdAt: '', transport: 'WALKER',
  parentPhone: '634459222', familyId: '0018', ...o });

const ROSTER: Student[] = [
  s({ id: 'ax', name: 'Axmed Cabdirashiid Daahir',   className: 'Grade 11-A', transport: '17' }),
  s({ id: 'cb', name: 'Cabdale Cabdirashiid Daahir', className: 'Grade 10-A', transport: 'WALKER' }),
  s({ id: 'mx', name: 'Maxamed Cabdirashiid Daahir', className: 'Grade 9-A',  transport: '17' }),
];

const getStudents = vi.fn().mockResolvedValue(ROSTER);
vi.mock('../../db/students', () => ({ getStudents: () => getStudents() }));
vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../db/familyIds', async () => {
  const actual = await vi.importActual<typeof import('../../db/familyIds')>('../../db/familyIds');
  return { ...actual, getParentNames: async () => new Map([['p18', 'asma sh.Cabdilaahi']]) };
});
const SESSION = { role: 'office', id: 'u1', name: 'Office' } as const;
vi.mock('../../../context/RoleContext', () => ({ useRole: () => ({ session: SESSION }) }));
const addToast = vi.fn();
vi.mock('../../../context/ToastContext', () => ({ useToast: () => ({ addToast }) }));

import { FamilyIds } from '../../../pages/admin/FamilyIds';

let host: HTMLDivElement;
async function mountPage() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<FamilyIds mode="browse" navigate={() => {}} />); });
}
const transportSelect = () => {
  const selects = [...host.querySelectorAll('select')] as HTMLSelectElement[];
  const found = selects.find(el => [...el.options].some(o => o.value === 'walker'));
  if (!found) throw new Error('transport dropdown not found on the page');
  return found;
};
async function choose(value: string) {
  const el = transportSelect();
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const body = () => host.querySelector('tbody')?.textContent ?? '';

beforeEach(() => { document.body.innerHTML = ''; });

describe('the real /admin/family-ids page', () => {
  it('loads the roster and shows the whole family by default', async () => {
    await mountPage();
    expect(host.textContent).toContain('MBK-0018');
    expect(body()).toContain('Axmed Cabdirashiid Daahir');
    expect(body()).toContain('Cabdale Cabdirashiid Daahir');
    expect(body()).toContain('Maxamed Cabdirashiid Daahir');
  });

  it('offers the real bus route in the dropdown', async () => {
    await mountPage();
    const values = [...transportSelect().options].map(o => o.value);
    expect(values).toContain('walker');
    expect(values).toContain('bus:17');
  });

  it('WALKER shows only Cabdale — the reported bug', async () => {
    await mountPage();
    await choose('walker');
    expect(body()).toContain('Cabdale Cabdirashiid Daahir');
    expect(body()).not.toContain('Axmed Cabdirashiid Daahir');
    expect(body()).not.toContain('Maxamed Cabdirashiid Daahir');
    expect(body()).not.toContain('Bus 17');
  });

  it('BUS 17 shows only the two riders', async () => {
    await mountPage();
    await choose('bus:17');
    expect(body()).toContain('Axmed Cabdirashiid Daahir');
    expect(body()).toContain('Maxamed Cabdirashiid Daahir');
    expect(body()).not.toContain('Cabdale Cabdirashiid Daahir');
  });

  it('keeps family identity and reports hidden siblings', async () => {
    await mountPage();
    await choose('walker');
    expect(host.textContent).toContain('MBK-0018');
    expect(host.textContent).toContain('asma sh.Cabdilaahi');
    expect(host.textContent).toContain('2 siblings on other transport hidden');
  });

  it('restores the full family on All students', async () => {
    await mountPage();
    await choose('walker');
    await choose('all');
    for (const n of ['Axmed', 'Cabdale', 'Maxamed']) {
      expect(body()).toContain(`${n} Cabdirashiid Daahir`);
    }
  });
});
