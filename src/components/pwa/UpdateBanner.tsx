import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { applyServiceWorkerUpdate, SW_UPDATE_EVENT } from '../../lib/pwa/register';

/**
 * "New version available — Update Now". Shown when the service worker finds a
 * newer deploy while the app is open. Updating is explicit: tapping the
 * button activates the waiting worker and reloads once.
 */
export function UpdateBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(SW_UPDATE_EVENT, show);
    return () => window.removeEventListener(SW_UPDATE_EVENT, show);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[70] flex justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
        <RefreshCw className="h-5 w-5 shrink-0 text-indigo-600" />
        <p className="flex-1 text-sm font-medium text-slate-800">New version available.</p>
        <button
          type="button"
          onClick={() => applyServiceWorkerUpdate()}
          className="min-h-11 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
        >
          Update Now
        </button>
      </div>
    </div>
  );
}
