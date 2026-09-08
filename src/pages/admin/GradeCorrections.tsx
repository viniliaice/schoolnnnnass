import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, History, Pencil, ShieldCheck } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { getClasses } from '../../lib/db/classes';
import { getTerms } from '../../lib/db/academic';
import { searchGradesForCorrection, type GradeSearchRow } from '../../lib/db/exams';
import {
  correctGrade,
  getGradeCorrectionHistory,
  type GradeCorrectionHistoryEntry,
} from '../../lib/db/gradeCorrections';
import { ASSESSMENT_DEFINITIONS, type AssessmentLabel } from '../../lib/excel-parser';
import { MONTHS } from '../../types';
import { Dialog } from '../../components/ui/Dialog';
import { Skeleton } from '../../components/ui/Skeleton';
import { cn } from '../../utils/cn';
import {
  displayScore,
  validateCorrection,
  type CorrectionDraft,
} from './gradeCorrectionUtils';

const PAGE_SIZE = 50;
const ASSESSMENT_LABELS = ASSESSMENT_DEFINITIONS.map(d => d.assessmentLabel as AssessmentLabel);

function formatDate(value: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'approved' ? 'bg-emerald-100 text-emerald-700'
    : status === 'rejected' ? 'bg-rose-100 text-rose-700'
    : 'bg-amber-100 text-amber-700';
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold capitalize', tone)}>{status}</span>;
}

type DialogStage = 'edit' | 'review' | 'done';

export function GradeCorrections() {
  const { session } = useRole();
  const { addToast } = useToast();
  const queryClient = useQueryClient();

  // Filters (all server-side).
  const [classFilter, setClassFilter] = useState<string>('');
  const [subjectFilter, setSubjectFilter] = useState<string>('');
  const [assessmentFilter, setAssessmentFilter] = useState<string>('');
  const [termFilter, setTermFilter] = useState<string>('');
  const [monthFilter, setMonthFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [studentSearch, setStudentSearch] = useState<string>('');
  const [appliedSearch, setAppliedSearch] = useState<string>('');
  const [page, setPage] = useState(1);

  // Correction dialog state.
  const [active, setActive] = useState<GradeSearchRow | null>(null);
  const [stage, setStage] = useState<DialogStage>('edit');
  const [draft, setDraft] = useState<CorrectionDraft>({ newScoreText: '', newEntryState: 'scored', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string>('');

  // History panel state.
  const [historyExam, setHistoryExam] = useState<GradeSearchRow | null>(null);

  const isAdmin = session?.role === 'admin';

  const classesQuery = useQuery({ queryKey: ['gc-classes'], queryFn: getClasses });
  const termsQuery = useQuery({ queryKey: ['gc-terms'], queryFn: getTerms });

  const hasFilter = Boolean(classFilter || appliedSearch || subjectFilter || assessmentFilter || termFilter || monthFilter || statusFilter !== 'all');

  const gradesQuery = useQuery({
    queryKey: ['gc-grades', classFilter, subjectFilter, assessmentFilter, termFilter, monthFilter, statusFilter, appliedSearch, page],
    queryFn: () => searchGradesForCorrection({
      classNames: classFilter ? [classFilter] : undefined,
      subject: subjectFilter || undefined,
      assessmentLabel: assessmentFilter || undefined,
      termId: termFilter || undefined,
      month: monthFilter || undefined,
      status: (statusFilter as never) || 'all',
      studentSearch: appliedSearch || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    enabled: isAdmin && hasFilter,
    placeholderData: keepPreviousData,
  });

  const rows = gradesQuery.data?.rows ?? [];
  const total = gradesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const historyQuery = useQuery<GradeCorrectionHistoryEntry[]>({
    queryKey: ['gc-history', historyExam?.id],
    queryFn: () => getGradeCorrectionHistory(historyExam!.id),
    enabled: Boolean(historyExam?.id),
  });

  function openCorrect(row: GradeSearchRow) {
    setActive(row);
    setStage('edit');
    setDialogError('');
    setDraft({
      newScoreText: row.entryState === 'scored' && row.score != null ? String(row.score) : '',
      newEntryState: row.entryState,
      reason: '',
    });
  }

  const validation = useMemo(() => {
    if (!active) return null;
    return validateCorrection(draft, { score: active.score, entryState: active.entryState }, active.total);
  }, [active, draft]);

  const validationError = typeof validation === 'string' ? validation : '';
  const parsedNew = typeof validation === 'string' ? null : validation;

  async function confirmCorrection() {
    if (!active || !parsedNew) return;
    setSubmitting(true);
    setDialogError('');
    try {
      const result = await correctGrade({
        examId: active.id,
        expectedOldScore: active.score,
        expectedOldEntryState: active.entryState,
        newScore: parsedNew.score,
        newEntryState: parsedNew.entryState,
        reason: draft.reason.trim(),
      });
      setStage('done');
      addToast({
        type: 'success',
        title: 'Grade corrected successfully',
        description: `${active.studentName} · ${active.subject} — ${active.assessmentLabel ?? active.examType}: ${displayScore(result.oldScore, result.oldEntryState)} → ${displayScore(result.newScore, result.newEntryState)}`,
      });
      // Refresh the grades table and any open history so the corrected value is
      // immediately canonical everywhere.
      await queryClient.invalidateQueries({ queryKey: ['gc-grades'] });
      await queryClient.invalidateQueries({ queryKey: ['gc-history', active.id] });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'The correction could not be saved.');
      setStage('review');
    } finally {
      setSubmitting(false);
    }
  }

  function closeDialog() {
    setActive(null);
    setStage('edit');
    setDialogError('');
    setSubmitting(false);
  }

  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-800">
        <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-5 w-5" /> Administrators only</div>
        <p className="mt-1 text-sm">Grade corrections can only be performed by an administrator.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Grade Corrections</h1>
        <p className="mt-1 text-slate-500">
          Correct a single existing grade without re-uploading. Every correction is permanently recorded in the grade audit history.
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">Class
            <select value={classFilter} onChange={e => { setClassFilter(e.target.value); setPage(1); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
              <option value="">All classes</option>
              {(classesQuery.data ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">Subject
            <input value={subjectFilter} onChange={e => { setSubjectFilter(e.target.value); setPage(1); }} placeholder="e.g. Mathematics" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" />
          </label>
          <label className="text-sm font-medium text-slate-700">Assessment
            <select value={assessmentFilter} onChange={e => { setAssessmentFilter(e.target.value); setPage(1); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
              <option value="">All</option>
              {ASSESSMENT_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">Term
            <select value={termFilter} onChange={e => { setTermFilter(e.target.value); setPage(1); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
              <option value="">All terms</option>
              {(termsQuery.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">Month
            <select value={monthFilter} onChange={e => { setMonthFilter(e.target.value); setPage(1); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
              <option value="">All months</option>
              {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">Status
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex-1 text-sm font-medium text-slate-700">Student (name, Student ID, or Gov ID)
            <input
              value={studentSearch}
              onChange={e => setStudentSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setAppliedSearch(studentSearch); setPage(1); } }}
              placeholder="Search students…"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <button
            onClick={() => { setAppliedSearch(studentSearch); setPage(1); }}
            className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Search
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="rounded-2xl border border-slate-200 bg-white">
        {!hasFilter ? (
          <div className="p-10 text-center text-slate-500">
            <p className="font-medium text-slate-700">Choose a filter to begin</p>
            <p className="mt-1 text-sm">Select a class, subject, assessment, term, month, or search for a student.</p>
          </div>
        ) : gradesQuery.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : gradesQuery.isError ? (
          <div className="p-6 text-rose-700">Could not load grades. Please adjust the filters and try again.</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-500">
            <p className="font-medium text-slate-700">No grades found.</p>
            <p className="mt-1 text-sm">Adjust the class, subject, assessment, term, or student filters and try again.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Student ID</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">Assessment</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{row.studentName}</td>
                      <td className="px-4 py-3 text-slate-500">{row.studentId}</td>
                      <td className="px-4 py-3 text-slate-600">{row.className}</td>
                      <td className="px-4 py-3 text-slate-600">{row.subject}</td>
                      <td className="px-4 py-3 text-slate-600">{row.assessmentLabel ?? row.examType}</td>
                      <td className="px-4 py-3 font-semibold text-slate-800">
                        {displayScore(row.score, row.entryState)} <span className="font-normal text-slate-400">/ {row.total}</span>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(row.date)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setHistoryExam(row)}
                            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                            title="Correction history"
                          >
                            <History className="h-3.5 w-3.5" /> History
                          </button>
                          <button
                            onClick={() => openCorrect(row)}
                            className="flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Correct
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
              <span>{total} grade{total === 1 ? '' : 's'} · page {page} of {totalPages}</span>
              <div className="flex items-center gap-2">
                <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /> Prev</button>
                <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40">Next <ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Correction dialog */}
      {active && (
        <Dialog
          open
          onClose={closeDialog}
          title={stage === 'done' ? 'Grade corrected' : stage === 'review' ? 'Confirm Grade Correction' : 'Correct Grade'}
          description={stage === 'review' ? 'This correction will be permanently recorded in the grade audit history.' : undefined}
        >
          {/* Context — always shown so the admin cannot edit the wrong student */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 p-4 text-sm">
            <div><dt className="text-xs text-slate-500">Student</dt><dd className="font-semibold text-slate-800">{active.studentName}</dd></div>
            <div><dt className="text-xs text-slate-500">Student ID</dt><dd className="text-slate-700">{active.studentId}</dd></div>
            <div><dt className="text-xs text-slate-500">Class</dt><dd className="text-slate-700">{active.className}</dd></div>
            <div><dt className="text-xs text-slate-500">Subject</dt><dd className="text-slate-700">{active.subject}</dd></div>
            <div><dt className="text-xs text-slate-500">Assessment</dt><dd className="text-slate-700">{active.assessmentLabel ?? active.examType}</dd></div>
            <div><dt className="text-xs text-slate-500">Assessment date</dt><dd className="text-slate-700">{formatDate(active.date)}</dd></div>
          </dl>

          {stage === 'edit' && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Current score</p>
                  <p className="text-2xl font-bold text-slate-800">{displayScore(active.score, active.entryState)} <span className="text-base font-normal text-slate-400">/ {active.total}</span></p>
                </div>
                <label className="rounded-xl border border-teal-200 bg-teal-50/40 p-3 text-xs text-slate-500">New score
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={active.total}
                      value={draft.newScoreText}
                      disabled={draft.newEntryState !== 'scored'}
                      onChange={e => setDraft(d => ({ ...d, newScoreText: e.target.value }))}
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-xl font-bold text-slate-800 disabled:bg-slate-100"
                    />
                    <span className="text-base font-normal text-slate-400">/ {active.total}</span>
                  </div>
                </label>
              </div>
              <label className="block text-sm font-medium text-slate-700">Entry state
                <select
                  value={draft.newEntryState}
                  onChange={e => setDraft(d => ({ ...d, newEntryState: e.target.value as CorrectionDraft['newEntryState'] }))}
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2"
                >
                  <option value="scored">Scored</option>
                  <option value="absent">Absent</option>
                  <option value="not_applicable">Not applicable</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">Correction reason <span className="text-rose-500">*</span>
                <textarea
                  value={draft.reason}
                  onChange={e => setDraft(d => ({ ...d, reason: e.target.value }))}
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Incorrect value entered during bulk upload"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                />
                <span className="text-xs text-slate-400">{draft.reason.trim().length}/1000</span>
              </label>
              {validationError && draft.reason.trim().length > 0 && (
                <p className="text-sm text-rose-600">{validationError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={closeDialog} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">Cancel</button>
                <button
                  disabled={typeof validation === 'string'}
                  onClick={() => setStage('review')}
                  className={cn('rounded-xl px-4 py-2 text-sm font-semibold', typeof validation !== 'string' ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}
                >
                  Review Correction
                </button>
              </div>
            </div>
          )}

          {stage === 'review' && parsedNew && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-center gap-4 rounded-xl border border-slate-200 p-4">
                <div className="text-center">
                  <p className="text-xs text-slate-500">Previous</p>
                  <p className="text-2xl font-bold text-slate-500 line-through">{displayScore(active.score, active.entryState)} / {active.total}</p>
                </div>
                <span className="text-2xl text-slate-400">→</span>
                <div className="text-center">
                  <p className="text-xs text-slate-500">New</p>
                  <p className="text-2xl font-bold text-teal-700">{displayScore(parsedNew.score, parsedNew.entryState)} / {active.total}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Reason</p>
                <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{draft.reason.trim()}</p>
              </div>
              {active.status === 'approved' && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  This grade is currently <strong>approved</strong>. Correcting it will reset its status to <strong>pending</strong> so the new value is re-approved.
                </div>
              )}
              {dialogError && <p className="text-sm text-rose-600">{dialogError}</p>}
              <div className="flex justify-end gap-2">
                <button disabled={submitting} onClick={() => setStage('edit')} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">Back</button>
                <button
                  disabled={submitting}
                  onClick={confirmCorrection}
                  className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {submitting ? 'Saving…' : 'Confirm Correction'}
                </button>
              </div>
            </div>
          )}

          {stage === 'done' && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-center gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-center">
                  <p className="text-xs text-slate-500">Previous</p>
                  <p className="text-xl font-bold text-slate-500 line-through">{displayScore(active.score, active.entryState)} / {active.total}</p>
                </div>
                <span className="text-2xl text-slate-400">→</span>
                <div className="text-center">
                  <p className="text-xs text-slate-500">New</p>
                  <p className="text-xl font-bold text-emerald-700">{parsedNew ? displayScore(parsedNew.score, parsedNew.entryState) : ''} / {active.total}</p>
                </div>
              </div>
              <p className="text-center text-sm text-slate-600">Grade corrected successfully and recorded in the audit history.</p>
              <div className="flex justify-end">
                <button onClick={closeDialog} className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Done</button>
              </div>
            </div>
          )}
        </Dialog>
      )}

      {/* History panel */}
      {historyExam && (
        <Dialog open onClose={() => setHistoryExam(null)} title="Correction History" description={`${historyExam.studentName} · ${historyExam.subject} — ${historyExam.assessmentLabel ?? historyExam.examType}`}>
          {historyQuery.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : (historyQuery.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">This grade has never been corrected.</p>
          ) : (
            <ol className="space-y-3">
              {(historyQuery.data ?? []).map(entry => (
                <li key={entry.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{formatDate(entry.correctedAt)} · {new Date(entry.correctedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    <span>Admin: {entry.correctedByName ?? entry.correctedBy}</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-slate-800">
                    {displayScore(entry.oldScore, entry.oldEntryState)} <span className="text-slate-400">→</span> {displayScore(entry.newScore, entry.newEntryState)}
                  </p>
                  <p className="mt-1 text-sm text-slate-600"><span className="text-slate-400">Reason:</span> {entry.reason}</p>
                  {entry.oldStatus && entry.newStatus && entry.oldStatus !== entry.newStatus && (
                    <p className="mt-1 text-xs text-slate-500">Status: <span className="capitalize">{entry.oldStatus}</span> → <span className="capitalize">{entry.newStatus}</span></p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Dialog>
      )}
    </div>
  );
}
