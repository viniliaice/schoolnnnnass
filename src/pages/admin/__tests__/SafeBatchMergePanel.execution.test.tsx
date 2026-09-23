// @vitest-environment jsdom
// "Merge All Safe Duplicates" — full UI execution flow (destructive against the
// in-memory demo tables, so it lives in its own file to keep the read-only
// panel tests deterministic).
import { describe, it, expect, beforeEach, vi } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../context/ToastContext';
import { I18nProvider } from '../../../lib/i18n/AppLanguageContext';
import { SafeBatchMergePanel } from '../SafeBatchMergePanel';
import { supabase } from '../../../lib/supabase';

async function renderPanel(language: 'en' | 'ar' = 'en') {
  localStorage.setItem('mbk-language', language);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ToastProvider>
            <SafeBatchMergePanel />
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return { container, unmount: () => root.unmount() };
}

const tick = async (ms = 60) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

function byTestId(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  (globalThis as any).__mockRole = 'admin';
});

describe('SafeBatchMergePanel — confirmed execution', () => {
  it('cannot be run at all by a non-administrator', async () => {
    (globalThis as any).__mockRole = 'teacher';
    const { container, unmount } = await renderPanel('en');
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);
    const txt = container.textContent || '';
    expect(txt).toContain('The safe preview failed');
    expect(txt).toMatch(/Only administrators/i);
    expect(byTestId(container, 'safe-batch-run-button')).toBeNull();
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
    unmount();
  });

  it('executes the confirmed batch and reports every merged pair', async () => {
    // ToastProvider only holds state (the app shell renders it), so capture the
    // emitted toast through its log to assert the success notification.
    const toasts: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      toasts.push(args.map(String).join(' '));
    });
    const { container, unmount } = await renderPanel('en');
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);
    for (const key of ['keeper', 'excluded', 'audit']) {
      await act(async () => { (byTestId(container, `safe-batch-confirm-${key}`) as HTMLInputElement).click(); });
    }
    await act(async () => {
      const input = byTestId(container, 'safe-batch-phrase-input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'MERGE SAFE DUPLICATES');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const note = byTestId(container, 'safe-batch-reason-input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(note, 'September duplicate cleanup');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick(20);

    await act(async () => { (byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).click(); });
    await tick(200);

    const txt = container.textContent || '';
    expect(txt).toContain('Batch results');
    expect(byTestId(container, 'safe-batch-merged-stu-axmed-a>stu-axmed-b')).not.toBeNull();
    expect(byTestId(container, 'safe-batch-merged-stu-samegov-a>stu-samegov-b')).not.toBeNull();
    expect(toasts.some((l) => l.includes('Batch complete'))).toBe(true);
    expect(toasts.some((l) => l.includes('2 duplicate records were merged'))).toBe(true);
    logSpy.mockRestore();
    // The excluded pairs were never part of the batch.
    expect(txt).not.toContain('stu-abshir-b →');

    // A refresh preview now reports nothing safe left.
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(150);
    expect(byTestId(container, 'safe-batch-status')!.textContent).toContain('nothing safe to batch right now');
    unmount();
  });

});
