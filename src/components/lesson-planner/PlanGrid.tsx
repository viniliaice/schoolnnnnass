import { DayOfWeek, DAYS_OF_WEEK, Subject } from '../../types';
import { Plus, Trash2 } from 'lucide-react';
import { PeriodCell } from './PeriodCell';

interface PlanGridProps {
  periods: {
    day: DayOfWeek;
    period_number: number;
    subject: string;
    className: string;
    isFree: boolean;
    topic: string;
    objective: string;
    slide_number: string;
    details: {
      activity: string;
      time: string;
      resource: string;
      place: string;
    }[];
  }[];
  periodCount: number;
  teacherClasses: string[];
  subjects: Subject[];
  planClassName: string;
  weekDates: string[];
  onUpdateCell: (day: DayOfWeek, periodNumber: number, field: string, value: any) => void;
  onUpdateActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number, field: 'activity' | 'time' | 'resource' | 'place', value: string) => void;
  onAddActivity: (day: DayOfWeek, periodNumber: number) => void;
  onRemoveActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number) => void;
  /** Add/remove rows so the teacher controls the number of periods. */
  onChangePeriodCount?: (value: number) => void;
}

export function PlanGrid({
  periods,
  periodCount,
  teacherClasses,
  subjects,
  planClassName,
  weekDates,
  onUpdateCell,
  onUpdateActivity,
  onAddActivity,
  onRemoveActivity,
  onChangePeriodCount,
}: PlanGridProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="p-2.5 text-left font-semibold text-slate-700 w-12">#</th>
              {DAYS_OF_WEEK.map((day, i) => (
                <th key={day} className="p-2.5 text-left font-semibold text-slate-700 min-w-[300px] border-l border-slate-200">
                  <div>{day}</div>
                  <div className="text-xs font-normal text-slate-400 mt-0.5">{weekDates[i] || ''}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: periodCount }, (_, pi) => (
              <tr key={pi} className="border-b border-slate-100 last:border-0">
                <td className="p-2.5 text-center align-top pt-3">
                  <div className="flex flex-col items-center gap-1">
                    <span className="font-medium text-slate-400 text-xs">P{pi + 1}</span>
                    {pi === periodCount - 1 && onChangePeriodCount && periodCount > 1 && (
                      <button
                        type="button"
                        onClick={() => onChangePeriodCount(periodCount - 1)}
                        title={`Remove period ${periodCount}`}
                        aria-label={`Remove period ${periodCount}`}
                        className="p-1 rounded text-slate-300 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </td>
                {DAYS_OF_WEEK.map((day) => {
                  const cell = periods.find((c) => c.day === day && c.period_number === pi + 1);
                  return (
                    <PeriodCell
                      key={day}
                      cell={cell}
                      periodIndex={pi}
                      teacherClasses={teacherClasses}
                      subjects={subjects}
                      defaultClassName={planClassName}
                      periodCount={periodCount}
                      onUpdateCell={onUpdateCell}
                      onUpdateActivity={onUpdateActivity}
                      onAddActivity={onAddActivity}
                      onRemoveActivity={onRemoveActivity}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onChangePeriodCount && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
          <button
            type="button"
            onClick={() => onChangePeriodCount(periodCount + 1)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-indigo-300 text-sm font-medium text-indigo-600 hover:bg-indigo-50 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Period {periodCount + 1}
          </button>
          <span className="text-xs text-slate-400">{periodCount} periods per day</span>
        </div>
      )}
    </div>
  );
}
