import { useState } from 'react';
import { DayOfWeek, DAYS_OF_WEEK, PeriodActivity, Subject } from '../../types';
import { cn } from '../../utils/cn';
import { ChevronDown } from 'lucide-react';

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
  /** When true, each day section is an accordion panel — collapsed by default. */
  collapsible?: boolean;
  /** Used only when collapsible is true. Defaults to true. */
  defaultCollapsed?: boolean;
}

function subjectName(subjects: Subject[] | undefined, value: string): string {
  if (!value) return '—';
  return subjects?.find((s) => s.id === value)?.name || value;
}

/**
 * Readable, print-friendly representation of one week of a lesson plan.
 * Grouped by day so each period gets room to breathe (much easier to scan
 * than the compact editing grid) and it flows well onto a PDF page.
 */
export function PlanReadView({
  periods, periodCount, subjects, planClassName, weekDates,
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
        const plannedCount = dayPeriods.filter((p) => p && !p.isFree && p.topic.trim()).length;
        const isExpanded = expandedDays[day] ?? !defaultCollapsed;

        return (
          <section key={day} className="avoid-break bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {collapsible ? (
              <button
                type="button"
                onClick={() => toggleDay(day)}
                className="w-full flex items-center gap-3 px-5 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
              >
                <ChevronDown className={cn(
                  'w-4 h-4 text-slate-400 shrink-0 transition-transform',
                  isExpanded && 'rotate-180'
                )} />
                <h3 className="text-base font-bold text-slate-900 text-left">{day}</h3>
                {weekDates?.[di] && <span className="text-sm text-slate-500">{weekDates[di]}</span>}
                <span className="ml-auto text-xs font-medium text-slate-500">
                  {plannedCount} of {periodCount} periods planned
                </span>
              </button>
            ) : (
              <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 bg-slate-50 border-b border-slate-200">
                <h3 className="text-base font-bold text-slate-900">{day}</h3>
                {weekDates?.[di] && <span className="text-sm text-slate-500">{weekDates[di]}</span>}
                <span className="ml-auto text-xs font-medium text-slate-500">
                  {plannedCount} of {periodCount} periods planned
                </span>
              </header>
            )}

            {isExpanded && (
              <div className="divide-y divide-slate-100">
                {dayPeriods.map((cell, pi) => {
                  const isFree = !cell || cell.isFree || cell.subject === '__FREE__';
                  return (
                    <div key={pi} className="avoid-break flex gap-4 px-5 py-4">
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
