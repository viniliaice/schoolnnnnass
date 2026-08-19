import { describe, expect, it, vi } from 'vitest';

// The table pulls in the print dialog -> useCardPdf -> the supabase client,
// which throws without env vars. Printing itself is covered elsewhere; here we
// only exercise rendering + resolution.
vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
import { renderToStaticMarkup } from 'react-dom/server';
import { FamiliesTable } from '../../../pages/admin/family-ids/FamiliesTable';
import { resolvePrintBatch } from '../printBatch';
import { buildFamilyRows, filterFamilyRows } from '../familyRows';
import type { Student } from '../../../types';

const s = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: 'p1', createdAt: '', transport: 'WALKER',
  parentPhone: '0612345678', familyId: '0042', ...over,
});
const ROSTER: Student[] = [
  s({ id: 'a', name: 'Ahmed Xasan', className: 'Grade 7-A', transport: '9' }),
  s({ id: 'b', name: 'Amina Xasan', className: 'Grade 4-B' }),
  s({ id: 'c', name: 'Cali Nuur', familyId: '0017', parentId: 'p2', className: 'Grade 5-A', transport: 'CAR' }),
  s({ id: 'd', name: 'Left Kid', familyId: '0099', parentId: 'p3', transport: 'LEFT' }),
];
const NAMES = new Map([['p1', 'Xasan Maxamed Cabdi'], ['p2', 'Cali Nuur Cumar']]);

describe('Phase 2 — families table renders', () => {
  const html = renderToStaticMarkup(
    <FamiliesTable students={ROSTER} parentNames={NAMES} loading={false} />
  );
  it('shows both families with grades, counts and mixed transport', () => {
    expect(html).toContain('MBK-0042');
    expect(html).toContain('MBK-0017');
    expect(html).toContain('Xasan Maxamed Cabdi');
    expect(html).toContain('G7');
    expect(html).toContain('Bus 9');
    expect(html).toContain('WALKER');
  });
  it('offers all four print entry points', () => {
    expect(html).toContain('Print by students');
    expect(html).toContain('Print selected (0)');
    expect(html).toContain('Print all (2)');
    expect(html.match(/&gt; Print<\/button>|Print<\/button>/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('never renders a family whose members have all left', () => {
    expect(html).not.toContain('MBK-0099');
    expect(html).not.toContain('Left Kid');
  });
  it('renders an empty state instead of a broken table', () => {
    const empty = renderToStaticMarkup(<FamiliesTable students={[]} loading={false} />);
    expect(empty).toContain('No families yet');
  });

  it('shows rows even when parent names are unavailable (office/supervisor)', () => {
    // profiles is admin-readable only; a blank parent column must never stop
    // the table from listing families.
    const noNames = renderToStaticMarkup(<FamiliesTable students={ROSTER} loading={false} />);
    expect(noNames).toContain('MBK-0042');
    expect(noNames).toContain('Ahmed Xasan');
  });

  it('distinguishes a LOAD FAILURE from an empty school', () => {
    const failed = renderToStaticMarkup(
      <FamiliesTable students={[]} loading={false} error="permission denied" />
    );
    expect(failed).toContain('Could not load families');
    expect(failed).toContain('permission denied');
    expect(failed).not.toContain('No families yet');
  });

  it('only shows the loading state while actually loading', () => {
    const busy = renderToStaticMarkup(<FamiliesTable students={[]} loading />);
    expect(busy).toContain('Loading families');
    const done = renderToStaticMarkup(<FamiliesTable students={ROSTER} loading={false} />);
    expect(done).not.toContain('Loading families');
  });
});

describe('Phase 2 — the four print paths all resolve to unique families', () => {
  const rows = buildFamilyRows(ROSTER, NAMES);
  it('print one family -> 1 card', () => {
    expect(resolvePrintBatch({ kind: 'families', familyIds: ['0042'] }, ROSTER).cardCount).toBe(1);
  });
  it('print selected -> N cards', () => {
    expect(resolvePrintBatch({ kind: 'families', familyIds: ['0042', '0017'] }, ROSTER).cardCount).toBe(2);
  });
  it('print all filtered -> only the filtered families', () => {
    const ids = filterFamilyRows(rows, { transport: 'car' }).map(r => r.familyId);
    expect(ids).toEqual(['0017']);
    expect(resolvePrintBatch({ kind: 'families', familyIds: ids }, ROSTER).cardCount).toBe(1);
  });
  it('print by students -> siblings collapse to one card', () => {
    const b = resolvePrintBatch({ kind: 'students', studentIds: ['a', 'b', 'c'] }, ROSTER);
    expect(b.cardCount).toBe(2);
    expect(b.duplicatesMerged).toBe(1);
  });
  it('a LEFT student can never be printed', () => {
    const b = resolvePrintBatch({ kind: 'students', studentIds: ['d'] }, ROSTER);
    expect(b.cardCount).toBe(0);
    expect(b.skippedLeft).toHaveLength(1);
  });
});
