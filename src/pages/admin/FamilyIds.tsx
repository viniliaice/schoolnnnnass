// Admin Family IDs page — import the transport sheet, generate family IDs,
// resolve exceptions, and print cards.
//
// IA (design review): stats row → Generate → exception buckets. States per
// the design review state table (loading / empty / error / success / partial)
// are implemented inline.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PDFDownloadLink } from '@react-pdf/renderer';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { canGenerateFamilyIds } from '../../lib/routing';
import { getStudents } from '../../lib/db/students';
import {
  applyTransportImport, assignFamilyOverride, findUnattached,
  generateFamilyIds, groupStudentsByFamily, setStudentTransport,
  type GenerateSummary,
} from '../../lib/db/familyIds';
import { parseTransportImport, matchImportRows, summarizeImport, type TransportImportRow } from '../../lib/import/transportImport';
import { displayFamilyId, transportLabel } from '../../lib/transport';
import { buildFamilyCardData, FamilyCardsDocument, type CardLayout } from '../../lib/print/familyCards';
import type { Student } from '../../types';

const TRANSPORT_OPTIONS = ['WALKER', 'CAR'] as const;

export function FamilyIds() {
  const { addToast } = useToast();
  const { session } = useRole();
  const canWrite = !!session && canGenerateFamilyIds(session.role);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [importText, setImportText] = useState('');
  const [importedRows, setImportedRows] = useState<TransportImportRow[]>([]);
  const [applying, setApplying] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState<GenerateSummary | null>(null);
  const [layout, setLayout] = useState<CardLayout>('pocket');
  const [withLookup, setWithLookup] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setStudents(await getStudents());
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to load students', description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { void reload(); }, [reload]);

  const groups = useMemo(() => groupStudentsByFamily(students), [students]);
  const unattached = useMemo(() => findUnattached(students), [students]);
  const families = useMemo(() => Array.from(groups.entries()), [groups]);
  const importSummary = useMemo(() => (importedRows.length ? summarizeImport(importedRows) : null), [importedRows]);

  const handleParse = () => {
    if (!importText.trim()) {
      addToast({ type: 'error', title: 'Paste the sheet export first' });
      return;
    }
    const result = parseTransportImport(importText);
    const rows = matchImportRows(result.rows, students);
    setImportedRows(rows);
    if (result.issues.some(i => i.severity === 'error')) {
      addToast({ type: 'error', title: 'Import failed', description: result.issues.find(i => i.severity === 'error')?.message });
      return;
    }
    const s = summarizeImport(rows);
    addToast({
      type: s.unmatched + s.ambiguous > 0 ? 'info' : 'success',
      title: `${s.total} rows parsed`,
      description: `${s.matched} matched · ${s.ambiguous} ambiguous · ${s.unmatched} unmatched`,
    });
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const { applied, skipped } = await applyTransportImport(importedRows);
      addToast({ type: 'success', title: `Applied ${applied} row(s)`, description: skipped ? `${skipped} skipped` : undefined });
      setImportedRows([]);
      setImportText('');
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: 'Apply failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setApplying(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await generateFamilyIds();
      setGenerateResult(result);
      addToast({
        type: 'success',
        title: `Generated ${result.familiesCreated} family ID(s)`,
        description: `${result.studentsAssigned} students assigned · ${result.totalFamilies} total families`,
      });
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: 'Generate failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setGenerating(false);
    }
  };

  const handleTransport = async (studentId: string, transport: string) => {
    try {
      await setStudentTransport(studentId, transport);
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: 'Update failed', description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleOverride = async (studentId: string) => {
    const familyId = window.prompt('Family ID to assign (e.g. 0043 — existing or new):');
    if (!familyId) return;
    try {
      await assignFamilyOverride(studentId, familyId);
      addToast({ type: 'success', title: `Assigned ${studentId} → ${displayFamilyId(familyId)}` });
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: 'Assign failed', description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Family IDs</h1>
          <p className="text-sm text-slate-500">Dismissal gate: import the transport sheet, generate MBK-#### per family, print cards.</p>
        </div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">Aqoonsiga qoyska</span>
      </div>

      {/* Stats row (IA: stats first) */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Families" value={families.length} />
        <StatCard label="Students" value={students.length} />
        <StatCard label="Unattached" value={unattached.length} tone={unattached.length ? 'warn' : 'ok'} />
        <StatCard label="Ambiguous" value={importSummary?.ambiguous ?? 0} tone={importSummary?.ambiguous ? 'warn' : 'ok'} />
      </div>

      {/* Generate */}
      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-slate-900">1 · Generate family IDs</h2>
        <p className="mb-3 text-sm text-slate-500">
          Idempotent: re-running never reassigns existing IDs. Students without a parent link or phone stay unattached.
        </p>
        <button
          onClick={handleGenerate}
          disabled={!canWrite || generating}
          title={canWrite ? undefined : 'Generate is admin-only'}
          className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {generating ? 'Generating… / Dhali…' : '⚙ Generate / Dhali lambarrada'}
        </button>
        {!canWrite && (
          <p className="mt-2 text-xs font-medium text-slate-500">Office/supervisor view is read-only — Generate is admin-only.</p>
        )}
        {generateResult && (
          <p className="mt-3 text-sm text-slate-600">
            Last run: {generateResult.familiesCreated} families created · {generateResult.studentsAssigned} students assigned ·{' '}
            {generateResult.unattached.length} unattached · {generateResult.totalFamilies} total families
          </p>
        )}
      </section>

      {/* Import */}
      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-slate-900">2 · Import the transport sheet</h2>
        <p className="mb-3 text-sm text-slate-500">
          Paste the Google Sheets export (or drop a .csv / .xlsx file). Columns are matched by header name — order doesn't matter.
        </p>
        <textarea
          value={importText}
          onChange={e => setImportText(e.target.value)}
          placeholder={'number\tGov-id\tBus\tGrade\tName\tSECOND NUMBER\t...'}
          rows={6}
          className="mb-3 w-full rounded-xl border border-slate-300 p-3 font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <button onClick={handleParse} className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900">
            Parse & match
          </button>
          {importedRows.length > 0 && canWrite && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {applying ? 'Applying…' : `Apply ${importSummary?.matched ?? 0} matched`}
            </button>
          )}
        </div>

        {importSummary && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-emerald-100 px-2 py-1 font-semibold text-emerald-800">{importSummary.matched} matched</span>
              <span className="rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-800">{importSummary.ambiguous} ambiguous</span>
              <span className="rounded-full bg-slate-200 px-2 py-1 font-semibold text-slate-700">{importSummary.unmatched} unmatched</span>
              <span className="rounded-full bg-sky-100 px-2 py-1 font-semibold text-sky-800">{importSummary.walkers} walkers</span>
              <span className="rounded-full bg-indigo-100 px-2 py-1 font-semibold text-indigo-800">{importSummary.bus} bus</span>
            </div>
            <div className="max-h-48 overflow-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Grade</th>
                    <th className="px-3 py-2">Bus</th>
                    <th className="px-3 py-2">Match</th>
                  </tr>
                </thead>
                <tbody>
                  {importedRows.slice(0, 100).map((row, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-medium">{row.name}</td>
                      <td className="px-3 py-1.5 text-slate-500">{row.gradeCode || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-500">{row.transport.kind === 'bus' ? row.transport.value : row.transport.value}</td>
                      <td className="px-3 py-1.5">
                        <span className={
                          row.match === 'matched' ? 'text-emerald-700 font-semibold'
                          : row.match === 'ambiguous' ? 'text-amber-700 font-semibold'
                          : 'text-slate-400'
                        }>
                          {row.match}{row.classMismatch ? ' ⚠' : ''}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Families */}
      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-slate-900">3 · Families</h2>
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : families.length === 0 ? (
          <p className="text-sm text-slate-500">No families yet — run Generate. Empty state: your first family ID will appear here.</p>
        ) : (
          <div className="max-h-96 overflow-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2">Family ID</th>
                  <th className="px-3 py-2">Students</th>
                  <th className="px-3 py-2">Transport</th>
                  <th className="px-3 py-2">Phone</th>
                </tr>
              </thead>
              <tbody>
                {families.map(([familyId, kids]) => (
                  <tr key={familyId} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 font-bold text-emerald-900">{displayFamilyId(familyId)}</td>
                    <td className="px-3 py-2">
                      {kids.map(k => (
                        <div key={k.id} className="flex items-center gap-2">
                          <span className="font-medium">{k.name}</span>
                          <span className="text-slate-400">{k.className}</span>
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2">
                      {kids.map(k => canWrite ? (
                        <select
                          key={k.id}
                          value={k.transport ?? ''}
                          onChange={e => handleTransport(k.id, e.target.value)}
                          className="mb-1 block rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        >
                          <option value="">—</option>
                          {TRANSPORT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <span key={k.id} className="mb-1 block text-xs font-medium text-slate-600">
                          {transportLabel(k.transport)}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{kids.find(k => k.parentPhone)?.parentPhone ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Unattached bucket */}
      <section className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="mb-1 text-base font-semibold text-amber-900">Unattached — no parent link, no phone</h2>
        <p className="mb-3 text-sm text-amber-700">These students can't be grouped automatically. Assign a family ID manually (existing or new).</p>
        {unattached.length === 0 ? (
          <p className="text-sm text-emerald-700">No unattached students 🎉</p>
        ) : (
          <ul className="divide-y divide-amber-200">
            {unattached.map(s => (
              <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                <span>{s.name} <span className="text-amber-700/70">· {s.className}</span></span>
                {canWrite && (
                  <button onClick={() => handleOverride(s.id)} className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100">
                    Assign →
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Print */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-slate-900">4 · Print cards</h2>
        <p className="mb-3 text-sm text-slate-500">Office prints: pocket (85×54), lanyard for walkers (60×90), windshield placard for car line (A5 landscape).</p>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={layout === 'pocket'} onChange={() => setLayout('pocket')} /> Pocket
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={layout === 'lanyard'} onChange={() => setLayout('lanyard')} /> Lanyard (walkers)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={layout === 'placard'} onChange={() => setLayout('placard')} /> Placard (car line)
          </label>
          <label className="flex items-center gap-1 text-slate-600">
            <input type="checkbox" checked={withLookup} onChange={e => setWithLookup(e.target.checked)} /> Include gate lookup list
          </label>
        </div>
        {families.length === 0 ? (
          <p className="text-sm text-slate-500">Generate IDs before printing.</p>
        ) : (
          <AsyncPrintLink families={families} layout={layout} withLookup={withLookup} />
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="text-xs font-medium text-slate-500">{label}</div>
    </div>
  );
}

/** Builds QR data URLs then renders the download link (loading → ready states). */
function AsyncPrintLink({ families, layout, withLookup }: { families: [string, Student[]][]; layout: CardLayout; withLookup: boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof buildFamilyCardData>> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    buildFamilyCardData(new Map(families))
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [families]);

  if (error) return <p className="text-sm text-red-600">Could not build the PDF (QR generation failed). Try again.</p>;
  if (!data) return <p className="text-sm text-slate-400">Preparing PDF…</p>;
  return (
    <PDFDownloadLink
      document={<FamilyCardsDocument families={data} layout={layout} includeLookupList={withLookup} />}
      fileName={`mbk-family-cards-${layout}.pdf`}
      className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-900"
    >
      {({ loading }) => (loading ? 'Preparing…' : `⬇ Download ${layout} cards PDF`)}
    </PDFDownloadLink>
  );
}
