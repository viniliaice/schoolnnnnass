// PARENT — Final report section (one tab of the Exam Results screen).
//
// Renders for ONE student (the active child). Same data path as before
// (getFinalReport RPC) with a phone-friendly layout: subject cards on small
// screens, the original weighted table on larger ones, plus the teacher /
// principal comment that ships with the report.

import { useEffect, useState } from 'react';
import { getCurrentTerm } from '../../lib/db/academic';
import { getFinalReport } from '../../lib/db/reports';
import { getGrade, type FinalReport, type FinalSubject, type Student, type Term } from '../../types';
import { Award, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ReportCardShell } from './components/ReportCardShell';
import { TeacherCommentsCard, type ReportCommentLike } from './components/TeacherCommentsCard';

const PASS_MARK = 60;

function gradeChipClass(grade: string): string {
  return grade === 'A'
    ? 'bg-emerald-100 text-emerald-700'
    : grade === 'B'
      ? 'bg-blue-100 text-blue-700'
      : grade === 'C'
        ? 'bg-amber-100 text-amber-700'
        : grade === 'D'
          ? 'bg-orange-100 text-orange-700'
          : 'bg-red-100 text-red-700';
}

/** Phone layout — one card per subject, no sideways scrolling. */
function FinalMobileRows({ results }: { results: FinalSubject[] }) {
  return (
    <div className="divide-y divide-slate-100 md:hidden">
      {results.map((result, i) => (
        <div key={`${result.subject}-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold uppercase tracking-wide text-slate-900">{result.subject}</p>
            <p className="mt-1 text-xs text-slate-500">
              CA {result.ca_avg}%<span className="mx-1 text-slate-300">·</span>
              Midterm {result.midterm_score}%<span className="mx-1 text-slate-300">·</span>
              Final {result.final_score}%
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span
              className={cn(
                'text-lg font-extrabold',
                result.total >= 80 ? 'text-emerald-600' : result.total >= PASS_MARK ? 'text-amber-600' : 'text-red-600',
              )}
            >
              {result.total}%
            </span>
            <span className="flex items-center gap-1.5">
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', gradeChipClass(getGrade(result.total)))}>
                {getGrade(result.total)}
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-bold',
                  result.total >= PASS_MARK ? 'text-emerald-600' : 'text-red-600',
                )}
              >
                {result.total >= PASS_MARK ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {result.total >= PASS_MARK ? 'Pass' : 'Fail'}
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Larger screens — the original weighted table. */
function FinalDesktopTable({
  results,
  weights,
  overallFinal,
  passedCount,
  allPassed,
}: {
  results: FinalSubject[];
  weights: FinalReport['weights'];
  overallFinal: number;
  passedCount: number;
  allPassed: boolean;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">Subject</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">CA ({weights.ca}%)</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Midterm ({weights.midterm}%)</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Final ({weights.final}%)</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Final Score</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Grade</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {results.map((result, i) => (
            <tr key={`${result.subject}-${i}`} className="hover:bg-slate-50">
              <td className="px-5 py-4 text-sm font-semibold text-slate-800">{result.subject}</td>
              <td className="px-5 py-4 text-center text-sm text-slate-600">{result.ca_avg}%</td>
              <td className="px-5 py-4 text-center text-sm text-slate-600">{result.midterm_score}%</td>
              <td className="px-5 py-4 text-center text-sm text-slate-600">{result.final_score}%</td>
              <td className="px-5 py-4 text-center">
                <span
                  className={cn(
                    'text-lg font-bold',
                    result.total >= 80 ? 'text-emerald-600' : result.total >= PASS_MARK ? 'text-amber-600' : 'text-red-600',
                  )}
                >
                  {result.total}%
                </span>
              </td>
              <td className="px-5 py-4 text-center">
                <span className={cn('rounded-full px-3 py-1 text-xs font-bold', gradeChipClass(getGrade(result.total)))}>
                  {getGrade(result.total)}
                </span>
              </td>
              <td className="px-5 py-4 text-center">
                {result.total >= PASS_MARK ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                    <CheckCircle className="h-4 w-4" /> Pass
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                    <XCircle className="h-4 w-4" /> Fail
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
            <td className="px-5 py-3 text-sm text-slate-800">OVERALL</td>
            <td className="px-5 py-3 text-center text-sm text-slate-600">
              {Math.round(results.reduce((s, r) => s + r.ca_avg, 0) / results.length)}%
            </td>
            <td className="px-5 py-3 text-center text-sm text-slate-600">
              {Math.round(results.reduce((s, r) => s + r.midterm_score, 0) / results.length)}%
            </td>
            <td className="px-5 py-3 text-center text-sm text-slate-600">
              {Math.round(results.reduce((s, r) => s + r.final_score, 0) / results.length)}%
            </td>
            <td className="px-5 py-3 text-center text-lg font-bold text-indigo-700">{overallFinal}%</td>
            <td className="px-5 py-3 text-center">
              <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-700">
                {getGrade(overallFinal)}
              </span>
            </td>
            <td className="px-5 py-3 text-center">
              {allPassed ? (
                <span className="text-xs font-bold text-emerald-600">ALL PASSED</span>
              ) : (
                <span className="text-xs font-bold text-amber-600">
                  {passedCount}/{results.length}
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function FinalReportTab({ student, term }: { student: Student; term: Term | null }) {
  const [reportData, setReportData] = useState<FinalReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadReport = async () => {
      setLoading(true);
      setError(null);
      setReportData(null);
      try {
        const resolvedTerm = term ?? (await getCurrentTerm());
        if (!resolvedTerm) {
          setError('Current academic term is unavailable.');
          return;
        }
        const report = await getFinalReport(student.id, resolvedTerm.id);
        if (!cancelled) setReportData(report || null);
      } catch (err) {
        console.error('Failed to load final report', err);
        if (!cancelled) setError('Unable to load the final report. Please try again later.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadReport();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id, term?.id]);

  const results = reportData?.results ?? [];
  const weights = reportData?.weights ?? { ca: 0, midterm: 0, final: 0 };
  const overallFinal = results.length
    ? Math.round(results.reduce((s, r) => s + r.total, 0) / results.length)
    : 0;
  const passedCount = results.filter(r => r.total >= PASS_MARK).length;
  const allPassed = results.length > 0 && passedCount === results.length;
  const rank = reportData && reportData.total_students > 0 ? `${reportData.overall_rank} / ${reportData.total_students}` : '—';

  const comments: ReportCommentLike[] = reportData?.comment
    ? [{ teacherComment: reportData.comment.teacher, principalComment: reportData.comment.principal }]
    : [];

  return (
    <div className="space-y-4" data-testid="final-report">
      <ReportCardShell
        tone="amber"
        title="Final Report"
        subtitle={`${student.name} · ${student.className}${term?.name ? ` · ${term.name}` : ''}`}
        stats={
          results.length > 0
            ? [
                { label: 'Final Average', value: `${overallFinal}%` },
                { label: 'Position', value: rank },
              ]
            : []
        }
        testId="final-report-card"
      >
        {results.length > 0 && (
          <div className="border-b border-amber-100 bg-amber-50 px-4 py-2.5">
            <p className="text-xs font-medium text-amber-800">
              Final Score = (CA × {weights.ca}%) + (Midterm × {weights.midterm}%) + (Final Exam × {weights.final}%) ·
              Pass mark: {PASS_MARK}%
            </p>
          </div>
        )}

        {/* Overall pass status — one glance, no table parsing */}
        {results.length > 0 && (
          <div className="flex items-center justify-center gap-2 border-b border-slate-100 px-4 py-3">
            {allPassed ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-4 py-1.5 text-sm font-bold text-emerald-700">
                <CheckCircle className="h-4 w-4" /> PASSED — all subjects
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-4 py-1.5 text-sm font-bold text-amber-700">
                {passedCount} of {results.length} subjects passed
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div className="py-12 text-center text-slate-500">Loading final report…</div>
        ) : error ? (
          <div className="py-12 text-center text-rose-600">{error}</div>
        ) : results.length > 0 ? (
          <>
            <FinalMobileRows results={results} />
            <FinalDesktopTable
              results={results}
              weights={weights}
              overallFinal={overallFinal}
              passedCount={passedCount}
              allPassed={allPassed}
            />
          </>
        ) : (
          <div className="py-12 text-center text-slate-400">
            <Award className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
            <p className="font-medium">Final report not available yet</p>
            <p className="mt-1 text-xs">The final report appears here once the school publishes it.</p>
          </div>
        )}
      </ReportCardShell>

      <TeacherCommentsCard comments={comments} />
    </div>
  );
}
