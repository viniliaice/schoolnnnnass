// @vitest-environment jsdom
//
// Drives the REAL <select> in the real table, the way the user did. The pure
// row model passing is not enough: the reported bug was that the rendered
// table still showed all three siblings.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
import { FamiliesTable } from '../../../pages/admin/family-ids/FamiliesTable';
import type { Student } from '../../../types';

const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 11-A', parentId: 'p18', createdAt: '', transport: 'WALKER',
  parentPhone: '634459222', familyId: '0018', ...o });
const FAMILY = [
  s({ id: 'ax', name: 'Axmed Cabdirashiid Daahir',   className: 'Grade 11-A', transport: '17' }),
  s({ id: 'cb', name: 'Cabdale Cabdirashiid Daahir', className: 'Grade 10-A', transport: 'WALKER' }),
  s({ id: 'mx', name: 'Maxamed Cabdirashiid Daahir', className: 'Grade 9-A',  transport: '17' }),
];
const NAMES = new Map([['p18', 'asma sh.Cabdilaahi']]);

let host: HTMLDivElement;
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FamiliesTable students={FAMILY} parentNames={NAMES} loading={false} />);
  });
}
async function choose(value: string) {
  const select = host.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const text = () => host.textContent ?? '';

beforeEach(() => { document.body.innerHTML = ''; });

describe('choosing Walkers in the real dropdown', () => {
  it('shows Cabdale and HIDES the bus-riding siblings', async () => {
    await mount();
    // Sanity: unfiltered shows all three.
    expect(text()).toContain('Axmed Cabdirashiid Daahir');

    await choose('walker');

    expect(text()).toContain('Cabdale Cabdirashiid Daahir');
    expect(text()).not.toContain('Axmed Cabdirashiid Daahir');
    expect(text()).not.toContain('Maxamed Cabdirashiid Daahir');
  });

  it('does not show Bus 17 anywhere in the row', async () => {
    await mount();
    await choose('walker');
    // 'Bus 17' remains as a dropdown OPTION; assert on the table body only.
    const body = host.querySelector('tbody')?.textContent ?? '';
    expect(body).toContain('WALKER');
    expect(body).not.toContain('Bus 17');
  });

  it('keeps the family row identity visible', async () => {
    await mount();
    await choose('walker');
    expect(text()).toContain('MBK-0018');
    expect(text()).toContain('asma sh.Cabdilaahi');
  });

  it('says how many siblings the filter is hiding', async () => {
    await mount();
    await choose('walker');
    expect(text()).toContain('2 siblings on other transport hidden');
  });
});

describe('choosing Bus 17', () => {
  it('shows the two riders and hides the walker', async () => {
    await mount();
    await choose('bus:17');
    expect(text()).toContain('Axmed Cabdirashiid Daahir');
    expect(text()).toContain('Maxamed Cabdirashiid Daahir');
    expect(text()).not.toContain('Cabdale Cabdirashiid Daahir');
  });
});

describe('choosing Car pickup', () => {
  it('drops the family entirely', async () => {
    await mount();
    await choose('car');
    expect(text()).not.toContain('MBK-0018');
    expect(text()).not.toContain('Cabdale Cabdirashiid Daahir');
  });
});

describe('returning to All students', () => {
  it('restores the complete family', async () => {
    await mount();
    await choose('walker');
    await choose('all');
    for (const n of ['Axmed', 'Cabdale', 'Maxamed']) {
      expect(text()).toContain(`${n} Cabdirashiid Daahir`);
    }
  });
});
