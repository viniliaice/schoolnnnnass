// @vitest-environment jsdom
// Duplicate Students page — the SERVER-AUTHORITATIVE safe-merge count.
//
// The page used to show only a client-side "High Confidence" number, computed
// by evaluatePair() in the browser. That number cannot see attendance, exams,
// quiz attempts, enrollment state or candidate-group size, and it was proven to
// diverge from the database verdict (see duplicateBatch.pageVsServer.test.ts).
//
// These tests pin the contract:
//   * the number the page presents as authoritative is the one the RPC returns;
//   * the client-side classification is still shown but labelled as an estimate;
//   * a page where the two disagree renders BOTH, never a blended number;
//   * a non-admin gets an explicit failure instead of a plausible-looking count.
import { describe, it, expect, beforeEach } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../context/ToastContext';
import { I18nProvider } from '../../../lib/i18n/AppLanguageContext';
import { DuplicateStudents } from '../DuplicateStudents';
import { getSafeDuplicateBatch } from '../../../lib/db/duplicateStudents';

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ToastProvider>
            <DuplicateStudents />
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  return { container, unmount: () => root.unmount() };
}

const byTestId = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = (c: HTMLElement, id: string) => (byTestId(c, id)?.textContent ?? '').trim();

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  (globalThis as any).__mockRole = 'admin';
});

describe('DuplicateStudents — server-authoritative safe count', () => {
  it('renders the number returned by get_safe_duplicate_batch, not a client-side count', async () => {
    // Ask the server directly first, then assert the page shows THAT number.
    const report = await getSafeDuplicateBatch({ limit: 1, offset: 0, includeExcluded: false });
    const { container, unmount } = await renderPage();

    const card = byTestId(container, 'server-safe-count');
    expect(card).not.toBeNull();
    expect(text(container, 'server-safe-count-value')).toBe(String(report.summary.safeCount));
    expect(text(container, 'server-needs-review')).toContain(String(report.summary.needsReviewCount));
    expect(text(container, 'server-blocked')).toContain(String(report.summary.blockedCount));
    expect(text(container, 'server-candidate-pairs')).toContain(String(report.summary.candidatePairs));
    expect(card?.textContent).toContain('Safe to Merge — server verified');
    expect(card?.textContent).toContain('only number that controls batch execution');
    unmount();
  });

  it('labels the client-side High Confidence card as a page estimate', async () => {
    const { container, unmount } = await renderPage();
    const hc = byTestId(container, 'card-high-confidence');
    expect(hc).not.toBeNull();
    expect(hc?.textContent).toContain('High Confidence');
    expect(text(container, 'card-high-confidence-hint')).toContain('page estimate');
    expect(text(container, 'card-high-confidence-hint')).toContain('not the batch count');
    unmount();
  });

  it('states unambiguously which number controls the batch', async () => {
    const { container, unmount } = await renderPage();
    const note = byTestId(container, 'authoritative-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('Safe to Merge — server verified');
    expect(container.textContent).toContain('never authorise a merge');
    expect(container.textContent).toContain('recomputes it again the moment you confirm');
    unmount();
  });

  it('shows both numbers when the client and the server disagree, and never blends them', async () => {
    const report = await getSafeDuplicateBatch({ limit: 1, offset: 0, includeExcluded: false });
    const { container, unmount } = await renderPage();

    const server = text(container, 'server-safe-count-value');
    const client = byTestId(container, 'card-high-confidence')?.querySelector('span.text-2xl')?.textContent?.trim() ?? '';

    // Both are rendered as their own numbers. Neither is derived from the other.
    expect(server).toBe(String(report.summary.safeCount));
    expect(client).toMatch(/^\d+$/);
    // The server card is visually the authoritative one.
    expect(byTestId(container, 'server-safe-count')?.className).toContain('border-emerald-300');
    // The client cards carry the "page estimate" hint; the server card does not.
    expect(text(container, 'card-high-confidence-hint')).toContain('page estimate');
    expect(byTestId(container, 'server-safe-count')?.textContent ?? '').not.toContain('page estimate');
    unmount();
  });

  it('refuses to invent a number for a non-admin, and says why', async () => {
    (globalThis as any).__mockRole = 'teacher';
    const { container, unmount } = await renderPage();
    // No fabricated count: the authoritative card shows a placeholder, plus the
    // server's own refusal surfaced verbatim.
    expect(text(container, 'server-safe-count-value')).toBe('—');
    const err = byTestId(container, 'server-safe-count-error');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('Only administrators');
    // The client-side classification is still available for reading the list,
    // and is explicitly not an authorisation.
    expect(err?.textContent).toContain('cannot authorise a batch merge');
    unmount();
    (globalThis as any).__mockRole = 'admin';
  });
});
