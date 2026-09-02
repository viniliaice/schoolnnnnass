// QA harness entry for the supervisor Lesson Plan Review screen.
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/index.css';
import './qa-fonts.css';
import { ToastProvider } from '../src/context/ToastContext';
import { I18nProvider } from '../src/lib/i18n/AppLanguageContext';
import { LessonPlanReview } from '../src/pages/supervisor/LessonPlanReview';

// Continuous layout-shift observer — the acceptance criterion, measured.
function ClsMeter() {
  useEffect(() => {
    let total = 0;
    if (document.getElementById('cls-meter')) return;
    const el = document.createElement('div');
    el.id = 'cls-meter';
    el.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:9999;background:#0f172a;color:#fff;' +
      'font:12px monospace;padding:6px 10px;border-radius:8px';
    el.textContent = 'CLS 0.0000';
    document.body.appendChild(el);
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!e.hadRecentInput) total += e.value;
      }
      el.textContent = `CLS ${total.toFixed(4)}`;
      el.style.background = total > 0.01 ? '#b91c1c' : '#0f172a';
      (window as unknown as { __cls: number }).__cls = total;
    });
    po.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
    return () => po.disconnect();
  }, []);
  return null;
}

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
(window as unknown as { __qc: QueryClient }).__qc = client;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToastProvider>
          <ClsMeter />
          <LessonPlanReview />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
