// Read-only student directory (office + admin + supervisor).
// Name, grade, transport, family ID — lookup/search only, no edit actions.
// Writes are impossible here by construction (no update/delete handlers;
// RLS also blocks office writes at the database).

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { getStudents } from '../../lib/db/students';
import { displayFamilyId, transportLabel } from '../../lib/transport';
import type { Student } from '../../types';

export function StudentDirectory() {
  const { addToast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [onlyAssigned, setOnlyAssigned] = useState(false);

  useEffect(() => {
    getStudents()
      .then(setStudents)
      .catch(err => addToast({ type: 'error', title: 'Failed to load students', description: err instanceof Error ? err.message : undefined }))
      .finally(() => setLoading(false));
  }, [addToast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students
      .filter(s => {
        if (onlyAssigned && !s.familyId) return false;
        if (!q) return true;
        return (
          s.name.toLowerCase().includes(q) ||
          s.className.toLowerCase().includes(q) ||
          (s.familyId ?? '').includes(q) ||
          (s.transport ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [students, query, onlyAssigned]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Student Directory</h1>
          <p className="text-sm text-slate-500">Read-only: name, grade, transport, family ID. No edit actions.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={onlyAssigned}
              onChange={e => setOnlyAssigned(e.target.checked)}
              className="h-4 w-4"
            />
            Only families with IDs
          </label>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, grade, transport, MBK-####…"
            className="w-72 rounded-xl border border-slate-300 px-4 py-2 text-sm focus:border-emerald-700 focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          {students.length === 0 ? 'No students in the directory yet.' : 'No students match your search.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Grade</th>
                  <th className="px-4 py-3">Transport</th>
                  <th className="px-4 py-3">Family ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(s => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{s.name}</td>
                    <td className="px-4 py-2.5 text-slate-600">{s.className}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                        s.transport === 'WALKER' ? 'bg-emerald-100 text-emerald-800'
                        : s.transport === 'CAR' ? 'bg-amber-100 text-amber-800'
                        : s.transport ? 'bg-indigo-100 text-indigo-800'
                        : 'bg-slate-100 text-slate-500'
                      }`}>
                        {transportLabel(s.transport)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono font-bold text-emerald-900">
                      {s.familyId ? displayFamilyId(s.familyId) : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
            {filtered.length} of {students.length} students
          </div>
        </div>
      )}
    </div>
  );
}
