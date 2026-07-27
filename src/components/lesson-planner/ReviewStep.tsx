import { DayOfWeek, DAYS_OF_WEEK, PeriodActivity, Subject } from '../../types';
import { Loader2, Send, FileText } from 'lucide-react';

interface ReviewStepProps {
  periods: {
    day: DayOfWeek;
    period_number: number;
    subject: string;
    className: string;
    isFree: boolean;
    topic: string;
    objective: string;
    slide_number: string;
    details: PeriodActivity[];
  }[];
  teacherClasses: string[];
  subjects: Subject[];
  periodCount: number;
  weekLabel: string;
  title: string;
  planClassName: string;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

export function ReviewStep({
  periods,
  teacherClasses,
  subjects,
  periodCount,
  weekLabel,
  title,
  planClassName,
  onBack,
  onSubmit,
  isSubmitting,
}: ReviewStepProps) {
  const freeCount = periods.filter((p) => p.isFree).length;
  const filledCount = periods.filter((p) => !p.isFree && p.topic.trim()).length;
  const emptyCount = periods.filter((p) => !p.isFree && !p.topic.trim()).length;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Review & Submit</h2>
            <p className="text-sm text-slate-500">{title || 'Lesson Plan'} &middot; {weekLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            Back to Plan
          </button>
          <button
            onClick={onSubmit}
            disabled={isSubmitting || emptyCount > 0}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            Submit to Supervisor
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-emerald-50 rounded-2xl border border-emerald-100 p-4 text-center">
          <p className="text-3xl font-bold text-emerald-700">{filledCount}</p>
          <p className="text-sm text-emerald-600">Periods with topics</p>
        </div>
        <div className="bg-amber-50 rounded-2xl border border-amber-100 p-4 text-center">
          <p className="text-3xl font-bold text-amber-700">{emptyCount}</p>
          <p className="text-sm text-amber-600">Empty periods</p>
        </div>
        <div className="bg-slate-50 rounded-2xl border border-slate-100 p-4 text-center">
          <p className="text-3xl font-bold text-slate-700">{freeCount}</p>
          <p className="text-sm text-slate-500">Free periods</p>
        </div>
      </div>

      {/* Period-by-period review */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 bg-slate-50">
          <h3 className="font-semibold text-slate-900">Weekly Plan Overview</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="p-2.5 text-left font-semibold text-slate-700 w-12">#</th>
                {DAYS_OF_WEEK.map((day) => (
                  <th key={day} className="p-2.5 text-left font-semibold text-slate-700 min-w-[220px] border-l border-slate-200">{day}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: periodCount }, (_, pi) => (
                <tr key={pi} className="border-b border-slate-100 last:border-0">
                  <td className="p-2.5 text-center font-medium text-slate-400 text-xs align-top pt-3">P{pi + 1}</td>
                  {DAYS_OF_WEEK.map((day) => {
                    const cell = periods.find((c) => c.day === day && c.period_number === pi + 1);
                    if (!cell) return <td key={day} className="p-2 border-l border-slate-100 align-top" />;
                    return (
                      <td key={day} className="p-2 border-l border-slate-100 align-top">
                        {cell.isFree ? (
                          <div className="text-center py-4 text-slate-400 text-xs">
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-slate-600">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                              Free Period
                            </span>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400 font-medium w-8 shrink-0">Subj:</span>
                              <span className="flex-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 bg-white">
                                {subjects.find((s) => s.id === cell.subject)?.name || cell.subject || '—'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400 font-medium w-8 shrink-0">Cls:</span>
                              <span className="flex-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 bg-white">
                                {cell.className || planClassName || '—'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400 font-medium w-10 shrink-0">Topic:</span>
                              <input
                                value={cell.topic}
                                readOnly
                                className="flex-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium bg-white focus:outline-none"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400 font-medium w-10 shrink-0">Obj:</span>
                              <input
                                value={cell.objective}
                                readOnly
                                className="flex-1 rounded-md border border-slate-200 px-2 py-0.5 text-xs bg-white focus:outline-none"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400 font-medium w-9 shrink-0">Pg:</span>
                              <input
                                value={cell.slide_number}
                                readOnly
                                className="w-10 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-center bg-white focus:outline-none"
                              />
                            </div>
                            {cell.details.length > 0 && (
                              <div className="space-y-0.5 pt-0.5 border-t border-slate-100">
                                {cell.details.map((act, ai) => (
                                  <div key={ai} className="space-y-0.5">
                                    <div className="flex items-center gap-1 text-xs">
                                      <span className="text-slate-400">{ai + 1}.</span>
                                      <span className="flex-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-slate-600 bg-white">{act.activity || '—'}</span>
                                      <span className="w-14 rounded-md border border-slate-200 px-1 py-0.5 text-center text-slate-600 bg-white">{act.time || '—'}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-xs">
                                      <span className="flex-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-slate-600 bg-white">{act.resource || '—'}</span>
                                      <span className="flex-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-slate-600 bg-white">{act.place || '—'}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
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
    </div>
  );
}