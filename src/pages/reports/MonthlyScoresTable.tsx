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
      <div className="bg-indigo-50 border-b border-indigo-100 px-5 py-3">
        <p className="text-xs text-indigo-700 font-medium">
          Monthly Score = (CA × 40%) + (Quiz × 60%). Missing CA or Quiz is shown as
          “Not recorded”, not as 0. Grade is based on the Monthly score.
        </p>
      </div>

      {/* Mobile cards — visible on small screens, hidden on md+ */}
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
              <div className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-sm text-slate-900 truncate uppercase tracking-wide">{row.subject}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {row.assessment_count} assessments
                    <span className="mx-1.5 text-slate-300">•</span>
                    <span className="inline-flex items-center gap-1">
                      CA <span data-testid={`monthly-ca-${row.subject}`} className="font-medium text-slate-700">{formatReportPercent(row.ca_avg)}</span>
                    </span>
                    <span className="mx-1 text-slate-300">/</span>
                    <span className="inline-flex items-center gap-1">
                      Quiz <span data-testid={`monthly-quiz-${row.subject}`} className="font-medium text-slate-700">{formatReportPercent(row.quiz_avg)}</span>
                    </span>
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p data-testid={`monthly-score-${row.subject}`} className={cn('text-lg font-bold leading-none', avgColor)}>
                    {formatReportPercent(row.average)}
                  </p>
                  <p data-testid={`monthly-grade-${row.subject}`} className="text-[11px] font-semibold text-slate-500 mt-1">
                    Grade {row.grade ?? '—'}
                  </p>
                </div>
              </div>

              <div className="px-4 pb-3">
                <button
                  onClick={() => toggle(row.subject)}
                  aria-expanded={isExpanded}
                  aria-controls={`monthly-details-${row.subject}`}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700 transition-colors"
                >
                  {isExpanded ? 'Hide Details' : 'View Details'}
                  <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', isExpanded && 'rotate-180')} />
                </button>

                {isExpanded && (
                  <div id={`monthly-details-${row.subject}`} className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 flex items-center justify-between text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                      <span>Assessment</span>
                      <span className="flex gap-4">
                        <span className="w-10 text-center">%</span>
                        <span className="w-16 text-right">Score</span>
                      </span>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {row.ca_details.map((detail, index) => (
                        <div key={`ca-card-${index}`} className="flex items-center justify-between px-3 py-2.5 text-sm">
                          <span className="font-medium text-slate-700 text-xs">CA · {detail.type}</span>
                          <span className="flex items-center gap-4">
                            <span className="w-10 text-center text-xs font-semibold text-slate-600">{detail.percentage}%</span>
                            <span className="w-16 text-right text-xs text-slate-600">{detail.score}/{detail.total}</span>
                          </span>
                        </div>
                      ))}
                      {row.quiz_details.map((detail, index) => (
                        <div key={`quiz-card-${index}`} data-testid={`monthly-quiz-detail-${row.subject}-${index}`} className="flex items-center justify-between px-3 py-2.5 text-sm bg-indigo-50/30">
                          <span className="font-medium text-slate-700 text-xs">Quiz · {detail.type}</span>
                          <span className="flex items-center gap-4">
                            <span className="w-10 text-center text-xs font-semibold text-slate-600">{detail.percentage}%</span>
                            <span className="w-16 text-right text-xs text-slate-600">{detail.score}/{detail.total}</span>
                          </span>
                        </div>
                      ))}
                      {row.ca_details.length === 0 && row.quiz_details.length === 0 &&
                        row.details.map((detail, index) => (
                          <div key={index} className="flex items-center justify-between px-3 py-2.5 text-sm">
                            <span className="font-medium text-slate-700 text-xs">{detail.type}</span>
                            <span className="flex items-center gap-4">
                              <span className="w-10 text-center text-xs font-semibold text-slate-600">{detail.percentage}%</span>
                              <span className="w-16 text-right text-xs text-slate-600">{detail.score}/{detail.total}</span>
                            </span>
                          </div>
                        ))}
                    </div>
                    <div className="bg-slate-50 px-3 py-2 text-[11px] text-slate-500 flex items-center justify-between">
                      <span>CA {row.ca_weight}% · Quiz {row.quiz_weight}%</span>
                      <span className="font-semibold">Monthly {formatReportPercent(row.average)}</span>
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
