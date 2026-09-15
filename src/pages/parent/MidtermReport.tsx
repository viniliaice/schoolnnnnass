// PARENT — Midterm report section (one tab of the Exam Results screen).
//
// Renders for ONE student (the active child). Same data path as before
// (getMidtermReport RPC + report_comments) with a phone-friendly layout:
// subject cards on small screens, the full table on larger ones, and the
// teacher comments that were previously fetched but never displayed.

import { useEffect, useState } from 'react';
import { getCurrentTerm } from '../../lib/db/academic';
import { getMidtermReport, getReportCommentsForStudentTerm } from '../../lib/db/reports';
import type { MidtermReport, MidtermScore, Student, Term } from '../../types';
import { FileBarChart } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ReportCardShell } from './components/ReportCardShell';
import { TeacherCommentsCard, type ReportCommentLike } from './components/TeacherCommentsCard';

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

function scoreTone(percentage: number): string {
  return percentage >= 80 ? 'text-emerald-600' : percentage >= 60 ? 'text-amber-600' : 'text-red-600';
}

/** Phone layout — one card per subject, no sideways scrolling. */
function MidtermMobileRows({ scores }: { scores: MidtermScore[] }) {
  return (
    <div className="divide-y divide-slate-100 md:hidden">
      {scores.map(score => (
        <div key={score.subject} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold uppercase tracking-wide text-slate-900">{score.subject}</p>
            <p className="mt-1 text-xs text-slate-500">
              {score.score}/{score.total}
              <span className="mx-1 text-slate-300">·</span>Rank {score.subject_rank}
              <span className="mx-1 text-slate-300">·</span>Class avg {score.class_average}%
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn('text-lg font-extrabold', scoreTone(score.percentage))}>{score.percentage}%</span>
            <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', gradeChipClass(score.grade))}>
              {score.grade}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Larger screens — the original full table. */
function MidtermDesktopTable({ report }: { report: MidtermReport }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-500">Subject</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Score</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Total</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Percentage</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Grade</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Subject Rank</th>
            <th className="px-5 py-3 text-center text-xs font-semibold uppercase text-slate-500">Class Avg</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {report.scores.map(score => (
            <tr key={score.subject} className="hover:bg-slate-50">
              <td className="px-5 py-4 text-sm font-semibold text-slate-800">{score.subject}</td>
              <td className="px-5 py-4 text-center font-bold text-slate-700">{score.score}</td>
              <td className="px-5 py-4 text-center text-slate-500">{score.total}</td>
              <td className="px-5 py-4 text-center">
                <span className={cn('font-bold', scoreTone(score.percentage))}>{score.percentage}%</span>
              </td>
              <td className="px-5 py-4 text-center">
                <span className={cn('rounded-full px-3 py-1 text-xs font-bold', gradeChipClass(score.grade))}>
                  {score.grade}
                </span>
              </td>
              <td className="px-5 py-4 text-center text-slate-600">{score.subject_rank}</td>
              <td className="px-5 py-4 text-center text-slate-600">{score.class_average}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MidtermReportTab({ student, term }: { student: Student; term: Term | null }) {
  const [reportData, setReportData] = useState<MidtermReport | null>(null);
  const [comments, setComments] = useState<ReportCommentLike[]>([]);

  useEffect(() => {
    let cancelled = false;

    const loadReport = async () => {
      const resolvedTerm = term ?? (await getCurrentTerm());
      if (!resolvedTerm) return;

      const report = await getMidtermReport(student.id, resolvedTerm.id);
      if (cancelled) return;
      setReportData(report);

      const termComments = await getReportCommentsForStudentTerm(student.id, resolvedTerm.id).catch(
        () => [] as ReportCommentLike[],
      );
      if (!cancelled) setComments(termComments);
    };

    loadReport().catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id, term?.id]);

  const scores = reportData?.scores ?? [];
  const overallAvg = scores.length
    ? Math.round(scores.reduce((s, score) => s + score.percentage, 0) / scores.length)
    : 0;
  const rank = reportData ? `${reportData.overall_rank} / ${reportData.total_students}` : '—';

  return (
    <div className="space-y-4" data-testid="midterm-report">
      <ReportCardShell
        tone="blue"
        title="Midterm Report"
        subtitle={`${student.name} · ${student.className}${term?.name ? ` · ${term.name}` : ''}`}
        stats={
          scores.length > 0
            ? [
                { label: 'Average', value: `${overallAvg}%` },
                { label: 'Position', value: rank },
              ]
            : []
        }
        testId="midterm-report-card"
      >
        {scores.length > 0 ? (
          <>
            <MidtermMobileRows scores={scores} />
            <MidtermDesktopTable report={{ scores, overall_rank: reportData!.overall_rank, total_students: reportData!.total_students }} />
            {/* Overall summary row — readable without parsing the table */}
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
              <p className="text-sm font-bold text-slate-800">Overall</p>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Position {rank}</span>
                <span className="text-lg font-extrabold text-indigo-700">{overallAvg}%</span>
              </div>
            </div>
          </>
        ) : (
          <div className="py-12 text-center text-slate-400">
            <FileBarChart className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
            <p className="font-medium">No midterm results available yet</p>
            <p className="mt-1 text-xs">Midterm results appear here once the school publishes them.</p>
          </div>
        )}
      </ReportCardShell>

      <TeacherCommentsCard comments={comments} />
    </div>
  );
}
