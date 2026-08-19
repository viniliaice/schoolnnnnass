// @vitest-environment jsdom
//
// REPORTED: with the dropdown on Walkers, clicking a row's Print button still
// produced a card (and preview) containing the whole family:
//
//   MBK-0018 · Axmed (G11), Cabdale (G10), Maxamed (G9) · Bus 17 · WALKER
//
// Cause: the row Print button (and "Print selected") always sent
// kind:'families', which expands to the complete roster by design.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { renderToStaticMarkup } from 'react-dom/server';
import { resolvePrintBatch } from '../printBatch';
import { FamilyCardsDocument, familyTransportLabel } from '../familyCards';
import type { Student } from '../../../types';

vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
import { FamiliesTable } from '../../../pages/admin/family-ids/FamiliesTable';

const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 11-A', parentId: 'p18', createdAt: '', transport: 'WALKER',
  parentPhone: '634451005', familyId: '0018', ...o });
const AXMED   = s({ id: 'ax', name: 'Axmed Cabdirashiid Daahir',   className: 'Grade 11-A', transport: '17' });
const CABDALE = s({ id: 'cb', name: 'Cabdale Cabdirashiid Daahir', className: 'Grade 10-A', transport: 'WALKER' });
const MAXAMED = s({ id: 'mx', name: 'Maxamed Cabdirashiid Daahir', className: 'Grade 9-A',  transport: '17' });
const FAMILY = [AXMED, CABDALE, MAXAMED];
const NAMES = new Map([['p18', 'asma sh.Cabdilaahi']]);

let host: HTMLDivElement;
let opened: unknown = null;

// Capture what the row Print button hands to the dialog.
vi.mock('../../../pages/admin/family-ids/PrintCardsDialog', () => ({
  PrintCardsDialog: (props: { open: boolean; source: unknown }) => {
    if (props.open) opened = props.source;
    return null;
  },
}));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FamiliesTable students={FAMILY} parentNames={NAMES} loading={false} />);
  });
}
async function choose(value: string) {
  const el = host.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function clickRowPrint() {
  const btn = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Print');
  if (!btn) throw new Error('row Print button not found');
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => { document.body.innerHTML = ''; opened = null; });

describe('row Print under the Walkers filter', () => {
  it('requests STUDENT mode with only the walker', async () => {
    await mount();
    await choose('walker');
    await clickRowPrint();
    expect(opened).toEqual({
      kind: 'students',
      studentIds: ['cb'],
      label: 'MBK-0018 — 1 walkers student(s)',
    });
  });

  it('the resulting CARD contains Cabdale only', async () => {
    await mount();
    await choose('walker');
    await clickRowPrint();
    const src = opened as { studentIds: string[] };
    const batch = resolvePrintBatch({ kind: 'students', studentIds: src.studentIds }, FAMILY);

    const html = renderToStaticMarkup(
      <FamilyCardsDocument
        families={[{ familyId: '0018', parentName: 'asma sh.Cabdilaahi',
                     parentPhone: '634451005', students: batch.families[0].students }]}
        layout="pocket"
      />,
    );
    expect(html).toContain('Cabdale Cabdirashiid Daahir');
    expect(html).not.toContain('Axmed Cabdirashiid Daahir');
    expect(html).not.toContain('Maxamed Cabdirashiid Daahir');
  });

  it('the footer badge reads WALKER, not "Bus 17 · WALKER"', async () => {
    await mount();
    await choose('walker');
    await clickRowPrint();
    const src = opened as { studentIds: string[] };
    const batch = resolvePrintBatch({ kind: 'students', studentIds: src.studentIds }, FAMILY);
    expect(familyTransportLabel(batch.families[0].students)).toBe('WALKER');
  });
});

describe('row Print under the Bus 17 filter', () => {
  it('requests the two riders and the badge reads Bus 17', async () => {
    await mount();
    await choose('bus:17');
    await clickRowPrint();
    const src = opened as { kind: string; studentIds: string[] };
    expect(src.kind).toBe('students');
    expect(src.studentIds.sort()).toEqual(['ax', 'mx']);

    const batch = resolvePrintBatch({ kind: 'students', studentIds: src.studentIds }, FAMILY);
    expect(familyTransportLabel(batch.families[0].students)).toBe('Bus 17');
    const html = renderToStaticMarkup(
      <FamilyCardsDocument
        families={[{ familyId: '0018', parentName: 'asma sh.Cabdilaahi',
                     parentPhone: '634451005', students: batch.families[0].students }]}
        layout="pocket" />,
    );
    expect(html).not.toContain('Cabdale Cabdirashiid Daahir');
  });
});

describe('row Print with NO filter still prints the whole family', () => {
  it('requests family mode', async () => {
    await mount();
    await clickRowPrint();
    expect(opened).toEqual({
      kind: 'families',
      familyIds: ['0018'],
      label: 'MBK-0018 — 3 student(s)',
    });
  });

  it('the card shows all three and both transports', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0018'] }, FAMILY);
    expect(familyTransportLabel(batch.families[0].students)).toBe('Bus 17 · WALKER');
    expect(batch.families[0].students).toHaveLength(3);
  });
});
