import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getCurrentTerm, getMidtermReport, getReportCommentsForStudentTerm } from '../../lib/database';
import { Student } from '../../types';
import type { MidtermReport } from '../../types';
import { FileBarChart } from 'lucide-react';
import { cn } from '../../utils/cn';

export function MidtermReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [reportData, setReportData] = useState<MidtermReport | null>(null);
  const [selectedChild, setSelectedChild] = useState('');
  const [reportComments, setReportComments] = useState<string[]>([]);

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
      const report = await getMidtermReport(selectedChild, term.id);
      setReportData(report);

      const comments = await getReportCommentsForStudentTerm(selectedChild, term.id);
      setReportComments(comments.map(comment => comment.teacherComment || '').filter(Boolean));
    };

    loadReport();
  }, [selectedChild]);

  const child = children.find(c => c.id === selectedChild);

  const overallAvg = reportData?.scores.length
    ? Math.round(reportData.scores.reduce((s, score) => s + score.percentage, 0) / reportData.scores.length)
    : 0;

  const rank = reportData ? `${reportData.overall_rank} / ${reportData.total_students}` : '—';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Midterm Reports</h1>
        <p className="text-slate-500 mt-1">Half-term examination results with rankings</p>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Child</label>
        <div className="flex gap-2 flex-wrap">
          {children.map(c => (
            <button key={c.id} onClick={() => setSelectedChild(c.id)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                selectedChild === c.id ? 'bg-blue-100 text-blue-700 ring-2 ring-offset-1 ring-blue-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{c.name}</button>
          ))}
        </div>
      </div>

      {child && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="bg-gradient-to-r from-blue-500 to-cyan-600 p-5">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Midterm Examination Report</h2>
                <p className="text-sm text-white/80">{child.name} · {child.className}</p>
              </div>
              <div className="flex gap-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{overallAvg}%</p>
                  <p className="text-xs text-white/70">Average</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{rank}</p>
                  <p className="text-xs text-white/70">Position</p>
                </div>
              </div>
            </div>
          </div>

          {reportData && reportData.scores.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Score</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Total</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Percentage</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Grade</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject Rank</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Class Avg</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportData.scores.map(score => (
                      <tr key={score.subject} className="hover:bg-slate-50">
                        <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{score.subject}</td>
                        <td className="px-5 py-4 text-center font-bold text-slate-700">{score.score}</td>
                        <td className="px-5 py-4 text-center text-slate-500">{score.total}</td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn("font-bold",
                            score.percentage >= 80 ? 'text-emerald-600' : score.percentage >= 60 ? 'text-amber-600' : 'text-red-600'
                          )}>{score.percentage}%</span>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn("px-3 py-1 rounded-full text-xs font-bold",
                            score.grade === 'A' ? 'bg-emerald-100 text-emerald-700' :
                            score.grade === 'B' ? 'bg-blue-100 text-blue-700' :
                            score.grade === 'C' ? 'bg-amber-100 text-amber-700' :
                            score.grade === 'D' ? 'bg-orange-100 text-orange-700' :
                            'bg-red-100 text-red-700'
                          )}>{score.grade}</span>
                        </td>
                        <td className="px-5 py-4 text-center text-slate-600">{score.subject_rank}</td>
                        <td className="px-5 py-4 text-center text-slate-600">{score.class_average}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-bold">
                      <td className="px-5 py-3 text-sm text-slate-800">OVERALL</td>
                      <td className="px-5 py-3 text-center text-slate-800">—</td>
                      <td className="px-5 py-3 text-center text-slate-500">—</td>
                      <td className="px-5 py-3 text-center text-indigo-700">{overallAvg}%</td>
                      <td className="px-5 py-3 text-center">
                        <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700">
                          {overallAvg >= 90 ? 'A' : overallAvg >= 80 ? 'B' : overallAvg >= 70 ? 'C' : overallAvg >= 60 ? 'D' : 'F'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-center text-slate-800">{rank}</td>
                      <td className="px-5 py-3 text-center text-slate-500">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <FileBarChart className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No midterm results available</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
