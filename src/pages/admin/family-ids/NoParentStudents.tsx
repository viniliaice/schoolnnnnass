// "No parent" tab — the office worklist of students with no parent account.
//
// WHY THIS SCREEN EXISTS
// ----------------------
// A student with no `parentId` is invisible to the parent portal: no login, no
// report cards, no messages. They also cannot be grouped by parent at Generate
// time, so they are matched by PHONE ONLY — the ambiguous path that merges two
// households that happen to share a number (see
// INVESTIGATION-family-id-merge.md). Office staff need one place to see who is
// in that state and to check them off with the family office.
//
// Read-only by construction: there is no edit/assign handler here. Parent
// assignment stays in Manage Students (`assign_student_parent`, admin + office),
// and Family IDs are never generated or changed by viewing this tab.

import { useMemo, useState } from 'react';
import { AlertTriangle, Search, UserRoundX, Users } from 'lucide-react';
import { displayFamilyId, formatGradeLabel, transportLabel } from '../../../lib/transport';
import { findStudentsWithoutParent } from '../../../lib/db/familyIds';
import { cn } from '../../../utils/cn';
import type { Student } from '../../../types';

export function NoParentStudents({
  students,
  loading,
  error,
  onRetry,
}: {
  /** The full roster the Family IDs page loaded (LEFT included; filtered here). */
  students: Student[];
  loading?: boolean;
  /** Set when the roster could not be loaded — shown instead of a false "0". */
  error?: string | null;
  onRetry?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [className, setClassName] = useState('');

  const rows = useMemo(
    () =>
      findStudentsWithoutParent(students).sort(
        (a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name),
      ),
    [students],
  );

  const classes = useMemo(() => {
    const set = new Set<string>();
    for (const s of rows) set.add(s.className);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(s => {
      if (className && s.className !== className) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.className.toLowerCase().includes(q) ||
        (s.familyId ?? '').includes(q) ||
        (s.parentPhone ?? '').includes(q)
      );
    });
  }, [rows, query, className]);

  const withoutFamilyId = rows.filter(s => !s.familyId).length;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
            <UserRoundX className="h-4 w-4 text-amber-700" />
            Students without a parent account
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-500">
            These active students have no parent linked, so no parent can sign in for them. They are
            matched into families by phone number only. To fix one, assign a parent in{' '}
            <span className="font-semibold text-slate-700">Manage Students</span>.
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
          {rows.length} student{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {!loading && !error && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
            <Users className="mr-1 inline h-3 w-3" />
            {rows.length - withoutFamilyId} already have a Family ID
          </span>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 font-semibold',
              withoutFamilyId > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800',
            )}
          >
            {withoutFamilyId} still need a Family ID
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, class, phone, MBK-####…"
            className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-emerald-700 focus:outline-none"
          />
        </div>
        <select
          value={className}
          onChange={e => setClassName(e.target.value)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
        >
          <option value="">All classes</option>
          {classes.map(c => (
            <option key={c} value={c}>{formatGradeLabel(c)}</option>
          ))}
        </select>
      </div>

      <div className="mb-2 text-xs text-slate-600">
        <b>{filtered.length}</b> of {rows.length} students without a parent
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading students…</p>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="text-sm font-bold text-red-800">Could not load students</p>
          <p className="mt-1 text-xs text-red-700">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 rounded-xl bg-red-700 px-4 py-2 text-xs font-bold text-white hover:bg-red-800"
            >
              Try again
            </button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-8 text-center">
          <p className="text-sm font-semibold text-emerald-800">Every active student has a parent account</p>
          <p className="mt-1 text-xs text-emerald-700">Nothing to follow up.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-sm font-semibold text-slate-700">No students match your search</p>
          <button
            onClick={() => { setQuery(''); setClassName(''); }}
            className="mt-2 text-xs font-semibold text-emerald-800 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">Student</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2">Transport</th>
                <th className="px-3 py-2">Phone on file</th>
                <th className="px-3 py-2">Family ID</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-800">{s.name}</td>
                  <td className="px-3 py-2 text-slate-600">{formatGradeLabel(s.className)}</td>
                  <td className="px-3 py-2 text-slate-600">{transportLabel(s.transport)}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">
                    {s.parentPhone || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2 font-mono font-bold text-emerald-900">
                    {s.familyId ? (
                      displayFamilyId(s.familyId)
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                        <AlertTriangle className="h-3 w-3" /> missing
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
