import { useEffect, useMemo, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import {
  useTeacherPlans,
  usePlanWithPeriods,
  usePeriodAiReviews,
  useLessonPlanQuizPreviews,
  useGenerateLessonPlanQuizzes,
} from '../../lib/hooks/useLessonPlans';
import { useUnitPlansByClass } from '../../lib/hooks/useUnitPlans';
import { LessonPlanPeriod, PlanStatus, Subject, DAYS_OF_WEEK, isPlanEditable } from '../../types';
import {
  FileText, CheckCircle, Clock, AlertTriangle, XCircle,
  ChevronLeft, ChevronRight, Pencil, Search, FolderOpen, Loader2, Unlock, CalendarRange,
  HelpCircle, RotateCcw,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { PlanReadView, ReadPeriod } from '../../components/lesson-planner/PlanReadView';
import { ExportLessonPlanPdfButton } from '../../components/lesson-planner/ExportLessonPlanPdfButton';
import { LessonPlanPdfDocument } from '../shared/LessonPlanPdfDocument';
import { describePlanWeek } from '../../utils/weekDates';
import { getCurrentAcademicYear } from '../../lib/db/academic';
import { useToast } from '../../context/ToastContext';

const STATUS_META: Record<PlanStatus, { label: string; icon: typeof FileText; chip: string; help: string }> = {
  draft:      { label: 'Draft',      icon: Pencil,        chip: 'bg-slate-100 text-slate-600',     help: 'Not submitted yet — only you can see this.' },
  submitted:  { label: 'AI review pending', icon: Clock, chip: 'bg-blue-100 text-blue-700', help: 'Submitted and locked. AI review is running in the background.' },
  in_review:  { label: 'In review',  icon: Clock,         chip: 'bg-amber-100 text-amber-700',     help: 'Waiting on your supervisor\'s decision.' },
  approved:   { label: 'Approved',   icon: CheckCircle,   chip: 'bg-emerald-100 text-emerald-700', help: 'Your supervisor approved this plan.' },
  rejected:   { label: 'Revisions',  icon: XCircle,       chip: 'bg-rose-100 text-rose-700',       help: 'Your supervisor asked for revisions — see their comment.' },
  ai_failed:  { label: 'Needs review', icon: AlertTriangle, chip: 'bg-orange-100 text-orange-700', help: 'The review could not be completed. Your supervisor can still decide on this plan.' },
  revision_requested: { label: 'Revisions requested', icon: Unlock, chip: 'bg-amber-100 text-amber-700', help: 'Your supervisor reopened this plan — you can edit and resubmit it.' },
};

function toReadPeriods(periods: LessonPlanPeriod[]): ReadPeriod[] {
  return periods.map((p) => ({
    day: p.day,
    period_number: p.period_number,
    subject: p.subject || '',
    className: p.class_name || '',
    isFree: !!p.is_free,
    topic: p.topic || '',
    objective: p.objective || '',
    slide_number: p.slide_number || '',
    details: p.details || [],
  }));
}

interface SubmittedPlansViewProps {
  subjects?: Subject[];
  /** Load a plan back into the editor */
  onEditPlan?: (planId: string) => void;
  onBack?: () => void;
}

/**
 * "My Lesson Plans" — browse every plan you have created and open a
 * read-only view of any submitted plan, with its AI review and a PDF export.
 */
export function SubmittedPlansView({ subjects, onEditPlan, onBack }: SubmittedPlansViewProps) {
  const { session } = useRole();
  const { data: plans, isLoading } = useTeacherPlans(session?.userId);
  const [statusFilter, setStatusFilter] = useState<PlanStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [yearStart, setYearStart] = useState<string | null>(null);

  useEffect(() => {
    getCurrentAcademicYear().then((ay) => setYearStart(ay?.startDate ?? null));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plans || []).filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!q) return true;
      return `${p.title} ${p.class_name} ${p.week_label}`.toLowerCase().includes(q);
    });
  }, [plans, statusFilter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: plans?.length || 0 };
    for (const p of plans || []) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [plans]);

  if (selectedId) {
    return (
      <PlanDetail
        planId={selectedId}
        subjects={subjects}
        yearStart={yearStart}
        onBack={() => setSelectedId(null)}
        onEditPlan={onEditPlan}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-100 text-violet-700">
            <FolderOpen className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">My Lesson Plans</h2>
            <p className="text-sm text-slate-500">Open any plan to read it, check the AI review, or export a PDF.</p>
          </div>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, class or week"
            className="pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm w-full sm:w-72 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
          />
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'draft', 'submitted', 'in_review', 'revision_requested', 'approved', 'rejected', 'ai_failed'] as const).map((key) => {
          const label = key === 'all' ? 'All' : STATUS_META[key as PlanStatus].label;
          const n = counts[key] || 0;
          return (
            <button
              key={key}
              onClick={() => setStatusFilter(key as PlanStatus | 'all')}
              className={cn(
                'px-3.5 py-1.5 rounded-xl text-sm font-medium border transition-all',
                statusFilter === key
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200 ring-2 ring-offset-1 ring-indigo-100'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
              )}
            >
              {label} <span className="text-xs opacity-60">({n})</span>
            </button>
          );
        })}
      </div>

      {/* Plan cards */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {isLoading && (
          <div className="p-10 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your plans…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="p-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-slate-300 mb-3" />
            <p className="font-medium text-slate-600">No lesson plans here yet</p>
            <p className="text-sm text-slate-400 mt-1">
              {statusFilter === 'all' ? 'Start on the first step to create one.' : 'Try a different filter.'}
            </p>
          </div>
        )}
        <div className="divide-y divide-slate-100">
          {filtered.map((plan) => {
            const meta = STATUS_META[plan.status];
            const Icon = meta.icon;
            return (
              <button
                key={plan.id}
                onClick={() => setSelectedId(plan.id)}
                className="w-full flex items-center gap-4 p-4 text-left hover:bg-slate-50 transition-colors"
              >
                <div className="p-2.5 rounded-xl bg-slate-100 text-slate-500 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{plan.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-1.5">
                    <span>{plan.class_name}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                      <CalendarRange className="w-3 h-3" />
                      {describePlanWeek(plan.week_label, yearStart)}
                    </span>
                    <span>·</span>
                    <span>{plan.period_count} periods/day</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-1">{meta.help}</p>
                </div>
                <span className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0', meta.chip)}>
                  <Icon className="w-3.5 h-3.5" />
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {onBack && (
        <div className="pt-4 border-t border-slate-200">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all"
          >
            <ChevronLeft className="w-4 h-4" /> Back to Review
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function PlanDetail({
  planId,
  subjects,
  yearStart,
  onBack,
  onEditPlan,
}: {
  planId: string;
  subjects?: Subject[];
  yearStart: string | null;
  onBack: () => void;
  onEditPlan?: (planId: string) => void;
}) {
  const { data, isLoading } = usePlanWithPeriods(planId);
  const aiReviewPending = data?.plan.status === 'submitted' || data?.plan.status === 'in_review';
  const { data: periodAiReviews = [] } = usePeriodAiReviews(planId, aiReviewPending);
  const { data: unitPlans = [] } = useUnitPlansByClass(data?.plan.class_name ?? null);
  const { data: quizPreviews = [] } = useLessonPlanQuizPreviews(planId);
  const generateQuizzesMut = useGenerateLessonPlanQuizzes();
  const { addToast } = useToast();
  const [quizzesOpen, setQuizzesOpen] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);

  const handleGenerateQuizzes = async () => {
    setQuizError(null);
    try {
      await generateQuizzesMut.mutateAsync(planId);
      setQuizzesOpen(true);
      addToast({
        type: 'success',
        title: quizPreviews.length > 0 ? 'New quiz set ready' : 'Quizzes generated',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to generate quizzes';
      setQuizError(message);
      addToast({ type: 'error', title: 'Failed to generate quizzes', description: message.slice(0, 400) });
    }
  };

  if (isLoading || !data) {
    return (
      <div className="p-12 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading plan…
      </div>
    );
  }

  const { plan, periods } = data;
  const meta = STATUS_META[plan.status];
  const Icon = meta.icon;
  const read = toReadPeriods(periods);
  // Locking (#1): only a draft or an explicitly reopened plan may be edited.
  const canEdit = isPlanEditable(plan.status);

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> All plans
        </button>
        <div className="flex items-center gap-2">
          {canEdit && onEditPlan && (
            <button
              onClick={() => onEditPlan(plan.id)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Pencil className="w-4 h-4" /> Edit plan
            </button>
          )}
          <ExportLessonPlanPdfButton
            document={<LessonPlanPdfDocument plan={plan} periods={periods} unitPlans={unitPlans} subjects={subjects} periodAiReviews={periodAiReviews} />}
            fileName={`${plan.title.replace(/[^a-z0-9]/gi, '_')}_${plan.class_name}_${plan.week_label}.pdf`}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
          />
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-900">{plan.title}</h2>
              <p className="text-sm text-slate-500 mt-1 flex flex-wrap items-center gap-x-2">
                <span>{plan.class_name}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                  <CalendarRange className="w-3.5 h-3.5" />
                  {describePlanWeek(plan.week_label, yearStart)}
                </span>
                <span>·</span>
                <span>{plan.period_count} periods/day</span>
              </p>
            </div>
            <span className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold', meta.chip)}>
              <Icon className="w-3.5 h-3.5" /> {meta.label}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-3 bg-slate-50 rounded-xl p-3">{meta.help}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <Stat label="Days" value={DAYS_OF_WEEK.length} />
            <Stat label="Periods planned" value={read.filter((p) => !p.isFree && p.topic.trim()).length} />
            <Stat label="Free periods" value={read.filter((p) => p.isFree).length} />
            <Stat label="Activities" value={read.reduce((n, p) => n + p.details.length, 0)} />
          </div>
        </div>

        <section className="no-print overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => setQuizzesOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-slate-50"
          >
            <span className="flex items-center gap-2 font-bold text-slate-900">
              <HelpCircle className="h-5 w-5 text-indigo-600" /> Student quizzes ({quizPreviews.length})
            </span>
            <ChevronRight className={cn('h-4 w-4 text-slate-400 transition-transform', quizzesOpen && 'rotate-90')} />
          </button>
          {quizzesOpen && (
            <div className="space-y-3 border-t border-slate-100 p-5">
              {quizError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                  <p className="font-semibold">Could not generate a new quiz set.</p>
                  <p className="mt-1 break-words">{quizError}</p>
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-indigo-800">
                  {quizPreviews.length > 0
                    ? 'Preview the current questions or replace them with a completely new validated set.'
                    : 'No generated quizzes are available yet. Create a student-focused set from this plan.'}
                </p>
                <button
                  type="button"
                  onClick={handleGenerateQuizzes}
                  disabled={generateQuizzesMut.isPending}
                  className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {generateQuizzesMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  {generateQuizzesMut.isPending
                    ? 'Generating new set…'
                    : quizPreviews.length > 0 ? 'Redo quiz set' : 'Generate quizzes'}
                </button>
              </div>

              {quizPreviews.map(({ quiz, questions }) => (
                <details key={quiz.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <summary className="cursor-pointer text-sm font-bold text-slate-800">
                    {quiz.title} · {questions.length} questions
                  </summary>
                  <ol className="mt-3 space-y-2 text-sm text-slate-700">
                    {questions.map((question, index) => (
                      <li key={question.id} className="rounded-lg bg-white p-3">
                        <p><span className="font-bold">{index + 1}.</span> {question.promptSnapshot}</p>
                        {question.optionsSnapshot?.length ? (
                          <ul className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                            {question.optionsSnapshot.map((option) => (
                              <li
                                key={option.label}
                                className={cn(
                                  'rounded-md border px-2 py-1',
                                  question.correctAnswerSnapshot === option.label
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'border-slate-200 bg-slate-50',
                                )}
                              >
                                <span className="font-bold">{option.label}.</span> {option.text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-xs font-medium text-slate-500">Direct answer</p>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </div>
          )}
        </section>

        <PlanReadView
          periods={read}
          periodCount={plan.period_count}
          subjects={subjects}
          planClassName={plan.class_name}
        />

      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3 text-center">
      <p className="text-xl font-bold text-slate-800">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}
