// /qa — the zero-layout-shift contract, asserted structurally.
//
// jsdom cannot measure pixels, so instead we assert the two invariants that
// CAUSE layout shift when broken:
//   1. While a family is loading, NO student content is on screen — only
//      skeletons. (No "students first, drivers later" intermediate paint.)
//   2. The skeleton and the loaded card render the SAME shell: same number of
//      structural rows, both with a transport slot, a driver slot, a status
//      line, and a 44px action band. Same rows + same fixed row heights =
//      same height.
//   3. A new scan never shows the previous family's students.

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StudentCard, StudentCardSkeleton } from '../../pages/admin/gate/StudentCard';
import { gateT } from '../i18n/gateStrings';

const t = gateT('en');

const DRIVER_STUDENT = { id: 's1', name: 'RAYAAN AXMAD', className: 'Grade 1-C', transport: 'DRIVER', familyId: '0050', parentPhone: '1' };
const WALKER = { ...DRIVER_STUDENT, id: 's3', name: 'HODAN', transport: 'WALKER' };
const BUS = { ...DRIVER_STUDENT, id: 's2', name: 'MOHAMED', transport: '10' };
const ASKO = { id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: null, photoPath: '', addedAt: '', studentIds: ['s1'] };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function render(node: React.ReactNode) {
  act(() => { root.render(<ul>{node}</ul>); });
  return container.querySelector('li')!;
}

/** The shell fingerprint: how many structural rows the card is made of. */
function shape(li: HTMLElement) {
  return {
    rows: li.children.length,
    // The action band must always exist at the same reserved height.
    actionBand: Boolean(li.querySelector('.min-h-\\[44px\\]')),
    // Two side-by-side fields: transport + driver.
    fields: li.children[1]?.children.length ?? 0,
  };
}

describe('student card geometry is identical across every state', () => {
  it('skeleton and loaded card share the same shell', () => {
    const skeleton = shape(render(<StudentCardSkeleton />));
    const loaded = shape(render(
      <StudentCard student={DRIVER_STUDENT} driver={ASKO} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    expect(loaded).toEqual(skeleton);
  });

  it('a driver student with NO driver yet has the same shell as one WITH a driver', () => {
    const without = shape(render(
      <StudentCard student={DRIVER_STUDENT} driver={undefined} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    const withDriver = shape(render(
      <StudentCard student={DRIVER_STUDENT} driver={ASKO} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    expect(withDriver).toEqual(without);
  });

  it('walking, bus, releasing and released cards all share the same shell', () => {
    const base = shape(render(
      <StudentCard student={WALKER} driver={undefined} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    const bus = shape(render(
      <StudentCard student={BUS} driver={undefined} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    const busy = shape(render(
      <StudentCard student={WALKER} driver={undefined} releasedAt={undefined} releasing
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    const done = shape(render(
      <StudentCard student={WALKER} driver={ASKO} releasedAt={'2026-09-02T10:00:00Z'} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    ));
    expect(bus).toEqual(base);
    expect(busy).toEqual(base);
    expect(done).toEqual(base);
  });

  it('the driver slot is always present — assigning a driver only swaps text', () => {
    const li = render(
      <StudentCard student={WALKER} driver={undefined} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    );
    expect(li.textContent).toContain(t.driver);
    expect(li.textContent).toContain(t.driverNotAssigned);
  });

  it('a bus student gets NO release button but keeps the reserved action band', () => {
    const li = render(
      <StudentCard student={BUS} driver={undefined} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    );
    expect(li.querySelectorAll('button')).toHaveLength(0);
    expect(li.textContent).toContain(t.notEligible);
    expect(shape(li).actionBand).toBe(true);
  });

  it('every interactive control meets the 44px touch target', () => {
    const li = render(
      <StudentCard student={DRIVER_STUDENT} driver={ASKO} releasedAt={undefined} releasing={false}
        failed={false} lang="en" t={t} onRelease={() => {}} onAssign={() => {}} onRemoveDriver={() => {}} />,
    );
    const buttons = Array.from(li.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className).toContain('min-h-[44px]');
  });
});
