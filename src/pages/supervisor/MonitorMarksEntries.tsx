import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock3,
  Filter,
  Loader2,
  Search,
  UserRound,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { getAcademicYears, getTerms } from '../../lib/db/academic';
import { useMarksEntryTracking } from '../../lib/hooks/useMarksEntryTracking';
import {
  filterMarksEntryRows,
  marksEntryFilterOptions,
  marksScopeLabel,
  sortMarksEntryRows,
  statusLabel,
  summarizeMarksEntryRows,
  type MarksEntryFilters,
  type MarksEntryRow,
  type MarksEntrySort,
  type MarksEntryStatus,
  type MarksExamScope,
} from '../../lib/marksEntryTracking';
import { MONTHS, type AcademicYear, type Term } from '../../types';
import { useI18n } from '../../lib/i18n/AppLanguageContext';

const STATUS_FILTERS: Array<{ value: MarksEntryFilters['status']; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'complete', label: 'Complete' },
];

const SCOPE_OPTIONS: Array<{ value: MarksExamScope; label: string }> = [
  { value: 'monthly', label: 'Monthly coursework + quiz' },
  { value: 'midterm', label: 'Midterm' },
  { value: 'final', label: 'Final' },
  { value: 'ca', label: 'CA' },
  { value: 'homework', label: 'Homework' },
  { value: 'classwork', label: 'Classwork' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'discipline', label: 'Akhlaaq / Discipline' },
];

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function StatusBadge({ status }: { status: MarksEntryStatus }) {
  const Icon = status === 'complete' ? CheckCircle2 : status === 'in_progress' ? Clock3 : XCircle;
  const tone = status === 'complete' ? 'theme-status-success' : status === 'in_progress' ? 'theme-status-warning' : 'theme-status-danger';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold', tone)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {statusLabel(status)}
    </span>
  );
}

function CompletionBar({ row }: { row: MarksEntryRow }) {
  const color = row.status === 'complete' ? 'bg-emerald-500' : row.status === 'in_progress' ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="min-w-36">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-700">{row.enteredStudents}/{row.expectedStudents} students</span>
        <span className="font-bold text-slate-500">{row.percentage}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.percentage}
        aria-label={`${row.percentage}% complete`}
      >
        <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${row.percentage}%` }} />
      </div>
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  children,
  icon: Icon = Filter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  icon?: typeof Filter;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border bg-white px-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-200"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      </div>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border bg-slate-50 p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
    </div>
  );
}

function EntryDetails({ row, onClose }: { row: MarksEntryRow; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const monthly = row.examScope === 'monthly';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="marks-entry-detail-title"
        className="theme-surface w-full max-w-2xl overflow-hidden rounded-3xl"
      >
        <div className="flex items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">Entry details</p>
            <h2 id="marks-entry-detail-title" className="mt-1 truncate text-xl font-bold text-slate-900">{row.subjectName}</h2>
            <p className="mt-1 text-sm text-slate-500">{row.teacherName} · {row.className}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" className="rounded-xl border p-2 text-slate-500 hover:text-slate-900">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="max-h-[calc(100vh-10rem)] space-y-5 overflow-y-auto p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">{marksScopeLabel(row.examScope)}{row.month ? ` · ${row.month}` : ''}</p>
              <p className="mt-1 text-xs text-slate-500">Last update: {formatDateTime(row.lastUpdated)}</p>
            </div>
            <StatusBadge status={row.status} />
          </div>

          <div className="rounded-2xl border bg-slate-50 p-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="font-bold text-slate-800">Completion</span>
              <span className="font-bold text-slate-600">{row.percentage}%</span>
            </div>
            <CompletionBar row={row} />
            {monthly && (
              <p className="mt-3 text-xs leading-5 text-slate-500">
                Monthly completion follows the existing rule: coursework is CA for every student or Homework plus Classwork for every student, and Quiz for every student. Homework (CA) counts Homework records together with legacy CA records; Quiz counts every quiz record, including bulk-uploaded monthly tests labelled MT. The percentage is the same blended component coverage used by the existing teacher monitor.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DetailMetric label="Expected" value={row.expectedStudents} />
            <DetailMetric label={monthly ? 'Complete students' : 'Entered'} value={row.enteredStudents} />
            <DetailMetric label="Missing" value={row.missingStudents.length} />
            <DetailMetric label="Last update" value={row.lastUpdated ? formatDateTime(row.lastUpdated).split(',')[0] : '—'} />
          </div>

          {monthly && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="monthly-components">
              <DetailMetric label="Homework (CA)" value={`${row.homeworkEntered}/${row.expectedStudents}`} />
              <DetailMetric label="Classwork" value={`${row.classworkEntered}/${row.expectedStudents}`} />
              <DetailMetric label="Quiz" value={`${row.quizEntered}/${row.expectedStudents}`} />
              <DetailMetric label="Attendance" value={`${row.attendanceEntered}/${row.expectedStudents}`} />
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-slate-900">Missing students</h3>
              <span className="text-xs text-slate-500">{row.missingStudents.length} not complete</span>
            </div>
            {row.missingStudents.length === 0 ? (
              <div className="theme-status-success rounded-xl border p-3 text-sm font-semibold">Every active term-roster student has the required entry.</div>
            ) : (
              <ul className="max-h-48 space-y-2 overflow-y-auto rounded-xl border p-3">
                {row.missingStudents.map((student) => (
                  <li key={student.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold text-slate-800">{student.name}</span>
                    <span className="text-xs text-slate-500">ID {student.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs leading-5 text-slate-500">Expected students come from the selected term roster and students marked LEFT are excluded. Existing pending, approved, rejected, scored, absent, and not-applicable exam records are counted once as explicit entry records.</p>
        </div>
      </section>
    </div>
  );
}

export function MonitorMarksEntries() {
  const { t } = useI18n();
  const [selectedYearId, setSelectedYearId] = useState('');
  const [selectedTermId, setSelectedTermId] = useState('');
  const [examScope, setExamScope] = useState<MarksExamScope>('monthly');
  const [month, setMonth] = useState('');
  const [status, setStatus] = useState<MarksEntryFilters['status']>('all');
  const [teacherId, setTeacherId] = useState('');
  const [className, setClassName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MarksEntrySort>('status');
  const [selectedRow, setSelectedRow] = useState<MarksEntryRow | null>(null);

  const yearsQuery = useQuery({
    queryKey: ['academicYears', 'marksMonitor'],
    queryFn: getAcademicYears,
    staleTime: 1000 * 60 * 10,
  });
  const termsQuery = useQuery({
    queryKey: ['terms', 'marksMonitor'],
    queryFn: getTerms,
    staleTime: 1000 * 60 * 10,
  });

  const years = yearsQuery.data ?? [];
  const terms = termsQuery.data ?? [];
  const selectedTerm = useMemo(
    () => terms.find((term) => term.id === selectedTermId) ?? null,
    [selectedTermId, terms],
  );
  const termOptions = useMemo(
    () => terms.filter((term) => !selectedYearId || term.academicYearId === selectedYearId),
    [selectedYearId, terms],
  );

  useEffect(() => {
    if (years.length === 0) return;
    setSelectedYearId((current) => current && years.some((year) => year.id === current)
      ? current
      : (years.find((year) => year.isCurrent)?.id ?? years[0].id));
  }, [years]);

  useEffect(() => {
    if (termOptions.length === 0) {
      setSelectedTermId('');
      return;
    }
    setSelectedTermId((current) => current && termOptions.some((term) => term.id === current)
      ? current
      : (termOptions.find((term) => term.isCurrent)?.id ?? termOptions[0].id));
  }, [termOptions]);

  const termMonths = useMemo(() => {
    const configured = selectedTerm?.months?.filter(Boolean) ?? [];
    return Array.from(new Set(configured.length > 0 ? configured : MONTHS));
  }, [selectedTerm]);
  // Monthly/coursework scopes are month-scoped in the existing exams workflow;
  // Midterm and Final are term-scoped and must not inherit a stale month.
  const monthIsApplicable = examScope !== 'midterm' && examScope !== 'final';

  useEffect(() => {
    if (!monthIsApplicable || termMonths.length === 0) return;
    setMonth((current) => current && (current === '' || termMonths.includes(current))
      ? current
      : (termMonths.includes(MONTHS[new Date().getMonth()]) ? MONTHS[new Date().getMonth()] : termMonths[0]));
  }, [monthIsApplicable, termMonths]);

  const query = selectedYearId && selectedTermId
    ? { academicYearId: selectedYearId, termId: selectedTermId, examScope, month: monthIsApplicable ? month || null : null }
    : null;
  const trackingQuery = useMarksEntryTracking(query);
  const rows = trackingQuery.data ?? [];
  const filters = useMemo<MarksEntryFilters>(() => ({ status, teacherId, className, subjectId, search }), [status, teacherId, className, subjectId, search]);
  const visibleRows = useMemo(
    () => sortMarksEntryRows(filterMarksEntryRows(rows, filters), sort),
    [filters, rows, sort],
  );
  const summary = useMemo(() => summarizeMarksEntryRows(rows), [rows]);
  const filterOptions = useMemo(() => marksEntryFilterOptions(rows), [rows]);
  const loading = yearsQuery.isLoading || termsQuery.isLoading || trackingQuery.isLoading;
  const setupError = yearsQuery.error || termsQuery.error;
  const dataError = trackingQuery.error;
  const hasFilters = status !== 'all' || Boolean(teacherId || className || subjectId || search.trim());

  const resetRowFilters = () => {
    setStatus('all');
    setTeacherId('');
    setClassName('');
    setSubjectId('');
    setSearch('');
  };

  const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Please refresh and try again.';

  const statCards = [
    { label: t('marksMonitor.totalAssignments', 'Assignments'), value: summary.totalAssignments, icon: ClipboardList, tone: 'bg-slate-100 text-slate-700' },
    { label: t('marksMonitor.complete', 'Complete'), value: summary.complete, icon: CheckCircle2, tone: 'bg-emerald-100 text-emerald-700' },
    { label: t('marksMonitor.inProgress', 'In Progress'), value: summary.inProgress, icon: Clock3, tone: 'bg-amber-100 text-amber-700' },
    { label: t('marksMonitor.notStarted', 'Not Started'), value: summary.notStarted, icon: XCircle, tone: 'bg-rose-100 text-rose-700' },
    { label: t('marksMonitor.averageCompletion', 'Average completion'), value: `${summary.averagePercentage}%`, icon: BarChart3, tone: 'bg-indigo-100 text-indigo-700' },
  ];

  return (
    <div className="theme-ornamented mx-auto max-w-7xl p-0 sm:p-1">
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-2xl bg-indigo-100 p-3 text-indigo-700">
            <BarChart3 className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{t('marksMonitor.title', 'Monitor Marks Entries')}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-500">{t('marksMonitor.subtitle', 'Track mark-entry completion by academic period, teacher, class, subject, and exam workflow.')}</p>
          </div>
        </div>
      </div>

      <section aria-label="Academic period and exam scope" className="theme-surface mb-4 rounded-2xl p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-indigo-600" aria-hidden />
          <h2 className="text-sm font-bold text-slate-900">Academic period</h2>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField id="marks-academic-year" label="Academic year" value={selectedYearId} onChange={(value) => { setSelectedYearId(value); setSelectedTermId(''); }} icon={CalendarDays}>
            {years.length === 0 && <option value="">{yearsQuery.isLoading ? 'Loading…' : 'No academic years'}</option>}
            {years.map((year: AcademicYear) => <option key={year.id} value={year.id}>{year.name}{year.isCurrent ? ' · current' : ''}</option>)}
          </SelectField>
          <SelectField id="marks-term" label="Term" value={selectedTermId} onChange={setSelectedTermId} icon={CalendarDays}>
            {termOptions.length === 0 && <option value="">{termsQuery.isLoading ? 'Loading…' : 'No terms'}</option>}
            {termOptions.map((term: Term) => <option key={term.id} value={term.id}>{term.name}{term.isCurrent ? ' · current' : ''}</option>)}
          </SelectField>
          <SelectField id="marks-exam-scope" label="Exam workflow" value={examScope} onChange={(value) => {
            const nextScope = value as MarksExamScope;
            setExamScope(nextScope);
            if (nextScope === 'midterm' || nextScope === 'final') setMonth('');
          }} icon={BookOpen}>
            {SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </SelectField>
          <div className="min-w-0">
            <label htmlFor="marks-month" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"><CalendarDays className="h-3.5 w-3.5" aria-hidden /> Month{monthIsApplicable ? '' : ' (not applicable)'}</label>
            <div className="relative">
              <select
                id="marks-month"
                value={monthIsApplicable ? month : ''}
                onChange={(event) => setMonth(event.target.value)}
                disabled={!monthIsApplicable}
                className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border bg-white px-3 pr-9 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">{monthIsApplicable ? 'All months' : 'Not applicable for this workflow'}</option>
                {monthIsApplicable && termMonths.map((termMonth) => <option key={termMonth} value={termMonth}>{termMonth}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            </div>
          </div>
        </div>
        {examScope === 'monthly' && (
          <p className="mt-3 text-xs leading-5 text-slate-500">Monthly uses the existing coursework rule: CA, or Homework plus Classwork, together with Quiz. Homework (CA) counts Homework and legacy CA records; every quiz record counts toward Quiz, including bulk-uploaded monthly tests labelled MT, matching the monthly report.</p>
        )}
      </section>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {statCards.map((card) => (
          <div key={card.label} className="theme-surface min-w-0 rounded-2xl p-3 sm:p-4">
            <div className="flex items-center gap-2">
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', card.tone)}><card.icon className="h-4 w-4" aria-hidden /></span>
              <p className="truncate text-xs font-bold uppercase tracking-wide text-slate-500">{card.label}</p>
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">{loading ? '…' : card.value}</p>
          </div>
        ))}
      </div>

      <section className="theme-surface mb-4 rounded-2xl p-4 sm:p-5" aria-label="Marks completion summary">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-900">{marksScopeLabel(examScope)} progress</p>
          <p className="text-sm text-slate-500"><span className="font-bold text-slate-700">{summary.enteredStudents} of {summary.expectedStudents}</span> student rows complete across the visible assignments</p>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.averagePercentage} aria-label="Average marks completion">
          <div className={cn('h-full rounded-full transition-all duration-500', summary.averagePercentage === 100 ? 'bg-emerald-500' : summary.averagePercentage > 0 ? 'bg-indigo-500' : 'bg-slate-400')} style={{ width: `${summary.averagePercentage}%` }} />
        </div>
        <p className="mt-2 text-xs text-slate-500">Average row completion: <span className="font-bold text-slate-700">{summary.averagePercentage}%</span></p>
      </section>

      <section aria-label="Marks entry filters" className="theme-surface mb-4 grid min-w-0 gap-3 rounded-2xl p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-5">
        <SelectField id="marks-status-filter" label="Status" value={status} onChange={(value) => setStatus(value as MarksEntryFilters['status'])}>
          {STATUS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectField>
        <SelectField id="marks-teacher-filter" label="Teacher" value={teacherId} onChange={setTeacherId} icon={UserRound}>
          <option value="">All teachers</option>
          {filterOptions.teachers.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </SelectField>
        <SelectField id="marks-class-filter" label="Class" value={className} onChange={setClassName} icon={Users}>
          <option value="">All classes</option>
          {filterOptions.classes.map((option) => <option key={option} value={option}>{option}</option>)}
        </SelectField>
        <SelectField id="marks-subject-filter" label="Subject" value={subjectId} onChange={setSubjectId} icon={BookOpen}>
          <option value="">All subjects</option>
          {filterOptions.subjects.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </SelectField>
        <div className="min-w-0">
          <label htmlFor="marks-search" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"><Search className="h-3.5 w-3.5" aria-hidden /> Search</label>
          <input id="marks-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Teacher, class, or subject…" className="h-11 w-full rounded-xl border px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div className="min-w-0 sm:col-span-2 lg:col-span-5 lg:flex lg:items-end lg:justify-between">
          <SelectField id="marks-sort" label="Sort" value={sort} onChange={(value) => setSort(value as MarksEntrySort)} icon={ClipboardList}>
            <option value="status">Status · missing first</option>
            <option value="name">Teacher, class, subject</option>
            <option value="latest">Latest update</option>
            <option value="percentage">Completion percentage</option>
          </SelectField>
          {hasFilters && <button type="button" onClick={resetRowFilters} className="mt-3 inline-flex h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-bold text-slate-600 hover:text-slate-900 lg:mt-0">Clear row filters</button>}
        </div>
      </section>

      {setupError && (
        <div className="theme-status-danger mb-4 rounded-2xl border p-4" role="alert">
          <p className="font-bold">Could not load the academic period</p>
          <p className="mt-1 text-sm">{errorMessage(setupError)}</p>
        </div>
      )}
      {dataError && (
        <div className="theme-status-danger mb-4 rounded-2xl border p-4" role="alert">
          <p className="font-bold">Could not load marks-entry monitoring</p>
          <p className="mt-1 text-sm">{errorMessage(dataError)}</p>
          <p className="mt-2 text-xs">The monitor does not substitute an unscoped client query when its secured database function is unavailable.</p>
        </div>
      )}

      {loading ? (
        <div className="theme-surface flex min-h-52 items-center justify-center rounded-2xl p-8" role="status">
          <div className="flex items-center gap-3 text-sm font-semibold text-slate-500"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Loading assignments and term roster…</div>
        </div>
      ) : !dataError && rows.length === 0 ? (
        <div className="theme-surface rounded-2xl p-10 text-center">
          <ClipboardList className="mx-auto h-10 w-10 text-slate-400" aria-hidden />
          <h2 className="mt-3 text-lg font-bold text-slate-900">No assigned class-subjects found</h2>
          <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">No teacher/class/subject assignments are available for this academic period and supervisor scope. A teacher profile without a class-subject assignment is intentionally not expected.</p>
        </div>
      ) : !dataError && visibleRows.length === 0 ? (
        <div className="theme-surface rounded-2xl p-10 text-center">
          <Filter className="mx-auto h-10 w-10 text-slate-400" aria-hidden />
          <h2 className="mt-3 text-lg font-bold text-slate-900">No assignments match these filters</h2>
          <button type="button" onClick={resetRowFilters} className="mt-4 rounded-xl border px-4 py-2 text-sm font-bold text-slate-700 hover:text-slate-900">Clear filters</button>
        </div>
      ) : (
        <>
          <div className="theme-surface hidden overflow-hidden rounded-2xl lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="border-b bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Teacher</th>
                    <th className="px-4 py-3">Class</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">Exam / month</th>
                    <th className="px-4 py-3">Completion</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Last update</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((row) => (
                    <tr key={row.assignmentId} className="align-middle hover:bg-slate-50">
                      <td className="px-4 py-4 font-semibold text-slate-900">{row.teacherName}</td>
                      <td className="px-4 py-4 text-slate-600">{row.className}</td>
                      <td className="px-4 py-4 text-slate-600">{row.subjectName}</td>
                      <td className="px-4 py-4 text-slate-600"><span className="font-semibold text-slate-800">{marksScopeLabel(row.examScope)}</span><span className="block text-xs text-slate-500">{row.month || 'All months'}</span></td>
                      <td className="px-4 py-4"><CompletionBar row={row} /></td>
                      <td className="px-4 py-4"><StatusBadge status={row.status} /></td>
                      <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{formatDateTime(row.lastUpdated)}</td>
                      <td className="px-4 py-4 text-right"><button type="button" onClick={() => setSelectedRow(row)} className="rounded-xl border px-3 py-2 text-xs font-bold text-slate-700 hover:text-slate-900">View details</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 lg:hidden">
            {visibleRows.map((row) => (
              <article key={row.assignmentId} className="theme-surface rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-bold text-slate-900">{row.subjectName}</h2>
                    <p className="mt-1 text-sm text-slate-500">{row.teacherName} · {row.className}</p>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-500"><span>{marksScopeLabel(row.examScope)} · {row.month || 'All months'}</span><span>{formatDateTime(row.lastUpdated)}</span></div>
                <div className="mt-3"><CompletionBar row={row} /></div>
                <button type="button" onClick={() => setSelectedRow(row)} className="mt-4 min-h-11 w-full rounded-xl border px-3 py-2 text-sm font-bold text-slate-700 hover:text-slate-900">View details · {row.missingStudents.length} missing</button>
              </article>
            ))}
          </div>
        </>
      )}

      {selectedRow && <EntryDetails row={selectedRow} onClose={() => setSelectedRow(null)} />}
    </div>
  );
}
