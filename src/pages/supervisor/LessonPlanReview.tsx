import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useSupervisorPlans, usePlanWithPeriods, useReview, usePeriodAiReviews, useLessonPlanQuizPreviews,
  useApprovePlan, useRejectPlan, useRetryAIReview, useRequestRevision, useAiReviewTimeout, useRegeneratePeriodAiReviews, useGenerateLessonPlanQuizzes, useAddGeneratedQuizToBank,
} from '../../lib/hooks/useLessonPlans';
import { LessonPlanPeriod, PlanStatus } from '../../types';
import { ClipboardCheck, ChevronRight, Filter, AlertTriangle, Loader2, CalendarRange, RotateCcw, HelpCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { PlanReadView, ReadPeriod } from '../../components/lesson-planner/PlanReadView';
import { ExportLessonPlanPdfButton } from '../../components/lesson-planner/ExportLessonPlanPdfButton';
import { AiReviewPanel, minutesSince } from '../../components/lesson-planner/AiReviewPanel';
import { LessonPlanPdfDocument } from '../shared/LessonPlanPdfDocument';
import { useUnitPlansByClass } from '../../lib/hooks/useUnitPlans';
import { describePlanWeek } from '../../utils/weekDates';
import { getCurrentAcademicYear } from '../../lib/db/academic';
import { getSubjects } from '../../lib/db/subjects';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { useToast } from '../../context/ToastContext';
import { DecisionPanel } from '../../components/lesson-planner/DecisionPanel';
import {
  IDLE, filterQueue, formatWaited, nextPlanAfter, queueCounts, queuePosition, scoreBand,
  sortQueue, statusInfo, type DecisionKind, type DecisionPhase, type QueueFilter,
} from '../../lib/lessonReview/reviewQueue';
import { DecisionRunner } from '../../lib/lessonReview/decisionRunner';

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


export function LessonPlanReview() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  // Default to the work that needs doing rather than the full archive.
  const [statusFilter, setStatusFilter] = useState<QueueFilter>('awaiting');
  const [phase, setPhase] = useState<DecisionPhase>(IDLE);
  const [quizzesOpen, setQuizzesOpen] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const { t } = useI18n();
  const { addToast } = useToast();

  const { data: plans } = useSupervisorPlans();
  const { data: planWithPeriods } = usePlanWithPeriods(selectedPlanId || undefined);
  const planStatus = planWithPeriods?.plan.status;
  const reviewMayBeArriving = planStatus === 'submitted' || planStatus === 'in_review';
  const { data: review } = useReview(selectedPlanId || undefined, reviewMayBeArriving);
  const aiReviewPending = planStatus === 'submitted' || (planStatus === 'in_review' && !review);
  const { data: periodAiReviews = [] } = usePeriodAiReviews(selectedPlanId || undefined, reviewMayBeArriving);
  const { data: quizPreviews = [] } = useLessonPlanQuizPreviews(selectedPlanId || undefined);
  // Guarantees a stuck plan flips to ai_failed instead of waiting forever (#4).
  useAiReviewTimeout(planWithPeriods?.plan);
  const approveMut = useApprovePlan();
  const rejectMut = useRejectPlan();
  const retryMut = useRetryAIReview();
  const revisionMut = useRequestRevision();
  const regeneratePeriodReviewMut = useRegeneratePeriodAiReviews();
  const generateQuizzesMut = useGenerateLessonPlanQuizzes();
  const addQuizToBankMut = useAddGeneratedQuizToBank();
  const [yearStart, setYearStart] = useState<string | null>(null);
  const plan = planWithPeriods?.plan;
  const { data: unitPlans = [] } = useUnitPlansByClass(plan?.class_name ?? null);
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: getSubjects,
    staleTime: 1000 * 60 * 10,
  });

  useEffect(() => {
    getCurrentAcademicYear().then((ay) => setYearStart(ay?.startDate ?? null));
  }, []);

  const readPeriods = useMemo(
    () => toReadPeriods(planWithPeriods?.periods ?? []),
    [planWithPeriods?.periods]
  );
  // Sort once (awaiting first, oldest first) then filter, so the visible order
  // is exactly the order the supervisor will be walked through by "next".
  const sortedPlans = useMemo(() => sortQueue(plans ?? []), [plans]);
  const filteredPlans = useMemo(
    () => filterQueue(sortedPlans, statusFilter),
    [sortedPlans, statusFilter]
  );
  const counts = useMemo(() => queueCounts(sortedPlans), [sortedPlans]);
  const nextPlan = useMemo(
    () => nextPlanAfter(filteredPlans, selectedPlanId),
    [filteredPlans, selectedPlanId]
  );
  const position = queuePosition(filteredPlans, selectedPlanId);

  /**
   * Switch plans. The comment is per-plan working state: carrying it across
   * would risk attaching one teacher's feedback to another teacher's plan, so
   * it and the decision phase are always reset together with the id.
   */
  const selectPlan = useCallback((planId: string | null) => {
    setSelectedPlanId(planId);
    // Comment is per-plan working state: carrying it over would risk attaching
    // one teacher's feedback to another teacher's plan.
    setComment('');
    // Disown any in-flight response so it cannot paint onto the new plan.
    runnerRef.current?.detach();
    setPhase(IDLE);
    setQuizError(null);
  }, []);

  const goToNextPlan = useCallback(() => {
    selectPlan(nextPlan ? nextPlan.id : null);
  }, [nextPlan, selectPlan]);

  // Keep the latest mutation closures in a ref so the runner (created once)
  // always submits with current values without being recreated per keystroke.
  const submitRef = useRef<(kind: DecisionKind, planId: string) => Promise<unknown>>(
    async () => undefined,
  );
  submitRef.current = async (kind, planId) => {
    if (kind === 'approve') return approveMut.mutateAsync({ planId, reviewId: review?.id, comment });
    if (kind === 'reject') return rejectMut.mutateAsync({ planId, reviewId: review?.id, comment });
    return revisionMut.mutateAsync({ planId, note: comment || undefined });
  };

  // Single runner instance owns duplicate-click and stale-response protection.
  // See DecisionRunner + lesson-review-runner.test.ts.
  const runnerRef = useRef<DecisionRunner | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = new DecisionRunner({
      submit: (kind, planId) => submitRef.current(kind, planId),
      setPhase: (next) => setPhase(next),
      onError: (_kind, message) =>
        addToast({ type: 'error', title: 'Decision was not saved', description: message.slice(0, 300) }),
    });
  }

  const runDecision = useCallback((kind: DecisionKind) => {
    void runnerRef.current?.run(kind, selectedPlanId);
  }, [selectedPlanId]);

  const retryDecision = useCallback(() => {
    if (phase.phase === 'error') runDecision(phase.kind);
  }, [phase, runDecision]);

  const handleRetryReview = useCallback(async () => {
    if (!selectedPlanId || !planWithPeriods) return;
    await retryMut.mutateAsync({ planId: selectedPlanId });
  }, [planWithPeriods, retryMut, selectedPlanId]);

  const handleRegeneratePeriodReview = useCallback(async () => {
    if (!selectedPlanId) return;
    await regeneratePeriodReviewMut.mutateAsync(selectedPlanId);
  }, [regeneratePeriodReviewMut, selectedPlanId]);

  const handleGenerateQuizzes = useCallback(async () => {
    if (!selectedPlanId) return;
    setQuizError(null);
    try {
      await generateQuizzesMut.mutateAsync(selectedPlanId);
      setQuizzesOpen(true);
      addToast({ type: 'success', title: 'Quizzes generated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // Inline banner is the primary surface — toast is secondary (may render off-screen on small viewports)
      setQuizError(msg);
      console.error('[LessonPlanReview] generate quizzes failed — full raw logged above', { error: msg });
      addToast({ type: 'error', title: 'Failed to generate quizzes', description: msg.slice(0, 400) });
    }
  }, [addToast, generateQuizzesMut, selectedPlanId]);

  const handleAddQuizToBank = useCallback(async (quizId: string) => {
    if (!selectedPlanId) return;
    try {
      const result = await addQuizToBankMut.mutateAsync({ quizId, planId: selectedPlanId });
      addToast({ type: 'success', title: result === 'already_added' ? 'Already added to quiz bank' : 'Added to quiz bank' });
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to add quiz to bank', description: err instanceof Error ? err.message : undefined });
    }
  }, [addQuizToBankMut, addToast, selectedPlanId]);

  const handleAddCommentLine = useCallback((line: string) => {
    const clean = line.trim();
    if (!clean) return;
    setComment((current) => {
      const lines = current.split('\n').map((entry) => entry.trim()).filter(Boolean);
      if (lines.includes(clean)) return current;
      return current.trim() ? `${current.trim()}\n${clean}` : clean;
    });
  }, []);

  const pending = approveMut.isPending || rejectMut.isPending || revisionMut.isPending;
  const aiFailed = plan?.status === 'ai_failed';
  // Status is authoritative. A cached review from an older attempt must never
  // hide the pending state after the queueing RPC has deleted stale rows.
  const waitingOnAi = !!plan && aiReviewPending;
  const waitedMinutes = minutesSince(plan?.ai_started_at || plan?.updated_at);
  const aiLikelyStuck = waitingOnAi && waitedMinutes >= 3;

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-5 flex items-start gap-3 sm:mb-6 sm:items-center">
        <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
          <ClipboardCheck className="w-6 h-6" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{t('lessonReview.title')}</h1>
          <p className="mt-1 text-sm leading-5 text-slate-500">{t('lessonReview.subtitle')}</p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:gap-6">
        {/* Left: plan list */}
        <div className="w-full xl:w-80 shrink-0">
          <div className="mb-3 flex items-center gap-2">
            <Filter className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <label htmlFor="queue-filter" className="sr-only">Filter plans by status</label>
            <select
              id="queue-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as QueueFilter)}
              className="min-h-[44px] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="awaiting">Awaiting decision ({counts.awaiting})</option>
              <option value="all">All statuses ({counts.total})</option>
              <option value="submitted">Submitted (pending AI)</option>
              <option value="in_review">In review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="revision_requested">Revision requested</option>
              <option value="ai_failed">AI failed</option>
            </select>
          </div>

          <p className="mb-2 text-xs font-semibold text-slate-500" aria-live="polite">
            {counts.awaiting === 0
              ? 'No plans awaiting a decision'
              : `${counts.awaiting} awaiting decision`}
            {position > 0 && ` · viewing ${position} of ${filteredPlans.length}`}
          </p>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {/* Skeleton matches real row geometry (same paddings + three text
                lines + chip) so the list does not resize when data lands. */}
            {!plans && (
              <ul className="divide-y divide-slate-100" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className="p-3">
                    <div className="h-4 w-3/4 rounded bg-slate-200" />
                    <div className="mt-1.5 h-3 w-1/2 rounded bg-slate-100" />
                    <div className="mt-1.5 h-3 w-2/5 rounded bg-slate-100" />
                    <div className="mt-2 h-5 w-24 rounded-full bg-slate-100" />
                  </li>
                ))}
              </ul>
            )}

            {plans && filteredPlans.length === 0 && (
              <div className="p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">
                  {counts.awaiting === 0 ? '✓ All caught up' : 'Nothing matches this filter'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {counts.awaiting === 0
                    ? 'Every submitted lesson plan has been decided.'
                    : 'Try “Awaiting decision” or “All statuses”.'}
                </p>
              </div>
            )}

            {plans && filteredPlans.length > 0 && (
              <ul
                className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto overscroll-contain"
                /* Capped height + scroll keeps the queue usable at 80+ plans
                   without the page itself becoming metres long. Rows are cheap
                   (no per-row query), so plain scrolling beats virtualization
                   at this scale and keeps Ctrl+F working. */
              >
                {filteredPlans.map((p) => {
                  const info = statusInfo(p.status);
                  const selected = selectedPlanId === p.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => selectPlan(p.id)}
                        aria-current={selected ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2 p-3 text-left transition-colors duration-150',
                          'hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600',
                          selected && 'bg-indigo-50',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-900">{p.title}</p>
                          <p className="truncate text-xs text-slate-600">
                            {p.teacher_name || 'Unknown teacher'} · {p.class_name}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                            <CalendarRange className="h-3 w-3 shrink-0" aria-hidden="true" />
                            {describePlanWeek(p.week_label, yearStart)}
                          </p>
                          <span className={cn('mt-1.5 w-fit', info.chip)}>
                            <span aria-hidden="true">{info.glyph}</span> {info.label}
                          </span>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Right: detail */}
        {selectedPlanId && planWithPeriods && plan && (
          <div
            className="flex-1 space-y-6 min-w-0"
            data-testid="plan-detail"
            /* Re-keyed per plan so React remounts the pane on switch. Without
               this, scroll position and collapsed/expanded period state leak
               from one teacher's plan to the next. */
            key={plan.id}
          >
            {/* AI health banner — answers "how do I know the AI didn't work?" */}
            {(aiFailed || aiLikelyStuck) && (
              <div className="no-print rounded-2xl border-2 border-orange-300 bg-orange-50 p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-orange-900">
                    {aiFailed
                      ? 'No AI review for this plan — the AI failed'
                      : `No AI review after ${formatWaited(waitedMinutes)} — the AI probably failed`}
                  </p>
                  <p className="text-sm text-orange-800 mt-1">
                    You are not blocked. Read the plan below and approve or request revisions manually, or retry the AI
                    review first. Your decision is recorded either way.
                  </p>
                  {plan.ai_failure_reason && (
                    <p className="text-xs text-orange-900 mt-2 font-mono bg-orange-100 rounded-lg p-2 break-words">
                      Reason: {plan.ai_failure_reason}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Printable region */}
            <div className="space-y-6">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
                <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="break-words text-lg font-bold text-slate-900 sm:text-xl">{plan.title}</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                      {(plans?.find((p) => p.id === plan.id)?.teacher_name) || 'Unknown teacher'} · {plan.class_name} ·{' '}
                      <span className="font-medium text-slate-600">{describePlanWeek(plan.week_label, yearStart)}</span> ·{' '}
                      {plan.period_count} periods/day
                    </p>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                    <span className={cn('w-fit px-3 py-1.5', statusInfo(plan.status).chip)}>
                      <span aria-hidden="true">{statusInfo(plan.status).glyph}</span>
                      {statusInfo(plan.status).label}
                    </span>
                    {review && !waitingOnAi && (
                      <span className={cn('w-fit px-3 py-1.5', scoreBand(review.percentage).chip)}>
                        <span aria-hidden="true">{scoreBand(review.percentage).glyph}</span>
                        AI {review.percentage}% · {scoreBand(review.percentage).label}
                      </span>
                    )}
                    {!waitingOnAi && <button
                      type="button"
                      onClick={handleRegeneratePeriodReview}
                      disabled={regeneratePeriodReviewMut.isPending}
                      className="no-print flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                    >
                      {regeneratePeriodReviewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      {regeneratePeriodReviewMut.isPending ? t('lessonReview.regenerating') : t('lessonReview.regenerate')}
                    </button>}
                    <ExportLessonPlanPdfButton
                      document={<LessonPlanPdfDocument plan={plan} periods={planWithPeriods.periods} review={review} unitPlans={unitPlans} subjects={subjects} periodAiReviews={periodAiReviews} />}
                      fileName={`${plan.title.replace(/[^a-z0-9]/gi, '_')}_${plan.class_name}_${plan.week_label}.pdf`}
                      className="no-print flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                    />
                  </div>
                </div>
              </div>

              {/* Inline quiz generation error — always visible, not just a toast */}
              {quizError && (
                <div className="no-print rounded-2xl border-2 border-rose-300 bg-rose-50 p-4 flex items-start gap-3" role="alert" aria-live="assertive">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-rose-900">Quiz generation failed</p>
                    <p className="text-sm text-rose-800 mt-1 break-words whitespace-pre-wrap">{quizError}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleGenerateQuizzes}
                        disabled={generateQuizzesMut.isPending}
                        className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                      >
                        {generateQuizzesMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        Try again
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuizError(null)}
                        className="inline-flex items-center gap-2 rounded-xl bg-white border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Dismiss
                      </button>
                    </div>
                    <p className="text-xs text-rose-700/80 mt-2">If this keeps failing, the model returned duplicate answer options. The system already retried automatically — a second manual retry often succeeds.</p>
                  </div>
                </div>
              )}

              <section className="no-print overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => setQuizzesOpen(open => !open)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-slate-50"
                >
                  <span className="flex items-center gap-2 font-bold text-slate-900">
                    <HelpCircle className="h-5 w-5 text-indigo-600" /> {t('lessonReview.quizzes')} ({quizPreviews.length})
                  </span>
                  <ChevronRight className={cn('h-4 w-4 text-slate-400 transition-transform', quizzesOpen && 'rotate-90')} />
                </button>
                {quizzesOpen && (
                  <div className="space-y-3 border-t border-slate-100 p-5">
                    {quizPreviews.length === 0 ? (
                      <div className="flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-slate-500">{t('lessonReview.noQuizzes')}</p>
                        <button
                          type="button"
                          onClick={handleGenerateQuizzes}
                          disabled={generateQuizzesMut.isPending}
                          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {generateQuizzesMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          {generateQuizzesMut.isPending ? t('lessonReview.generatingQuizzes') : t('lessonReview.generateQuizzes')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-col gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-sm text-indigo-800">
                            Want different questions? Generate and validate a complete new set before replacing this one.
                          </p>
                          <button
                            type="button"
                            onClick={handleGenerateQuizzes}
                            disabled={generateQuizzesMut.isPending}
                            className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            {generateQuizzesMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            {generateQuizzesMut.isPending ? 'Generating new set…' : 'Redo quiz set'}
                          </button>
                        </div>
                        {quizPreviews.map(({ quiz, questions, addedToBank }) => (
                      <details key={quiz.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <summary className="cursor-pointer text-sm font-bold text-slate-800">
                          {quiz.title} · {questions.length} questions
                        </summary>
                        <div className="mt-3 flex justify-end">
                          <button
                            type="button"
                            onClick={() => handleAddQuizToBank(quiz.id)}
                            disabled={addedToBank || addQuizToBankMut.isPending}
                            className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {addedToBank ? 'Added' : addQuizToBankMut.isPending ? 'Adding…' : 'Add to Quiz Bank'}
                          </button>
                        </div>
                        <ol className="mt-3 space-y-2 text-sm text-slate-700">
                          {questions.map((question, index) => (
                            <li key={question.id} className="rounded-lg bg-white p-3">
                              <p><span className="font-bold">{index + 1}.</span> {question.promptSnapshot}</p>
                              {question.optionsSnapshot?.length ? (
                                <ul className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                                  {question.optionsSnapshot.map((option) => (
                                    <li key={option.label} className={cn('rounded-md border px-2 py-1', question.correctAnswerSnapshot === option.label ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50')}>
                                      <span className="font-bold">{option.label}.</span> {option.text}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      </details>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </section>

              <PlanReadView
                periods={readPeriods}
                periodCount={plan.period_count}
                planClassName={plan.class_name}
                subjects={subjects}
                unitPlans={unitPlans}
                periodAiReviews={periodAiReviews}
                showAiReview
                aiReviewPending={waitingOnAi}
                onAddCommentLine={handleAddCommentLine}
                collapsible
                defaultCollapsed
              />

              <AiReviewPanel
                review={review}
                status={plan.status}
                updatedAt={plan.ai_started_at || plan.updated_at}
                failureReason={plan.ai_failure_reason}
                retrying={retryMut.isPending}
                onRetry={handleRetryReview}
                retryError={retryMut.isError ? (retryMut.error as Error)?.message : null}
                audience="supervisor"
              />
            </div>

            <DecisionPanel
              phase={phase}
              comment={comment}
              onCommentChange={setComment}
              onDecide={runDecision}
              onRetry={retryDecision}
              onNext={nextPlan ? goToNextPlan : null}
              remaining={nextPlan ? counts.awaiting - 1 : 0}
              hasAiScore={!!review}
              waitingOnAi={waitingOnAi}
              aiFailed={aiFailed}
              alreadyRevision={plan.status === 'revision_requested'}
              commentPlaceholder={t('lessonReview.commentPlaceholder')}
              labels={{
                heading: t('lessonReview.supervisorDecision'),
                approve: t('lessonReview.approve'),
                reject: t('lessonReview.reject'),
                requestRevisions: t('lessonReview.requestRevisions'),
              }}
            />
          </div>
        )}

        {!selectedPlanId && (
          <div className="flex-1 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <ClipboardCheck className="mx-auto mb-3 h-10 w-10 text-slate-300" aria-hidden="true" />
            {counts.awaiting === 0 ? (
              <>
                <p className="font-semibold text-slate-700">✓ All caught up</p>
                <p className="mt-1 text-sm text-slate-500">
                  Every submitted lesson plan has been decided. New submissions will appear here.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-slate-700">
                  {counts.awaiting} lesson {counts.awaiting === 1 ? 'plan is' : 'plans are'} waiting for you
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Pick one from the queue, or start with the one that has waited longest.
                </p>
                <button
                  type="button"
                  onClick={goToNextPlan}
                  className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700"
                >
                  Start reviewing <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
