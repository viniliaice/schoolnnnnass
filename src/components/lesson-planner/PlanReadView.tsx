import { useState } from 'react';
import { DayOfWeek, DAYS_OF_WEEK, PeriodActivity, Subject, UnitPlan, LessonPlanPeriod } from '../../types';
import { cn } from '../../utils/cn';
import { ChevronDown } from 'lucide-react';
import { reviewPeriodInstruction, summarizeDay } from '../../lib/lessonPlanReview';

export interface ReadPeriod {
  day: DayOfWeek;
  period_number: number;
  subject: string;
  className: string;
  isFree: boolean;
  topic: string;
  objective: string;
  slide_number: string;
  details: PeriodActivity[];
}

interface PlanReadViewProps {
  periods: ReadPeriod[];
  periodCount: number;
  subjects?: Subject[];
  planClassName: string;
  weekDates?: string[];
  unitPlans?: UnitPlan[];
  showAiReview?: boolean;
  /** When true, each day section is an accordion panel — collapsed by default. */
  collapsible?: boolean;
  /** Used only when collapsible is true. Defaults to true. */
  defaultCollapsed?: boolean;
}

function subjectName(subjects: Subject[] | undefined, value: string): string {
  if (!value) return '—';
  return subjects?.find((s) => s.id === value)?.name || value;
}

function toLessonPeriod(period: ReadPeriod): LessonPlanPeriod {
  return {
    id: `${period.day}-${period.period_number}`,
    plan_id: '',
    day: period.day,
    period_number: period.period_number,
    subject: period.subject,
    class_name: period.className,
    is_free: period.isFree,
    topic: period.topic,
    objective: period.objective,
    activities: period.details.map((detail) => detail.activity).join('\n'),
    slide_number: period.slide_number,
    details: period.details,
    sort_order: period.period_number,
    created_at: '',
    updated_at: '',
  };
}

function AiReviewBox({ period, unitPlans }: { period: ReadPeriod; unitPlans: UnitPlan[] }) {
  const review = reviewPeriodInstruction(toLessonPeriod(period), unitPlans);
  const tone = review.alignmentStatus === 'full'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : review.alignmentStatus === 'partial'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : review.alignmentStatus === 'none'
        ? 'border-rose-200 bg-rose-50 text-rose-800'
        : 'border-slate-200 bg-slate-50 text-slate-600';

  return (
    <div className={cn('mt-3 rounded-xl border p-3', tone)}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide">AI Review</span>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-bold shadow-sm">{review.alignmentLabel}</span>
      </div>
      <p className="text-sm leading-6">{review.aiReview}</p>
      <p className="mt-1 text-xs leading-5 opacity-80">{review.alignmentReason}</p>
    </div>
  );
}

/**
 * Readable, print-friendly representation of one week of a lesson plan.
 * Grouped by day so each period gets room to breathe (much easier to scan
 * than the compact editing grid) and it flows well onto a PDF page.
 */
export function PlanReadView({
  periods, periodCount, subjects, planClassName, weekDates, unitPlans = [], showAiReview = false,
  collapsible = false, defaultCollapsed = true,
}: PlanReadViewProps) {
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});

  const toggleDay = (day: string) =>
    setExpandedDays((prev) => ({ ...prev, [day]: !prev[day] }));

  return (
    <div className="space-y-4">
      {DAYS_OF_WEEK.map((day, di) => {
        const dayPeriods = Array.from({ length: periodCount }, (_, pi) =>
          periods.find((p) => p.day === day && p.period_number === pi + 1)
        );
        const summary = summarizeDay(
          dayPeriods.filter(Boolean).map((period) => ({ is_free: !!period!.isFree, topic: period!.topic })),
          periodCount
        );
        const isExpanded = expandedDays[day] ?? !defaultCollapsed;

        return (
          <section key={day} className="avoid-break bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {collapsible ? (
              <button
                type="button"
                onClick={() => toggleDay(day)}
                className="flex min-h-12 w-full flex-wrap items-center gap-3 bg-slate-50 px-4 py-3 text-left transition-colors hover:bg-slate-100 sm:px-5"
              >
                <ChevronDown className={cn(
                  'w-4 h-4 text-slate-400 shrink-0 transition-transform',
                  isExpanded && 'rotate-180'
                )} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="text-base font-bold text-slate-900 text-left">{day}</h3>
                    {weekDates?.[di] && <span className="text-sm text-slate-500">{weekDates[di]}</span>}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:max-w-md">
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">{summary.planned} planned</span>
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">{summary.free} free</span>
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-bold text-indigo-700 shadow-sm">{summary.percent}% done</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${summary.percent}%` }} />
                  </div>
                </div>
              </button>
            ) : (
              <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 bg-slate-50 border-b border-slate-200">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="text-base font-bold text-slate-900">{day}</h3>
                    {weekDates?.[di] && <span className="text-sm text-slate-500">{weekDates[di]}</span>}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:max-w-md">
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">{summary.planned} planned</span>
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">{summary.free} free</span>
                    <span className="rounded-lg bg-white px-2 py-1 text-xs font-bold text-indigo-700 shadow-sm">{summary.percent}% done</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-indigo-600" style={{ width: `${summary.percent}%` }} />
                  </div>
                </div>
              </header>
            )}

            {isExpanded && (
              <div className="divide-y divide-slate-100">
                {dayPeriods.map((cell, pi) => {
                  const isFree = !cell || cell.isFree || cell.subject === '__FREE__';
                  return (
                    <div key={pi} className="avoid-break flex gap-3 px-4 py-4 sm:gap-4 sm:px-5">
                      <div className="shrink-0 w-14">
                        <div className={cn(
                          'w-11 h-11 rounded-xl flex flex-col items-center justify-center text-xs font-bold',
                          isFree ? 'bg-slate-100 text-slate-400' : 'bg-indigo-50 text-indigo-700'
                        )}>
                          <span className="text-[10px] font-medium opacity-70">P</span>
                          {pi + 1}
                        </div>
                      </div>

                      {isFree ? (
                        <div className="flex items-center text-sm text-slate-400 italic">Free period</div>
                      ) : (
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold">
                              {subjectName(subjects, cell!.subject)}
                            </span>
                            <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium">
                              {cell!.className || planClassName || '—'}
                            </span>
                            {cell!.slide_number && (
                              <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium">
                                Page {cell!.slide_number}
                              </span>
                            )}
                            {!cell!.topic.trim() && (
                              <span className="px-2.5 py-1 rounded-lg bg-amber-100 text-amber-700 text-xs font-semibold">
                                Missing topic
                              </span>
                            )}
                          </div>

                          <p className="text-sm font-semibold text-slate-900 leading-snug">
                            {cell!.topic || <span className="text-slate-300 font-normal">No topic entered</span>}
                          </p>

                          {cell!.objective && (
                            <p className="text-sm text-slate-600 leading-relaxed">
                              <span className="font-medium text-slate-500">Objective: </span>
                              {cell!.objective}
                            </p>
                          )}

                          {cell!.details.length > 0 && (
                            <ol className="space-y-1.5 pt-1">
                              {cell!.details.map((a, ai) => (
                                <li key={ai} className="flex gap-2 text-sm text-slate-600">
                                  <span className="shrink-0 text-slate-400 font-medium">{ai + 1}.</span>
                                  <span className="min-w-0">
                                    <span className="text-slate-800">{a.activity || '—'}</span>
                                    {(a.time || a.resource || a.place) && (
                                      <span className="text-xs text-slate-500">
                                        {a.time && <> · {a.time}</>}
                                        {a.resource && <> · {a.resource}</>}
                                        {a.place && <> · {a.place}</>}
                                      </span>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          )}

                          {showAiReview && <AiReviewBox period={cell!} unitPlans={unitPlans} />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
