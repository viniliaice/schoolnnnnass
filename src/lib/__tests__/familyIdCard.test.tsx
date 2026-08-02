// Render tests for the M3 family card using react-dom/server — no jsdom or
// testing-library needed. Covers the normal (ready) and pending states plus
// the status classifier.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { classifyFamilyCard, FamilyIdCard, type FamilyCardState } from '../../pages/parent/components/FamilyIdCard';
import type { Student } from '../../types';

const kids: Student[] = [
  { id: 's1', name: 'Fartun Axmed', className: 'Grade 4-A', parentId: 'p1', createdAt: '', transport: 'WALKER', familyId: '0421' },
  { id: 's2', name: 'Maxamed Axmed', className: 'Grade 2-B', parentId: 'p1', createdAt: '', transport: 'WALKER', familyId: '0421' },
];

describe('classifyFamilyCard', () => {
  it('maps loading / pending / ready', () => {
    expect(classifyFamilyCard(true, null, [])).toEqual({ status: 'loading' });
    expect(classifyFamilyCard(false, null, kids)).toMatchObject({ status: 'pending' });
    expect(classifyFamilyCard(false, '0421', kids)).toMatchObject({ status: 'ready', familyId: '0421' });
  });
});

describe('FamilyIdCard render', () => {
  it('renders the family ID and kids in the ready state', () => {
    const state: FamilyCardState = { status: 'ready', familyId: '0421', students: kids };
    const html = renderToStaticMarkup(<FamilyIdCard state={state} />);
    expect(html).toContain('MBK-0421');
    expect(html).toContain('Fartun Axmed');
    expect(html).toContain('Maxamed Axmed');
    expect(html).toContain('Grade 4-A');
    // The print link only appears once the QR is built (async, skipped in SSR),
    // so accept either the link or its "preparing" placeholder.
    expect(html.includes('Download / print my card') || html.includes('Preparing your card')).toBe(true);
  });

  it('renders the pending state (no family ID yet) instead of an empty card', () => {
    const state: FamilyCardState = { status: 'pending', students: kids };
    const html = renderToStaticMarkup(<FamilyIdCard state={state} />);
    expect(html).toContain('Family ID is on the way');
    expect(html).not.toContain('MBK-');
  });

  it('renders a loading state', () => {
    const html = renderToStaticMarkup(<FamilyIdCard state={{ status: 'loading' }} />);
    expect(html).toContain('Loading your family ID');
  });
});
