// School-wide student search for the driver-management screen.
//
// Reuses the SAME matching rules as FamiliesTable.tsx: buildFamilyRows() +
// familyRowMatches() give one search box for family ID, student name, parent
// name or phone, plus a per-student "Add" action. Kept presentational — the
// caller decides what "Add" means (add to a draft selection, or attach to a
// driver immediately).

import { buildFamilyRows, familyRowMatches } from '../../../lib/print/familyRows';
import { displayFamilyId, formatGradeLabel } from '../../../lib/transport';
import type { Student } from '../../../types';

export function StudentSearchList({
  students,
  query,
  excludeIds,
  actionLabel,
  onAction,
  emptyHint,
}: {
  students: Student[];
  query: string;
  /** Students already selected/attached — hidden from the results. */
  excludeIds?: Set<string>;
  actionLabel: string;
  onAction: (student: Student) => void;
  emptyHint?: string;
}) {
  const excluded = excludeIds ?? new Set<string>();
  const rows = buildFamilyRows(students).filter(row => {
    if (!familyRowMatches(row, query)) return false;
    return row.students.some(s => !excluded.has(s.id));
  });

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
        {emptyHint ?? 'No students match your search'}
      </p>
    );
  }

  return (
    <div className="max-h-64 overflow-auto rounded-xl border border-slate-200">
      {rows.map(row => (
        <div key={row.familyId} className="border-b border-slate-100 last:border-b-0">
          <div className="sticky top-0 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-800">
            {displayFamilyId(row.familyId)}
            {row.parentName ? ` · ${row.parentName}` : ''}
          </div>
          {row.students
            .filter(s => !excluded.has(s.id))
            .map(s => (
              <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-700">{s.name}</div>
                  <div className="text-xs text-slate-400">{formatGradeLabel(s.className)}</div>
                </div>
                <button
                  onClick={() => onAction(s)}
                  className="shrink-0 rounded-lg bg-emerald-800 px-3 py-1 text-xs font-bold text-white transition hover:bg-emerald-900"
                >
                  {actionLabel}
                </button>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
