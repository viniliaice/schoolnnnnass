import { useEffect, useRef, useState } from 'react';
import {
  useSupervisorPlans, usePlanWithPeriods, useReview,
  useApprovePlan, useRejectPlan, useRetryAIReview, useRequestRevision, useAiReviewTimeout,
} from '../../lib/hooks/useLessonPlans';
import { LessonPlanPeriod, PlanStatus } from '../../types';
import { ClipboardCheck, ChevronRight, Filter, Download, AlertTriangle, Loader2, Unlock, CalendarRange } from 'lucide-react';
import { cn } from '../../utils/cn';
import { PlanReadView, ReadPeriod } from '../../components/lesson-planner/PlanReadView';
import { AiReviewPanel, minutesSince } from '../../components/lesson-planner/AiReviewPanel';
import { printElementAsPdf } from '../../utils/printToPdf';
import { describePlanWeek } from '../../utils/weekDates';
import { getCurrentAcademicYear } from '../../lib/db/academic';

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
  const printRef = useRef<HTMLDivElement>(null);

  const { data: plans } = useSupervisorPlans();
  const { data: planWithPeriods } = usePlanWithPeriods(selectedPlanId || undefined);
  const { data: review } = useReview(selectedPlanId || undefined);
  // Guarantees a stuck plan flips to ai_failed instead of waiting forever (#4).
  useAiReviewTimeout(planWithPeriods?.plan);
  const approveMut = useApprovePlan();
  const rejectMut = useRejectPlan();
  const retryMut = useRetryAIReview();
  const revisionMut = useRequestRevision();
  const [yearStart, setYearStart] = useState<string | null>(null);

  useEffect(() => {
    getCurrentAcademicYear().then((ay) => setYearStart(ay?.startDate ?? null));
  }, []);

  const handleRequestRevision = async () => {
    if (!selectedPlanId) return;
    await revisionMut.mutateAsync({ planId: selectedPlanId, note: comment || undefined });
    setComment('');
  };

  const handleApprove = async () => {
    if (!selectedPlanId) return;
    await approveMut.mutateAsync({ planId: selectedPlanId, reviewId: review?.id, comment });
    setComment('');
  };

  const handleReject = async () => {
    if (!selectedPlanId) return;
    await rejectMut.mutateAsync({ planId: selectedPlanId, reviewId: review?.id, comment });
    setComment('');
  };

  const handleRetryReview = async () => {
    if (!selectedPlanId || !planWithPeriods) return;
    const periods = planWithPeriods.periods.map((p) => ({
      day: p.day,
      period_number: p.period_number,
      topic: p.topic,
      objective: p.objective ?? null,
      activities: p.activities,
      slide_number: p.slide_number ?? null,
      details: (p.details as any[]) ?? [],
    }));
    await retryMut.mutateAsync({ planId: selectedPlanId, periods });
  };

  const pending = approveMut.isPending || rejectMut.isPending || revisionMut.isPending;
  const plan = planWithPeriods?.plan;
  const aiFailed = plan?.status === 'ai_failed';
  const waitingOnAi = !!plan && plan.status === 'submitted' && !review;
  const waitedMinutes = minutesSince(plan?.updated_at);
  const aiLikelyStuck = waitingOnAi && waitedMinutes >= 3;

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
          <ClipboardCheck className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lesson Plan Review</h1>
          <p className="text-sm text-slate-500">Read the plan, check the AI score, then approve or request revisions.</p>
        </div>
      </div>

      <div className="flex gap-6 flex-col xl:flex-row">
        {/* Left: plan list */}
        <div className="w-full xl:w-80 shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | PlanStatus)}
              className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
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
            {plans?.filter((p) => statusFilter === 'all' || p.status === statusFilter).map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlanId(p.id)}
                className={cn(
                  'w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors',
                  selectedPlanId === p.id && 'bg-indigo-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{p.title}</p>
                  <p className="text-xs text-slate-500">{p.teacher_name || 'Unknown'} · {p.class_name}</p>
                  <p className="text-xs text-slate-500 inline-flex items-center gap-1 mt-0.5">
                    <CalendarRange className="w-3 h-3" />
                    {describePlanWeek(p.week_label, yearStart)}
                  </p>
                  <span className={cn('inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs font-medium', STATUS_CHIP[p.status])}>
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
            <div ref={printRef} className="space-y-6">
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">{plan.title}</h2>
                    <p className="text-sm text-slate-500 mt-1">
                      {(plans?.find((p) => p.id === plan.id)?.teacher_name) || 'Unknown teacher'} · {plan.class_name} ·{' '}
                      <span className="font-medium text-slate-600">{describePlanWeek(plan.week_label, yearStart)}</span> ·{' '}
                      {plan.period_count} periods/day
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('px-3 py-1.5 rounded-full text-xs font-semibold', STATUS_CHIP[plan.status])}>
                      {plan.status === 'ai_failed' ? 'AI failed' : plan.status.replace('_', ' ')}
                    </span>
                    <button
                      onClick={() => printElementAsPdf(printRef.current, `${plan.title} — ${plan.class_name} — ${plan.week_label}`)}
                      className="no-print flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Download className="w-4 h-4" /> Export PDF
                    </button>
                  </div>
                </div>
              </div>

              <PlanReadView
                periods={toReadPeriods(planWithPeriods.periods)}
                periodCount={plan.period_count}
                planClassName={plan.class_name}
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
            <div className="no-print bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-bold text-slate-900">Supervisor Decision</h2>
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
                placeholder="Add your comments for the teacher (optional, but recommended when requesting revisions)"
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
              />

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleApprove}
                  disabled={pending}
                  className="flex-1 min-w-[160px] py-2.5 rounded-xl bg-emerald-600 text-white font-medium text-sm hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  {approveMut.isPending ? 'Approving…' : 'Approve'}
                </button>
                <button
                  onClick={handleReject}
                  disabled={pending}
                  className="flex-1 min-w-[160px] py-2.5 rounded-xl bg-rose-600 text-white font-medium text-sm hover:bg-rose-700 disabled:opacity-50 transition-colors"
                >
                  {rejectMut.isPending ? 'Sending…' : 'Reject'}
                </button>
              </div>

              {/* Unlocking (#1): the only way a submitted plan becomes editable */}
              <div className="pt-3 border-t border-slate-100">
                <button
                  onClick={handleRequestRevision}
                  disabled={pending || plan.status === 'revision_requested'}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500 text-white font-medium text-sm hover:bg-amber-600 disabled:opacity-50 transition-colors"
                >
                  <Unlock className="w-4 h-4" />
                  {plan.status === 'revision_requested'
                    ? 'Already unlocked for editing'
                    : revisionMut.isPending
                      ? 'Unlocking…'
                      : 'Request Revisions (unlock for editing)'}
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
