// PARENT — Monthly report section (one tab of the Exam Results screen).
//
// Renders for ONE student (the active child) — the child picker and the
// page-level heading live in ExamResults, so parents never hunt for where
// monthly reports went. Data is unchanged: same getMonthlyReport RPC, same
// MonthlyScoresTable, same report_comments, same RLS boundary.

import { useEffect, useState } from 'react';
import { getCurrentTerm } from '../../lib/db/academic';
import { getMonthlyReport, getReportCommentsForStudentTerm } from '../../lib/db/reports';
import { getChildAttendanceSummary, type AttendanceSummary } from '../../lib/db/parent-portal';
import { MONTHS, type MonthlyScore, type Student, type Term } from '../../types';
import { Calendar, CalendarCheck2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatReportPercent, overallMonthlyAverage } from '../../lib/monthlyReport';
import { MonthlyScoresTable } from '../reports/MonthlyScoresTable';
import { ReportCardShell } from './components/ReportCardShell';
import { TeacherCommentsCard } from './components/TeacherCommentsCard';

type TermComment = { teacherComment?: string | null; principalComment?: string | null };

export function MonthlyReportTab({ student, term }: { student: Student; term: Term | null }) {
  const [reportData, setReportData] = useState<MonthlyScore[]>([]);
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);
  const [comments, setComments] = useState<TermComment[]>([]);
  const [attendance, setAttendance] = useState<AttendanceSummary | null>(null);
  // Auto-jump once per child to the latest month that actually has data, so
  // parents land on a filled report instead of an empty current month.
  const [autoJumpedFor, setAutoJumpedFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadReport = async () => {
      const resolvedTerm = term ?? (await getCurrentTerm());
      if (!resolvedTerm) return;

      const report = await getMonthlyReport(student.id, resolvedTerm.id);
      if (cancelled) return;
      setReportData(report);

      const [termComments, attendanceSummary] = await Promise.all([
        getReportCommentsForStudentTerm(student.id, resolvedTerm.id).catch(() => [] as TermComment[]),
        getChildAttendanceSummary(student.id).catch(() => null),
      ]);
      if (cancelled) return;
      setComments(termComments);
      setAttendance(attendanceSummary && attendanceSummary.total > 0 ? attendanceSummary : null);

      // Once per child: if the preselected month is empty but earlier months
      // have data, open the most recent month with data instead.
      setAutoJumpedFor(prev => (prev === student.id ? prev : student.id));
      setSelectedMonth(prevMonth => {
        if (autoJumpedFor === student.id) return prevMonth; // already auto-selected / user-driven
        if (report.some(d => d.month === prevMonth)) return prevMonth;
        const available = [...new Set(report.map(d => d.month))];
        if (available.length === 0) return prevMonth;
        return available.sort((a, b) => MONTHS.indexOf(b) - MONTHS.indexOf(a))[0];
      });
    };

    loadReport().catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id, term?.id]);

  const monthlyData = reportData.filter(d => d.month === selectedMonth);
  const overallAvg = overallMonthlyAverage(monthlyData);
  const availableMonths = [...new Set(reportData.map(d => d.month))];

  return (
    <div className="space-y-4" data-testid="monthly-report">
      {/* Month picker — big native select, plus one-tap chips for months that
          actually have data (no hunting through 12 empty months). */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="parent-month-select">
          Month
        </label>
        <select
          id="parent-month-select"
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="min-h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-base font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-violet-300"
        >
          {MONTHS.map(m => (
            <option key={m} value={m}>
              {m} {availableMonths.includes(m) ? '· has report' : ''}
            </option>
          ))}
        </select>
        {availableMonths.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {availableMonths.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setSelectedMonth(m)}
                className={cn(
                  'min-h-10 rounded-full px-4 text-sm font-semibold transition-colors',
                  selectedMonth === m
                    ? 'bg-violet-600 text-white'
                    : 'bg-violet-50 text-violet-700 hover:bg-violet-100',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      <ReportCardShell
        tone="violet"
        title={`Monthly Report — ${selectedMonth}`}
        subtitle={`${student.name} · ${student.className}${term?.name ? ` · ${term.name}` : ''}`}
        stats={monthlyData.length > 0 ? [{ label: 'Monthly Average', value: formatReportPercent(overallAvg) }] : []}
        testId="monthly-report-card"
      >
        {/* Attendance — shown where a record exists for this child */}
        {attendance && (
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3" data-testid="monthly-attendance">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-50">
              <CalendarCheck2 className="h-5 w-5 text-cyan-600" aria-hidden="true" />
            </span>
            <p className="text-sm text-slate-700">
              <span className="font-bold text-slate-900">Attendance:</span> {attendance.total} days recorded —{' '}
              <span className="font-semibold text-emerald-700">{attendance.present} present</span>
              {attendance.absent > 0 && <span className="font-semibold text-red-600"> · {attendance.absent} absent</span>}
              {attendance.late > 0 && <span className="font-semibold text-amber-600"> · {attendance.late} late</span>}
            </p>
          </div>
        )}

        {monthlyData.length > 0 ? (
          <MonthlyScoresTable rows={monthlyData} month={selectedMonth} />
        ) : (
          <div className="py-12 text-center text-slate-400">
            <Calendar className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
            <p className="font-medium">No report for {selectedMonth} yet</p>
            <p className="mt-1 text-xs">
              {availableMonths.length > 0
                ? `Months with reports: ${availableMonths.join(', ')}`
                : 'The school has not published monthly results yet.'}
            </p>
          </div>
        )}
      </ReportCardShell>

      <TeacherCommentsCard comments={comments} />
    </div>
  );
}
