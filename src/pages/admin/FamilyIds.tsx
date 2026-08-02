// Admin Family IDs page — import the transport sheet, generate family IDs,
// resolve exceptions, and print cards.
//
// IA (design review): stats row → Generate → exception buckets. States per
// the design review state table (loading / empty / error / success / partial)
// are implemented inline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PDFDownloadLink } from '@react-pdf/renderer';
import { HelpCircle, ChevronDown, Download, Upload } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { canGenerateFamilyIds } from '../../lib/routing';
import { getStudents } from '../../lib/db/students';
import {
  applyTransportImport, assignFamilyOverride, findUnattached,
  generateFamilyIds, groupStudentsByFamily, setStudentTransport,
  type GenerateSummary,
} from '../../lib/db/familyIds';
import {
  parseTransportImport, matchImportRows, summarizeImport,
  type TransportImportResult, type TransportImportRow,
} from '../../lib/import/transportImport';
import { TRANSPORT_EXAMPLE_CSV, downloadExampleWorkbook } from '../../lib/import/transportTemplate';
import { displayFamilyId, transportLabel } from '../../lib/transport';
import { buildFamilyCardData, FamilyCardsDocument, type CardLayout } from '../../lib/print/familyCards';
import { cn } from '../../utils/cn';
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
  const [helpOpen, setHelpOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  /** Shared by paste and file upload: match rows, store them, surface the summary. */
  const processImportResult = useCallback((result: TransportImportResult) => {
    const rows = matchImportRows(result.rows, students);
    setImportedRows(rows);
    const fatal = result.issues.find(i => i.severity === 'error');
    if (fatal) {
      addToast({ type: 'error', title: 'Import failed', description: fatal.message });
      return;
    }
    const s = summarizeImport(rows);
    addToast({
      type: s.unmatched + s.ambiguous > 0 ? 'info' : 'success',
      title: `${s.total} rows parsed`,
      description: `${s.matched} matched · ${s.ambiguous} ambiguous · ${s.unmatched} unmatched`,
    });
  }, [students, addToast]);

  const handleParse = () => {
    if (!importText.trim()) {
      addToast({ type: 'error', title: 'Paste the sheet export first' });
      return;
    }
    processImportResult(parseTransportImport(importText));
  };

  const handleFile = async (file: File) => {
    try {
      // .csv/.txt come through as text; Excel files as binary — the parser
      // accepts both (XLSX.read type 'string' vs 'array').
      const input = /\.(csv|txt)$/i.test(file.name) ? await file.text() : await file.arrayBuffer();
      setImportText('');
      processImportResult(parseTransportImport(input));
    } catch (err) {
      addToast({ type: 'error', title: 'Could not read file', description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleDownloadExample = () => {
    downloadExampleWorkbook();
    addToast({ type: 'success', title: 'Example workbook downloaded', description: 'Fill it in with your students, then drop it back here.' });
  };

  const handlePasteExample = () => {
    setImportText(TRANSPORT_EXAMPLE_CSV);
    addToast({ type: 'info', title: 'Example pasted', description: 'Press "Parse & match" to see how it imports.' });
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

      {/* How-to — clear directions for first-time admins (collapsible, open by default) */}
      <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5">
        <button
          onClick={() => setHelpOpen(o => !o)}
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={helpOpen}
        >
          <span className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 shrink-0 text-indigo-700" />
            <h2 className="text-base font-bold text-indigo-900">How to create family IDs — Sida loo sameeyo</h2>
          </span>
          <ChevronDown className={cn('h-5 w-5 shrink-0 text-indigo-500 transition-transform', helpOpen && 'rotate-180')} />
        </button>

        {helpOpen && (
          <div className="mt-4 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <ol className="space-y-3 text-sm leading-relaxed text-slate-700">
              <li>
                <span className="font-bold text-indigo-900">1 · Open the master sheet.</span> In Google Sheets, open the student
                transport sheet used at the office. It must have a <b>Name</b> column; <b>Grade</b>, <b>Bus</b>, <b>Gov-id</b> and
                {' '}<b>SECOND NUMBER</b> are optional but recommended. Headers are matched by name, so column order doesn't matter.
              </li>
              <li>
                <span className="font-bold text-indigo-900">2 · Export or copy.</span> In Google Sheets: <i>File → Download → Excel (.xlsx)</i>{' '}
                or <i>Comma-separated values (.csv)</i>. You can also just select the rows and copy them.
              </li>
              <li>
                <span className="font-bold text-indigo-900">3 · Upload it here.</span> Drop the file into the box in section 2 below
                (or click to browse, or paste the copied rows). Check the <b>matched / ambiguous / unmatched</b> counts, then press{' '}
                <b>Apply</b> to save the transport data.
              </li>
              <li>
                <span className="font-bold text-indigo-900">4 · Generate &amp; print.</span> Press the green{' '}
                <b>⚙ Generate / Dhali lambarrada</b> button to create the <code>MBK-####</code> IDs, then download the cards from the
                bottom <b>Print cards</b> section.
              </li>
            </ol>

            <div className="rounded-xl border border-indigo-200 bg-white p-4 text-xs">
              <p className="mb-2 font-bold text-indigo-900">Expected columns</p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1 pr-3">Column</th>
                    <th className="py-1">Example</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600">
                  <tr><td className="py-1 pr-3"><code>Name</code> <span className="font-semibold text-emerald-700">(required)</span></td><td>Xalimo Xasan Maxamed</td></tr>
                  <tr><td className="py-1 pr-3"><code>Bus</code></td><td>9 · or NB / 0 / empty = walker</td></tr>
                  <tr><td className="py-1 pr-3"><code>Grade</code></td><td>G7A, F3A …</td></tr>
                  <tr><td className="py-1 pr-3"><code>Gov-id</code></td><td>634555034</td></tr>
                  <tr><td className="py-1 pr-3"><code>SECOND NUMBER</code></td><td>+252 63 4555034</td></tr>
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={handleDownloadExample}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 px-3 py-1.5 font-semibold text-white transition hover:bg-indigo-800"
                >
                  <Download className="h-3.5 w-3.5" /> Download example (.xlsx)
                </button>
                <button
                  onClick={handlePasteExample}
                  className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 font-semibold text-indigo-800 transition hover:bg-indigo-50"
                >
                  Paste example
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Download the example to see the exact format before uploading your own file.</p>
            </div>
          </div>
        )}
      </section>

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
          Drop the Excel / CSV export below, or paste the copied rows. Columns are matched by header name — order doesn't matter.
        </p>

        {/* Drop zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
          className={cn(
            'mb-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition',
            dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50 hover:border-emerald-400 hover:bg-emerald-50/50'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.txt"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
          <Upload className="h-8 w-8 text-emerald-700" />
          <p className="text-sm font-semibold text-slate-700">Drop your Excel file here, or click to browse</p>
          <p className="text-xs text-slate-500">Supports .xlsx, .xls, .csv — or paste the rows into the box below</p>
        </div>

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
