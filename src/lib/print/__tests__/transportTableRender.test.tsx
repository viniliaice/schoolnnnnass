// Renders exactly what the preview shows, so the assertions describe the UI.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
import { FamiliesTable } from '../../../pages/admin/family-ids/FamiliesTable';
import type { Student } from '../../../types';
const s = (o: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: 'p1', createdAt: '', transport: 'WALKER',
  parentPhone: '0612345678', familyId: '0042', ...o });
const ROSTER: Student[] = [
  s({ id: 'a', name: 'Ahmed Sheikh', transport: '9', className: 'Grade 7-A' }),
  s({ id: 'b', name: 'Amina Sheikh', transport: null, className: 'Grade 4-B' }),
  s({ id: 'c', name: 'Yasmin Sheikh', transport: 'CAR', className: 'KG-A' }),
];
describe('families table with transport editing', () => {
  const admin = renderToStaticMarkup(
    <FamiliesTable students={ROSTER} parentNames={new Map([['p1','Xasan Maxamed Cabdi']])}
      loading={false} canEditTransport onEditTransport={async () => {}} />);
  const office = renderToStaticMarkup(
    <FamiliesTable students={ROSTER} parentNames={new Map()} loading={false} />);

  it('shows each student\'s own transport', () => {
    expect(admin).toContain('Bus 9');
    expect(admin).toContain('WALKER');   // the null-transport child
    expect(admin).toContain('CAR');
  });
  it('offers a per-student edit control to admins', () => {
    expect(admin).toContain('Edit transport for Ahmed Sheikh');
    expect(admin).toContain('Edit transport for Amina Sheikh');
    expect(admin).toContain('Edit transport for Yasmin Sheikh');
  });
  it('hides every edit control from non-admins', () => {
    expect(office).not.toContain('Edit transport for');
    expect(office).toContain('Bus 9');   // still readable + printable
    expect(office).toContain('MBK-0042');
  });
});
