import { DayOfWeek, DAYS_OF_WEEK, Subject } from '../../types';
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
  onUpdateCell: (day: DayOfWeek, periodNumber: number, field: string, value: any) => void;
  onUpdateActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number, field: 'activity' | 'time' | 'resource' | 'place', value: string) => void;
  onAddActivity: (day: DayOfWeek, periodNumber: number) => void;
  onRemoveActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number) => void;
}

export function PlanGrid({
  periods,
  periodCount,
  teacherClasses,
  subjects,
  planClassName,
  onUpdateCell,
  onUpdateActivity,
  onAddActivity,
  onRemoveActivity,
}: PlanGridProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="p-2.5 text-left font-semibold text-slate-700 w-12">#</th>
              {DAYS_OF_WEEK.map((day) => (
                <th key={day} className="p-2.5 text-left font-semibold text-slate-700 min-w-[300px] border-l border-slate-200">{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: periodCount }, (_, pi) => (
              <tr key={pi} className="border-b border-slate-100 last:border-0">
                <td className="p-2.5 text-center font-medium text-slate-400 text-xs align-top pt-3">P{pi + 1}</td>
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
    </div>
  );
}