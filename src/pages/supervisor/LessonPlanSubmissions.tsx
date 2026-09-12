import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BellRing,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Eye,
  Filter,
  Loader2,
  Percent,
  Search,
  Users,
  XCircle,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { useToast } from '../../context/ToastContext';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { getCurrentAcademicYear } from '../../lib/db/academic';
import { useSupervisorPlanWeeks } from '../../lib/hooks/useLessonPlans';
import { useLessonPlanSubmitters, useSubmissionTrackingPlans } from '../../lib/hooks/useLessonPlanSubmissions';
import {
  buildSubmissionRows,
  buildSubmissionWeeks,
  defaultSubmissionWeek,
  filterSubmissionRows,
  sortSubmissionRows,
  submissionClassLabel,
  submissionClassOptions,
  summarizeSubmissions,
  type SubmissionRow,
  type SubmissionSort,
  type SubmissionStatusFilter,
} from '../../lib/lessonPlanSubmissionTracking';
import { setPendingLessonPlanReview } from '../../lib/lessonPlanDeepLink';

/** "12 Sep 2026, 8:14 AM" */
function formatSubmittedAt(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

function StatusPill({ row }: { row: SubmissionRow }) {
  const { t } = useI18n();
  if (!row.submitted) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">
        <XCircle className="h-3.5 w-3.5" aria-hidden />
        {t('lessonSubmission.notSubmitted')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      {t('lessonSubmission.submitted')}
    </span>
  );
}

/** Secondary note under the status: sent back for revisions, or extra plan records. */
function StatusNote({ row }: { row: SubmissionRow }) {
  const { t } = useI18n();
  if (row.latestPlanStatus === 'revision_requested') {
    return <span className="text-[11px] font-medium text-amber-600">{t('lessonSubmission.revisionsNote')}</span>;
  }
  if (row.submitted && row.planCount > 1) {
    return (
      <span className="text-[11px] text-slate-400">
        {row.planCount} {t('lessonSubmission.plansThisWeek')}
      </span>
    );
  }
  return null;
}

interface LessonPlanSubmissionsProps {
  /** Path-based navigation from the dashboard layout (cross-page links). */
  navigate?: (path: string) => void;
  /** Where this role's Lesson Plan Review page lives. */
  reviewPath?: string;
}

/**
 * Lesson Plan Submission — the supervisor's accountability page.
 *
 * It answers "who has submitted and who hasn't?" for ONE selected week.
 * The roster of expected teachers comes first, so a teacher with no plan
 * appears as "Not Submitted" instead of disappearing. Detailed review
 * (approve / reject / revisions) stays on the Lesson Plan Review page.
 */
export function LessonPlanSubmissions({ navigate, reviewPath = '/supervisor/lesson-plans' }: LessonPlanSubmissionsProps) {
  const { t } = useI18n();
  const { addToast } = useToast();

  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SubmissionStatusFilter>('all');
  const [classFilter, setClassFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SubmissionSort>('missing-first');

  // ── Weeks ──────────────────────────────────────────────────────────────
  // Generated from the academic-year calendar (so weeks with zero
  // submissions stay selectable) and merged with the stored submission
  // weeks — never grouped by the teacher-typed plan title.
  const { data: academicYear, isLoading: yearLoading } = useQuery({
    queryKey: ['academicYear', 'current'],
    queryFn: getCurrentAcademicYear,
    staleTime: 1000 * 60 * 10,
  });
  const { data: weekCounts, isLoading: weeksLoading } = useSupervisorPlanWeeks();
  const resolvingWeek = yearLoading || weeksLoading;
  const weeks = useMemo(
    () => (resolvingWeek ? [] : buildSubmissionWeeks(weekCounts, academicYear ?? null)),
    [resolvingWeek, weekCounts, academicYear]
  );
  const selectedWeek = useMemo(
    () => weeks.find((week) => week.key === selectedWeekKey) ?? null,
    [weeks, selectedWeekKey]
  );

  // Open on the current school week. The supervisor can then step back
  // through previous weeks — including weeks where nobody submitted.
  useEffect(() => {
    if (weeks.length === 0) return;
    setSelectedWeekKey((current) => {
      if (current && weeks.some((week) => week.key === current)) return current;
      return defaultSubmissionWeek(weeks)?.key ?? null;
    });
  }, [weeks]);

  const handleSelectWeek = useCallback((weekKey: string) => {
    setSelectedWeekKey(weekKey);
  }, []);

  // ── The selected week's data ───────────────────────────────────────────
  const { data: submitters, isLoading: submittersLoading, error: submittersError } = useLessonPlanSubmitters();
  const { data: weekPlans, isLoading: weekPlansLoading, error: weekPlansError } = useSubmissionTrackingPlans(
    selectedWeek?.key ?? null,
    selectedWeek?.weekLabels
  );

  const rows = useMemo(() => buildSubmissionRows(submitters, weekPlans), [submitters, weekPlans]);
  const summary = useMemo(() => summarizeSubmissions(rows), [rows]);
  const classOptions = useMemo(() => submissionClassOptions(rows), [rows]);
  const visibleRows = useMemo(
    () => sortSubmissionRows(
      filterSubmissionRows(rows, { status: statusFilter, className: classFilter || null, search }),
      sort
    ),
    [rows, statusFilter, classFilter, search, sort]
  );

  // ── Actions ────────────────────────────────────────────────────────────
  /** View = open this submission on the existing Lesson Plan Review page. */
  const handleView = useCallback(
    (row: SubmissionRow) => {
      if (!row.latestPlanId) return;
      if (!navigate) return;
      setPendingLessonPlanReview(row.latestPlanId, row.teacherName);
      navigate(reviewPath);
    },
    [navigate, reviewPath]
  );

  /**
   * Reminders are a UI action only for now: the school's messaging rules
   * (can_send_message) let supervisors message parents, not teachers, and
   * this feature deliberately does not build new messaging infrastructure.
   * The hook is here so a notification system can be wired in later.
   */
  const handleSendReminder = useCallback(
    (row: SubmissionRow) => {
      addToast({
        type: 'info',
        title: t('lessonSubmission.reminderTitle'),
        description: t('lessonSubmission.reminderBody'),
      });
    },
    [addToast, t]
  );

  const rosterProblem = !!submittersError;
  const plansProblem = !!weekPlansError;
  const listLoading = resolvingWeek || submittersLoading || weekPlansLoading;
  const hasFilters = statusFilter !== 'all' || !!classFilter || !!search.trim();

  const statCards = [
    { key: 'total', label: t('lessonSubmission.totalTeachers'), value: summary.total, icon: Users, tone: 'bg-slate-100 text-slate-700' },
    { key: 'submitted', label: t('lessonSubmission.submitted'), value: summary.submitted, icon: CheckCircle2, tone: 'bg-emerald-100 text-emerald-700' },
    { key: 'notSubmitted', label: t('lessonSubmission.notSubmitted'), value: summary.notSubmitted, icon: XCircle, tone: 'bg-rose-100 text-rose-700' },
    { key: 'rate', label: t('lessonSubmission.submissionRate'), value: `${summary.rate}%`, icon: Percent, tone: 'bg-indigo-100 text-indigo-700' },
  ];

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700">
            <ClipboardList className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{t('lessonSubmission.title')}</h1>
            <p className="mt-1 text-sm leading-5 text-slate-500">{t('lessonSubmission.subtitle')}</p>
          </div>
        </div>
        {navigate && (
          <button
            type="button"
            onClick={() => navigate(reviewPath)}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100"
          >
            <ClipboardCheck className="h-4 w-4" />
            {t('lessonSubmission.openReview')}
          </button>
        )}
      </div>

      {/* Week selector */}
      <section
        aria-label={t('lessonSubmission.weekSection')}
        className="mb-4 min-w-0 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4"
      >
        <div className="min-w-0">
          <label
            htmlFor="submission-week"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <CalendarRange className="h-3.5 w-3.5" /> {t('lessonReview.week')}
          </label>
          <div className="relative min-w-0">
            <select
              id="submission-week"
              value={selectedWeek?.key ?? ''}
              onChange={(e) => handleSelectWeek(e.target.value)}
              className="h-12 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-base font-bold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {resolvingWeek && <option value="">{t('lessonReview.loadingWeeks')}</option>}
              {weeks.map((week) => (
                <option key={week.key} value={week.key}>
                  {week.rangeLabel ? `${week.label} — ${week.rangeLabel}` : week.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
          {selectedWeek && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <span className="font-semibold text-slate-700">{selectedWeek.label}</span>
              {selectedWeek.rangeLabel && <span>{selectedWeek.rangeLabel}</span>}
              {selectedWeek.isCurrent && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                  {t('lessonSubmission.currentWeek')}
                </span>
              )}
            </p>
          )}
        </div>
      </section>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map((card) => (
          <div key={card.key} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
            <div className="flex items-center gap-2">
              <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', card.tone)}>
                <card.icon className="h-4 w-4" aria-hidden />
              </span>
              <p className="truncate text-xs font-bold uppercase tracking-wide text-slate-500">{card.label}</p>
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">{listLoading ? '…' : card.value}</p>
          </div>
        ))}
      </div>

      {/* Progress */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-label={t('lessonSubmission.progressTitle')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-900">{t('lessonSubmission.progressTitle')}</p>
          <p className="text-sm text-slate-500">
            {listLoading ? (
              t('lessonReview.loadingPlans')
            ) : (
              <>
                <span className="font-semibold text-slate-700">
                  {summary.submitted} of {summary.total}
                </span>{' '}
                {t('lessonSubmission.progressTeachers')}
              </>
            )}
          </p>
        </div>
        <div
          className="h-3 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={summary.rate}
          aria-label={t('lessonSubmission.progressTitle')}
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              summary.rate === 100 ? 'bg-emerald-500' : summary.rate >= 50 ? 'bg-indigo-500' : 'bg-amber-500'
            )}
            style={{ width: `${summary.rate}%` }}
          />
        </div>
        <p className="mt-2 text-sm font-semibold text-slate-700">{summary.rate}%</p>
      </section>

      {/* Filters */}
      <section
        aria-label={t('lessonSubmission.filters')}
        className="mb-4 grid min-w-0 gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-4"
      >
        <div className="min-w-0">
          <label
            htmlFor="submission-status-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Filter className="h-3.5 w-3.5" /> {t('lessonReview.status')}
          </label>
          <div className="relative">
            <select
              id="submission-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as SubmissionStatusFilter)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="all">{t('lessonSubmission.allStatuses')}</option>
              <option value="submitted">{t('lessonSubmission.submitted')}</option>
              <option value="not_submitted">{t('lessonSubmission.notSubmitted')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="submission-class-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Users className="h-3.5 w-3.5" /> {t('lessonSubmission.class')}
          </label>
          <div className="relative">
            <select
              id="submission-class-filter"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">{t('lessonSubmission.allClasses')}</option>
              {classOptions.map((className) => (
                <option key={className} value={className}>{className}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="submission-search"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Search className="h-3.5 w-3.5" /> {t('lessonSubmission.searchTeacher')}
          </label>
          <input
            id="submission-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('lessonSubmission.searchPlaceholder')}
            className="h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div className="min-w-0">
          <label
            htmlFor="submission-sort"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <ClipboardList className="h-3.5 w-3.5" /> {t('lessonSubmission.sort')}
          </label>
          <div className="relative">
            <select
              id="submission-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SubmissionSort)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-200 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="missing-first">{t('lessonSubmission.sortMissingFirst')}</option>
              <option value="name">{t('lessonSubmission.sortName')}</option>
              <option value="latest">{t('lessonSubmission.sortLatest')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
      </section>

      {/* Roster problems must not look like "everybody missing". */}
      {rosterProblem && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-bold">{t('lessonSubmission.rosterErrorTitle')}</p>
          <p className="mt-1">{t('lessonSubmission.rosterErrorBody')}</p>
        </div>
      )}
      {plansProblem && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-bold">{t('lessonSubmission.plansErrorTitle')}</p>
          <p className="mt-1">{t('lessonSubmission.plansErrorBody')}</p>
        </div>
      )}

      {/* Teacher list */}
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white">
        {listLoading && (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('lessonReview.loadingPlans')}
          </div>
        )}

        {!listLoading && rows.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">{t('lessonSubmission.noTeachers')}</div>
        )}

        {!listLoading && rows.length > 0 && visibleRows.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">{t('lessonSubmission.noMatches')}</div>
        )}

        {/* Desktop / tablet: the full table */}
        {!listLoading && visibleRows.length > 0 && (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3">{t('lessonSubmission.teacher')}</th>
                    <th scope="col" className="px-4 py-3">{t('lessonSubmission.class')}</th>
                    <th scope="col" className="px-4 py-3">{t('lessonReview.status')}</th>
                    <th scope="col" className="px-4 py-3">{t('lessonSubmission.submittedAt')}</th>
                    <th scope="col" className="px-4 py-3 text-right">{t('lessonSubmission.action')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((row) => (
                    <tr key={row.teacherId} className="align-middle hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{row.teacherName}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="break-words">{submissionClassLabel(row)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <StatusPill row={row} />
                          <StatusNote row={row} />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {row.submitted ? formatSubmittedAt(row.submittedAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.submitted ? (
                          <button
                            type="button"
                            onClick={() => handleView(row)}
                            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
                          >
                            <Eye className="h-3.5 w-3.5" /> {t('lessonSubmission.view')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSendReminder(row)}
                            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                          >
                            <BellRing className="h-3.5 w-3.5" /> {t('lessonSubmission.sendReminder')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: compact cards instead of a wide table */}
            <div className="divide-y divide-slate-100 sm:hidden">
              {visibleRows.map((row) => (
                <div key={row.teacherId} className="p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{row.teacherName}</p>
                      <p className="mt-0.5 break-words text-sm text-slate-500">{submissionClassLabel(row)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill row={row} />
                      <StatusNote row={row} />
                    </div>
                  </div>
                  <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm text-slate-500">
                      {row.submitted ? formatSubmittedAt(row.submittedAt) : '—'}
                    </p>
                    {row.submitted ? (
                      <button
                        type="button"
                        onClick={() => handleView(row)}
                        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
                      >
                        <Eye className="h-4 w-4" /> {t('lessonSubmission.view')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSendReminder(row)}
                        className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                      >
                        <BellRing className="h-4 w-4" /> {t('lessonSubmission.sendReminder')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {!listLoading && hasFilters && visibleRows.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-400">
            {visibleRows.length} of {rows.length} {t('lessonSubmission.teachers')}
          </div>
        )}
      </div>
    </div>
  );
}
