// Former Students directory — admin only.
//
// Everything the cleanup produced lives here:
//   * search former students by name or System ID, filter by their last class
//   * see WHEN they were marked former and BY WHOM (plus the source file/import)
//   * restore one to Active (exact previous transport is put back, never guessed)
//   * open the preserved historical record + full status ledger
//   * browse the import history ("Import #12 — uploaded 486, exact matches 452 …")
//     and roll a whole import back
//
// Reads go through admin-gated RPCs (list_former_students,
// list_former_student_imports, get_former_student_import) so the RLS on the new
// audit tables is never relied on from the browser.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, UserMinus, RotateCcw, ShieldCheck, History, FileSpreadsheet, AlertTriangle,
  Loader2, CheckCircle2, XCircle, ChevronDown, ChevronUp, Info, Users,
} from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { cn } from '../../utils/cn';
import {
  getFormerStudentImport,
  listFormerStudentImports,
  listFormerStudents,
  rollbackFormerStudentImport,
  setStudentFormerStatus,
  statusChangeReasonLabel,
  actionTakenLabel,
  matchStatusLabel,
  getStudentStatusHistory,
  FORMER_STUDENT_ROLLBACK_PHRASE,
  type FormerStudentImportRecord,
  type FormerStudentImportRowRecord,
  type FormerStudentRecord,
  type StudentStatusChange,
} from '../../lib/db/formerStudents';

type Tab = 'students' | 'imports';

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ImportStatusBadge({ status }: { status: FormerStudentImportRecord['status'] }) {
  if (status === 'applied') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200"><CheckCircle2 className="w-3.5 h-3.5" /> Applied</span>;
  }
  if (status === 'rolled_back') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200"><RotateCcw className="w-3.5 h-3.5" /> Rolled back</span>;
  }
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200"><AlertTriangle className="w-3.5 h-3.5" /> Partly rolled back</span>;
}

export function FormerStudents() {
  const { session } = useRole();
  const { addToast } = useToast();
  const role = session?.role ?? null;
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState<Tab>('students');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Directory
  const [students, setStudents] = useState<FormerStudentRecord[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const pageSize = 25;

  // Import history
  const [imports, setImports] = useState<FormerStudentImportRecord[]>([]);
  const [importTotal, setImportTotal] = useState(0);
  const [expandedImport, setExpandedImport] = useState<string | null>(null);
  const [importRows, setImportRows] = useState<FormerStudentImportRowRecord[]>([]);
  const [importRowsLoading, setImportRowsLoading] = useState(false);

  // Dialogs
  const [restoreTarget, setRestoreTarget] = useState<FormerStudentRecord | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [profileTarget, setProfileTarget] = useState<FormerStudentRecord | null>(null);
  const [profileHistory, setProfileHistory] = useState<StudentStatusChange[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<FormerStudentImportRecord | null>(null);
  const [rollbackPhrase, setRollbackPhrase] = useState('');
  const [rollingBack, setRollingBack] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadStudents = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listFormerStudents({
        search: debouncedSearch,
        className: classFilter === 'all' ? null : classFilter,
        limit: pageSize,
        offset: page * pageSize,
      });
      setStudents(res.students);
      setTotal(res.total);
      setClasses(res.classes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load former students.');
      setStudents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, debouncedSearch, classFilter, page]);

  const loadImports = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await listFormerStudentImports(50, 0);
      setImports(res.imports);
      setImportTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the import history.');
    }
  }, [isAdmin]);

  useEffect(() => { void loadStudents(); }, [loadStudents]);
  useEffect(() => { if (tab === 'imports') void loadImports(); }, [tab, loadImports]);
  useEffect(() => { setPage(0); }, [debouncedSearch, classFilter]);

  const openProfile = useCallback(async (record: FormerStudentRecord) => {
    setProfileTarget(record);
    setProfileHistory([]);
    try {
      setProfileHistory(await getStudentStatusHistory(record.id));
    } catch {
      setProfileHistory([]);
    }
  }, []);

  const toggleImportRows = useCallback(async (importId: string) => {
    if (expandedImport === importId) {
      setExpandedImport(null);
      setImportRows([]);
      return;
    }
    setExpandedImport(importId);
    setImportRowsLoading(true);
    try {
      const res = await getFormerStudentImport(importId, 500, 0);
      setImportRows(res.rows);
    } catch (err) {
      setImportRows([]);
      addToast({ type: 'error', title: 'Could not load the import rows', description: err instanceof Error ? err.message : undefined });
    } finally {
      setImportRowsLoading(false);
    }
  }, [expandedImport, addToast]);

  const doRestore = useCallback(async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await setStudentFormerStatus(restoreTarget.id, 'active', restoreReason.trim() || 'Restored from the Former Students page');
      addToast({
        type: 'success',
        title: res.changed ? `${restoreTarget.name} is active again` : 'Nothing changed',
        description: res.changed
          ? 'Their previous bus/transport setting was put back and every historical record is intact.'
          : 'This student was already active.',
      });
      setRestoreTarget(null);
      setRestoreReason('');
      await loadStudents();
    } catch (err) {
      addToast({ type: 'error', title: 'Could not restore this student', description: err instanceof Error ? err.message : undefined });
    } finally {
      setRestoring(false);
    }
  }, [restoreTarget, restoreReason, addToast, loadStudents]);

  const doRollback = useCallback(async () => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      const res = await rollbackFormerStudentImport(rollbackTarget.id, rollbackPhrase);
      addToast({
        type: 'success',
        title: `Import #${rollbackTarget.importNumber} rolled back`,
        description: `${res.restored} student(s) restored to their previous status${res.skipped > 0 ? `, ${res.skipped} skipped because their status changed afterwards` : ''}.`,
      });
      setRollbackTarget(null);
      setRollbackPhrase('');
      await Promise.all([loadImports(), loadStudents()]);
    } catch (err) {
      addToast({ type: 'error', title: 'Rollback failed', description: err instanceof Error ? err.message : undefined });
    } finally {
      setRollingBack(false);
    }
  }, [rollbackTarget, rollbackPhrase, addToast, loadImports, loadStudents]);

  const pages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="max-w-xl mx-auto bg-white rounded-2xl border border-red-200 p-6 text-center">
          <ShieldCheck className="w-10 h-10 text-red-500 mx-auto" />
          <h2 className="text-lg font-bold text-slate-900 mt-3">Administrators only</h2>
          <p className="text-sm text-slate-600 mt-2">
            Former student records and their audit trail are restricted to administrators, in the app and in the database.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">Former Students</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200">
              <Users className="w-3.5 h-3.5" /> {total} record{total === 1 ? '' : 's'}
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Students who left the school. Nothing here was deleted — marks, attendance, payments, parent links and
            historical classes are all preserved. Restore anyone to Active at any time.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/admin/student-cleanup"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
          >
            <FileSpreadsheet className="w-4 h-4" /> New cleanup import
          </a>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex gap-2 border-b border-slate-200">
        {([
          ['students', 'Former Students', UserMinus],
          ['imports', `Import History${importTotal > 0 ? ` (${importTotal})` : ''}`, History],
        ] as Array<[Tab, string, typeof UserMinus]>).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-colors',
              tab === key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700',
            )}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <p className="text-sm text-red-800 break-words">{error}</p>
        </div>
      )}

      {/* ── Directory ────────────────────────────────────────────────────── */}
      {tab === 'students' && (
        <>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, System ID or Gov ID…"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <select
              value={classFilter}
              onChange={e => setClassFilter(e.target.value)}
              className="px-3 py-2.5 rounded-xl border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 lg:w-64"
            >
              <option value="all">All previous classes ({classes.length})</option>
              {classes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              onClick={() => void loadStudents()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Refresh
            </button>
          </div>

          {loading ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500 shadow-sm">
              <Loader2 className="w-6 h-6 animate-spin mx-auto text-indigo-500" />
              <p className="mt-2">Loading former students…</p>
            </div>
          ) : students.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center shadow-sm">
              <UserMinus className="w-9 h-9 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-700 mt-3">No former students yet</p>
              <p className="text-xs text-slate-500 mt-1">
                Upload the school's list of leavers from <a className="text-indigo-600 font-semibold" href="/admin/student-cleanup">Student Cleanup</a>.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Desktop */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-bold px-4 py-3">Student</th>
                      <th className="text-left font-bold px-4 py-3">System ID</th>
                      <th className="text-left font-bold px-4 py-3">Last Class</th>
                      <th className="text-left font-bold px-4 py-3">Parent</th>
                      <th className="text-left font-bold px-4 py-3">Marked Former</th>
                      <th className="text-left font-bold px-4 py-3">By</th>
                      <th className="text-left font-bold px-4 py-3">Source</th>
                      <th className="text-right font-bold px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {students.map(s => (
                      <tr key={s.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-900">{s.name}</p>
                          {s.govId && <p className="text-[11px] text-slate-400 font-mono">Gov {s.govId}</p>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600 break-all">{s.id}</td>
                        <td className="px-4 py-3 text-slate-700">{s.className}</td>
                        <td className="px-4 py-3 text-slate-700">
                          {s.parentName ?? <span className="text-slate-400">—</span>}
                          {s.parentPhone && <span className="block text-[11px] text-slate-400">{s.parentPhone}</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{formatDate(s.markedFormerAt)}</td>
                        <td className="px-4 py-3 text-slate-700">{s.markedFormerByName ?? <span className="text-slate-400">—</span>}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {s.lastChange ? statusChangeReasonLabel(s.lastChange.reason) : '—'}
                          {s.lastChange?.fileName && <span className="block text-[11px] text-slate-400 break-all">{s.lastChange.fileName}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => void openProfile(s)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                            >
                              <History className="w-3.5 h-3.5" /> History
                            </button>
                            <button
                              onClick={() => { setRestoreTarget(s); setRestoreReason(''); }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              <RotateCcw className="w-3.5 h-3.5" /> Restore
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="lg:hidden divide-y divide-slate-100">
                {students.map(s => (
                  <div key={s.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 truncate">{s.name}</p>
                        <p className="font-mono text-[11px] text-slate-500 break-all">{s.id}</p>
                      </div>
                      <span className="inline-flex px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                        {s.className}
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                      <div><dt className="text-slate-400 font-semibold">Marked former</dt><dd>{formatDate(s.markedFormerAt)}</dd></div>
                      <div><dt className="text-slate-400 font-semibold">By</dt><dd>{s.markedFormerByName ?? '—'}</dd></div>
                      <div><dt className="text-slate-400 font-semibold">Parent</dt><dd className="truncate">{s.parentName ?? '—'}</dd></div>
                      <div><dt className="text-slate-400 font-semibold">Source</dt><dd className="truncate">{s.lastChange ? statusChangeReasonLabel(s.lastChange.reason) : '—'}</dd></div>
                    </dl>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => void openProfile(s)}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg text-xs font-bold border border-slate-300 bg-white text-slate-700"
                      >
                        <History className="w-3.5 h-3.5" /> History
                      </button>
                      <button
                        onClick={() => { setRestoreTarget(s); setRestoreReason(''); }}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg text-xs font-bold bg-emerald-600 text-white"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Restore
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {pages > 1 && (
                <div className="flex items-center justify-between gap-3 p-3 border-t border-slate-200 text-xs text-slate-600">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-semibold disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span>Page {page + 1} of {pages} · {total} former students</span>
                  <button
                    onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
                    disabled={page >= pages - 1}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-semibold disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Import history ───────────────────────────────────────────────── */}
      {tab === 'imports' && (
        <div className="space-y-3">
          {imports.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center shadow-sm">
              <History className="w-9 h-9 text-slate-300 mx-auto" />
              <p className="text-sm font-semibold text-slate-700 mt-3">No imports yet</p>
              <p className="text-xs text-slate-500 mt-1">Every cleanup upload is recorded here with its counts, who ran it, and a rollback.</p>
            </div>
          ) : imports.map(imp => (
            <div key={imp.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-4">
                <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-bold text-slate-900">Import #{imp.importNumber}</h3>
                      <ImportStatusBadge status={imp.status} />
                      {imp.fileName && (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-500 font-mono truncate">
                          <FileSpreadsheet className="w-3.5 h-3.5" /> {imp.fileName}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {formatDateTime(imp.createdAt)} · by {imp.adminName ?? 'an administrator'}
                      {imp.rolledBackAt && ` · rolled back ${formatDateTime(imp.rolledBackAt)} by ${imp.rolledBackByName ?? '—'}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {[
                      ['Uploaded', imp.uploadedCount, 'bg-slate-50 text-slate-700 border-slate-200'],
                      ['Exact matches', imp.exactMatchCount, 'bg-emerald-50 text-emerald-700 border-emerald-200'],
                      ['ID/name conflicts', imp.nameConflictCount, 'bg-amber-50 text-amber-800 border-amber-200'],
                      ['Duplicates', imp.possibleDuplicateCount, 'bg-orange-50 text-orange-800 border-orange-200'],
                      ['Not found', imp.notFoundCount, 'bg-red-50 text-red-700 border-red-200'],
                      ['Deactivated', imp.deactivatedCount, 'bg-indigo-50 text-indigo-700 border-indigo-200'],
                      ['Skipped', imp.skippedCount, 'bg-slate-50 text-slate-600 border-slate-200'],
                    ].map(([label, value, className]) => (
                      <span key={String(label)} className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-lg border font-semibold', String(className))}>
                        {label}: <strong className="tabular-nums">{value as number}</strong>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => void toggleImportRows(imp.id)}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50"
                    >
                      {expandedImport === imp.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      Rows
                    </button>
                    <button
                      onClick={() => { setRollbackTarget(imp); setRollbackPhrase(''); }}
                      disabled={imp.status === 'rolled_back'}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Rollback
                    </button>
                  </div>
                </div>
              </div>

              {expandedImport === imp.id && (
                <div className="border-t border-slate-200 bg-slate-50/60">
                  {importRowsLoading ? (
                    <p className="p-4 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading rows…</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-slate-500 uppercase tracking-wide">
                          <tr>
                            <th className="text-left font-bold px-4 py-2">Row</th>
                            <th className="text-left font-bold px-4 py-2">Uploaded</th>
                            <th className="text-left font-bold px-4 py-2">Database</th>
                            <th className="text-left font-bold px-4 py-2">Match</th>
                            <th className="text-left font-bold px-4 py-2">Requested</th>
                            <th className="text-left font-bold px-4 py-2">Result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 bg-white">
                          {importRows.map(r => (
                            <tr key={r.id}>
                              <td className="px-4 py-2 text-slate-500 tabular-nums">{r.rowNumber ?? '—'}</td>
                              <td className="px-4 py-2">
                                <p className="font-semibold text-slate-800">{r.uploadedName || <span className="text-red-500 italic">missing</span>}</p>
                                <p className="font-mono text-[11px] text-slate-500 break-all">{r.uploadedSystemId || 'no System ID'}</p>
                              </td>
                              <td className="px-4 py-2">
                                <p className="text-slate-800">{r.studentName ?? '—'}</p>
                                <p className="font-mono text-[11px] text-slate-500 break-all">{r.studentId ?? '—'}</p>
                              </td>
                              <td className="px-4 py-2 text-slate-700">{matchStatusLabel(r.matchStatus)}</td>
                              <td className="px-4 py-2 text-slate-700">
                                {r.requestedAction.replace('_', ' ')}
                                {r.adminConfirmed && <span className="ml-1 text-amber-700 font-bold">(confirmed)</span>}
                              </td>
                              <td className="px-4 py-2">
                                <span className={cn(
                                  'inline-flex px-2 py-0.5 rounded-md font-bold border',
                                  r.actionTaken === 'deactivated' && 'bg-indigo-50 text-indigo-700 border-indigo-200',
                                  r.actionTaken === 'blocked' && 'bg-red-50 text-red-700 border-red-200',
                                  r.actionTaken === 'kept_active' && 'bg-emerald-50 text-emerald-700 border-emerald-200',
                                  (r.actionTaken === 'skipped' || r.actionTaken === 'already_former') && 'bg-slate-50 text-slate-600 border-slate-200',
                                )}>
                                  {actionTakenLabel(r.actionTaken)}
                                </span>
                                {r.restoredAt && <span className="ml-1 text-[11px] text-slate-500">restored {formatDate(r.restoredAt)}</span>}
                                {r.actionReason && <span className="block text-[11px] text-slate-400">{r.actionReason.replace(/_/g, ' ')}</span>}
                              </td>
                            </tr>
                          ))}
                          {importRows.length === 0 && (
                            <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No rows recorded for this import.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Restore dialog ───────────────────────────────────────────────── */}
      <Dialog
        open={restoreTarget !== null}
        onClose={() => { if (!restoring) { setRestoreTarget(null); setRestoreReason(''); } }}
        title="Restore to Active"
        description="The student comes back into every active list. Nothing else changes."
      >
        {restoreTarget && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-emerald-900 space-y-1">
              <p className="font-bold">{restoreTarget.name}</p>
              <p className="font-mono text-xs break-all">{restoreTarget.id}</p>
              <p className="text-xs">Last class: {restoreTarget.className} · marked former {formatDate(restoreTarget.markedFormerAt)} by {restoreTarget.markedFormerByName ?? '—'}</p>
            </div>
            <p className="text-xs text-slate-600">
              Their previous bus/transport setting is restored exactly as it was recorded, and this restore is written to
              the same audit ledger as the original change.
            </p>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Reason (optional)</label>
              <input
                value={restoreReason}
                onChange={e => setRestoreReason(e.target.value)}
                placeholder="e.g. Re-enrolled for Term 2"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setRestoreTarget(null); setRestoreReason(''); }}
                disabled={restoring}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void doRestore()}
                disabled={restoring}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
              >
                {restoring ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Restore to Active
              </button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ── Historical profile dialog ────────────────────────────────────── */}
      <Dialog
        open={profileTarget !== null}
        onClose={() => setProfileTarget(null)}
        title="Historical record"
        description="Read-only. This is what the cleanup preserved."
        className="max-w-2xl"
      >
        {profileTarget && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <p className="font-bold text-slate-900">{profileTarget.name}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-xs">
                {[
                  ['System ID', profileTarget.id],
                  ['Gov ID', profileTarget.govId ?? '—'],
                  ['Last class / section', profileTarget.className],
                  ['Parent', profileTarget.parentName ?? '—'],
                  ['Parent phone', profileTarget.parentPhone ?? '—'],
                  ['Family ID', profileTarget.familyId ?? '—'],
                  ['Transport', profileTarget.transport ?? '—'],
                  ['Enrolled since', formatDate(profileTarget.createdAt)],
                  ['Marked former', formatDateTime(profileTarget.markedFormerAt)],
                  ['Marked by', profileTarget.markedFormerByName ?? '—'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-slate-400 font-semibold uppercase tracking-wide">{label}</dt>
                    <dd className="text-slate-800 break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Marks, attendance, homework, quizzes, report comments, payments, parent links, messages and historical
                class assignments are all still attached to this System ID. Reports for terms this student attended
                still include them.
              </span>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Status history (audit ledger)</h4>
              {profileHistory.length === 0 ? (
                <p className="text-xs text-slate-500 flex items-center gap-2"><Info className="w-3.5 h-3.5" /> No status changes recorded.</p>
              ) : (
                <ol className="space-y-2">
                  {profileHistory.map(h => (
                    <li key={h.id} className="rounded-xl border border-slate-200 p-3 text-xs">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-bold text-slate-800">
                          {h.previousStatus} <ArrowRightInline /> {h.newStatus}
                        </span>
                        <span className="text-slate-500">{formatDateTime(h.createdAt)}</span>
                      </div>
                      <p className="text-slate-600 mt-1">{statusChangeReasonLabel(h.reason)}</p>
                      <p className="text-slate-500 mt-0.5">
                        {h.changedByName ?? 'system'}
                        {h.fileName ? ` · ${h.fileName}` : ''}
                        {h.previousTransport ? ` · previous transport ${h.previousTransport}` : ''}
                      </p>
                      {h.note && <p className="text-slate-400 mt-0.5 italic">{h.note}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              <a
                href="/admin/exam-reports"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" /> Open exam reports
              </a>
              <button
                onClick={() => { setRestoreTarget(profileTarget); setRestoreReason(''); setProfileTarget(null); }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Restore to Active
              </button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ── Rollback dialog ──────────────────────────────────────────────── */}
      <Dialog
        open={rollbackTarget !== null}
        onClose={() => { if (!rollingBack) { setRollbackTarget(null); setRollbackPhrase(''); } }}
        title={`Roll back Import #${rollbackTarget?.importNumber ?? ''}`}
        description="Restores the students this import marked as former."
      >
        {rollbackTarget && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-amber-900 space-y-1 text-xs">
              <p className="font-bold text-sm">{rollbackTarget.deactivatedCount} student(s) will be restored to their previous status.</p>
              <p>Only this import is undone — students from other imports, and students whose status changed after this
                import, are checked against the audit ledger and skipped (they are reported, never overwritten).</p>
              <p className="mt-1">File: {rollbackTarget.fileName ?? '—'} · applied {formatDateTime(rollbackTarget.createdAt)} by {rollbackTarget.adminName ?? '—'}</p>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">
                Type <span className="font-mono text-slate-800">{FORMER_STUDENT_ROLLBACK_PHRASE}</span> to confirm
              </label>
              <input
                value={rollbackPhrase}
                onChange={e => setRollbackPhrase(e.target.value)}
                placeholder={FORMER_STUDENT_ROLLBACK_PHRASE}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setRollbackTarget(null); setRollbackPhrase(''); }}
                disabled={rollingBack}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void doRollback()}
                disabled={rollbackPhrase.trim().toUpperCase() !== FORMER_STUDENT_ROLLBACK_PHRASE || rollingBack}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-40"
              >
                {rollingBack ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Roll back this import
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function ArrowRightInline() {
  return <span className="text-slate-400 mx-1">→</span>;
}
