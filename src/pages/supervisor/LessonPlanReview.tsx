import { useState } from 'react';
import { useSupervisorPlans, usePlanWithPeriods, useReview, useApprovePlan, useRejectPlan, useRetryAIReview } from '../../lib/hooks/useLessonPlans';
import { DAYS_OF_WEEK, PlanStatus } from '../../types';
import { ClipboardCheck, ChevronRight, Filter } from 'lucide-react';
import { cn } from '../../utils/cn';

export function LessonPlanReview() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PlanStatus>('all');

  const { data: plans } = useSupervisorPlans();
  const { data: planWithPeriods } = usePlanWithPeriods(selectedPlanId || undefined);
  const { data: review } = useReview(selectedPlanId || undefined);
  const approveMut = useApprovePlan();
  const rejectMut = useRejectPlan();
  const retryMut = useRetryAIReview();

  const handleApprove = async () => {
    if (!selectedPlanId || !review) return;
    await approveMut.mutateAsync({ planId: selectedPlanId, reviewId: review.id, comment });
    setComment('');
  };

  const handleReject = async () => {
    if (!selectedPlanId || !review) return;
    await rejectMut.mutateAsync({ planId: selectedPlanId, reviewId: review.id, comment });
    setComment('');
  };

  const handleRetryReview = async () => {
    if (!selectedPlanId || !planWithPeriods) return;
    const periods = planWithPeriods.periods.map(p => ({
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

  const pending = approveMut.isPending || rejectMut.isPending;

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
          <ClipboardCheck className="w-6 h-6" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Lesson Plan Review</h1>
      </div>

      <div className={cn('flex gap-6', 'flex-col xl:flex-row')}>
        {/* Left: Plan list */}
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
          <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
            {(!plans || plans.length === 0) && (
              <div className="p-8 text-center text-sm text-slate-500">No submitted plans</div>
            )}
            {plans?.filter((plan) => statusFilter === 'all' || plan.status === statusFilter).map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlanId(plan.id)}
                className={cn(
                  'w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors',
                  selectedPlanId === plan.id && 'bg-indigo-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{plan.title}</p>
                  <p className="text-xs text-slate-500">{plan.teacher_name || 'Unknown'} &middot; {plan.class_name}</p>
                  <span className={cn(
                    'inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium',
                    plan.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                    plan.status === 'rejected' ? 'bg-rose-100 text-rose-700' :
                    plan.status === 'in_review' ? 'bg-amber-100 text-amber-700' :
                    plan.status === 'submitted' ? 'bg-blue-100 text-blue-700' :
                    plan.status === 'ai_failed' ? 'bg-orange-100 text-orange-700' :
                    'bg-slate-100 text-slate-600'
                  )}>
                    {plan.status === 'ai_failed' ? 'AI Failed' : plan.status.replace('_', ' ')}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>
            ))}
          </div>
        </div>

        {/* Right: Plan detail + AI review + Approval — stacked vertically <1200px */}
        {selectedPlanId && planWithPeriods && (
          <div className="flex-1 space-y-6 min-w-0">
            {/* Original Plan */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">{planWithPeriods.plan.title}</h2>
              <p className="text-sm text-slate-500 mb-4">
                {planWithPeriods.plan.class_name} &middot; {planWithPeriods.plan.week_label} &middot; {planWithPeriods.plan.period_count} periods/day
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="p-2 text-left font-semibold text-slate-700 w-12">#</th>
                      {DAYS_OF_WEEK.map((day) => (
                        <th key={day} className="p-2 text-left font-semibold text-slate-700 min-w-[180px]">{day}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: planWithPeriods.plan.period_count }, (_, pi) => (
                      <tr key={pi} className="border-b border-slate-100 last:border-0">
                        <td className="p-2 text-center font-medium text-slate-400 text-xs">P{pi + 1}</td>
                        {DAYS_OF_WEEK.map((day) => {
                          const period = planWithPeriods.periods.find((p) => p.day === day && p.period_number === pi + 1);
                          return (
                            <td key={day} className="p-2 border-l border-slate-100 align-top">
                              {period ? (
                                <>
                                  <p className="font-medium text-xs text-slate-800">{period.topic}</p>
                                  <p className="text-xs text-slate-500 mt-0.5">{period.activities}</p>
                                </>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* AI Review */}
            {review && (
              <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-slate-900">AI Review</h2>
                  <span className={cn(
                    'ml-auto px-3 py-1 rounded-full text-xs font-bold',
                    review.percentage >= 90 ? 'bg-emerald-100 text-emerald-700' :
                    review.percentage >= 80 ? 'bg-blue-100 text-blue-700' :
                    review.percentage >= 70 ? 'bg-amber-100 text-amber-700' :
                    review.percentage >= 60 ? 'bg-orange-100 text-orange-700' :
                    'bg-rose-100 text-rose-700'
                  )}>
                    {review.percentage}% &middot; {review.performance_level}
                  </span>
                </div>
                <p className="text-sm text-slate-600">{review.executive_summary}</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {Object.entries(review.scores).map(([key, val]: [string, any]) => (
                    <div key={key} className="bg-slate-50 rounded-xl p-3">
                      <p className="text-xs text-slate-500 capitalize mb-1">{key.replace(/_/g, ' ')}</p>
                      <p className="text-lg font-bold text-slate-900">{val.score}/5</p>
                      <p className="text-xs text-slate-400 mt-1">{val.explanation}</p>
                    </div>
                  ))}
                </div>
                {review.strengths.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700 mb-2">Strengths</h3>
                    <ul className="list-disc list-inside text-sm text-slate-600 space-y-1">
                      {review.strengths.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {review.improvements.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700 mb-2">Improvements</h3>
                    <ul className="space-y-2">
                      {review.improvements.map((imp, i) => (
                        <li key={i} className="bg-amber-50 rounded-xl p-3 text-sm">
                          <p className="font-medium text-amber-800">{imp.area}</p>
                          <p className="text-amber-700 text-xs mt-0.5">{imp.why}</p>
                          <p className="text-amber-600 text-xs mt-1">{imp.recommendation}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {review.ai_summary_notes && (
                  <div className="bg-indigo-50 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-indigo-800 mb-1">Supervisor Guidance</h3>
                    <p className="text-sm text-indigo-700">{review.ai_summary_notes.status_recommendation}</p>
                    <p className="text-xs text-indigo-600 mt-1">{review.ai_summary_notes.reasoning}</p>
                  </div>
                )}
              </div>
            )}

            {/* Retry AI Review for failed plans */}
            {planWithPeriods.plan.status === 'ai_failed' && (
              <div className="bg-white rounded-2xl border border-rose-200 p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-slate-900">AI Review</h2>
                  <span className="ml-auto px-3 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-700">
                    Failed
                  </span>
                </div>
                <p className="text-sm text-slate-600">The AI review could not be generated on the previous attempt. You can retry now.</p>
                <button
                  onClick={handleRetryReview}
                  disabled={retryMut.isPending}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {retryMut.isPending ? (
                    <>Retrying...</>
                  ) : (
                    <>Retry AI Review</>
                  )}
                </button>
                {retryMut.isError && (
                  <p className="text-sm text-rose-600">Error: {retryMut.error?.message || 'Unknown error'}</p>
                )}
              </div>
            )}

            {/* Approval Panel */}
            {planWithPeriods.plan.status === 'submitted' && !review ? (
              <div className="bg-white rounded-2xl border border-blue-200 p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-slate-900">Supervisor Decision</h2>
                  <span className="ml-auto px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700 animate-pulse">
                    Awaiting AI Review...
                  </span>
                </div>
                <p className="text-sm text-slate-600">The teacher has submitted this plan. AI review is being generated — please check back shortly.</p>
              </div>
            ) : (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
              <h2 className="text-lg font-bold text-slate-900">Supervisor Decision</h2>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add your comments (optional)"
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm resize-none"
              />
              <div className="flex gap-3">
                <button
                  onClick={handleApprove}
                  disabled={pending || !review}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white font-medium text-sm hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  Approve
                </button>
                <button
                  onClick={handleReject}
                  disabled={pending || !review}
                  className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white font-medium text-sm hover:bg-rose-700 disabled:opacity-50 transition-colors"
                >
                  Request Revisions
                </button>
              </div>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
