import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent } from '../../lib/db/students';
import { getCurrentTerm } from '../../lib/db/academic';
import { getMonthlyReport } from '../../lib/db/reports';
import { Student, MonthlyScore, MONTHS } from '../../types';
import { Calendar } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatReportPercent, overallMonthlyAverage } from '../../lib/monthlyReport';
import { MonthlyScoresTable } from '../reports/MonthlyScoresTable';

export function MonthlyReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [reportData, setReportData] = useState<MonthlyScore[]>([]);
  const [selectedChild, setSelectedChild] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const kids = await getStudentsByParent(session.userId);
      setChildren(kids);
      if (kids.length > 0) setSelectedChild(kids[0].id);
    };

    loadData();
  }, [session]);

  useEffect(() => {
    if (!selectedChild) return;

    const loadReport = async () => {
      const term = await getCurrentTerm();
      if (!term) return;
      const report = await getMonthlyReport(selectedChild, term.id);
      setReportData(report);
    };

    loadReport();
  }, [selectedChild]);

  // Filter by selected month
  const monthlyData = reportData.filter(d => d.month === selectedMonth);

  const overallAvg = overallMonthlyAverage(monthlyData);

  const child = children.find(c => c.id === selectedChild);

  // Available months from data
  const availableMonths = [...new Set(reportData.map(d => d.month))];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Monthly Reports</h1>
        <p className="text-slate-500 mt-1">Monthly score = CA 40% + Quiz 60%, calculated per subject</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Child</label>
          <div className="flex gap-2 flex-wrap">
            {children.map(c => (
              <button key={c.id} onClick={() => setSelectedChild(c.id)}
                className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                  selectedChild === c.id ? 'bg-violet-100 text-violet-700 ring-2 ring-offset-1 ring-violet-200' : 'bg-white text-slate-500 border border-slate-200'
                )}>{c.name}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Month</label>
          <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
            className="px-4 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:ring-2 focus:ring-violet-200 outline-none">
            {MONTHS.map(m => (
              <option key={m} value={m}>{m} {availableMonths.includes(m) ? '✓' : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Report Card */}
      {child && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-violet-500 to-indigo-600 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white">Monthly Report — {selectedMonth}</h2>
                <p className="text-sm text-white/80">{child.name} · {child.className}</p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-white">{formatReportPercent(overallAvg)}</p>
                <p className="text-xs text-white/70">Monthly Average</p>
              </div>
            </div>
          </div>

          {monthlyData.length > 0 ? (
            <MonthlyScoresTable rows={monthlyData} month={selectedMonth} />
          ) : (
            <div className="text-center py-12 text-slate-400">
              <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No CA or Quiz data available for {selectedMonth}</p>
              <p className="text-xs mt-1">Available months: {availableMonths.join(', ') || 'None'}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
