// @vitest-environment jsdom
// "Merge All Safe Duplicates" panel — UI contract:
//   * bilingual (EN / عربي) from the app dictionaries
//   * dry-run preview before anything can be executed
//   * exact pairs + exclusion reasons rendered from the SERVER verdict
//   * three confirmations + typed phrase gate (never a single click)
//   * chunked execution results per pair
import { describe, it, expect, beforeEach } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../context/ToastContext';
import { I18nProvider } from '../../../lib/i18n/AppLanguageContext';
import { SafeBatchMergePanel } from '../SafeBatchMergePanel';

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

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === text) as HTMLButtonElement | undefined;
}

function byTestId(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  (globalThis as any).__mockRole = 'admin';
});

describe('SafeBatchMergePanel — English', () => {
  it('shows the batch title but no destructive action before a dry run', async () => {
    const { container, unmount } = await renderPanel('en');
    const txt = container.textContent || '';
    expect(txt).toContain('Merge All Safe Duplicates');
    expect(txt).toContain('Server-decided batch merge');
    // There is no unrestricted "Merge All" button — the safety rule still holds.
    expect(buttonByText(container, 'Merge All')).toBeUndefined();
    expect(buttonByText(container, 'Delete All Duplicates')).toBeUndefined();
    expect(byTestId(container, 'safe-batch-run-button')).toBeNull();
    expect(byTestId(container, 'safe-batch-preview-button')).not.toBeNull();
    unmount();
  });

  it('runs the dry run and renders the exact pairs the server approved', async () => {
    const { container, unmount } = await renderPanel('en');
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);

    const txt = container.textContent || '';
    expect(txt).toContain('Safe to merge');
    expect(byTestId(container, 'safe-batch-status')!.textContent).toContain('2 pairs are safe to merge now.');
    expect(txt).toContain('Exact pairs the server will merge');
    expect(txt).toContain('Kept Student ID');
    expect(txt).toContain('stu-axmed-a');
    expect(txt).toContain('stu-axmed-b');
    expect(txt).toContain('stu-samegov-a');
    expect(txt).toContain('Grade 1-B');
    expect(txt).toContain('Maxamed Heeban'); // parent of the kept record
    expect(txt).toContain('consolidate');
    expect(txt).toContain('The parent-assigned record will be kept');
    expect(txt).toContain('Each chunk of 25 merges is one atomic transaction');
    expect(txt).toContain('dry run writes: 0');

    // The dry run states plainly that nothing changed, and the execution count
    // it offers is the server's — never a client-side classification.
    expect(byTestId(container, 'safe-batch-no-writes')!.textContent)
      .toContain('Safe preview completed. No records were modified.');
    expect(byTestId(container, 'safe-batch-status')!.textContent).toContain('2 pairs are safe');

    // Excluded pairs are listed with the reason each stays in individual review.
    expect(txt).toContain('Excluded — individual review only');
    await act(async () => { (Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Excluded — individual review only')) as HTMLButtonElement).click(); });
    await tick(20);
    const after = container.textContent || '';
    expect(after).toContain('Abshir Cabdi Maxamed');
    expect(after).toMatch(/Exam identity conflict/);
    expect(after).toContain('Ahmed Mohamed');
    expect(after).toMatch(/Gov ID conflict/);
    unmount();
  });

  it('keeps the run button disabled until all three confirmations and the exact phrase', async () => {
    const { container, unmount } = await renderPanel('en');
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);

    const run = byTestId(container, 'safe-batch-run-button') as HTMLButtonElement;
    expect(run).not.toBeNull();
    expect(run.disabled).toBe(true);

    // 1. checkboxes only → still disabled
    for (const key of ['keeper', 'excluded', 'audit']) {
      await act(async () => {
        const box = byTestId(container, `safe-batch-confirm-${key}`) as HTMLInputElement;
        box.click();
      });
    }
    await tick(20);
    expect((byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).disabled).toBe(true);

    // 2. wrong phrase → still disabled + explicit mismatch message
    await act(async () => {
      const input = byTestId(container, 'safe-batch-phrase-input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'MERGE ALL');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick(20);
    expect((byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('The typed phrase does not match MERGE SAFE DUPLICATES.');

    // 3. exact phrase → enabled
    await act(async () => {
      const input = byTestId(container, 'safe-batch-phrase-input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'MERGE SAFE DUPLICATES');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick(20);
    expect((byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

});

describe('SafeBatchMergePanel — عربي', () => {
  it('renders the same flow in Arabic', async () => {
    const { container, unmount } = await renderPanel('ar');
    const txt = container.textContent || '';
    expect(txt).toContain('دمج جميع السجلات المكررة الآمنة');
    expect(txt).toContain('دمج جماعي يقرره الخادم');
    expect(buttonByText(container, 'Merge All')).toBeUndefined();

    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);
    const after = container.textContent || '';
    expect(after).toContain('آمنة للدمج');
    expect(after).toContain('الأزواج المحددة التي سيدمجها الخادم');
    expect(after).toContain('رقم الطالب المحتفظ به');
    expect(after).toContain('يُحتفظ بالسجل الذي لديه ولي أمر معيّن');
    expect(after).toContain('كل دفعة من 25 عملية دمج');
    expect(after).toContain('stu-axmed-a');
    // Arabic confirmation gate
    expect(after).toContain('التأكيد النهائي');
    expect(after).toContain('أفهم أنه سيتم الاحتفاظ بالسجل المرتبط بولي الأمر');
    expect(after).toContain('اكتب عبارة التأكيد لتفعيل الدمج الجماعي');
    expect((byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId(container, 'safe-batch-run-button') as HTMLButtonElement).textContent).toContain('دمج السجلات الآمنة على دفعات');
    unmount();
  });

  it('uses the server phrase (never translated) in the Arabic gate', async () => {
    const { container, unmount } = await renderPanel('ar');
    await act(async () => { byTestId(container, 'safe-batch-preview-button')!.click(); });
    await tick(120);
    expect(container.textContent).toContain('MERGE SAFE DUPLICATES');
    expect((byTestId(container, 'safe-batch-phrase-input') as HTMLInputElement).placeholder).toBe('MERGE SAFE DUPLICATES');
    unmount();
  });
});
