import { useState } from 'react';
import { Download, MonitorSmartphone, X } from 'lucide-react';
import { usePwaInstall } from '../../lib/pwa/install';

/**
 * "Install App" affordance for the teacher interface. Shows the native
 * install prompt when the browser offers one, iOS share-sheet instructions
 * on iPhone/iPad, and manual instructions elsewhere. Never re-appears once
 * installed, and stays hidden for 7 days after a dismissal.
 */
export function InstallAppCard({ alwaysVisible = false }: { alwaysVisible?: boolean }) {
  const { installed, canPrompt, ios, shouldShow, promptInstall, dismiss } = usePwaInstall();
  const [outcome, setOutcome] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  if (installed) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        MBK School is installed on this device.
      </div>
    );
  }

  if (!alwaysVisible && !shouldShow) return null;

  const handleInstall = async () => {
    const result = await promptInstall();
    if (result === 'dismissed') setOutcome('You can install MBK School any time from your browser menu.');
    if (result === 'unavailable') setShowHelp(true);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="install-app-card">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
          <MonitorSmartphone className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-slate-900">Install App</h3>
          <p className="mt-1 text-sm text-slate-500">
            Install MBK School on your phone or computer for faster access and notifications.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(canPrompt || ios) && (
              <button
                type="button"
                onClick={handleInstall}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
              >
                <Download className="h-4 w-4" /> Install App
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
            >
              How to install
            </button>
            {!alwaysVisible && (
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss install suggestion"
                className="ml-auto min-h-11 rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {outcome && <p className="mt-2 text-xs text-slate-500">{outcome}</p>}
          {(showHelp || (!canPrompt && !ios)) && <InstallInstructions ios={ios} />}
        </div>
      </div>
    </div>
  );
}

function InstallInstructions({ ios }: { ios: boolean }) {
  return (
    <div className="mt-3 rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
      {ios ? (
        <ol className="list-decimal space-y-1 pl-4">
          <li>Open this site in Safari.</li>
          <li>Tap the Share button (the square with an arrow).</li>
          <li>Choose “Add to Home Screen”, then “Add”.</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            <strong>Android / Chrome:</strong> browser menu ⋮ → “Install app” (or the install icon in the
            address bar).
          </li>
          <li>
            <strong>Windows / Edge or Chrome:</strong> the install icon at the right of the address bar →
            “Install”.
          </li>
          <li>
            <strong>Mac / Chrome or Edge:</strong> same install icon, or File → “Install MBK School”.
          </li>
          <li>
            <strong>Chromebook:</strong> launcher → the install icon appears in the address bar.
          </li>
        </ol>
      )}
    </div>
  );
}
