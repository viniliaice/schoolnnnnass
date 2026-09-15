// @vitest-environment jsdom
//
// END-TO-END parent workflow, run against the REAL preview client (the same
// in-browser demo Supabase the live preview uses — deliberately NO vi.mock).
//
// It replays the acceptance flow from the redesign brief:
//
//   login (parent1@example.com)
//     → Home (welcome, children, latest result, school messages, NO family ID)
//     → select a child
//     → Exam Results: Monthly → Midterm → Final tabs
//     → switch children easily
//     → Children screen (View Results / View Details)
//     → More (Take Quiz, Pickup Card, Settings, Sign Out)
//     → Messages + bottom navigation
//
// Demo data used (src/lib/supabase.ts):
//   parent-1  "Maxamed Heeban" (parent1@example.com)
//     ├─ stu-barwaaqo "Barwaaqo Maxamed Heeban" Grade 2-C — monthly/midterm/
//     │   final RPC demo data + approved exam results + family ID 0001
//     └─ stu-sara     "Sara Abdullahi"          Grade 1-A — sparse results

import { describe, expect, it, beforeEach, vi } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// The pickup card's PDF download is a web-only API (same mock convention as
// the lesson-plan PDF tests); keep this test on the parent workflow itself.
// Partial mock: other exports (StyleSheet, Document…) are used by admin PDF
// modules pulled in by App.
vi.mock('@react-pdf/renderer', async importOriginal => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return {
    ...actual,
    PDFDownloadLink: ({ children }: { children: unknown }) => (
      <button type="button" data-testid="family-card-download">
        {typeof children === 'function' ? 'Download / print my card' : (children as string)}
      </button>
    ),
  };
});

import App from '../../../App';

const text = (host: HTMLElement) => host.textContent ?? '';

/** Flush React + timers until `predicate` holds (or the wait times out). */
async function waitFor(host: HTMLElement, predicate: () => boolean, label: string, attempts = 120) {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

function clickByTestId(host: HTMLElement, testId: string) {
  const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`element [data-testid="${testId}"] not found`);
  el.click();
}

function clickButtonByText(host: HTMLElement, textMatch: string) {
  const btn = Array.from(host.querySelectorAll('button')).find(b =>
    (b.textContent ?? '').trim().includes(textMatch),
  );
  if (!btn) throw new Error(`button containing "${textMatch}" not found`);
  btn.click();
}

/** Set a controlled input's value the way React 19 expects in jsdom. */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountApp() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<App />);
  });
  return { host, root };
}

/** Preview boots auto-logged-in as the demo admin — sign out to reach Login. */
async function reachLoginPage(host: HTMLElement) {
  await waitFor(host, () => host.querySelector('button[title="Sign Out"]') != null, 'the demo admin session to load');
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[title="Sign Out"]')!.click();
  });
  await waitFor(host, () => host.querySelector('input#email') != null, 'the login page');
}

/** Fill the REAL login form as the demo parent. */
async function loginAsParent(host: HTMLElement) {
  await act(async () => {
    setNativeValue(host.querySelector<HTMLInputElement>('input#email')!, 'parent1@example.com');
    setNativeValue(host.querySelector<HTMLInputElement>('input#password')!, 'any-password-works-in-preview');
  });
  await act(async () => {
    clickButtonByText(host, 'Sign In');
  });
}

const navItems = (host: HTMLElement) =>
  ['home', 'children', 'results', 'messages', 'more'].map(
    key => host.querySelector(`[data-testid="parent-nav-${key}"]`)?.textContent?.trim() ?? '',
  );

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

describe('Parent mobile app — full workflow on the real preview client', () => {
  it('login → Home — the parent shell replaces the staff sidebar', async () => {
    const { host } = await mountApp();
    await reachLoginPage(host);
    await loginAsParent(host);

    await waitFor(host, () => host.querySelector('[data-testid="parent-home"]') != null, 'the parent Home screen');

    // The bottom navigation IS the primary navigation (5 items, labelled).
    expect(navItems(host)).toEqual(['Home', 'Children', 'Results', 'Messages', 'More']);
    // …and the SAME five destinations exist as desktop top-bar pills (lg+).
    expect(host.querySelector('[data-testid="parent-nav-lg-home"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="parent-nav-lg-results"]')?.textContent).toContain('Results');

    // Home: welcome + children + quick View Results + latest result + messages.
    expect(text(host)).toContain('Welcome, Maxamed');
    expect(text(host)).toContain('Barwaaqo Maxamed Heeban');
    expect(text(host)).toContain('Sara Abdullahi');
    expect(host.querySelector('[data-testid="home-view-results"]')).not.toBeNull();
    expect(text(host)).toContain('New result'); // latest approved result card
    expect(text(host)).toContain('School Messages');
    expect(text(host)).toContain('Midterm exams start next Sunday'); // demo announcement

    // "Your Family ID" must be completely gone from the parent dashboard.
    expect(text(host)).not.toContain('Family ID');
    expect(text(host)).not.toContain('MBK-0001');
    // …and the admin-style stat grid / technical clutter is gone too.
    expect(text(host)).not.toContain('Attendance Records');
    expect(text(host)).not.toContain('Homework Items');
    expect(text(host)).not.toContain('Active Session');
  }, 30_000);

  it('Home → select child → Monthly → Midterm → Final (2–3 taps each)', async () => {
    const { host } = await mountApp();
    await reachLoginPage(host);
    await loginAsParent(host);
    await waitFor(host, () => host.querySelector('[data-testid="parent-home"]') != null, 'the parent Home screen');

    // TAP 1 — select the child on Home; this both activates the child and
    // opens Exam Results (the "Open app → Home → Select Child → Exam Results"
    // flow from the brief).
    await act(async () => { clickByTestId(host, 'home-child-stu-barwaaqo'); });
    await waitFor(host, () => host.querySelector('[data-testid="exam-results"]') != null, 'Exam Results');

    // The three report tabs — the ONLY place parents look now.
    expect(host.querySelector('[data-testid="results-tab-monthly"]')?.textContent).toContain('Monthly');
    expect(host.querySelector('[data-testid="results-tab-midterm"]')?.textContent).toContain('Midterm');
    expect(host.querySelector('[data-testid="results-tab-final"]')?.textContent).toContain('Final');
    expect(host.querySelector('[data-testid="results-active-child"]')?.textContent).toContain('Barwaaqo Maxamed Heeban');
    expect(host.querySelector('[data-testid="results-active-child"]')?.textContent).toContain('Grade 2-C');

    // TAP 2 — Monthly tab content (auto-opens the latest month with data).
    await waitFor(host, () => text(host).includes('Monthly Report —'), 'the monthly report to load');
    expect(text(host)).toContain('Monthly Report — August'); // demo data month
    expect(text(host)).toContain('English'); // subject rows
    expect(text(host)).toContain('Mathematics');
    expect(text(host)).toContain('Monthly Average');

    // TAP 3 — Midterm.
    await act(async () => { clickByTestId(host, 'results-tab-midterm'); });
    await waitFor(host, () => host.querySelector('[data-testid="midterm-report-card"]') != null, 'the midterm report');
    expect(text(host)).toContain('Midterm Report');
    expect(text(host)).toContain('Average');
    expect(text(host)).toContain('Position');
    expect(text(host)).toContain('2 / 12'); // overall rank from the demo RPC
    expect(text(host)).toContain('85%'); // English midterm percentage

    // TAP 3 — Final.
    await act(async () => { clickByTestId(host, 'results-tab-final'); });
    await waitFor(host, () => host.querySelector('[data-testid="final-report-card"]') != null, 'the final report');
    expect(text(host)).toContain('Final Report');
    expect(text(host)).toContain('Final Average');
    expect(text(host)).toContain('PASSED'); // all-demo-subjects pass status
    expect(text(host)).toContain('Excellent progress!'); // teacher comment
  }, 30_000);

  it('switching between children works from Results and from Children', async () => {
    const { host } = await mountApp();
    await reachLoginPage(host);
    await loginAsParent(host);
    await waitFor(host, () => host.querySelector('[data-testid="parent-home"]') != null, 'the parent Home screen');

    // Open Results via the quick action (uses the default active child).
    await act(async () => { clickByTestId(host, 'home-view-results'); });
    await waitFor(host, () => host.querySelector('[data-testid="exam-results"]') != null, 'Exam Results');

    // Switch to the sister — one tap on her chip.
    await act(async () => { clickByTestId(host, 'results-child-stu-sara'); });
    await waitFor(
      host,
      () => host.querySelector('[data-testid="results-active-child"]')?.textContent?.includes('Sara Abdullahi') ?? false,
      'Sara to become the active child',
    );
    // Her monthly report has no demo data → friendly empty state (not an error).
    await waitFor(host, () => text(host).includes('No report for'), 'the empty monthly state for Sara');

    // Children tab: both children with View Results / View Details actions.
    await act(async () => { clickByTestId(host, 'parent-nav-children'); });
    await waitFor(host, () => host.querySelector('[data-testid="children-view"]') != null, 'My Children');
    expect(host.querySelector('[data-testid="child-view-results-stu-barwaaqo"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="child-view-results-stu-sara"]')).not.toBeNull();

    // "View Details" expands the subject panel for that child.
    await act(async () => { clickByTestId(host, 'child-view-details-stu-sara'); });
    await waitFor(host, () => text(host).includes('Subject performance'), 'child details to expand');

    // "View Results" on a child card activates that child AND opens Results.
    await act(async () => { clickByTestId(host, 'child-view-results-stu-barwaaqo'); });
    await waitFor(host, () => host.querySelector('[data-testid="exam-results"]') != null, 'Exam Results from Children');
    await waitFor(
      host,
      () => host.querySelector('[data-testid="results-active-child"]')?.textContent?.includes('Barwaaqo Maxamed Heeban') ?? false,
      'Barwaaqo to be active again',
    );
  }, 30_000);

  it('More holds Take Quiz, Pickup Card, Settings and Sign Out — off the main nav', async () => {
    const { host } = await mountApp();
    await reachLoginPage(host);
    await loginAsParent(host);
    await waitFor(host, () => host.querySelector('[data-testid="parent-home"]') != null, 'the parent Home screen');

    // Take Quiz must NOT be a primary nav item (already asserted by the nav
    // labels), and MUST be reachable from More.
    await act(async () => { clickByTestId(host, 'parent-nav-more'); });
    await waitFor(host, () => host.querySelector('[data-testid="parent-more"]') != null, 'the More screen');
    expect(text(host)).toContain('Take Quiz');
    expect(text(host)).toContain('Activity Updates'); // Streams, parent-friendly label
    expect(text(host)).toContain('School Pickup Card');
    expect(text(host)).toContain('Settings'); // appearance/language moved here
    expect(text(host)).toContain('Sign Out');
    expect(host.querySelector('[data-testid="more-sign-out"]')).not.toBeNull();

    // Take Quiz opens the (unchanged) quizzes page.
    await act(async () => { clickByTestId(host, 'more-quiz'); });
    await waitFor(host, () => text(host).includes('No active quizzes available'), 'the quizzes page');

    // The Family ID lives ONLY here now — the pickup administrative function.
    await act(async () => { clickByTestId(host, 'parent-nav-more'); });
    await act(async () => { clickByTestId(host, 'more-pickup'); });
    await waitFor(host, () => text(host).includes('School Pickup Card'), 'the pickup card screen');
    await waitFor(host, () => text(host).includes('MBK-0001'), 'the family ID on the pickup card');
    expect(text(host)).toContain('Recent Pickups');

    // Messages is a first-class bottom-nav destination.
    await act(async () => { clickByTestId(host, 'parent-nav-messages'); });
    await waitFor(host, () => text(host).includes('Messages'), 'the messages page');
  }, 30_000);
});
