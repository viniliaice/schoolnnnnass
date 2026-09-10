import { useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import type { MonthlyScore } from '../../types';
import { cn } from '../../utils/cn';
import { formatReportPercent } from '../../lib/monthlyReport';

function formatDetailLine(detail: MonthlyScore['details'][number]): string {
  return `${detail.type}: ${detail.score}/${detail.total} (${detail.percentage}%)`;
}

export function MonthlyScoresTable({
  rows,
  month,
}: {
  rows: MonthlyScore[];
  month: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (subject: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(subject)) next.delete(subject);
      else next.add(subject);
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400" data-testid="monthly-empty">
        <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p className="font-medium">No CA or Quiz data available for {month}</p>
      </div>
    );
  }

  return (
    <div data-testid="monthly-score-table">
      <div className="bg-indigo-50/70 border-b border-indigo-100 px-4 py-2.5">
        <p className="text-[11px] leading-[1.4] text-slate-700">
          <span className="font-bold text-indigo-800">Monthly Score = (CA × 40%) + (Quiz × 60%)</span>
          <span className="text-slate-500"> · Missing = “Not recorded” (not 0) · Grade from monthly score</span>
        </p>
      </div>

      {/* Mobile cards — visible on small screens, hidden on md+ — compact */}
      <div className="md:hidden divide-y divide-slate-100">
        {rows.map(row => {
          const isExpanded = expanded.has(row.subject);
          const avgColor =
            row.average == null
              ? 'text-slate-400'
              : row.average >= 80
                ? 'text-emerald-600'
                : row.average >= 60
                  ? 'text-amber-600'
                  : 'text-red-600';
          return (
            <div key={`${row.subject}-${row.month}-card`} data-testid={`monthly-row-${row.subject}`} className="bg-white">
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[13px] text-slate-900 truncate uppercase tracking-[0.03em] leading-none">{row.subject}</p>
                  <p className="text-[11px] text-slate-500 mt-1 leading-none truncate">
                    {row.assessment_count} • CA <span data-testid={`monthly-ca-${row.subject}`} className="font-semibold text-slate-700">{formatReportPercent(row.ca_avg)}</span>
                    <span className="mx-1 text-slate-300">·</span>
                    Quiz <span data-testid={`monthly-quiz-${row.subject}`} className="font-semibold text-slate-700">{formatReportPercent(row.quiz_avg)}</span>
                    <span className="ml-1 text-slate-400">Grade {row.grade ?? '—'}</span>
                  </p>
                </div>
                <div className="text-right shrink-0 min-w-[64px]">
                  <p data-testid={`monthly-score-${row.subject}`} className={cn('text-[18px] font-extrabold leading-none tracking-tight', avgColor)}>
                    {formatReportPercent(row.average)}
                  </p>
                  <p data-testid={`monthly-grade-${row.subject}`} className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mt-1 leading-none">
                    Grade {row.grade ?? '—'}
                  </p>
                </div>
              </div>

              <div className="px-3.5 pb-2.5">
                <button
                  onClick={() => toggle(row.subject)}
                  aria-expanded={isExpanded}
                  aria-controls={`monthly-details-${row.subject}`}
                  className="w-full flex items-center justify-center gap-1 h-8 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-[11px] font-semibold text-slate-700 transition-colors"
                >
                  {isExpanded ? 'Hide Details' : 'View Details'}
                  <ChevronDown className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-180')} />
                </button>

                {isExpanded && (
                  <div id={`monthly-details-${row.subject}`} className="mt-2.5 rounded-xl border border-slate-200 overflow-hidden">
                    <div className="bg-slate-50 px-3 py-1.5 flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                      <span>Assessment</span>
                      <span className="flex gap-3">
                        <span className="w-9 text-center">%</span>
                        <span className="w-14 text-right">Score</span>
                      </span>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {row.ca_details.map((detail, index) => (
                        <div key={`ca-card-${index}`} className="flex items-center justify-between px-3 py-2 text-sm">
                          <span className="font-medium text-slate-700 text-[11px] truncate pr-2">CA · {detail.type}</span>
                          <span className="flex items-center gap-3 shrink-0">
                            <span className="w-9 text-center text-[11px] font-semibold text-slate-600">{detail.percentage}%</span>
                            <span className="w-14 text-right text-[11px] text-slate-600">{detail.score}/{detail.total}</span>
                          </span>
                        </div>
                      ))}
                      {row.quiz_details.map((detail, index) => (
                        <div key={`quiz-card-${index}`} data-testid={`monthly-quiz-detail-${row.subject}-${index}`} className="flex items-center justify-between px-3 py-2 text-sm bg-indigo-50/30">
                          <span className="font-medium text-slate-700 text-[11px] truncate pr-2">Quiz · {detail.type}</span>
                          <span className="flex items-center gap-3 shrink-0">
                            <span className="w-9 text-center text-[11px] font-semibold text-slate-600">{detail.percentage}%</span>
                            <span className="w-14 text-right text-[11px] text-slate-600">{detail.score}/{detail.total}</span>
                          </span>
                        </div>
                      ))}
                      {row.ca_details.length === 0 && row.quiz_details.length === 0 &&
                        row.details.map((detail, index) => (
                          <div key={index} className="flex items-center justify-between px-3 py-2 text-sm">
                            <span className="font-medium text-slate-700 text-[11px] truncate pr-2">{detail.type}</span>
                            <span className="flex items-center gap-3 shrink-0">
                              <span className="w-9 text-center text-[11px] font-semibold text-slate-600">{detail.percentage}%</span>
                              <span className="w-14 text-right text-[11px] text-slate-600">{detail.score}/{detail.total}</span>
                            </span>
                          </div>
                        ))}
                    </div>
                    <div className="bg-slate-50 px-3 py-2 text-[10px] leading-none flex items-center justify-between gap-2 border-t border-slate-200">
                      <span className="text-slate-500 font-medium">Weighting CA 40% + Quiz 60%</span>
                      <span className="font-bold text-slate-700">Monthly {formatReportPercent(row.average)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table — hidden on mobile, visible on md+ */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Subject</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">CA</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Quiz</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">CA Weight</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Quiz Weight</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Monthly Score</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Grade</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.subject}-${row.month}`} className="border-b last:border-b-0">
                <td className="px-4 py-3 font-semibold text-slate-800">{row.subject}</td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-ca-${row.subject}-desktop`}>
                  {formatReportPercent(row.ca_avg)}
                </td>
                <td className="px-4 py-3 text-center font-semibold" data-testid={`monthly-quiz-${row.subject}-desktop`}>
                  {formatReportPercent(row.quiz_avg)}
                </td>
                <td className="px-4 py-3 text-center text-slate-600">{row.ca_weight}%</td>
                <td className="px-4 py-3 text-center text-slate-600">{row.quiz_weight}%</td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-score-${row.subject}-desktop`}>
                  <span className={cn(
                    'font-bold',
                    row.average == null ? 'text-slate-400' : row.average >= 80 ? 'text-emerald-600' : row.average >= 60 ? 'text-amber-600' : 'text-red-600',
                  )}>
                    {formatReportPercent(row.average)}
                  </span>
                </td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-grade-${row.subject}-desktop`}>
                  {row.grade ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="text-xs text-slate-600 space-y-1">
                    {row.ca_details.map((detail, index) => (
                      <div key={`ca-${index}`}>
                        <span className="font-semibold">CA · {detail.type}</span>: {detail.score}/{detail.total} ({detail.percentage}%)
                        {detail.date ? <span className="text-slate-500"> — {detail.date}</span> : null}
                      </div>
                    ))}
                    {row.quiz_details.map((detail, index) => (
                      <div key={`quiz-${index}`}>
                        <span className="font-semibold">Quiz · {detail.type}</span>: {detail.score}/{detail.total} ({detail.percentage}%)
                        {detail.date ? <span className="text-slate-500"> — {detail.date}</span> : null}
                      </div>
                    ))}
                    {row.ca_details.length === 0 && row.quiz_details.length === 0
                      ? row.details.map((detail, index) => (
                          <div key={index}>{formatDetailLine(detail)}</div>
                        ))
                      : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
