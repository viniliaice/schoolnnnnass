// Student Class Update & New Student Import — admin workflow.
//
// Upload (.xlsx exported from the school's Google Sheet) → parse & match
// (read-only) → full preview with tabs → explicit confirmation → ONE atomic
// admin-gated RPC (apply_student_class_import). No database write happens
// before the admin confirms.
//
// Authorization: route is admin-only (ROUTE_ACCESS + App switch) AND the
// commit RPC re-checks the role server-side. Hiding this page is not the
// control.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadCloud, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle, Loader2, RefreshCcw, ShieldCheck } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { cn } from '../../utils/cn';
import { getStudents, getStudentClasses } from '../../lib/db/students';
import { getClasses } from '../../lib/db/classes';
import { getAcademicYears } from '../../lib/db/academic';
import { applyStudentClassImport, checkClassImportPayload, resolveClassImportRows, assertCanImportClasses, type ClassImportApplyResult } from '../../lib/db/classImport';
import {
  parseClassImportFile, matchClassImportRows, summarizeClassImport,
  buildCommitPayload, buildClassImportTemplate, resolveRowCandidate,
  bulkResolveSingleCandidates, applyServerResolutions,
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS,
  type ClassImportRow, type ClassImportIssue, type ClassImportSummary, type ClassImportCandidate,
} from '../../lib/import/classImport';
import type { ClassImportPreflightProblem } from '../../lib/db/classImport';

/**
 * After the server preflight, move rows it says already-exist into manual
 * review (ambiguous) and exclude them from this commit, attaching the
 * existing student as a one-click candidate. This guarantees the admin
 * fixes the misclassification instead of failing the whole atomic import.
 */
function reclassifyByPreflight(rows: ClassImportRow[], problems: ClassImportPreflightProblem[]): ClassImportRow[] {
  const byGov = new Map<string, ClassImportPreflightProblem>();
  const byId = new Map<string, ClassImportPreflightProblem>();
  for (const p of problems) {
    if (p.kind === 'already_exists_gov' && p.govId) byGov.set(p.govId.toUpperCase(), p);
    if (p.kind === 'already_exists_id' && p.studentId) byId.set(p.studentId.toUpperCase(), p);
  }
  return rows.map(row => {
    if (row.status !== 'new_student') return row;
    const hit = (row.studentId.trim() && byId.get(row.studentId.trim().toUpperCase()))
      || (row.govId.trim() && byGov.get(row.govId.trim().toUpperCase()))
      || null;
    if (!hit) return row;
    const candidates = hit.existingId
      ? [{ id: hit.existingId, name: hit.existingName ?? 'Existing student', className: hit.existingClassName ?? '' }]
      : [];
    return {
      ...row,
      status: 'ambiguous',
      excluded: true,
      candidates,
      issues: [...row.issues, {
        severity: 'error' as const,
        code: 'STUDENT_ID_NOT_FOUND' as const,
        row: row.rowNumber,
        message: `${hit.message} Use “use this student” to link it, or exclude the row.`,
      }],
    };
  });
}
import { transportLabel } from '../../lib/transport';
import type { AcademicYear, Student } from '../../types';
import { CLASSES } from '../../types';

type Step = 'upload' | 'preview' | 'done';
type Tab = 'all' | 'changes' | 'new' | 'nochange' | 'review' | 'errors';

const TAB_LABELS: Record<Tab, string> = {
  all: 'All',
  changes: 'Class Changes',
  new: 'New Students',
  nochange: 'No Change',
  review: 'Needs Review',
  errors: 'Errors & Duplicates',
};

function StatusBadge({ row }: { row: ClassImportRow }) {
  const styles: Record<ClassImportRow['status'], string> = {
    class_change: 'bg-amber-100 text-amber-800',
    no_change: 'bg-emerald-100 text-emerald-800',
    new_student: 'bg-sky-100 text-sky-800',
    ambiguous: 'bg-purple-100 text-purple-800',
    unmatched: 'bg-rose-100 text-rose-800',
    invalid: 'bg-rose-100 text-rose-800',
    duplicate: 'bg-slate-200 text-slate-700',
  };
  const labels: Record<ClassImportRow['status'], string> = {
    class_change: 'Class change',
    no_change: 'No change',
    new_student: 'New student',
    ambiguous: 'Manual review',
    unmatched: 'Unmatched',
    invalid: 'Invalid',
    duplicate: 'Duplicate',
  };
  return <span className={cn('inline-block px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap', styles[row.status])}>{labels[row.status]}</span>;
}

export function ClassImport() {
  const { session } = useRole();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [loadingBase, setLoadingBase] = useState(true);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [knownClasses, setKnownClasses] = useState<string[]>([]);
  const [academicYears, setAcademicYears] = useState<AcademicYear[]>([]);
  const [selectedYearId, setSelectedYearId] = useState<string>('');

  const [fileName, setFileName] = useState<string>('');
  const [pageSize] = useState(100);
  const [tablePage, setTablePage] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [fileIssues, setFileIssues] = useState<ClassImportIssue[]>([]);
  const [rows, setRows] = useState<ClassImportRow[]>([]);
  const [tab, setTab] = useState<Tab>('all');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ClassImportApplyResult | null>(null);

  // ── Load read-only reference data (students, classes, years) ────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [allStudents, studentClasses, subjectClasses, years] = await Promise.all([
          getStudents(),
          getStudentClasses(),
          getClasses(),
          getAcademicYears(),
        ]);
        if (!mounted) return;
        setStudents(allStudents);
        // Authoritative class list = every class a loaded student is in + every
        // class with a subject assignment. Including the FULL roster (not the
        // capped getStudentClasses query) ensures a class a matched student is
        // already in (e.g. Grade 9-B, KG-B) is always valid and never reported
        // as "does not exist".
        const rosterClasses = allStudents.map(s => s.className).filter(Boolean);
        // Always include the authoritative class catalogue (CLASSES) so a real
        // class with no currently-loaded student/subject (e.g. KG-A, a new
        // section) is still valid and never reported as "does not exist".
        const classes = Array.from(new Set([...CLASSES, ...rosterClasses, ...studentClasses, ...subjectClasses, 'Graduated'])).sort();
        setKnownClasses(classes);
        setAcademicYears(years);
        const current = years.find(y => y.isCurrent);
        if (current) setSelectedYearId(current.id);
        setLoadingBase(false);
      } catch (err) {
        if (!mounted) return;
        setBaseError(err instanceof Error ? err.message : 'Failed to load students.');
        setLoadingBase(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const summary: ClassImportSummary | null = useMemo(
    () => (rows.length > 0 ? summarizeClassImport(rows) : null),
    [rows],
  );

  const tabRows = useMemo(() => {
    switch (tab) {
      case 'changes': return rows.filter(r => r.status === 'class_change');
      case 'new': return rows.filter(r => r.status === 'new_student');
      case 'nochange': return rows.filter(r => r.status === 'no_change');
      case 'review': return rows.filter(r => r.status === 'ambiguous' || r.status === 'unmatched');
      case 'errors': return rows.filter(r => r.status === 'invalid' || r.status === 'duplicate');
      default: return rows;
    }
  }, [rows, tab]);

  const studentById = useMemo(() => new Map(students.map(s => [s.id, s])), [students]);

  async function handleFile(file: File) {
    try {
      assertCanImportClasses(session?.role);
    } catch (err) {
      addToast({ type: 'error', title: 'Not allowed', description: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
      addToast({ type: 'error', title: 'Unsupported file', description: 'Please upload the Google Sheet exported as .xlsx' });
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      addToast({ type: 'error', title: 'File too large', description: `Maximum file size is ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB. Split the roster or use the generated template.` });
      return;
    }
    setParsing(true);
    setFileName(file.name);
    setStep('preview');
    setResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseClassImportFile(buffer);
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        addToast({ type: 'error', title: 'Too many rows', description: `This file has ${parsed.rows.length} student rows; the safe limit is ${MAX_IMPORT_ROWS} per import. Split it into smaller files.` });
      }
      const matched = parsed.rows.length > 0
        ? matchClassImportRows(parsed.rows, students, knownClasses)
        : [];

      // ── Authoritative server-side identity resolution ──────────────────
      // Gov ID is the school's external identifier and the sheet may have NO
      // internal Student ID column, so identity is confirmed against the live
      // database (not the downloaded roster). Existing students found by Gov
      // ID / name+phone are bound; names that exist are held for review.
      let resolved = matched;
      if (matched.length > 0) {
        try {
          const resolutions = await resolveClassImportRows(
            matched.map(r => ({
              studentId: r.studentId,
              govId: r.govId,
              name: r.name,
              parentPhone: r.parentPhone,
            })),
          );
          const applied = applyServerResolutions(matched, resolutions, knownClasses);
          resolved = applied.rows;
          if (applied.matched > 0 || applied.toReview > 0) {
            addToast({
              type: 'info',
              title: 'Identity checked against the school database',
              description: `${applied.matched} row(s) confirmed as existing students by their Gov ID/phone; ${applied.toReview} row(s) need a quick review.`,
            });
          }
        } catch {
          // Older DB without the resolver → rely on the local matcher + the
          // preflight/commit-time server guards.
        }
      }

      setTablePage(0);
      setFileIssues(parsed.issues);
      setRows(resolved);
      const firstProblem: Tab = resolved.some(r => r.status === 'class_change') ? 'changes' : 'all';
      setTab(firstProblem);
      addToast({ type: 'success', title: 'File loaded', description: `${resolved.length} rows detected — review the preview, nothing has been changed yet.` });
    } catch (err) {
      setRows([]);
      setFileIssues([{ severity: 'error', code: 'EMPTY_WORKBOOK', message: err instanceof Error ? err.message : 'Could not read this file.', row: 0 }]);
    } finally {
      setParsing(false);
    }
  }

  function toggleExclude(rowNumber: number) {
    setRows(prev => prev.map(r => (r.rowNumber === rowNumber ? { ...r, excluded: !r.excluded } : r)));
  }

  function resolveCandidate(row: ClassImportRow, candidate: ClassImportCandidate) {
    // The candidate may come from the SERVER resolver (a student that exists in
    // the live DB but is not in the browser's downloaded roster snapshot). The
    // candidate already carries id/name/class, so use it directly rather than
    // silently doing nothing when it is absent from the local map.
    const existing = studentById.get(candidate.id) ?? candidate;
    setRows(prev => prev.map(r => (r.rowNumber === row.rowNumber ? resolveRowCandidate(r, candidate, existing, knownClasses) : r)));
  }



  /**
   * One-click "accept the suggested student" for every Needs-Review row that
   * has exactly one possible match. Rows with several matches (e.g. two
   * students sharing a name) are left for a manual choice.
   */
  function acceptAllSingleSuggestions() {
    setRows(prev => {
      const result = bulkResolveSingleCandidates(prev, studentById, knownClasses);
      if (result.resolved > 0) {
        addToast({
          type: 'success',
          title: `Matched ${result.resolved} row(s)`,
          description: result.stillAmbiguous > 0 || result.conflicts > 0
            ? `${result.stillAmbiguous + result.conflicts} row(s) still need a manual choice (multiple or no matches).`
            : 'Every single-match review row was linked to its suggested student.',
        });
      } else {
        addToast({
          type: 'info',
          title: 'No single-match rows',
          description: 'The remaining Needs-Review rows each have multiple possible students (or none) and must be chosen one by one.',
        });
      }
      return result.rows;
    });
  }

  function downloadTemplate() {
    const blob = buildClassImportTemplate(students);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'student-class-import-template.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function confirmImport() {
    if (!summary) return;
    try {
      assertCanImportClasses(session?.role);
    } catch (err) {
      addToast({ type: 'error', title: 'Not allowed', description: err instanceof Error ? err.message : String(err) });
      setConfirmOpen(false);
      return;
    }
    const payload = buildCommitPayload(rows);
    if (payload.changes.length === 0 && payload.newStudents.length === 0) {
      setConfirmOpen(false);
      return;
    }
    setCommitting(true);
    try {
      // ── Authoritative preflight against the live database ──────────────
      // The preview classifies against the downloaded roster, which can be
      // incomplete. The server confirms whether each "new" student truly
      // does not exist and each change target exists; any row it flags as
      // already-existing is moved to manual review instead of failing the
      // whole atomic commit.
      let preflight;
      try {
        preflight = await checkClassImportPayload(payload.changes, payload.newStudents);
      } catch {
        preflight = null; // older DB without the RPC → fall back to commit-time guard
      }
      if (preflight && !preflight.ok) {
        const blocking = preflight.problems.filter(p =>
          ['already_exists_id', 'already_exists_gov', 'change_student_missing'].includes(p.kind));
        if (blocking.length > 0) {
          setRows(prev => reclassifyByPreflight(prev, preflight.problems));
          setConfirmOpen(false);
          addToast({
            type: 'error',
            title: `${blocking.length} row(s) already match an existing student`,
            description: 'They were moved to “Needs Review” so you can match them. No student was created and nothing was changed.',
          });
          setTab('review');
          setCommitting(false);
          return;
        }
        // Non-identity problems (bad class/transport) — surface and abort.
        setConfirmOpen(false);
        setCommitting(false);
        addToast({
          type: 'error',
          title: 'Import needs fixes before committing',
          description: preflight.problems[0]?.message ?? 'Some rows are invalid.',
        });
        return;
      }

      const importRef = `class-import-${Date.now()}`;
      const applied = await applyStudentClassImport(payload.changes, payload.newStudents, selectedYearId || null, importRef);
      setResult(applied);
      setStep('done');
      setConfirmOpen(false);
      // Refresh every roster/class cache so Bulk Upload Grades and class
      // views immediately reflect the new assignments.
      queryClient.invalidateQueries();
      addToast({
        type: 'success',
        title: 'Import committed',
        description: `${applied.updatedCount} class update(s), ${applied.createdCount} new student(s). Historical grades and attendance were preserved.`,
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Import failed — nothing was changed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setStep('upload');
    setRows([]);
    setFileIssues([]);
    setFileName('');
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const selectedYear = academicYears.find(y => y.id === selectedYearId);
  const applicable = summary ? summary.applicableChanges + summary.applicableCreates : 0;
  // Needs-Review rows that have exactly one suggested student and are not yet
  // linked — these are what the "Accept all suggested matches" button resolves.
  const reviewSingleCount = rows.filter(r => r.status === 'ambiguous' && r.candidates.length === 1).length;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Student Class Update &amp; Import</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Upload the Google Sheet export (.xlsx) to update class assignments and enrol new students.
          Nothing is changed until you confirm the preview.
        </p>
      </div>

      {/* Step indicator */}
      <ol className="flex items-center gap-2 text-sm">
        {(['upload', 'preview', 'done'] as Step[]).map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={cn(
              'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
              step === s ? 'bg-indigo-600 text-white' : (['upload', 'preview', 'done'].indexOf(step) > i ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'),
            )}>{i + 1}</span>
            <span className="text-slate-600 dark:text-slate-300 capitalize">{s === 'upload' ? 'Upload file' : s === 'preview' ? 'Review changes' : 'Confirm'}</span>
            {i < 2 && <span className="w-8 h-px bg-slate-300" />}
          </li>
        ))}
      </ol>

      {baseError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{baseError}</div>
      )}

      {/* ── Step 1: upload ──────────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4 shadow-sm">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-indigo-600" />
              <h2 className="font-semibold text-slate-900">Upload Excel file</h2>
            </div>
            <label className="block text-sm text-slate-600">
              Academic year for this update
              <select
                value={selectedYearId}
                onChange={e => setSelectedYearId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                disabled={loadingBase}
              >
                <option value="">— none —</option>
                {academicYears.map(y => (
                  <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' (current)' : ''}</option>
                ))}
              </select>
            </label>
            <label
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 hover:border-indigo-400 p-8 cursor-pointer text-center"
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
            >
              <UploadCloud className="w-8 h-8 text-slate-400" />
              <span className="text-sm font-medium text-slate-700">Choose Excel file or drop it here</span>
              <span className="text-xs text-slate-400">Accepted: .xlsx — expected columns: Student ID, Gov ID, Student Name, Current Class, Bus (route number, or NB for not on the bus)</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </label>
            {loadingBase && <p className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading current roster…</p>}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3 shadow-sm">
            <div className="flex items-center gap-2">
              <Download className="w-5 h-5 text-emerald-600" />
              <h2 className="font-semibold text-slate-900">Start from the current roster</h2>
            </div>
            <p className="text-sm text-slate-500">
              Download every student with their stable Student ID and current class, edit the
              <em> Current Class</em> column in Google Sheets / Excel (or paste new students at the
              bottom), then upload it here. Matching uses Student ID first — never names alone — so a
              student moving 7A → 7B stays the exact same record with all history intact.
            </p>
            <button
              onClick={downloadTemplate}
              disabled={loadingBase || students.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
            >
              <Download className="w-4 h-4" /> Export current students (.xlsx)
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: preview ─────────────────────────────────────────────── */}
      {step === 'preview' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-600 dark:text-slate-300">
              <span className="font-medium">{fileName}</span>
              {selectedYear && <span className="ml-2 text-slate-400">· academic year {selectedYear.name}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {reviewSingleCount > 0 && (
                <button
                  onClick={acceptAllSingleSuggestions}
                  className="inline-flex items-center gap-1 rounded-lg border border-purple-300 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 text-sm font-medium text-purple-800"
                  title="For every Needs-Review row with exactly one suggested student, click 'use this student' automatically. Rows with several possible students are left for you."
                >
                  <CheckCircle2 className="w-4 h-4" /> Accept all suggested matches ({reviewSingleCount})
                </button>
              )}
              <button onClick={reset} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                <RefreshCcw className="w-4 h-4" /> Upload another file
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={!summary || applicable === 0}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold px-4 py-1.5"
              >
                <ShieldCheck className="w-4 h-4" /> Confirm import…
              </button>
            </div>
          </div>

          {parsing && <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Parsing…</div>}

          {/* File-level issues */}
          {fileIssues.length > 0 && (
            <div className="space-y-1">
              {fileIssues.map((iss, i) => (
                <div key={i} className={cn('rounded-lg px-3 py-2 text-sm flex items-start gap-2', iss.severity === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700')}>
                  {iss.severity === 'error' ? <XCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                  {iss.message}
                </div>
              ))}
            </div>
          )}

          {/* Summary cards */}
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Rows in file', value: summary.totalRows, tone: 'text-slate-900' },
                { label: 'Matched existing', value: summary.matched, tone: 'text-slate-900' },
                { label: 'Class changes', value: summary.classChanges, tone: 'text-amber-600' },
                { label: 'No change', value: summary.noChange, tone: 'text-emerald-600' },
                { label: 'New students', value: summary.newStudents, tone: 'text-sky-600' },
                { label: 'Unmatched', value: summary.unmatched, tone: 'text-rose-600' },
                { label: 'Ambiguous', value: summary.ambiguous, tone: 'text-purple-600' },
                { label: 'Invalid / duplicate', value: summary.invalidRows + summary.duplicates, tone: 'text-rose-600' },
              ].map(card => (
                <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className={cn('text-2xl font-bold', card.tone)}>{card.value}</div>
                  <div className="text-xs text-slate-500 mt-1">{card.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Tabs */}
          {summary && (
            <div className="flex flex-wrap gap-1 border-b border-slate-200">
              {(Object.keys(TAB_LABELS) as Tab[]).map(t => {
                const count = t === 'all' ? rows.length
                  : t === 'changes' ? summary.classChanges
                  : t === 'new' ? summary.newStudents
                  : t === 'nochange' ? summary.noChange
                  : t === 'review' ? summary.ambiguous + summary.unmatched
                  : summary.invalidRows + summary.duplicates;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      'px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px',
                      tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700',
                    )}
                  >
                    {TAB_LABELS[t]} <span className="text-xs text-slate-400">({count})</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Rows table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Student ID</th>
                  <th className="px-3 py-2">Current</th>
                  <th className="px-3 py-2">Uploaded</th>
                  <th className="px-3 py-2">Bus</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {tabRows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">No rows in this view.</td></tr>
                )}
                {tabRows.slice(tablePage * pageSize, tablePage * pageSize + pageSize).map(row => (
                  <tr key={row.rowNumber} className={cn('border-b border-slate-100 align-top', row.excluded && 'opacity-50')}>
                    <td className="px-3 py-2 text-slate-400">{row.rowNumber}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{row.name || <span className="italic text-slate-400">no name</span>}</div>
                      {row.existingName && row.existingName !== row.name && (
                        <div className="text-xs text-slate-400">record: {row.existingName}</div>
                      )}
                      {row.matchedStudentId && row.matchMethod && (
                        <div className="text-[11px] font-medium text-emerald-700">
                          Matched by {row.matchMethod === 'gov_id' ? 'Gov ID'
                            : row.matchMethod === 'student_id' ? 'Student ID'
                            : row.matchMethod === 'name_phone' ? 'name + phone'
                            : 'manual review'}
                        </div>
                      )}
                      {row.status === 'new_student' && (
                        <div className="text-[11px] text-sky-700">New student — no existing record found</div>
                      )}
                      {row.issues.map((iss, i) => (
                        <div key={i} className={cn('text-xs mt-0.5', iss.severity === 'error' ? 'text-rose-600' : 'text-amber-600')}>{iss.message}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{row.studentId || row.govId || '—'}</td>
                    <td className="px-3 py-2">{row.fromClass ?? '—'}</td>
                    <td className="px-3 py-2">
                      {row.toClass ?? row.rawClass}
                      {row.status === 'class_change' && row.fromClass && row.toClass && (
                        <div className="text-xs text-amber-600">{row.fromClass} → {row.toClass}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {!row.rawBus && row.status !== 'new_student' ? (
                        <span className="text-slate-300">—</span>
                      ) : row.status === 'new_student' ? (
                        <span className="text-xs">{transportLabel(row.toTransport)}</span>
                      ) : row.parsedTransport && (() => {
                        const changed = row.fromTransport !== null
                          && transportLabel(row.parsedTransport) !== transportLabel(row.fromTransport);
                        return (
                          <>
                            <div className="text-xs">{transportLabel(row.parsedTransport)}</div>
                            {changed && <div className="text-xs text-amber-600">{transportLabel(row.fromTransport)} → {transportLabel(row.parsedTransport)}</div>}
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2"><StatusBadge row={row} /></td>
                    <td className="px-3 py-2 space-y-1 min-w-[180px]">
                      {row.status === 'new_student' && (
                        <div className="text-xs text-slate-500">Will create <span className="font-mono">{row.studentId || row.assignedId}</span></div>
                      )}
                      {row.status === 'ambiguous' && row.candidates.length > 0 && (
                        <div className="space-y-1">
                          {row.candidates.map(c => (
                            <button
                              key={c.id}
                              onClick={() => resolveCandidate(row, c)}
                              className="block w-full text-left rounded-lg border border-purple-200 bg-purple-50 hover:bg-purple-100 px-2 py-1 text-xs"
                              title={`Resolve: match this row to ${c.name}`}
                            >
                              <span className="font-medium">{c.name}</span> <span className="text-slate-500">({c.className})</span> — use this student
                            </button>
                          ))}
                        </div>
                      )}
                      {['class_change', 'new_student', 'ambiguous', 'unmatched'].includes(row.status) && (
                        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={row.excluded} onChange={() => toggleExclude(row.rowNumber)} />
                          {row.excluded ? 'Excluded from import' : 'Exclude row'}
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
                {tabRows.length > pageSize && (
                  <tr><td colSpan={8} className="px-3 py-2 text-center text-xs text-slate-400">
                    <div className="flex items-center justify-center gap-3">
                      <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        disabled={tablePage === 0}
                        onClick={() => setTablePage(p => Math.max(0, p - 1))}>Prev</button>
                      <span>Rows {tablePage * pageSize + 1}–{Math.min((tablePage + 1) * pageSize, tabRows.length)} of {tabRows.length}</span>
                      <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        disabled={(tablePage + 1) * pageSize >= tabRows.length}
                        onClick={() => setTablePage(p => p + 1)}>Next</button>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Step 3: result ──────────────────────────────────────────────── */}
      {step === 'done' && result && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            <h2 className="font-semibold text-emerald-900">Import committed successfully</h2>
          </div>
          <p className="text-sm text-emerald-800">
            {result.updatedCount} class assignment(s) updated · {result.createdCount} new student(s) created
            {result.skippedCount > 0 && <> · {result.skippedCount} row(s) already in the target class</>}.
            Historical grades and attendance were not touched. Teachers selecting the affected classes in
            <em> Bulk Upload Grades</em> will now see the updated rosters.
          </p>
          <p className="text-xs text-emerald-700">Import reference: <span className="font-mono">{result.importRef}</span></p>
          {result.changes.length > 0 && (
            <details className="text-sm text-emerald-900">
              <summary className="cursor-pointer font-medium">Applied class changes ({result.changes.length})</summary>
              <ul className="mt-2 space-y-0.5 max-h-64 overflow-y-auto">
                {result.changes.map(c => (
                  <li key={c.studentId} className="font-mono text-xs">{c.name} ({c.studentId}): {c.fromClass} → {c.toClass}</li>
                ))}
              </ul>
            </details>
          )}
          {result.created.length > 0 && (
            <details className="text-sm text-emerald-900">
              <summary className="cursor-pointer font-medium">New students ({result.created.length})</summary>
              <ul className="mt-2 space-y-0.5 max-h-64 overflow-y-auto">
                {result.created.map(c => (
                  <li key={c.studentId} className="font-mono text-xs">{c.name} ({c.studentId}) → {c.className}</li>
                ))}
              </ul>
            </details>
          )}
          <button onClick={reset} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2">
            <UploadCloud className="w-4 h-4" /> Start another import
          </button>
        </div>
      )}

      {/* ── Confirmation dialog ─────────────────────────────────────────── */}
      {summary && (
        <Dialog
          open={confirmOpen}
          onClose={() => { if (!committing) setConfirmOpen(false); }}
          title="Confirm student class import"
          description="This is the last step before the database is changed."
        >
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-1 text-amber-900">
              <p className="font-semibold">{summary.applicableChanges} student(s) will have their current class changed.</p>
              <p className="font-semibold">{summary.applicableCreates} new student(s) will be created.</p>
              {summary.excluded > 0 && <p className="text-xs">{summary.excluded} row(s) excluded or unprocessable — they will NOT be applied.</p>}
              <p className="text-xs mt-2 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> Historical grades and attendance will not be deleted or rewritten.</p>
            </div>
            <p className="text-slate-500 text-xs">
              The whole import is applied in a single transaction{selectedYear ? ` for academic year ${selectedYear.name}` : ''}. If any row fails, nothing is changed.
              Every class change is recorded in the audit log with your user and an import reference.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={committing}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void confirmImport()}
                disabled={committing || applicable === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2"
              >
                {committing && <Loader2 className="w-4 h-4 animate-spin" />}
                Confirm import
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
