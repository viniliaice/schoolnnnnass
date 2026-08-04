import { useCallback, useState, type ReactElement } from 'react';
import { pdf } from '@react-pdf/renderer';
import { Download, Loader2, AlertTriangle } from 'lucide-react';

interface ExportLessonPlanPdfButtonProps {
  document: ReactElement;
  fileName: string;
  className?: string;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ExportLessonPlanPdfButton({ document, fileName, className }: ExportLessonPlanPdfButtonProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);

    try {
      // Yield one frame so the loading state paints before heavy PDF layout work starts.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const blob = await pdf(document as Parameters<typeof pdf>[0]).toBlob();
      downloadBlob(blob, fileName);
    } catch (err) {
      console.error('[LessonPlanPdf] export failed:', err);
      setError(err instanceof Error ? err.message : 'Could not generate the PDF. Please try again.');
    } finally {
      setGenerating(false);
    }
  }, [document, fileName, generating]);

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      <button
        type="button"
        onClick={handleExport}
        disabled={generating}
        aria-busy={generating}
        className={className ?? 'flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto'}
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {generating ? 'Preparing PDF…' : 'Export PDF'}
      </button>
      {error && (
        <p className="flex max-w-sm items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium leading-5 text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
