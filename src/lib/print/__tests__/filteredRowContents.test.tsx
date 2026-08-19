// REPORTED BUG: with the dropdown on Walkers, MBK-0018 still listed all three
// siblings and all three transports:
//
//   MBK-0018  asma sh.Cabdilaahi  634459222
//     Axmed Cabdirashiid Daahir   G11    Bus 17
//     Cabdale Cabdirashiid Daahir G10    WALKER
//     Maxamed Cabdirashiid Daahir G9     Bus 17
//     count: 3
//
// Only Cabdale is a walker. The row must show Cabdale alone.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildFamilyRows, narrowRowsToSelection } from '../familyRows';
import type { Student } from '../../../types';

vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 11-A', parentId: 'p18', createdAt: '', transport: 'WALKER',
  parentPhone: '634459222', familyId: '0018', ...o });

const AXMED   = s({ id: 'ax', name: 'Axmed Cabdirashiid Daahir',   className: 'Grade 11-A', transport: '17' });
const CABDALE = s({ id: 'cb', name: 'Cabdale Cabdirashiid Daahir', className: 'Grade 10-A', transport: 'WALKER' });
const MAXAMED = s({ id: 'mx', name: 'Maxamed Cabdirashiid Daahir', className: 'Grade 9-A',  transport: '17' });
const FAMILY = [AXMED, CABDALE, MAXAMED];
const NAMES = new Map([['p18', 'asma sh.Cabdilaahi']]);

const render = (students: Student[], transport?: string) => {
  // Mirrors what FamiliesTable renders for the given selection.
  const rows = narrowRowsToSelection(buildFamilyRows(students, NAMES), (transport ?? 'all') as never);
  return rows;
};

describe('MBK-0018 under the Walkers filter', () => {
  it('lists ONLY Cabdale', () => {
    const [row] = render(FAMILY, 'walker');
    expect(row.students.map(x => x.name)).toEqual(['Cabdale Cabdirashiid Daahir']);
  });

  it('shows a student count of 1, not 3', () => {
    const [row] = render(FAMILY, 'walker');
    expect(row.studentCount).toBe(1);
  });

  it('shows only WALKER in the transport column', () => {
    const [row] = render(FAMILY, 'walker');
    expect(row.transports).toEqual(['WALKER']);
    expect(row.transports).not.toContain('Bus 17');
  });

  it('reports the two hidden siblings', () => {
    const [row] = render(FAMILY, 'walker');
    expect(row.hiddenByFilter).toBe(2);
  });

  it('keeps the family identity (id, parent, phone)', () => {
    const [row] = render(FAMILY, 'walker');
    expect(row.displayId).toBe('MBK-0018');
    expect(row.parentName).toBe('asma sh.Cabdilaahi');
    expect(row.parentPhone).toBe('634459222');
  });
});

describe('MBK-0018 under the Bus 17 filter', () => {
  it('lists Axmed and Maxamed only', () => {
    const [row] = render(FAMILY, 'bus:17');
    expect(row.students.map(x => x.name)).toEqual([
      'Axmed Cabdirashiid Daahir', 'Maxamed Cabdirashiid Daahir',
    ]);
    expect(row.studentCount).toBe(2);
    expect(row.transports).toEqual(['Bus 17']);
    expect(row.hiddenByFilter).toBe(1);
  });
});

describe('with no filter the family is complete', () => {
  it('lists all three and both transports', () => {
    const [row] = render(FAMILY, 'all');
    expect(row.studentCount).toBe(3);
    expect(row.transports).toEqual(['Bus 17', 'WALKER']);
    expect(row.hiddenByFilter).toBeUndefined();
  });
});

describe('a family with no matching student disappears', () => {
  it('drops MBK-0018 from the CAR filter', () => {
    expect(render(FAMILY, 'car')).toHaveLength(0);
  });
});

describe('the rendered table markup', () => {
  const table = async (transport: string) => {
    const { FamiliesTable } = await import('../../../pages/admin/family-ids/FamiliesTable');
    // Render, then drive the select to the requested transport via defaultValue
    // is not possible in SSR; assert on the pure row model instead for the
    // filtered case, and on markup for the unfiltered case.
    return renderToStaticMarkup(
      <FamiliesTable students={FAMILY} parentNames={NAMES} loading={false} />,
    );
  };

  it('unfiltered, shows every sibling', async () => {
    const html = await table('all');
    expect(html).toContain('Axmed Cabdirashiid Daahir');
    expect(html).toContain('Cabdale Cabdirashiid Daahir');
    expect(html).toContain('Maxamed Cabdirashiid Daahir');
  });
});
