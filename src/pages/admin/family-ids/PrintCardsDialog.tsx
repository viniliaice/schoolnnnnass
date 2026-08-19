// The one place every print path converges.
//
// Row "Print", "Print selected", "Print all filtered" and "Print by students"
// all open THIS dialog. It resolves the request to unique families, states
// exactly how many cards will print, discloses duplicates and skips, and only
// then builds the PDF. Printing never creates or changes a family ID.

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../../components/ui/Dialog';
import { displayFamilyId, formatGradeLabel, transportLabel } from '../../../lib/transport';
import {
  describePrintBatch, resolvePrintBatch, type PrintSource,
} from '../../../lib/print/printBatch';
import type { CardLayout } from '../../../lib/print/familyCards';
import { useCardPdf, type RestrictTo } from './useCardPdf';
import { cn } from '../../../utils/cn';
import type { Student } from '../../../types';

export type DialogSource =
  /** FAMILY PRINT — every active sibling is rendered. */
  | { kind: 'families'; familyIds: string[]; label: string }
  /**
   * STUDENT / TRANSPORT PRINT — only these students are rendered.
   * `studentIds` pre-seeds the picker (e.g. from a transport filter); omit it
   * to open the dialog with an empty manual selection.
   */
  | { kind: 'students'; studentIds?: string[]; label?: string };

interface Props {
  open: boolean;
  onClose: () => void;
  /** Full active roster — used to resolve students to families. */
  students: Student[];
  /** How the dialog was opened. */
  source: DialogSource;
}

const LAYOUTS: Array<[CardLayout, string]> = [
  ['pocket', 'Pocket'],
  ['lanyard', 'Lanyard'],
  ['placard', 'Placard (car line)'],
];

export function PrintCardsDialog({ open, onClose, students, source }: Props) {
  const [layout, setLayout] = useState<CardLayout>('pocket');
  const [withLookup, setWithLookup] = useState(false);
  const [studentQuery, setStudentQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const pdfState = useCardPdf({ layout, includeLookupList: withLookup });

  // Reset per-open state so a previous selection never leaks into a new print.
  useEffect(() => {
    if (open) {
      // A transport-filtered print arrives with its students already chosen.
      setPicked(new Set(source.kind === 'students' ? source.studentIds ?? [] : []));
      setStudentQuery('');
      pdfState.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const printSource: PrintSource = useMemo(
    () =>
      source.kind === 'families'
        ? { kind: 'families', familyIds: source.familyIds }
        : { kind: 'students', studentIds: [...picked] },
    [source, picked],
  );

  const batch = useMemo(() => resolvePrintBatch(printSource, students), [printSource, students]);
  const summary = describePrintBatch(batch, printSource);

  // Student picker list: only students who can actually produce a card, plus
  // those who cannot — shown, but flagged, never silently dropped.
  const pickable = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    return students
      .filter(s => s.transport !== 'LEFT')
      .filter(s => !q || s.name.toLowerCase().includes(q) || (s.className ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
  }, [students, studentQuery]);

  const toggle = (id: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const familyIds = batch.families.map(f => f.familyId);

  /**
   * STUDENT/TRANSPORT MODE: pin the exact students to render.
   *
   * get_family_cards() returns the complete family, so without this the
   * selection expands back to every sibling when the PDF is built. Family
   * mode passes undefined and prints everyone, which is the intended
   * behaviour there.
   */
  const restrictTo: RestrictTo | undefined = useMemo(() => {
    if (printSource.kind !== 'students') return undefined;
    const map: RestrictTo = new Map();
    for (const fam of batch.families) {
      map.set(fam.familyId, new Set(fam.students.map(s => s.id)));
    }
    return map;
  }, [printSource.kind, batch.families]);

  const canPrint = batch.cardCount > 0 && !pdfState.busy;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Print family cards"
      description={
        source.kind === 'families'
          ? source.label
          : source.label
            ? `${source.label} — only these students are printed, siblings are not added.`
            : 'Search and select students — only the students you pick are printed.'
      }
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {source.kind === 'students' && (
          <div>
            <input
              value={studentQuery}
              onChange={e => setStudentQuery(e.target.value)}
              placeholder="Search students by name or class…"
              className="mb-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
            <div className="max-h-56 overflow-auto rounded-xl border border-slate-200">
              {pickable.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">No students match that search.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {pickable.map(s => {
                    const noFamily = !s.familyId;
                    return (
                      <li key={s.id}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50',
                            noFamily && 'text-amber-800',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={picked.has(s.id)}
                            onChange={() => toggle(s.id)}
                            className="h-4 w-4 accent-emerald-700"
                          />
                          <span className="flex-1 font-medium">{s.name}</span>
                          <span className="text-xs text-slate-500">{formatGradeLabel(s.className)}</span>
                          <span className="w-28 text-right text-xs">
                            {noFamily ? (
                              <span className="font-semibold text-amber-700">no Family ID</span>
                            ) : (
                              <span className="font-mono text-emerald-800">{displayFamilyId(s.familyId)}</span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Exactly what will print */}
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm font-bold text-emerald-900">
            {batch.cardCount === 0 ? 'Nothing to print yet' : summary}
          </p>
          {batch.cardCount > 0 && (
            <p className="mt-0.5 text-xs text-emerald-800">
              {Math.ceil(batch.cardCount / (layout === 'placard' ? 1 : 4))} A4 sheet(s), front + back
            </p>
          )}
          {batch.families.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-auto text-xs text-emerald-900">
              {batch.families.map(f => (
                <li key={f.familyId}>
                  <span className="font-mono font-bold">{displayFamilyId(f.familyId)}</span>{' '}
                  · {f.students.map(s => `${s.name} (${formatGradeLabel(s.className)})`).join(', ')}
                  {' · '}
                  {[...new Set(f.students.map(s => transportLabel(s.transport)))].join(' · ')}
                  {f.omittedSiblings > 0 && (
                    <span className="ml-1 rounded bg-amber-100 px-1 font-semibold text-amber-900">
                      +{f.omittedSiblings} sibling{f.omittedSiblings === 1 ? '' : 's'} not printed
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Say the partial-family behaviour out loud: it is intended, but it
            must never be a surprise on the printed card. */}
        {batch.partialFamilies && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <b>Printing selected students only.</b> Siblings who are not part of
            this selection are left off the card. Use the family row&apos;s Print
            button to print a complete family.
          </div>
        )}

        {(batch.skippedNoFamilyId.length > 0 || batch.skippedLeft.length > 0) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {batch.skippedNoFamilyId.length > 0 && (
              <p>
                <b>{batch.skippedNoFamilyId.length} student(s) have no Family ID</b> and will be skipped:{' '}
                {batch.skippedNoFamilyId.map(s => s.name).join(', ')}. Generate IDs first (admin only).
              </p>
            )}
            {batch.skippedLeft.length > 0 && (
              <p className="mt-1">
                {batch.skippedLeft.length} student(s) marked as left were skipped.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          {LAYOUTS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={layout === value}
                onChange={() => setLayout(value)}
                className="accent-emerald-700"
              />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-slate-600">
            <input
              type="checkbox"
              checked={withLookup}
              onChange={e => setWithLookup(e.target.checked)}
              className="accent-emerald-700"
            />
            Include gate lookup list
          </label>
        </div>

        {pdfState.error && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{pdfState.error}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={() => pdfState.buildPreview(familyIds, restrictTo)}
            disabled={!canPrint}
            className="rounded-xl bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pdfState.busy ? 'Preparing…' : 'Preview'}
          </button>
          <button
            onClick={() => pdfState.download(familyIds, restrictTo)}
            disabled={!canPrint}
            className="rounded-xl bg-emerald-800 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pdfState.busy
              ? 'Preparing…'
              : `Print ${batch.cardCount} card${batch.cardCount === 1 ? '' : 's'}`}
          </button>
        </div>

        {pdfState.previewUrl && (
          <div className="rounded-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <span className="text-xs font-semibold text-slate-700">
                Preview · {layout} · {batch.cardCount} card(s)
              </span>
              <button
                onClick={pdfState.closePreview}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Close preview
              </button>
            </div>
            <iframe title="Family cards preview" src={pdfState.previewUrl} className="h-[50vh] w-full" />
          </div>
        )}
      </div>
    </Dialog>
  );
}
