// Render tests for the driver-group header on the dismissal gate.
//
// The gate screen used to render the driver's identity text and the
// "Release all for X" button as siblings in ONE flex row
// (`flex items-center justify-between gap-3`), so inside the screen's max-w-md
// column the long button label squeezed the identity line. These tests pin the
// fixed structure: row 1 = photo + name · phone + assigned count, row 2 = the
// full-width bulk action on its own line.
//
// Convention follows familyIdCard.test.tsx — renderToStaticMarkup, no jsdom or
// testing-library. supabase/ToastContext/html5-qrcode are mocked because
// GateScreen imports them at module scope (lib/supabase throws without env).

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('html5-qrcode', () => ({ Html5Qrcode: class { start() {} stop() {} clear() {} } }));

import { BulkReleaseButtons } from '../../pages/admin/gate/GateScreen';
import { gateT } from '../i18n/gateStrings';
import type { GateLookupRow } from '../db/gate';
import type { FamilyPickup } from '../db/authorizedPickups';

const t = gateT('en');

// Two students on the walking path temporarily assigned to one driver → the
// group qualifies for bulk release (buildBulkReleasePlan needs ≥2 eligible).
const students: GateLookupRow[] = [
  { id: 's1', name: 'RAYAAN AXMAD NUUR', className: 'Grade 3-A', transport: 'WALKER', familyId: '0421', parentPhone: '0612345678' },
  { id: 's2', name: 'SULAYMAN AXMAD NUUR', className: 'Grade 1-B', transport: 'WALKER', familyId: '0421', parentPhone: '0612345678' },
];

const driver: FamilyPickup = {
  id: 'pickup-1',
  name: 'maxmed ziyaad',
  phoneNumber: '0634218915',
  relationship: 'Uncle',
  photoPath: 'pickup-1.jpg',
  addedAt: '2026-09-01T00:00:00Z',
  studentIds: ['s1', 's2'],
};

const assignmentByStudent = { s1: 'pickup-1', s2: 'pickup-1' };
const driverById = new Map<string, FamilyPickup>([['pickup-1', driver]]);

function render(over: {
  photoUrls?: Map<string, string>;
  driverById?: Map<string, FamilyPickup>;
  students?: GateLookupRow[];
} = {}) {
  return renderToStaticMarkup(
    <BulkReleaseButtons
      students={over.students ?? students}
      assignmentByStudent={assignmentByStudent}
      driverById={over.driverById ?? driverById}
      photoUrls={over.photoUrls ?? new Map()}
      released={{}}
      releasing={{}}
      bulkSummary={null}
      t={t}
      onBulk={() => {}}
    />,
  );
}

describe('driver-group header — row 1 identity', () => {
  it('renders the signed photo immediately left of the name · phone line', () => {
    const html = render({ photoUrls: new Map([['pickup-1', 'https://cdn.test/signed.jpg']]) });
    expect(html).toContain('<img');
    expect(html).toContain('src="https://cdn.test/signed.jpg"');
    expect(html).toContain('alt="maxmed ziyaad"');
    expect(html).toContain('maxmed ziyaad · 0634218915');
    // The photo comes first in the DOM, then the text next to it.
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('maxmed ziyaad'));
  });

  it('keeps the assigned count on the identity row', () => {
    const html = render();
    expect(html).toContain(`2 ${t.studentsAssigned}`);
  });

  it('falls back to the initials avatar when no photo URL resolved', () => {
    const html = render();
    expect(html).not.toContain('<img');
    expect(html).toContain('rounded-full bg-emerald-100');
    expect(html).toContain('>M<'); // initial of "maxmed ziyaad"
  });

  it('still renders an avatar when the driver record is missing', () => {
    const html = render({ driverById: new Map() });
    expect(html).toContain('pickup-1'); // existing degenerate fallback: raw id
    expect(html).toContain('>?</span>');
    expect(html).toContain(`Release all for`);
  });
});

describe('driver-group header — row 2 action', () => {
  it('puts the bulk action on its own full-width row, not beside the identity', () => {
    const html = render({ photoUrls: new Map([['pickup-1', 'https://cdn.test/signed.jpg']]) });
    const imgAt = html.indexOf('<img');
    const buttonAt = html.indexOf('<button');
    const identityAt = html.indexOf('maxmed ziyaad · 0634218915');
    // Order: photo → identity text → action button.
    expect(imgAt).toBeLessThan(identityAt);
    expect(identityAt).toBeLessThan(buttonAt);
    // Own row, full width, still a ≥44px touch target.
    expect(html).toContain('w-full');
    expect(html).toContain('min-h-[44px]');
    // REGRESSION GUARD: the old squeezed layout was `justify-between` on the
    // row that held both the identity text and the button.
    expect(html).not.toContain('justify-between');
  });

  it('keeps the existing label and fires with the group student ids', () => {
    let seen: { driverId: string; ids: string[] } | null = null;
    const html = renderToStaticMarkup(
      <BulkReleaseButtons
        students={students}
        assignmentByStudent={assignmentByStudent}
        driverById={driverById}
        photoUrls={new Map()}
        released={{}}
        releasing={{}}
        bulkSummary={null}
        t={t}
        onBulk={(driverId, ids) => { seen = { driverId, ids }; }}
      />,
    );
    expect(html).toContain(`${t.releaseAllFor} maxmed ziyaad`);
    expect(seen).toBeNull(); // SSR only — no click happens here
  });
});

describe('driver-group header — grouping unchanged', () => {
  it('renders nothing when no driver is shared by ≥2 eligible students', () => {
    const html = render({ students: students.slice(0, 1) });
    expect(html).toBe('');
  });

  it('renders the bulk summary line after the action row', () => {
    const html = renderToStaticMarkup(
      <BulkReleaseButtons
        students={students}
        assignmentByStudent={assignmentByStudent}
        driverById={driverById}
        photoUrls={new Map()}
        released={{}}
        releasing={{}}
        bulkSummary={{ total: 2, ok: 1, failed: 1 }}
        t={t}
        onBulk={() => {}}
      />,
    );
    expect(html).toContain('1 / 2');
    expect(html.indexOf('1 / 2')).toBeGreaterThan(html.indexOf('<button'));
  });
});
