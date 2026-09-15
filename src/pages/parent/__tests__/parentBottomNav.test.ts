// Structure checks for the parent mobile navigation redesign:
//
//  - the primary navigation is the 5-item bottom bar (Home · Children ·
//    Results · Messages · More), not the old 9-item staff sidebar;
//  - "Take Quiz" is demoted to More, not a primary destination;
//  - the legacy /parent/monthly|midterm|final paths live UNDER Results so
//    old links still land in the right place;
//  - no-family-ID / no-horizontal-scroll guards documented in code/CS S.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PARENT_BOTTOM_NAV } from '../../../components/layout/ParentAppShell';

describe('parent bottom navigation', () => {
  it('has exactly five simple, parent-friendly destinations', () => {
    expect(PARENT_BOTTOM_NAV.map(item => item.key)).toEqual(['home', 'children', 'results', 'messages', 'more']);
    expect(PARENT_BOTTOM_NAV.map(item => item.fallback)).toEqual(['Home', 'Children', 'Results', 'Messages', 'More']);
  });

  it('does not include Take Quiz, Streams or any technical destination', () => {
    const paths = PARENT_BOTTOM_NAV.map(item => item.path);
    expect(paths).not.toContain('/parent/quizzes');
    expect(paths).not.toContain('/streams');
    expect(paths).not.toContain('/parent/weekly-learning');
  });

  it('Monthly / Midterm / Final legacy paths all light up the single Results item', () => {
    const results = PARENT_BOTTOM_NAV.find(item => item.key === 'results')!;
    expect(results.isActive('/parent/results')).toBe(true);
    expect(results.isActive('/parent/monthly')).toBe(true);
    expect(results.isActive('/parent/midterm')).toBe(true);
    expect(results.isActive('/parent/final')).toBe(true);
  });

  it('secondary features highlight More', () => {
    const more = PARENT_BOTTOM_NAV.find(item => item.key === 'more')!;
    for (const path of ['/parent/more', '/parent/quizzes', '/parent/weekly-learning', '/parent/pickup-card', '/streams']) {
      expect(more.isActive(path)).toBe(true);
    }
    // …but results must not be swallowed by More.
    expect(more.isActive('/parent/results')).toBe(false);
  });

  it('home / children / messages match their own paths only', () => {
    const home = PARENT_BOTTOM_NAV.find(item => item.key === 'home')!;
    const children = PARENT_BOTTOM_NAV.find(item => item.key === 'children')!;
    const messages = PARENT_BOTTOM_NAV.find(item => item.key === 'messages')!;
    expect(home.isActive('/dashboard')).toBe(true);
    expect(home.isActive('/parent/results')).toBe(false);
    expect(children.isActive('/parent/children')).toBe(true);
    expect(children.isActive('/parent/results')).toBe(false);
    expect(messages.isActive('/messages')).toBe(true);
    expect(messages.isActive('/streams')).toBe(false);
  });
});

describe('mobile overflow guard', () => {
  it('global CSS clips horizontal page scrolling (320–412px phones)', () => {
    const css = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8');
    expect(css).toContain('overflow-x: clip');
  });

  it('the bottom navigation is fixed and clears the phone safe area', () => {
    const source = readFileSync(new URL('../../../components/layout/ParentAppShell.tsx', import.meta.url), 'utf8');
    expect(source).toContain('env(safe-area-inset-bottom)');
    expect(source).toContain('fixed inset-x-0 bottom-0');
  });

  it('is phone-first and restores the classic staff sidebar on desktop (lg+)', () => {
    const source = readFileSync(new URL('../../../components/layout/ParentAppShell.tsx', import.meta.url), 'utf8');
    // Bottom bar: phones only.
    expect(source).toMatch(/fixed inset-x-0 bottom-0[^"]*lg:hidden/);
    // Phone header: phones only.
    expect(source).toMatch(/shadow-md lg:hidden/);
    // Desktop: the previous Sidebar is restored, without its own mobile toggle
    // (the parent shell supplies the phone chrome itself).
    expect(source).toContain('<Sidebar currentPath={currentPath} onNavigate={navigate} mobileToggle={false} />');
    expect(source).toContain('<div className="hidden lg:block">\n          <Sidebar');
    // Old header-pill experiment removed.
    expect(source).not.toContain('parent-nav-lg-');
  });
});
