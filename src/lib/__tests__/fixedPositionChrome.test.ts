// Guards for viewport-pinned ("fixed") chrome.
//
// A `position: fixed` element is only pinned to the viewport while NO ancestor
// creates a containing block for it. `backdrop-filter`, `filter`, `transform`,
// `perspective` and `contain: paint|layout` all do — and the theme engine in
// src/index.css adds `backdrop-filter` to `.bg-slate-50`/`.bg-gray-100`, which
// is exactly the background the app shells use. When an app shell root became
// the containing block, its fixed chrome (parent bottom navigation, floating
// language switcher, mobile sidebar drawer + hamburger) was laid out at the
// bottom/top of the page-height shell instead of the viewport, so phones had to
// scroll to reach it.
//
// `fixed` elements that are direct children of #root hit the same trap from the
// id-specifity `#root > *` rule, which used to out-specify their `fixed`
// utility class and leave them in normal flow.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellCss = () => readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const parentShell = () =>
  readFileSync(new URL('../../components/layout/ParentAppShell.tsx', import.meta.url), 'utf8');
const dashboardLayout = () =>
  readFileSync(new URL('../../components/layout/DashboardLayout.tsx', import.meta.url), 'utf8');
const toast = () => readFileSync(new URL('../../components/ui/Toast.tsx', import.meta.url), 'utf8');

describe('fixed chrome is anchored to the viewport', () => {
  it('defines one shell-root reset neutralizing every containing-block trigger', () => {
    const css = shellCss();
    const rule = css.match(/\.app-shell\s*\{[^}]*\}/s)?.[0] ?? '';

    expect(rule).not.toBe('');
    for (const declaration of [
      'backdrop-filter: none !important;',
      '-webkit-backdrop-filter: none !important;',
      'filter: none !important;',
      'transform: none !important;',
      'perspective: none !important;',
      'contain: none !important;',
      'will-change: auto !important;',
    ]) {
      expect(rule).toContain(declaration);
    }
  });

  it('marks both app shell roots with the reset class', () => {
    // Parent shell (fixed bottom navigation on phones).
    expect(parentShell()).toMatch(/<div className="app-shell [^"]*bg-slate-50/);
    // Staff shell — its fixed language switcher, hamburger and sidebar drawer
    // sit inside this root, and the edge-to-edge mobile routes (e.g. /gate) are
    // rendered inside the second one.
    const layout = dashboardLayout();
    expect(layout).toMatch(/<div className="app-shell [^"]*bg-slate-50">/);
    expect(layout).toMatch(/<main className="app-shell [^"]*bg-slate-100">/);
  });

  it('keeps `#root > *` from over-specifying fixed elements (toast container)', () => {
    const css = shellCss();
    const rule = css.match(/#root > \*[^{]*\{[^}]*\}/s)?.[0] ?? '';

    expect(rule).toContain(':not(.fixed)');
    expect(rule).toContain('position: relative');
    // The toast container is a direct child of #root and must stay fixed.
    expect(toast()).toMatch(/className="fixed inset-x-3 top-/);
  });
});
