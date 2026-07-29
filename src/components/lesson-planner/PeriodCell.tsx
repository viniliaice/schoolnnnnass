import { DayOfWeek, Subject } from '../../types';
import { Loader2, Send, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import { EmptyActivityRow } from './EmptyActivityRow';

interface PeriodCellProps {
  cell: {
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
  } | undefined;
  periodIndex: number;
  teacherClasses: string[];
  subjects: Subject[];
  defaultClassName: string;
  periodCount: number;
  onUpdateCell: (day: DayOfWeek, periodNumber: number, field: string, value: any) => void;
  onUpdateActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number, field: 'activity' | 'time' | 'resource' | 'place', value: string) => void;
  onAddActivity: (day: DayOfWeek, periodNumber: number) => void;
  onRemoveActivity: (day: DayOfWeek, periodNumber: number, activityIndex: number) => void;
}

export function PeriodCell({
  cell,
  periodIndex,
  teacherClasses,
  subjects,
  defaultClassName,
  periodCount,
  onUpdateCell,
  onUpdateActivity,
  onAddActivity,
  onRemoveActivity,
}: PeriodCellProps) {
  if (!cell) return <td className="p-2 border-l border-slate-100 align-top" />;

  const { day, period_number, subject, className, isFree, topic, objective, slide_number, details } = cell;

  if (isFree || subject === '__FREE__') {
    return (
      <td className="p-2 border-l border-slate-100 align-top">
        <div className="text-center py-4 text-slate-400 text-xs">
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-slate-600">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            Free Period
          </span>
        </div>
      </td>
    );
  }

  return (
    <td className="p-2 border-l border-slate-100 align-top">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 font-medium w-9 shrink-0">Subj:</span>
          <select
            value={subject || ''}
            onChange={(e) => onUpdateCell(day, period_number, 'subject', e.target.value)}
            className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
            disabled={isFree}
          >
            <option value="">Select subject</option>
            <option value="__FREE__">Free Period</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            type="checkbox"
            checked={isFree}
            onChange={(e) => onUpdateCell(day, period_number, 'isFree', e.target.checked)}
            className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            title="Free period"
          />
          <span className="text-xs text-slate-400">Free</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 font-medium w-9 shrink-0">Class:</span>
          <select
            value={className || defaultClassName}
            onChange={(e) => onUpdateCell(day, period_number, 'className', e.target.value)}
            className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
          >
            {teacherClasses.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 font-medium w-10 shrink-0">Topic:</span>
          <input
            value={topic}
            onChange={(e) => onUpdateCell(day, period_number, 'topic', e.target.value)}
            placeholder="Enter topic"
            className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-indigo-300"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 font-medium w-10 shrink-0">Obj:</span>
          <input
            value={objective}
            onChange={(e) => onUpdateCell(day, period_number, 'objective', e.target.value)}
            placeholder="Objective"
            className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
          />
          <span className="text-xs text-slate-400 font-medium w-9 shrink-0">Pg:</span>
          <input
            value={slide_number}
            onChange={(e) => onUpdateCell(day, period_number, 'slide_number', e.target.value)}
            placeholder="#"
            className="w-10 rounded-md border border-slate-200 px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-300"
          />
        </div>
        <div className="border-t border-slate-100" />
        {details.length === 0 ? (
          <EmptyActivityRow onAdd={() => onAddActivity(day, period_number)} />
        ) : (
          <>
            {details.map((act, ai) => (
              <div key={ai} className="space-y-0.5">
                <div className="flex items-center gap-1">
                  <input
                    value={act.activity}
                    onChange={(e) => onUpdateActivity(day, period_number, ai, 'activity', e.target.value)}
                    placeholder={`Act ${ai + 1}`}
                    className="flex-1 rounded-md border border-slate-200 px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  />
                  <input
                    value={act.time}
                    onChange={(e) => onUpdateActivity(day, period_number, ai, 'time', e.target.value)}
                    placeholder="min"
                    className="w-14 rounded-md border border-slate-200 px-1 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  />
                  <button
                    onClick={() => onRemoveActivity(day, period_number, ai)}
                    className="p-0.5 rounded text-slate-300 hover:text-red-500 shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    value={act.resource}
                    onChange={(e) => onUpdateActivity(day, period_number, ai, 'resource', e.target.value)}
                    placeholder="Resource"
                    className="flex-1 rounded-md border border-slate-200 px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  />
                  <input
                    value={act.place}
                    onChange={(e) => onUpdateActivity(day, period_number, ai, 'place', e.target.value)}
                    placeholder="Place/URL"
                    className="flex-1 rounded-md border border-slate-200 px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  />
                </div>
              </div>
            ))}
            <button
              onClick={() => onAddActivity(day, period_number)}
              className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 transition-colors pt-0.5"
            >
              <Plus className="w-3 h-3" /> Activity
            </button>
          </>
        )}
      </div>
    </td>
  );
}