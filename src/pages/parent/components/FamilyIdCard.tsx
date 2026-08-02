// M3 — Family ID card on the parent dashboard.
//
// Shows the logged-in parent's OWN family ID + kids (same visual treatment as
// the GateScreen "found" state: green panel, large MBK-####), with a
// download/print action reusing the M1 @react-pdf/renderer card component
// (pocket layout, pre-filled to this family only).
//
// Pending state: if Generate hasn't run for this family yet (no familyId),
// show a clear "coming soon" panel instead of a broken/empty card.
//
// The component is presentational — data comes from the parent dashboard via
// getParentFamilyCard() (parentId-scoped; RLS enforces own-family-only).

import { useEffect, useMemo, useState } from 'react';
import { PDFDownloadLink } from '@react-pdf/renderer';
import { displayFamilyId } from '../../../lib/transport';
import { buildFamilyCardData, FamilyCardsDocument } from '../../../lib/print/familyCards';
import type { Student } from '../../../types';

export type FamilyCardState =
  | { status: 'loading' }
  | { status: 'pending'; students: Student[] }
  | { status: 'ready'; familyId: string; students: Student[] };

/** Pure status classifier — used by the render tests. */
export function classifyFamilyCard(
  loading: boolean,
  familyId: string | null,
  students: Student[],
): FamilyCardState {
  if (loading) return { status: 'loading' };
  if (!familyId) return { status: 'pending', students };
  return { status: 'ready', familyId, students };
}

export function FamilyIdCard({ state }: { state: FamilyCardState }) {
  const [qrData, setQrData] = useState<Awaited<ReturnType<typeof buildFamilyCardData>> | null>(null);
  const [qrError, setQrError] = useState(false);

  const readyStudents = useMemo(
    () => (state.status === 'ready' || state.status === 'pending' ? state.students : []),
    [state],
  );

  const familyId = state.status === 'ready' ? state.familyId : null;

  useEffect(() => {
    let cancelled = false;
    setQrData(null);
    setQrError(false);
    if (!familyId) return;
    const group = new Map<string, Student[]>([[familyId, readyStudents]]);
    buildFamilyCardData(group)
      .then(d => { if (!cancelled) setQrData(d); })
      .catch(() => { if (!cancelled) setQrError(true); });
    return () => { cancelled = true; };
  }, [familyId, readyStudents]);

  if (state.status === 'loading') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-400">Loading your family ID…</p>
      </div>
    );
  }

  if (state.status === 'pending') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6" role="status">
        <div className="text-lg font-bold text-amber-900">Your Family ID is on the way</div>
        <p className="mt-1 text-sm text-amber-700">
          The school hasn't generated family IDs yet. Once it does, your family ID and printable card will appear here.
        </p>
        {state.students.length > 0 && (
          <p className="mt-2 text-xs text-amber-600">
            {state.students.length} child{state.students.length === 1 ? '' : 'ren'} linked to your account.
          </p>
        )}
      </div>
    );
  }

  // ready
  return (
    <div className="rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-6">
      <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-emerald-900">
        <span aria-hidden>✓</span> Your Family ID
      </div>
      <div className="mt-2 font-mono text-5xl font-black tracking-widest text-emerald-950">
        {displayFamilyId(state.familyId)}
      </div>

      <div className="mt-4 space-y-2">
        {state.students.map(s => (
          <div key={s.id} className="flex items-center justify-between rounded-xl border border-emerald-200 bg-white p-3">
            <div>
              <div className="font-bold text-slate-900">{s.name}</div>
              <div className="text-sm text-slate-500">{s.className}</div>
            </div>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800">
              {s.transport === 'WALKER' ? 'WALKER' : s.transport === 'CAR' ? 'CAR' : s.transport ? `Bus ${s.transport}` : '—'}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4">
        {qrError ? (
          <p className="text-sm text-red-600">Could not build the card PDF (QR generation failed). Try again.</p>
        ) : qrData ? (
          <PDFDownloadLink
            document={<FamilyCardsDocument families={qrData} layout="pocket" includeLookupList={false} />}
            fileName={`mbk-family-card-${state.familyId}.pdf`}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-emerald-800 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-900"
          >
            {({ loading }) => (loading ? 'Preparing…' : '⬇ Download / print my card')}
          </PDFDownloadLink>
        ) : (
          <p className="text-sm text-slate-500">Preparing your card…</p>
        )}
        <p className="mt-2 text-xs text-emerald-800/70">
          Keep this card for pickup — gate staff scan or type {displayFamilyId(state.familyId)}.
        </p>
      </div>
    </div>
  );
}
