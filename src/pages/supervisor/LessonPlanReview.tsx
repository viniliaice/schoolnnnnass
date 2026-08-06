import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useSupervisorPlans, usePlanWithPeriods, useReview, usePeriodAiReviews, useLessonPlanQuizPreviews,
  useApprovePlan, useRejectPlan, useRetryAIReview, useRequestRevision, useAiReviewTimeout, useRegeneratePeriodAiReviews, useGenerateLessonPlanQuizzes, useAddGeneratedQuizToBank,
} from '../../lib/hooks/useLessonPlans';
import { LessonPlanPeriod, PlanStatus } from '../../types';
import { ClipboardCheck, ChevronRight, Filter, AlertTriangle, Loader2, Unlock, CalendarRange, RotateCcw, HelpCircle } from 'lucide-react';
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

const STATUS_CHIP: Record<PlanStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  submitted: 'bg-blue-100 text-blue-700',
  in_review: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-rose-100 text-rose-700',
  ai_failed: 'bg-orange-100 text-orange-700',
  revision_requested: 'bg-amber-100 text-amber-700',
};

export function LessonPlanReview() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PlanStatus>('all');
  const [quizzesOpen, setQuizzesOpen] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const { t } = useI18n();
  const { addToast } = useToast();

  const { data: plans } = useSupervisorPlans();
  const { data: planWithPeriods } = usePlanWithPeriods(selectedPlanId || undefined);
  const { data: review } = useReview(selectedPlanId || undefined);
  const { data: periodAiReviews = [] } = usePeriodAiReviews(selectedPlanId || undefined);
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
  const retryPeriods = useMemo(() => (
    planWithPeriods?.periods.map((p) => ({
      day: p.day,
      period_number: p.period_number,
      topic: p.topic,
      objective: p.objective ?? null,
      activities: p.activities,
      slide_number: p.slide_number ?? null,
      details: (p.details as any[]) ?? [],
    })) ?? []
  ), [planWithPeriods?.periods]);
  const filteredPlans = useMemo(
    () => plans?.filter((p) => statusFilter === 'all' || p.status === statusFilter) ?? [],
    [plans, statusFilter]
  );

  const handleRequestRevision = useCallback(async () => {
    if (!selectedPlanId) return;
    await revisionMut.mutateAsync({ planId: selectedPlanId, note: comment || undefined });
    setComment('');
  }, [comment, revisionMut, selectedPlanId]);

  const handleApprove = useCallback(async () => {
    if (!selectedPlanId) return;
    await approveMut.mutateAsync({ planId: selectedPlanId, reviewId: review?.id, comment });
    setComment('');
  }, [approveMut, comment, review?.id, selectedPlanId]);

  const handleReject = useCallback(async () => {
    if (!selectedPlanId) return;
    await rejectMut.mutateAsync({ planId: selectedPlanId, reviewId: review?.id, comment });
    setComment('');
  }, [comment, rejectMut, review?.id, selectedPlanId]);

  const handleRetryReview = useCallback(async () => {
    if (!selectedPlanId || !planWithPeriods) return;
    await retryMut.mutateAsync({ planId: selectedPlanId, periods: retryPeriods });
  }, [planWithPeriods, retryMut, retryPeriods, selectedPlanId]);

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

  const handleGenerateMissingAssets = useCallback(async () => {
    if (!selectedPlanId) return;
    setQuizError(null);
    try {
      await regeneratePeriodReviewMut.mutateAsync(selectedPlanId);
      await generateQuizzesMut.mutateAsync(selectedPlanId);
      setQuizzesOpen(true);
      addToast({ type: 'success', title: 'AI review and quizzes generated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setQuizError(msg);
      console.error('[LessonPlanReview] generate missing assets failed', { error: msg });
      addToast({ type: 'error', title: 'Failed to generate review assets', description: msg.slice(0, 400) });
    }
  }, [addToast, generateQuizzesMut, regeneratePeriodReviewMut, selectedPlanId]);

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
  const waitingOnAi = !!plan && plan.status === 'submitted' && !review;
  const waitedMinutes = minutesSince(plan?.updated_at);
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
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | PlanStatus)}
              className="min-h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="all">All Statuses</option>
              <option value="submitted">Submitted (pending AI)</option>
              <option value="in_review">In Review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="ai_failed">AI Failed</option>
            </select>
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {(!plans || plans.length === 0) && (
              <div className="p-8 text-center text-sm text-slate-500">No submitted plans</div>
            )}
            {filteredPlans.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlanId(p.id)}
                className={cn(
                  'w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors sm:p-4',
                  selectedPlanId === p.id && 'bg-indigo-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{p.title}</p>
                  <p className="text-xs text-slate-500">{p.teacher_name || 'Unknown'} · {p.class_name}</p>
                  <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                    <CalendarRange className="w-3 h-3" />
                    {describePlanWeek(p.week_label, yearStart)}
                  </p>
                  <span className={cn('flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-xs font-medium w-fit', STATUS_CHIP[p.status])}>
                    {p.status === 'ai_failed' && <AlertTriangle className="w-3 h-3" />}
                    {p.status === 'ai_failed' ? 'AI failed' : p.status.replace('_', ' ')}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>
            ))}
          </div>
        </div>

        {/* Right: detail */}
        {selectedPlanId && planWithPeriods && plan && (
          <div className="flex-1 space-y-6 min-w-0">
            {/* AI health banner — answers "how do I know the AI didn't work?" */}
            {(aiFailed || aiLikelyStuck) && (
              <div className="no-print rounded-2xl border-2 border-orange-300 bg-orange-50 p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-orange-900">
                    {aiFailed
                      ? 'No AI review for this plan — the AI failed'
                      : `No AI review after ${waitedMinutes} minutes — the AI probably failed`}
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
                    <span className={cn('w-fit rounded-full px-3 py-1.5 text-xs font-semibold', STATUS_CHIP[plan.status])}>
                      {plan.status === 'ai_failed' ? 'AI failed' : plan.status.replace('_', ' ')}
                    </span>
                    {(periodAiReviews.length === 0 || quizPreviews.length === 0) && (
                      <button
                        type="button"
                        onClick={handleGenerateMissingAssets}
                        disabled={regeneratePeriodReviewMut.isPending || generateQuizzesMut.isPending}
                        className="no-print flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                      >
                        {(regeneratePeriodReviewMut.isPending || generateQuizzesMut.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        {(regeneratePeriodReviewMut.isPending || generateQuizzesMut.isPending) ? t('lessonReview.generatingNow') : t('lessonReview.generateNow')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleRegeneratePeriodReview}
                      disabled={regeneratePeriodReviewMut.isPending}
                      className="no-print flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                    >
                      {regeneratePeriodReviewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      {regeneratePeriodReviewMut.isPending ? t('lessonReview.regenerating') : t('lessonReview.regenerate')}
                    </button>
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
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {generateQuizzesMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          {generateQuizzesMut.isPending ? t('lessonReview.generatingQuizzes') : t('lessonReview.generateQuizzes')}
                        </button>
                      </div>
                    ) : quizPreviews.map(({ quiz, questions, addedToBank }) => (
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
                onAddCommentLine={handleAddCommentLine}
                collapsible
                defaultCollapsed
              />

              <AiReviewPanel
                review={review}
                status={plan.status}
                updatedAt={plan.updated_at}
                failureReason={plan.ai_failure_reason}
                retrying={retryMut.isPending}
                onRetry={handleRetryReview}
                retryError={retryMut.isError ? (retryMut.error as Error)?.message : null}
                audience="supervisor"
              />
            </div>

            {/* Decision panel — always usable */}
            <div className="no-print z-10 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 lg:sticky lg:bottom-4 lg:rounded-2xl lg:shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                <h2 className="text-lg font-bold text-slate-900">{t('lessonReview.supervisorDecision')}</h2>
                {waitingOnAi && !aiLikelyStuck && (
                  <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                    <Loader2 className="w-3 h-3 animate-spin" /> AI review still running
                  </span>
                )}
                {aiFailed && (
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700">
                    Deciding without an AI score
                  </span>
                )}
              </div>

              <p className="text-sm text-slate-600">
                {review
                  ? 'The AI review above is advisory — the final decision is yours.'
                  : 'No AI score is available for this plan. You can still approve it or send it back for revisions.'}
              </p>

              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t('lessonReview.commentPlaceholder')}
                rows={3}
                className="w-full resize-none rounded-xl border border-slate-300 px-3 py-3 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
              />

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  onClick={handleApprove}
                  disabled={pending}
                  className="min-h-12 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                >
                  {approveMut.isPending ? 'Approving…' : t('lessonReview.approve')}
                </button>
                <button
                  onClick={handleReject}
                  disabled={pending}
                  className="min-h-12 rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                >
                  {rejectMut.isPending ? 'Sending…' : t('lessonReview.reject')}
                </button>
              </div>

              {/* Unlocking (#1): the only way a submitted plan becomes editable */}
              <div className="pt-3 border-t border-slate-100">
                <button
                  onClick={handleRequestRevision}
                  disabled={pending || plan.status === 'revision_requested'}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                >
                  <Unlock className="w-4 h-4" />
                  {plan.status === 'revision_requested'
                    ? 'Already unlocked for editing'
                    : revisionMut.isPending
                      ? 'Unlocking…'
                      : t('lessonReview.requestRevisions')}
                </button>
                <p className="text-xs text-slate-500 mt-2">
                  Sends the plan back to the teacher and re-enables their edit controls. Any comment above is
                  passed along as your revision note.
                </p>
              </div>

              {(approveMut.isError || rejectMut.isError) && (
                <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl p-3">
                  Could not save the decision: {((approveMut.error || rejectMut.error) as Error)?.message || 'Unknown error'}
                </p>
              )}
            </div>
          </div>
        )}

        {!selectedPlanId && (
          <div className="flex-1 bg-white rounded-2xl border border-dashed border-slate-200 p-16 text-center">
            <ClipboardCheck className="w-10 h-10 mx-auto text-slate-300 mb-3" />
            <p className="font-medium text-slate-600">Select a plan to review</p>
            <p className="text-sm text-slate-400 mt-1">Plans flagged “AI failed” need a manual decision.</p>
          </div>
        )}
      </div>
    </div>
  );
}
