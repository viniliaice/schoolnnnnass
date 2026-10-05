import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Honest offline indicator: shown while the browser reports no connectivity.
 * The cached shell keeps the app usable, but server actions still fail and
 * are reported as failures — we never pretend they succeeded.
 */
export function OfflineIndicator() {
  // navigator.onLine is a boolean in browsers; treat anything else as online.
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && navigator.onLine === false,
  );

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[80] flex justify-center p-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]"
    >
      <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 shadow-lg">
        <WifiOff className="h-4 w-4" />
        You’re offline — showing the cached app. Changes will not sync until you reconnect.
      </div>
    </div>
  );
}
