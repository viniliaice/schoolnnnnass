// Families table — search, filter, select, print.
//
// This is the normal working surface for office staff: find a family fast
// (by ID, student, parent or phone), then print one card, the selected rows,
// or everything currently filtered. Every print action opens the shared
// PrintCardsDialog; none of them can generate a Family ID.

import { useMemo, useState } from 'react';
import { Pencil, Printer, Search, Users } from 'lucide-react';
import { displayFamilyId, formatGradeLabel, transportLabel } from '../../../lib/transport';
import {
  buildFamilyRows, classOptions, familyRowMatches, familyRowMatchesClass,
  narrowRowsToSelection, studentsMatchingTransport, transportOptions,
  type FamilyRow, type TransportSelection,
} from '../../../lib/print/familyRows';
import { PrintCardsDialog, type DialogSource } from './PrintCardsDialog';
import { EditTransportDialog } from './EditTransportDialog';
import { cn } from '../../../utils/cn';
import type { Student } from '../../../types';

export function FamiliesTable({
  students,
  parentNames,
  loading,
  error,
  onRetry,
  canEditTransport = false,
  onEditTransport,
}: {
  students: Student[];
  parentNames?: Map<string, string>;
  loading?: boolean;
  /** Set when the roster could not be loaded — shown instead of an empty table. */
  error?: string | null;
  onRetry?: () => void;
  /** Admin-only: show the per-student transport edit control (SQL also enforces). */
  canEditTransport?: boolean;
  onEditTransport?: (studentId: string, transport: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [transport, setTransport] = useState<TransportSelection>('all');
  const [className, setClassName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogSource | null>(null);
  const [editing, setEditing] = useState<Student | null>(null);

  const rows = useMemo(() => buildFamilyRows(students, parentNames), [students, parentNames]);
  const filtered = useMemo(
    () =>
      // Narrow FIRST: with a transport selected each row must list only the
      // matching students, not the whole family. Families with no match drop
      // out entirely.
      narrowRowsToSelection(rows, transport).filter(
        row => familyRowMatches(row, query) && familyRowMatchesClass(row, className),
      ),
    [rows, query, transport, className],
  );
  const classes = useMemo(() => classOptions(rows), [rows]);
  const transports = useMemo(() => transportOptions(rows), [rows]);

  // TRANSPORT IS STUDENT-LEVEL. When a transport is selected, the working unit
  // becomes the matching STUDENTS, not the families that contain them — so
  // printing cannot drag unselected siblings along.
  const transportActive = transport !== 'all';
  const transportName = transports.find(([v]) => v === transport)?.[1] ?? 'All students';
  const matchingStudents = useMemo(
    () => (transportActive ? studentsMatchingTransport(filtered, transport) : []),
    [transportActive, filtered, transport],
  );
  /** Siblings hidden by the transport filter, across all visible rows. */
  const hiddenByFilter = useMemo(
    () => filtered.reduce((n, r) => n + (r.hiddenByFilter ?? 0), 0),
    [filtered],
  );

  // Selection is keyed by familyId, so it survives filtering and sorting.
  const visibleIds = filtered.map(r => r.familyId);
  const selectedVisible = visibleIds.filter(id => selected.has(id));
  const hiddenSelected = selected.size - selectedVisible.length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleRow = (familyId: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(familyId)) next.delete(familyId); else next.add(familyId);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach(id => next.delete(id));
      else visibleIds.forEach(id => next.add(id));
      return next;
    });

  const openPrint = (source: DialogSource) => setDialog(source);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Families</h2>
          <p className="text-sm text-slate-500">
            Find a family and print its card. Printing never changes a Family ID.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => openPrint({ kind: 'students' })}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
          >
            <Users className="h-4 w-4" /> Print by students…
          </button>
          <button
            onClick={() =>
              openPrint({
                kind: 'families',
                familyIds: [...selected],
                label: `${selected.size} selected famil${selected.size === 1 ? 'y' : 'ies'}`,
              })
            }
            disabled={selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-800 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" /> Print selected ({selected.size})
          </button>
          {/* With a transport selected this prints the MATCHING STUDENTS, not
              their families — otherwise filtering to WALKER and pressing
              Print would also print the bus-riding siblings. */}
          <button
            onClick={() =>
              openPrint(
                transportActive
                  ? {
                      kind: 'students',
                      studentIds: matchingStudents.map(s => s.id),
                      label: `${matchingStudents.length} ${transportName.toLowerCase()} student${matchingStudents.length === 1 ? '' : 's'}`,
                    }
                  : {
                      kind: 'families',
                      familyIds: visibleIds,
                      label:
                        query || className
                          ? `${visibleIds.length} filtered famil${visibleIds.length === 1 ? 'y' : 'ies'}`
                          : `all ${visibleIds.length} famil${visibleIds.length === 1 ? 'y' : 'ies'}`,
                    },
              )
            }
            disabled={transportActive ? matchingStudents.length === 0 : visibleIds.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" />
            {transportActive
              ? `Print ${matchingStudents.length} ${transportName} student${matchingStudents.length === 1 ? '' : 's'}`
              : `Print all (${visibleIds.length})`}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search family ID, student, parent, phone…"
            className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-emerald-700 focus:outline-none"
          />
        </div>
        <select
          value={transport}
          onChange={e => setTransport(e.target.value as TransportSelection)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
        >
          {transports.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select
          value={className}
          onChange={e => setClassName(e.target.value)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
        >
          <option value="">All classes</option>
          {classes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <span>
          {transportActive ? (
            <>
              <b>{matchingStudents.length}</b> {transportName.toLowerCase()} student
              {matchingStudents.length === 1 ? '' : 's'} in <b>{filtered.length}</b> famil
              {filtered.length === 1 ? 'y' : 'ies'}
            </>
          ) : (
            <>
              <b>{filtered.length}</b> of {rows.length} families
            </>
          )}
        </span>
        {hiddenByFilter > 0 && (
          <span className="text-amber-700">
            {hiddenByFilter} sibling{hiddenByFilter === 1 ? '' : 's'} on other transport hidden
          </span>
        )}
        {visibleIds.length > 0 && (
          <button onClick={toggleAllVisible} className="font-semibold text-emerald-800 hover:underline">
            {allVisibleSelected ? 'Clear these' : `Select all ${visibleIds.length} filtered`}
          </button>
        )}
        {selected.size > 0 && (
          <>
            <span className="font-semibold text-slate-700">{selected.size} selected</span>
            {hiddenSelected > 0 && (
              <span className="text-amber-700">({hiddenSelected} hidden by the current filter)</span>
            )}
            <button onClick={() => setSelected(new Set())} className="font-semibold text-slate-600 hover:underline">
              Clear selection
            </button>
          </>
        )}
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading families…</p>
      ) : error ? (
        // Distinguish "couldn't load" from "nothing to show" — otherwise a
        // failed request looks like a school with no families.
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="text-sm font-bold text-red-800">Could not load families</p>
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
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-sm font-semibold text-slate-700">No families yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Import the transport sheet and generate Family IDs in Setup (admin only).
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-sm font-semibold text-slate-700">No families match your search</p>
          <button
            onClick={() => { setQuery(''); setTransport('all'); setClassName(''); }}
            className="mt-2 text-xs font-semibold text-emerald-800 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all filtered families"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="h-4 w-4 accent-emerald-700"
                  />
                </th>
                <th className="px-3 py-2">Family ID</th>
                <th className="px-3 py-2">Family / parent</th>
                <th className="px-3 py-2">Students</th>
                <th className="w-10 px-3 py-2">#</th>
                <th className="px-3 py-2">Transport</th>
                <th className="w-20 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <FamilyTableRow
                  key={row.familyId}
                  row={row}
                  selected={selected.has(row.familyId)}
                  onToggle={() => toggleRow(row.familyId)}
                  onPrint={() =>
                    openPrint({
                      kind: 'families',
                      familyIds: [row.familyId],
                      label: `${displayFamilyId(row.familyId)} — ${row.studentCount} student(s)`,
                    })
                  }
                  canEdit={canEditTransport}
                  onEdit={setEditing}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditTransportDialog
        student={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSave={async (studentId, transport) => {
          await onEditTransport?.(studentId, transport);
        }}
      />

      <PrintCardsDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        students={students}
        source={dialog ?? { kind: 'students' }}
      />
    </section>
  );
}

function FamilyTableRow({
  row, selected, onToggle, onPrint, canEdit, onEdit,
}: {
  row: FamilyRow; selected: boolean; onToggle: () => void; onPrint: () => void;
  canEdit?: boolean; onEdit?: (student: Student) => void;
}) {
  return (
    <tr className={cn('border-t border-slate-100 align-top', selected && 'bg-emerald-50/60')}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={`Select ${row.displayId}`}
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 accent-emerald-700"
        />
      </td>
      <td className="px-3 py-2 font-mono font-bold text-emerald-900">{row.displayId}</td>
      <td className="px-3 py-2">
        <div className="font-medium text-slate-800">{row.parentName || '—'}</div>
        {row.parentPhone && <div className="text-slate-400">{row.parentPhone}</div>}
      </td>
      <td className="px-3 py-2">
        {row.students.map(s => (
          <div key={s.id} className="flex items-center gap-1.5">
            <span className="font-medium text-slate-700">{s.name}</span>
            <span className="rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500">
              {formatGradeLabel(s.className)}
            </span>
          </div>
        ))}
      </td>
      <td className="px-3 py-2 font-bold tabular-nums text-slate-700">{row.studentCount}</td>
      {/* Transport is PER STUDENT, aligned row-for-row with the names above,
          so a mixed family reads correctly instead of collapsing to one mode.
          The family-level summary ('Bus 9 · WALKER') stays in the header cell
          only when every child shares a single mode. */}
      <td className="px-3 py-2 text-slate-600">
        {row.students.map(s => (
          <div key={s.id} className="flex items-center gap-1.5">
            <span>{transportLabel(s.transport)}</span>
            {canEdit && onEdit && (
              <button
                onClick={() => onEdit(s)}
                aria-label={`Edit transport for ${s.name}`}
                title={`Edit transport for ${s.name}`}
                className="rounded p-0.5 text-slate-400 opacity-70 transition hover:bg-slate-100 hover:text-emerald-700 hover:opacity-100"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={onPrint}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 transition hover:border-emerald-600 hover:text-emerald-800"
        >
          <Printer className="h-3.5 w-3.5" /> Print
        </button>
      </td>
    </tr>
  );
}
