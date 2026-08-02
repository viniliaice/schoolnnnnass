// M3 — "Recent pickups" panel on the parent dashboard.
// Read-only list of the parent's own children's releases (release_log),
// scoped by parentId + RLS. Shows student, family ID, and time.

import { useEffect, useState } from 'react';
import { displayFamilyId } from '../../../lib/transport';
import { getRecentReleases, type RecentRelease } from '../../../lib/db/familyPortal';

export function RecentReleases({ parentId }: { parentId: string }) {
  const [releases, setReleases] = useState<RecentRelease[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecentReleases(parentId)
      .then(data => { if (!cancelled) setReleases(data); })
      .catch(() => { if (!cancelled) setReleases([]); });
    return () => { cancelled = true; };
  }, [parentId]);

  if (releases === null) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Recent Pickups</h2>
        <p className="text-sm text-slate-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Recent Pickups</h2>
      <p className="mb-3 text-sm text-slate-500">When your children were handed over at the gate.</p>
      {releases.length === 0 ? (
        <p className="text-sm text-slate-400">No pickups recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {releases.map(r => (
            <li key={r.id} className="flex items-center justify-between py-2.5 text-sm">
              <div>
                <span className="font-medium text-slate-900">{r.students?.name ?? 'Your child'}</span>
                <span className="ml-2 font-mono text-xs font-bold text-emerald-800">{displayFamilyId(r.familyId)}</span>
              </div>
              <span className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
