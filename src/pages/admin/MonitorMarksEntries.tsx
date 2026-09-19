import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Filter,
  Loader2,
  Percent,
  Search,
  Users,
  XCircle,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { useToast } from '../../context/ToastContext';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { MONTHS } from '../../types';
import {
  useAcademicYears,
  useMonitorMarksEntries,
  useTerms,
} from '../../lib/hooks';
import {
  filterMonitorMarksRows,
  missingMonthlyComponents,
  monitorMarksClassOptions,
  monitorMarksSubjectOptions,
  monitorMarksTeacherOptions,
  sortMonitorMarksRows,
  summarizeMonitorMarks,
  type MonitorMarksRow,
  type MonitorMarksStatus,
  type MonitorMarksStatusFilter,
  type MonitorMarksSort,
} from '../../lib/marksUploadTracking';

/** "12 Sep 2026, 8:14 AM" — graceful with null. */
function formatLastUpdate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

function StatusPill({ status }: { status: MonitorMarksStatus }) {
  const { t } = useI18n();
  if (status === 'complete') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        {t('marksMonitoring.statusComplete')}
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        {t('marksMonitoring.statusInProgress')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">
      <XCircle className="h-3.5 w-3.5" aria-hidden />
      {t('marksMonitoring.statusNotStarted')}
    </span>
  );
}

interface MonitorMarksEntriesProps {
  /** Path-based navigation from the dashboard layout (cross-page links). */
  navigate?: (path: string) => void;
}

/**
 * Monitor Marks Entries — the admin/supervisor accountability page.
 *
 * It answers "which teacher/class/subject mark-entry assignments are complete,
 * in progress, or not started for the selected exam period?" The roster of
 * expected entries comes first (class_subjects), so an assignment with zero
 * marks appears as "Not Started" instead of disappearing. Detailed completion
 * is opened in a modal.
 */
export function MonitorMarksEntries({ navigate: _navigate }: MonitorMarksEntriesProps) {
  const { t } = useI18n();
  const { addToast } = useToast();

  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const [selectedTermId, setSelectedTermId] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [examType, setExamType] = useState<string>('Monthly');
  const [statusFilter, setStatusFilter] = useState<MonitorMarksStatusFilter>('all');
  const [classFilter, setClassFilter] = useState<string>('');
  const [subjectFilter, setSubjectFilter] = useState<string>('');
  const [teacherFilter, setTeacherFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MonitorMarksSort>('attention-first');
  const [selectedDetail, setSelectedDetail] = useState<MonitorMarksRow | null>(null);

  // ── Period scaffolding ──────────────────────────────────────────────────
  const { data: academicYears, isLoading: yearsLoading } = useAcademicYears();
  const { data: allTerms, isLoading: termsLoading } = useTerms();
  const resolvingPeriod = yearsLoading || termsLoading;

  const years = useMemo(() => academicYears ?? [], [academicYears]);
  const termsForYear = useMemo(
    () => (allTerms ?? []).filter((term) => term.academicYearId === selectedYearId),
    [allTerms, selectedYearId]
  );

  // Default the period to the current year + current term + a sensible month.
  useEffect(() => {
    if (resolvingPeriod) return;
    if (!selectedYearId) {
      const current = years.find((y) => y.isCurrent) ?? years[0];
      if (current) setSelectedYearId(current.id);
    }
  }, [resolvingPeriod, years, selectedYearId]);

  useEffect(() => {
    if (resolvingPeriod || !selectedYearId) return;
    if (!selectedTermId || !termsForYear.some((term) => term.id === selectedTermId)) {
      const current = termsForYear.find((term) => term.isCurrent) ?? termsForYear[0];
      if (current) setSelectedTermId(current.id);
    }
  }, [resolvingPeriod, selectedYearId, termsForYear, selectedTermId]);

  const selectedTerm = useMemo(
    () => termsForYear.find((term) => term.id === selectedTermId) ?? null,
    [termsForYear, selectedTermId]
  );

  const monthOptions = useMemo<string[]>(() => {
    if (selectedTerm?.months?.length) return selectedTerm.months;
    return MONTHS;
  }, [selectedTerm]);

  // Default the month to the current calendar month if it is valid for the
  // term, otherwise the first available month.
  useEffect(() => {
    if (monthOptions.length === 0) return;
    if (!selectedMonth || !monthOptions.includes(selectedMonth)) {
      const currentMonth = MONTHS[new Date().getMonth()];
      setSelectedMonth(monthOptions.includes(currentMonth) ? currentMonth : monthOptions[0]);
    }
  }, [monthOptions, selectedMonth]);

  const handleSelectYear = useCallback((yearId: string) => {
    setSelectedYearId(yearId);
    setSelectedTermId(null);
    setSelectedMonth('');
  }, []);

  const handleSelectTerm = useCallback((termId: string) => {
    setSelectedTermId(termId);
    setSelectedMonth('');
  }, []);

  // ── The selected period's data ───────────────────────────────────────────
  const {
    data: rows,
    isLoading: rowsLoading,
    error: rowsError,
  } = useMonitorMarksEntries({
    termId: selectedTermId,
    month: selectedMonth || null,
    examType,
    teacherId: teacherFilter || null,
    className: classFilter || null,
    subjectId: null,
    status: statusFilter === 'all' ? null : statusFilter,
  });

  const summary = useMemo(() => summarizeMonitorMarks(rows ?? []), [rows]);
  const classOptions = useMemo(() => monitorMarksClassOptions(rows ?? []), [rows]);
  const subjectOptions = useMemo(() => monitorMarksSubjectOptions(rows ?? []), [rows]);
  const teacherOptions = useMemo(() => monitorMarksTeacherOptions(rows ?? []), [rows]);

  const visibleRows = useMemo(
    () =>
      sortMonitorMarksRows(
        filterMonitorMarksRows(rows ?? [], {
          status: statusFilter,
          className: classFilter || null,
          subjectName: subjectFilter || null,
          teacherId: teacherFilter || null,
          search,
        }),
        sort
      ),
    [rows, statusFilter, classFilter, subjectFilter, teacherFilter, search, sort]
  );

  const listLoading = resolvingPeriod || rowsLoading;
  const hasFilters =
    statusFilter !== 'all' || !!classFilter || !!subjectFilter || !!teacherFilter || !!search.trim();

  const statCards = [
    { key: 'all', label: t('marksMonitoring.summaryAll'), value: summary.all, icon: Users, tone: 'bg-slate-100 text-slate-700' },
    { key: 'complete', label: t('marksMonitoring.summaryComplete'), value: summary.complete, icon: CheckCircle2, tone: 'bg-emerald-100 text-emerald-700' },
    { key: 'inProgress', label: t('marksMonitoring.summaryInProgress'), value: summary.inProgress, icon: Clock, tone: 'bg-amber-100 text-amber-700' },
    { key: 'notStarted', label: t('marksMonitoring.summaryNotStarted'), value: summary.notStarted, icon: XCircle, tone: 'bg-rose-100 text-rose-700' },
  ];

  const handleSendReminder = useCallback(
    (_row: MonitorMarksRow) => {
      addToast({
        type: 'info',
        title: t('marksMonitoring.reminderTitle'),
        description: t('marksMonitoring.reminderBody'),
      });
    },
    [addToast, t]
  );

  const detailMissing = useMemo(
    () => (selectedDetail ? missingMonthlyComponents(selectedDetail) : []),
    [selectedDetail]
  );

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700">
            <ClipboardList className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{t('marksMonitoring.title')}</h1>
            <p className="mt-1 text-sm leading-5 text-slate-500">{t('marksMonitoring.subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Period selectors */}
      <section
        aria-label={t('marksMonitoring.periodSection')}
        className="mb-4 grid min-w-0 gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-4"
      >
        <div className="min-w-0">
          <label
            htmlFor="monitor-year"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <CalendarRange className="h-3.5 w-3.5" /> {t('marksMonitoring.academicYear')}
          </label>
          <div className="relative">
            <select
              id="monitor-year"
              value={selectedYearId ?? ''}
              onChange={(e) => handleSelectYear(e.target.value)}
              className="h-12 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-base font-bold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {years.map((year) => (
                <option key={year.id} value={year.id}>{year.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-term"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <CalendarRange className="h-3.5 w-3.5" /> {t('marksMonitoring.term')}
          </label>
          <div className="relative">
            <select
              id="monitor-term"
              value={selectedTermId ?? ''}
              onChange={(e) => handleSelectTerm(e.target.value)}
              className="h-12 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-base font-bold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {termsForYear.map((term) => (
                <option key={term.id} value={term.id}>{term.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-month"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <CalendarRange className="h-3.5 w-3.5" /> {t('marksMonitoring.month')}
          </label>
          <div className="relative">
            <select
              id="monitor-month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="h-12 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-base font-bold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {monthOptions.map((month) => (
                <option key={month} value={month}>{month}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-exam-type"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <ClipboardList className="h-3.5 w-3.5" /> {t('marksMonitoring.examType')}
          </label>
          <div className="relative">
            <select
              id="monitor-exam-type"
              value={examType}
              onChange={(e) => setExamType(e.target.value)}
              className="h-12 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-base font-bold text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="Monthly">{t('marksMonitoring.examTypeMonthly')}</option>
              <option value="Midterm">Midterm</option>
              <option value="Final">Final</option>
              <option value="CA">CA</option>
              <option value="Homework">Homework</option>
              <option value="Classwork">Classwork</option>
              <option value="Quiz">Quiz</option>
              <option value="Attendance">Attendance</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
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
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-label={t('marksMonitoring.progressTitle')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-900">{t('marksMonitoring.progressTitle')}</p>
          <p className="text-sm text-slate-500">
            {listLoading ? (
              t('lessonReview.loadingPlans')
            ) : (
              <>
                <span className="font-semibold text-slate-700">{summary.avgCompletion}%</span>{' '}
                {t('marksMonitoring.avgCompletion')}
              </>
            )}
          </p>
        </div>
        <div
          className="h-3 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={summary.avgCompletion}
          aria-label={t('marksMonitoring.progressTitle')}
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              summary.avgCompletion === 100 ? 'bg-emerald-500' : summary.avgCompletion >= 50 ? 'bg-indigo-500' : 'bg-amber-500'
            )}
            style={{ width: `${summary.avgCompletion}%` }}
          />
        </div>
        <p className="mt-2 text-sm font-semibold text-slate-700">{summary.avgCompletion}%</p>
      </section>

      {/* Filters */}
      <section
        aria-label={t('marksMonitoring.filters')}
        className="mb-4 grid min-w-0 gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3 xl:grid-cols-6"
      >
        <div className="min-w-0">
          <label
            htmlFor="monitor-status-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Filter className="h-3.5 w-3.5" /> {t('marksMonitoring.status')}
          </label>
          <div className="relative">
            <select
              id="monitor-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as MonitorMarksStatusFilter)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="all">{t('marksMonitoring.allStatuses')}</option>
              <option value="complete">{t('marksMonitoring.statusComplete')}</option>
              <option value="in_progress">{t('marksMonitoring.statusInProgress')}</option>
              <option value="not_started">{t('marksMonitoring.statusNotStarted')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-class-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Users className="h-3.5 w-3.5" /> {t('marksMonitoring.class')}
          </label>
          <div className="relative">
            <select
              id="monitor-class-filter"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">{t('marksMonitoring.allClasses')}</option>
              {classOptions.map((className) => (
                <option key={className} value={className}>{className}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-subject-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <ClipboardList className="h-3.5 w-3.5" /> {t('marksMonitoring.subject')}
          </label>
          <div className="relative">
            <select
              id="monitor-subject-filter"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">{t('marksMonitoring.allSubjects')}</option>
              {subjectOptions.map((subject) => (
                <option key={subject} value={subject}>{subject}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-teacher-filter"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Users className="h-3.5 w-3.5" /> {t('marksMonitoring.teacher')}
          </label>
          <div className="relative">
            <select
              id="monitor-teacher-filter"
              value={teacherFilter}
              onChange={(e) => setTeacherFilter(e.target.value)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-300 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">{t('marksMonitoring.allTeachers')}</option>
              {teacherOptions.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>{teacher.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-search"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <Search className="h-3.5 w-3.5" /> {t('marksMonitoring.searchTeacher')}
          </label>
          <input
            id="monitor-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('marksMonitoring.searchPlaceholder')}
            className="h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div className="min-w-0">
          <label
            htmlFor="monitor-sort"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            <ClipboardList className="h-3.5 w-3.5" /> {t('marksMonitoring.sort')}
          </label>
          <div className="relative">
            <select
              id="monitor-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as MonitorMarksSort)}
              className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-slate-200 bg-white pl-3 pr-9 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="attention-first">{t('marksMonitoring.sortAttentionFirst')}</option>
              <option value="name">{t('marksMonitoring.sortName')}</option>
              <option value="completion">{t('marksMonitoring.sortCompletion')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
      </section>

      {/* Errors must not look like "everybody missing". */}
      {!!rowsError && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-bold">{t('marksMonitoring.dataErrorTitle')}</p>
          <p className="mt-1">{t('marksMonitoring.dataErrorBody')}</p>
        </div>
      )}

      {/* Entries list */}
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white">
        {listLoading && (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('lessonReview.loadingPlans')}
          </div>
        )}

        {!listLoading && (rows ?? []).length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">{t('marksMonitoring.noEntries')}</div>
        )}

        {!listLoading && (rows ?? []).length > 0 && visibleRows.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">{t('marksMonitoring.noMatches')}</div>
        )}

        {!listLoading && visibleRows.length > 0 && (
          <>
            {/* Desktop / tablet: the full table */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[780px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.teacher')}</th>
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.class')}</th>
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.subject')}</th>
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.examColumn')}</th>
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.status')}</th>
                    <th scope="col" className="px-4 py-3">{t('marksMonitoring.completion')}</th>
                    <th scope="col" className="px-4 py-3 text-right">{t('marksMonitoring.action')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((row) => (
                    <tr key={`${row.teacherId}-${row.subjectId}-${row.className}`} className="align-middle hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{row.teacherName}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{row.className}</td>
                      <td className="px-4 py-3 text-slate-600">{row.subjectName || row.subjectId}</td>
                      <td className="px-4 py-3 text-slate-600">{row.examType}</td>
                      <td className="px-4 py-3"><StatusPill status={row.status} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{row.enteredStudents}/{row.expectedStudents}</span>
                          <span className="text-slate-400">{t('marksMonitoring.completionCount')}</span>
                          <span className="text-slate-500">· {row.completionPercent}%</span>
                        </div>
                        <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              row.status === 'complete' ? 'bg-emerald-500' : row.status === 'in_progress' ? 'bg-amber-500' : 'bg-rose-500'
                            )}
                            style={{ width: `${row.completionPercent}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedDetail(row)}
                          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
                        >
                          {t('marksMonitoring.details')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: compact cards instead of a wide table */}
            <div className="divide-y divide-slate-100 sm:hidden">
              {visibleRows.map((row) => (
                <div key={`${row.teacherId}-${row.subjectId}-${row.className}`} className="p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{row.teacherName}</p>
                      <p className="mt-0.5 text-sm text-slate-500">
                        {row.className} · {row.subjectName || row.subjectId}
                      </p>
                      <p className="text-xs text-slate-400">{row.examType}</p>
                    </div>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{row.enteredStudents}/{row.expectedStudents}</span>
                      <span className="text-xs text-slate-400">{t('marksMonitoring.completionCount')}</span>
                      <span className="text-sm text-slate-500">· {row.completionPercent}%</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedDetail(row)}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
                    >
                      {t('marksMonitoring.details')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {!listLoading && hasFilters && visibleRows.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-400">
            {visibleRows.length} of {(rows ?? []).length} {t('marksMonitoring.entries')}
          </div>
        )}
      </div>

      {/* Teacher / entry detail modal */}
      {selectedDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/30 p-4">
          <div className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{t('marksMonitoring.detailTitle')}</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {selectedDetail.className} · {selectedDetail.teacherName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetail(null)}
                className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-slate-200"
              >
                {t('marksMonitoring.close')}
              </button>
            </div>
            <div className="space-y-4 px-5 py-5 text-sm text-slate-700">
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailCard label={t('marksMonitoring.subject')} value={selectedDetail.subjectName || selectedDetail.subjectId} />
                <DetailCard label={t('marksMonitoring.exam')} value={selectedDetail.examType} />
              </div>

              <div className="rounded-3xl bg-slate-50 p-4">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.28em] text-slate-500">
                  <span>{t('marksMonitoring.completionPercent')}</span>
                  <span>{selectedDetail.completionPercent}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      selectedDetail.status === 'complete' ? 'bg-emerald-500' : selectedDetail.status === 'in_progress' ? 'bg-amber-500' : 'bg-rose-500'
                    )}
                    style={{ width: `${selectedDetail.completionPercent}%` }}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <DetailCard label={t('marksMonitoring.expectedStudents')} value={selectedDetail.expectedStudents} />
                <DetailCard label={t('marksMonitoring.enteredStudents')} value={selectedDetail.enteredStudents} />
                <DetailCard label={t('marksMonitoring.missingStudents')} value={Math.max(0, selectedDetail.expectedStudents - selectedDetail.enteredStudents)} />
              </div>

              <div className="rounded-3xl bg-slate-100 p-4">
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{t('marksMonitoring.lastUpdate')}</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">{formatLastUpdate(selectedDetail.lastUpdate)}</p>
              </div>

              {examType === 'Monthly' && (
                <div className="rounded-3xl bg-slate-100 p-4">
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500">{t('marksMonitoring.missingComponents')}</p>
                  {detailMissing.length === 0 ? (
                    <p className="mt-2 text-sm text-emerald-700">{t('marksMonitoring.noMissing')}</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {detailMissing.map((component) => (
                        <li key={component} className="flex items-center gap-1.5 text-sm text-rose-700">
                          <AlertTriangle className="h-3.5 w-3.5" /> {component}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex justify-end">
                {selectedDetail.status !== 'complete' && (
                  <button
                    type="button"
                    onClick={() => handleSendReminder(selectedDetail)}
                    className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    {t('marksMonitoring.sendReminder')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-3xl bg-slate-50 p-4">
      <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}
