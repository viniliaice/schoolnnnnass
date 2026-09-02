// "Assign driver" / "Change driver" picker at the dismissal gate.
//
// The driver record is the source of truth: staff SEARCH the registered drivers
// (authorized_pickups) and SELECT one. This never creates or registers a driver
// and never accepts an arbitrary name — a student is assigned an existing driver
// via attach_students_to_authorized_pickup(), which has REPLACE semantics (one
// driver per student) and rejects bus students. Walking students may be assigned
// a driver for a temporary pickup; their permanent transport is not overwritten.
// Drivers themselves are registered on the /admin/drivers management screen
// (admin + office).

import { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { useToast } from '../../../context/ToastContext';
import { attachStudentsToAuthorizedPickup, searchAuthorizedPickups, type AuthorizedPickup } from '../../../lib/db/authorizedPickups';
import type { GateLookupRow } from '../../../lib/db/gate';
import type { GateLang, GateStrings } from '../../../lib/i18n/gateStrings';

export function AssignDriverPanel({
  open,
  onClose,
  student,
  t,
  onAssigned,
}: {
  open: boolean;
  onClose: () => void;
  /** The single eligible student (walking or driver transport) being assigned. */
  student: GateLookupRow | null;
  t: GateStrings;
  lang?: GateLang;
  onAssigned: () => void;
}) {
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AuthorizedPickup[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setError(null);
      setAssigning(null);
    }
  }, [open]);

  // Debounce-free but cancelled-safe search: every keystroke queries the
  // registered-driver list (identity only — no student/family data).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    // Debounced + cancelled-safe: typing no longer fires one RPC per keystroke,
    // and a slow earlier response can never overwrite a newer result set.
    const timer = setTimeout(() => {
      searchAuthorizedPickups(query)
        .then(list => { if (!cancelled) setResults(list); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query]);

  const assign = async (driver: AuthorizedPickup) => {
    if (!student) return;
    setAssigning(driver.id);
    setError(null);
    try {
      await attachStudentsToAuthorizedPickup(driver.id, [student.id]);
      addToast({
        type: 'success',
        title: `${t.assignDriver}: ${driver.name}`,
        description: `${driver.name} · ${driver.phoneNumber}`,
      });
      onAssigned();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast({ type: 'error', title: t.saveDriverFailed, description: message });
    } finally {
      setAssigning(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t.assignDriver}
      description={student ? `${student.name} · ${student.className}` : undefined}
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t.searchDriver}
            autoFocus
            className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-emerald-700 focus:outline-none"
          />
        </div>

        {/* Fixed-height list region: the skeleton, the empty state, and the
            real results all live in the same 18rem box, so the dialog never
            resizes while a search is in flight. */}
        {loading ? (
          <div aria-busy="true" className="max-h-72 space-y-1.5 overflow-hidden">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <span className="gate-skeleton h-9 w-9 shrink-0 rounded-full bg-slate-200/80" />
                <span className="min-w-0 flex-1 space-y-1.5">
                  <span className="gate-skeleton block h-3.5 w-32 rounded bg-slate-200/80" />
                  <span className="gate-skeleton block h-3 w-20 rounded bg-slate-200/80" />
                </span>
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="flex min-h-[9rem] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-sm text-slate-500">
            {t.noDriversMatch}
          </p>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-auto">
            {results.map(d => (
              <button
                key={d.id}
                onClick={() => void assign(d)}
                disabled={assigning !== null}
                className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-emerald-400 disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-black text-emerald-800">
                  {d.name.trim()[0]?.toUpperCase() ?? '?'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-800">{d.name}</span>
                  <span className="block truncate text-xs text-slate-500">{d.phoneNumber}{d.relationship ? ` · ${d.relationship}` : ''}</span>
                </span>
                {assigning === d.id && <Loader2 className="h-4 w-4 animate-spin text-emerald-700" />}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
