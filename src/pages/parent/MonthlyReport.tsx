import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent } from '../../lib/database';
import { Student, Exam, CA_TYPES, MONTHS } from '../../types';
import { Calendar } from 'lucide-react';
import { cn } from '../../utils/cn';

export function MonthlyReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedChild, setSelectedChild] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const kids = await getStudentsByParent(session.userId);
      setChildren(kids);
      if (kids.length > 0) setSelectedChild(kids[0].id);
      const examsData = await getExamsByParent(session.userId, 'approved');
      setExams(examsData);
    };

    loadData();
  }, [session]);

  // Monthly Report = CA-type exams for selected month, filtered per student
  const monthlyExams = exams.filter(e =>
    e.studentId === selectedChild &&
    e.month === selectedMonth &&
    CA_TYPES.includes(e.examType)
  );

  // Group by subject
  const subjects = [...new Set(monthlyExams.map(e => e.subject))];
  const subjectData = subjects.map(sub => {
    const subExams = monthlyExams.filter(e => e.subject === sub);
    const scores = subExams.map(e => ({ type: e.examType, score: e.score, total: e.total, pct: Math.round(e.score / e.total * 100) }));
    const avg = scores.length > 0 ? Math.round(scores.reduce((s, sc) => s + sc.pct, 0) / scores.length) : 0;
    return { subject: sub, scores, avg };
  });

  const overallAvg = subjectData.length > 0
    ? Math.round(subjectData.reduce((s, d) => s + d.avg, 0) / subjectData.length)
    : 0;

  const child = children.find(c => c.id === selectedChild);

  // Find months that have CA data for selected child
  const availableMonths = [...new Set(
    exams.filter(e => e.studentId === selectedChild && CA_TYPES.includes(e.examType)).map(e => e.month)
  )];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Monthly Reports</h1>
        <p className="text-slate-500 mt-1">Continuous Assessment performance per month (CA, Homework, Classwork, Quizzes)</p>
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
                <p className="text-3xl font-bold text-white">{overallAvg}%</p>
                <p className="text-xs text-white/70">Monthly Average</p>
              </div>
            </div>
          </div>

          {subjectData.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">CA Scores</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Monthly Average</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {subjectData.map(row => (
                    <tr key={row.subject} className="hover:bg-slate-50">
                      <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{row.subject}</td>
                      <td className="px-5 py-4 text-center">
                        <div className="flex flex-wrap gap-1.5 justify-center">
                          {row.scores.map((sc, i) => (
                            <span key={i} className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">
                              {sc.type}: {sc.score}/{sc.total}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-center">
                        <span className={cn("text-lg font-bold",
                          row.avg >= 80 ? 'text-emerald-600' : row.avg >= 60 ? 'text-amber-600' : 'text-red-600'
                        )}>{row.avg}%</span>
                      </td>
                      <td className="px-5 py-4 text-center text-sm">
                        {row.avg >= 90 ? <span className="text-emerald-600 font-medium">Excellent</span> :
                         row.avg >= 80 ? <span className="text-emerald-600 font-medium">Very Good</span> :
                         row.avg >= 70 ? <span className="text-blue-600 font-medium">Good</span> :
                         row.avg >= 60 ? <span className="text-amber-600 font-medium">Satisfactory</span> :
                         <span className="text-red-600 font-medium">Needs Improvement</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No CA data available for {selectedMonth}</p>
              <p className="text-xs mt-1">Available months: {availableMonths.join(', ') || 'None'}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
