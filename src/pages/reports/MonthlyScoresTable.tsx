import { Calendar } from 'lucide-react';
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
      <div className="overflow-x-auto">
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
              <tr key={`${row.subject}-${row.month}`} className="border-b last:border-b-0" data-testid={`monthly-row-${row.subject}`}>
                <td className="px-4 py-3 font-semibold text-slate-800">{row.subject}</td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-ca-${row.subject}`}>
                  {formatReportPercent(row.ca_avg)}
                </td>
                <td className="px-4 py-3 text-center font-semibold" data-testid={`monthly-quiz-${row.subject}`}>
                  {formatReportPercent(row.quiz_avg)}
                </td>
                <td className="px-4 py-3 text-center text-slate-600">{row.ca_weight}%</td>
                <td className="px-4 py-3 text-center text-slate-600">{row.quiz_weight}%</td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-score-${row.subject}`}>
                  <span className={cn(
                    'font-bold',
                    row.average == null ? 'text-slate-400' : row.average >= 80 ? 'text-emerald-600' : row.average >= 60 ? 'text-amber-600' : 'text-red-600',
                  )}>
                    {formatReportPercent(row.average)}
                  </span>
                </td>
                <td className="px-4 py-3 text-center" data-testid={`monthly-grade-${row.subject}`}>
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
                      <div key={`quiz-${index}`} data-testid={`monthly-quiz-detail-${row.subject}-${index}`}>
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
