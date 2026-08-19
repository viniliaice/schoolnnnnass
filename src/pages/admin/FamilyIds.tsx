// Admin Family IDs page — import the transport sheet, generate family IDs,
// resolve exceptions, and print cards.
//
// IA (design review): stats row → Generate → exception buckets. States per
// the design review state table (loading / empty / error / success / partial)
// are implemented inline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { HelpCircle, ChevronDown, Download, Upload } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { canGenerateFamilyIds } from '../../lib/routing';
import { getStudents } from '../../lib/db/students';
import {
  applyTransportImport, assignFamilyOverride, findLeftStudents, findUnattached,
  generateFamilyIds, groupStudentsByFamily, markStudentLeft, setStudentTransport,
  type GenerateSummary,
} from '../../lib/db/familyIds';
import {
  parseTransportImport, matchImportRows, summarizeImport, bucketOf,
  type ImportBucket,
  type TransportImportResult, type TransportImportRow,
} from '../../lib/import/transportImport';
import { TRANSPORT_EXAMPLE_CSV, downloadExampleWorkbook } from '../../lib/import/transportTemplate';
import { displayFamilyId, transportLabel } from '../../lib/transport';
import { FamilyCardsDocument, type CardLayout, type FamilyCardData } from '../../lib/print/familyCards';
import { getFamilyCards } from '../../lib/db/familyCards';
import { cn } from '../../utils/cn';
import type { Student } from '../../types';

const TRANSPORT_OPTIONS = ['WALKER', 'CAR'] as const;
const FAMILY_ID_PROGRESS_TARGET = 200;

const BUCKET_LABELS: Array<[ImportBucket, string]> = [
  ['nb', 'Walkers (NB / 0)'],
  ['empty', 'Empty bus cell'],
  ['bus', 'Bus riders'],
  ['other', 'Other / flagged'],
];

const ALL_BUCKETS = new Set<ImportBucket>(BUCKET_LABELS.map(([b]) => b));

/** Mock families for the sample preview — shows the card design before any real IDs exist. */
const SAMPLE_FAMILIES: FamilyCardData[] = [
  {
    familyId: '0042',
    parentName: 'Xasan Maxamed Cabdi',
    parentPhone: '+252 61 2345678',
    students: [
      { id: 's-0042-1', name: 'Xalimo Xasan Maxamed', className: 'G7A', parentId: 'p-0042', createdAt: '', transport: '9', parentPhone: '+252 61 2345678', familyId: '0042' },
      { id: 's-0042-2', name: 'Ahmed Xasan Maxamed', className: 'F3B', parentId: 'p-0042', createdAt: '', transport: '9', parentPhone: '+252 61 2345678', familyId: '0042' },
    ],
  },
  {
    familyId: '0017',
    parentName: 'Cabdiraxmaan Cali Yuusuf',
    parentPhone: '+252 68 1122334',
    students: [
      { id: 's-0017-1', name: 'Hodan Cabdiraxmaan Cali', className: 'G5A', parentId: 'p-0017', createdAt: '', transport: 'WALKER', parentPhone: '+252 68 1122334', familyId: '0017' },
    ],
  },
  {
    familyId: '0103',
    parentName: 'Cali Nuur Cumar',
    parentPhone: '+252 63 9988776',
    students: [
      { id: 's-0103-1', name: 'Yasmin Cali Nuur', className: 'G9C', parentId: 'p-0103', createdAt: '', transport: 'CAR', parentPhone: '+252 63 9988776', familyId: '0103' },
      { id: 's-0103-2', name: 'Fartuun Cali Nuur', className: 'F1A', parentId: 'p-0103', createdAt: '', transport: 'CAR', parentPhone: '+252 63 9988776', familyId: '0103' },
    ],
  },
];

export function FamilyIds() {
  const { addToast } = useToast();
  const { session } = useRole();
  const canWrite = !!session && canGenerateFamilyIds(session.role);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [importText, setImportText] = useState('');
  const [importedRows, setImportedRows] = useState<TransportImportRow[]>([]);
  const [applyBuckets, setApplyBuckets] = useState<Set<ImportBucket>>(new Set(ALL_BUCKETS));
  const [applying, setApplying] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genFilter, setGenFilter] = useState('all');
  const [generateResult, setGenerateResult] = useState<GenerateSummary | null>(null);
  const [layout, setLayout] = useState<CardLayout>('pocket');
  const [withLookup, setWithLookup] = useState(true);
  const [printFilter, setPrintFilter] = useState('all');
  const [helpOpen, setHelpOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await getStudents();
      setStudents(loaded);
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to load students', description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { void reload(); }, [reload]);

  const groups = useMemo(() => groupStudentsByFamily(students), [students]);
  const unattached = useMemo(() => findUnattached(students), [students]);
  const leftStudents = useMemo(() => findLeftStudents(students), [students]);
  const families = useMemo(() => Array.from(groups.entries()), [groups]);
  const familyProgress = useMemo(() => {
    const current = families.length;
    const percent = Math.min(100, Math.round((current / FAMILY_ID_PROGRESS_TARGET) * 100));
    return { current, target: FAMILY_ID_PROGRESS_TARGET, percent };
  }, [families.length]);
  /** Print-batch filter: families whose (first) student matches the transport bucket. */
  const filteredFamilies = useMemo(() => {
    if (printFilter === 'all') return families;
    const match = (t: string | null | undefined) => {
      if (printFilter === 'bus') return /^\d+$/.test(t ?? '');
      if (printFilter === 'walker') return t === 'WALKER' || t === 'CAR';
      if (printFilter === 'empty') return !t || t === '';
      return true;
    };
    return families.filter(([, students]) => match(students[0]?.transport));
  }, [families, printFilter]);
  const importSummary = useMemo(() => (importedRows.length ? summarizeImport(importedRows) : null), [importedRows]);
  /** Matched-row count per bucket, for the Apply-only chips. */
  const bucketCounts = useMemo(() => {
    const counts: Record<ImportBucket, number> = { nb: 0, empty: 0, bus: 0, other: 0 };
    for (const row of importedRows) {
      if (row.match === 'matched') counts[bucketOf(row.busRaw)] += 1;
    }
    return counts;
  }, [importedRows]);

  /** Unassigned students per transport bucket, for the generate-filter dropdown counts. */
  const genCounts = useMemo(() => {
    const candidates = students.filter(s => !s.familyId && s.transport !== 'LEFT');
    return {
      all: candidates.length,
      bus: candidates.filter(s => /^\d+$/.test(s.transport ?? '')).length,
      walker: candidates.filter(s => s.transport === 'WALKER' || s.transport === 'CAR').length,
      empty: candidates.filter(s => !s.transport || s.transport === '').length,
    };
  }, [students]);

  const toggleBucket = (bucket: ImportBucket) => {
    setApplyBuckets(prev => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket); else next.add(bucket);
      return next;
    });
  };

  /** Shared by paste and file upload: match rows, store them, surface the summary. */
  const processImportResult = useCallback((result: TransportImportResult) => {
    console.log('[family-ids] parse result', {
      headers: result.headers,
      mappedHeaders: result.mappedHeaders,
      issues: result.issues.map(i => ({ code: i.code, row: i.row })),
    });
    const rows = matchImportRows(result.rows, students);
    console.log('[family-ids] match result', rows.slice(0, 20).map(r => ({ name: r.name, match: r.match, studentId: r.studentId, classMismatch: r.classMismatch })));
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
    console.log('[family-ids] parse clicked', { chars: importText.length, preview: importText.slice(0, 300) });
    processImportResult(parseTransportImport(importText));
  };

  const handleFile = async (file: File) => {
    try {
      console.log('[family-ids] file selected', { name: file.name, size: file.size, type: file.type });
      // .csv/.txt come through as text; Excel files as binary — the parser
      // accepts both (XLSX.read type 'string' vs 'array').
      const input = /\.(csv|txt)$/i.test(file.name) ? await file.text() : await file.arrayBuffer();
      setImportText('');
      processImportResult(parseTransportImport(input));
    } catch (err) {
      console.error('[family-ids] file read failed', err);
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
      console.log('[family-ids] apply clicked', { rows: importedRows.length, buckets: Array.from(applyBuckets) });
      const { applied, skipped, errors } = await applyTransportImport(importedRows, applyBuckets);
      console.log('[family-ids] apply returned', { applied, skipped, errors });
      if (errors.length > 0) {
        // Surface the real per-row failures instead of a silent "0 applied".
        const sample = errors.slice(0, 3).join(' · ');
        addToast({
          type: 'error',
          title: `Applied ${applied} of ${importedRows.length} row(s)`,
          description: `${skipped} skipped — ${sample}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
        });
      } else {
        addToast({ type: 'success', title: `Applied ${applied} row(s)`, description: skipped ? `${skipped} skipped` : undefined });
      }
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
      const result = await generateFamilyIds(genFilter);
      setGenerateResult(result);
      addToast({
        type: 'success',
        title: `Generated ${result.familiesCreated} family ID(s)`,
        description: [
          `${result.studentsAssigned} students assigned`,
          // Siblings enrolling later join the family's existing MBK number
          // instead of being issued a second one.
          result.studentsJoined ? `${result.studentsJoined} joined an existing family` : null,
          `${result.totalFamilies} total families`,
        ].filter(Boolean).join(' · '),
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
    const familyId = window.prompt('Family ID to assign (exactly 4 digits, e.g. 0043 — existing or new):');
    if (!familyId) return;
    try {
      await assignFamilyOverride(studentId, familyId);
      addToast({ type: 'success', title: `Assigned ${studentId} → ${displayFamilyId(familyId)}` });
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: 'Assign failed', description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleMarkLeft = async (student: Student, left: boolean) => {
    try {
      await markStudentLeft(student.id, left);
      addToast({
        type: 'success',
        title: left ? `Marked ${student.name} as left` : `Restored ${student.name}`,
        description: left
          ? 'Removed from families and gate cards. Their family ID is kept for when they return.'
          : 'Restored to their original family ID.',
      });
      await reload();
    } catch (err) {
      addToast({ type: 'error', title: left ? 'Mark failed' : 'Restore failed', description: err instanceof Error ? err.message : undefined });
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
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Families" value={families.length} />
        <StatCard label="Students" value={students.length} />
        <StatCard label="Unattached" value={unattached.length} tone={unattached.length ? 'warn' : 'ok'} />
        <StatCard label="Ambiguous" value={importSummary?.ambiguous ?? 0} tone={importSummary?.ambiguous ? 'warn' : 'ok'} />
      </div>
      <FamilyProgressBar current={familyProgress.current} target={familyProgress.target} percent={familyProgress.percent} />

      {/* Generate */}
      <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-slate-900">1 · Generate family IDs</h2>
        <p className="mb-3 text-sm text-slate-500">
          Idempotent: re-running never reassigns existing IDs. Pick a transport group to generate only those students, or "All" for everything.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={genFilter}
            onChange={e => setGenFilter(e.target.value)}
            disabled={!canWrite || generating}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-800 disabled:opacity-50"
          >
            <option value="all">All students ({genCounts.all})</option>
            <option value="bus">Bus riders ({genCounts.bus})</option>
            <option value="walker">Walking ({genCounts.walker})</option>
            <option value="empty">Empty transport ({genCounts.empty})</option>
          </select>
          <button
            onClick={handleGenerate}
            disabled={!canWrite || generating || genCounts[genFilter as keyof typeof genCounts] === 0}
            title={canWrite ? undefined : 'Generate is admin-only'}
            className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? 'Generating… / Dhali…' : `⚙ Generate / Dhali lambarrada`}
          </button>
        </div>
        {!canWrite && (
          <p className="mt-2 text-xs font-medium text-slate-500">Office/supervisor view is read-only — Generate is admin-only.</p>
        )}
        {generateResult && (
          <p className="mt-3 text-sm text-slate-600">
            Last run: {generateResult.familiesCreated} families created ·{' '}
            {generateResult.studentsAssigned} students assigned ·{' '}
            {generateResult.studentsJoined ? <>{generateResult.studentsJoined} joined an existing family · </> : null}
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
        {importedRows.length > 0 && canWrite && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-slate-600">Apply only:</span>
            {BUCKET_LABELS.map(([bucket, label]) => {
              const count = bucketCounts[bucket];
              const on = applyBuckets.has(bucket);
              return (
                <label
                  key={bucket}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition',
                    on ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-white text-slate-500'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={count === 0}
                    onChange={() => toggleBucket(bucket)}
                    className="h-3.5 w-3.5 accent-emerald-700"
                  />
                  {label} <span className={cn('rounded-full px-1.5', on ? 'bg-emerald-200' : 'bg-slate-200')}>{count}</span>
                </label>
              );
            })}
          </div>
        )}
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
        <p className="mb-3 text-sm text-amber-700">These students can't be grouped automatically. Assign a family ID manually (existing or new), or mark as left if they've left the school.</p>
        {unattached.length === 0 ? (
          <p className="text-sm text-emerald-700">No unattached students 🎉</p>
        ) : (
          <ul className="divide-y divide-amber-200">
            {unattached.map(s => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{s.name} <span className="text-amber-700/70">· {s.className}</span></span>
                <span className="flex shrink-0 gap-2">
                  {canWrite && (
                    <button
                      onClick={() => handleMarkLeft(s, true)}
                      className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      title="They left the school — removes from families and gate cards"
                    >
                      Mark as left
                    </button>
                  )}
                  {canWrite && (
                    <button onClick={() => handleOverride(s.id)} className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100">
                      Assign →
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Marked as left */}
      <section className="mb-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-colors">
        <button
          type="button"
          onClick={() => setLeftOpen(open => !open)}
          className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50"
          aria-expanded={leftOpen}
        >
          <ChevronDown className={cn(
            'h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200 ease-out',
            leftOpen && 'rotate-180'
          )} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-900">Marked as left</h2>
            <p className="mt-0.5 text-sm text-slate-500">No gate card while away. Restoring returns them to the same family ID.</p>
          </div>
          <span className="shrink-0 rounded-full bg-rose-100 px-3 py-1 text-xs font-bold text-rose-700">
            {leftStudents.length}
          </span>
        </button>

        {leftOpen && (
          <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-4">
            {leftStudents.length === 0 ? (
              <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">No students marked as left.</p>
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {leftStudents.map(s => (
                  <li key={s.id} className="flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="font-medium text-slate-800">{s.name} <span className="font-normal text-slate-500">· {s.className}</span></span>
                    {canWrite && (
                      <button
                        onClick={() => handleMarkLeft(s, false)}
                        className="min-h-10 shrink-0 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                      >
                        Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Print */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-slate-900">4 · Print cards</h2>
        <p className="mb-3 text-sm text-slate-500">Office prints: pocket &amp; lanyard (60×90 — fits the 65×95 pouch film), windshield placard for car line (A5 landscape). Pick a group to print only those, or "All". Each card prints FRONT + BACK for duplex lamination; back rows are mirrored for long-edge flip.</p>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5 text-slate-700">
            <span className="font-medium text-slate-600">Which students:</span>
            <select
              value={printFilter}
              onChange={e => setPrintFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800"
            >
              <option value="all">All students ({families.length})</option>
              <option value="bus">Bus riders</option>
              <option value="walker">Walking (WALKER / CAR)</option>
              <option value="empty">Empty transport</option>
            </select>
            <span className="text-xs text-slate-400">{filteredFamilies.length} of {families.length} families</span>
          </label>
        </div>
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
        {families.length === 0 && (
          <p className="text-sm text-slate-500">Generate IDs before printing — or use the sample preview below to see the card design first.</p>
        )}
        {filteredFamilies.length === 0 && families.length > 0 && (
          <p className="text-sm text-slate-500">No families match this group.</p>
        )}
        <AsyncPrintLink families={filteredFamilies} layout={layout} withLookup={withLookup} />
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

function FamilyProgressBar({ current, target, percent }: { current: number; target: number; percent: number }) {
  return (
    <section className="mb-6 rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white p-4 shadow-sm" aria-label="Family ID progress">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-emerald-950">Family ID progress</h2>
          <p className="text-xs text-emerald-700">Target: print and verify {target} family IDs.</p>
        </div>
        <div className="text-right">
          <div className="text-lg font-black tabular-nums text-emerald-900">{current} of {target}</div>
          <div className="text-xs font-semibold text-emerald-700">{percent}% complete</div>
        </div>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-emerald-100" role="progressbar" aria-valuenow={Math.min(current, target)} aria-valuemin={0} aria-valuemax={target} aria-label={`${current} of ${target} family IDs`}>
        <div className="h-full rounded-full bg-emerald-700 transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}

/** Lazily builds the family-card PDF only when staff preview/download. */
function AsyncPrintLink({ families, layout, withLookup }: { families: [string, Student[]][]; layout: CardLayout; withLookup: boolean }) {
  const [data, setData] = useState<FamilyCardData[] | null>(null);
  const [error, setError] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIsSample, setPreviewIsSample] = useState(false);
  const pdfBlobRef = useRef<Blob | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = true;
    setData(null);
    setError(false);
    pdfBlobRef.current = null;
  }, [families]);

  useEffect(() => {
    pdfBlobRef.current = null;
  }, [layout, withLookup]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const getCardData = async () => {
    if (data) return data;
    // Card content comes from get_family_cards(), NOT from the RLS-scoped
    // student list the table is rendered from. A supervisor only sees their
    // assigned classes, and only admins can read profiles, so building cards
    // client-side printed rosters missing siblings and a blank parent name.
    // The RPC returns the complete family for every gate role.
    const built = await getFamilyCards(families.map(([familyId]) => familyId));
    if (!cancelledRef.current) setData(built);
    return built;
  };

  const buildPdf = async (fams: FamilyCardData[]) => {
    const blob = await pdf(
      <FamilyCardsDocument families={fams} layout={layout} includeLookupList={withLookup} />
    ).toBlob();
    return blob;
  };

  const openPreview = (blob: Blob, isSample: boolean) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewIsSample(isSample);
    setPreviewUrl(URL.createObjectURL(blob));
    setPreviewOpen(true);
  };

  const handleSamplePreview = async () => {
    if (previewing || preparing) return;
    setPreviewing(true);
    cancelledRef.current = false;
    try {
      const blob = await buildPdf(SAMPLE_FAMILIES);
      if (cancelledRef.current) return;
      openPreview(blob, true);
    } catch {
      if (!cancelledRef.current) setError(true);
    } finally {
      if (!cancelledRef.current) setPreviewing(false);
    }
  };

  const handlePreview = async () => {
    if (previewing || preparing || families.length === 0) return;
    setPreviewing(true);
    cancelledRef.current = false;
    try {
      const cardData = await getCardData();
      if (!pdfBlobRef.current) pdfBlobRef.current = await buildPdf(cardData);
      if (cancelledRef.current) return;
      openPreview(pdfBlobRef.current, false);
    } catch {
      if (!cancelledRef.current) setError(true);
    } finally {
      if (!cancelledRef.current) setPreviewing(false);
    }
  };

  const handlePrepare = async () => {
    if (preparing || previewing || families.length === 0) return;
    setPreparing(true);
    cancelledRef.current = false;
    try {
      const cardData = await getCardData();
      if (!pdfBlobRef.current) pdfBlobRef.current = await buildPdf(cardData);
      if (cancelledRef.current) return; // stopped — discard the blob
      const url = URL.createObjectURL(pdfBlobRef.current);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mbk-family-cards-${layout}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      if (!cancelledRef.current) setError(true);
    } finally {
      if (!cancelledRef.current) setPreparing(false);
    }
  };

  const handleClosePreview = () => {
    setPreviewOpen(false);
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
  };

  if (error) return <p className="text-sm text-red-600">Could not build the PDF. Try again.</p>;
  const hasReal = families.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleSamplePreview}
          disabled={previewing || preparing}
          className="rounded-xl bg-indigo-700 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {previewing ? 'Preparing sample…' : '👁 Sample — front & back'}
        </button>
        {hasReal && (
          <>
            <button
              onClick={handlePreview}
              disabled={previewing || preparing}
              className="rounded-xl bg-slate-700 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewing ? 'Preparing preview…' : '👁 Preview'}
            </button>
            <button
              onClick={handlePrepare}
              disabled={preparing || previewing}
              className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preparing ? 'Preparing…' : `⬇ Download ${layout} cards PDF`}
            </button>
          </>
        )}
      </div>
      {previewOpen && previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={handleClosePreview}>
          <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-slate-800">
                  {previewIsSample ? 'Sample — mock data' : 'Preview'} · {layout} cards · front + back
                </h3>
                <a
                  href={previewUrl}
                  download={`mbk-family-cards-${layout}.pdf`}
                  className="rounded-lg bg-emerald-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-900"
                >
                  ⬇ Download
                </a>
              </div>
              <button
                onClick={handleClosePreview}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <iframe title="Family cards preview" src={previewUrl} className="w-full flex-1" />
          </div>
        </div>
      )}
    </div>
  );
}
