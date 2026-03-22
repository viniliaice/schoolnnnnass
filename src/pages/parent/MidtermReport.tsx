import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent, getStudents } from '../../lib/database';
import { Student, Exam, getGrade } from '../../types';
import { FileBarChart } from 'lucide-react';
import { cn } from '../../utils/cn';

export function MidtermReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedChild, setSelectedChild] = useState('');
  const [allStudents, setAllStudents] = useState<Student[]>([]);

  useEffect(() => {
    if (!session) return;
    const kids = getStudentsByParent(session.userId);
    setChildren(kids);
    if (kids.length > 0) setSelectedChild(kids[0].id);
    setExams(getExamsByParent(session.userId, 'approved'));
    setAllStudents(getStudents());
  }, [session]);

  const child = children.find(c => c.id === selectedChild);

  // Midterm exams for selected child
  const midtermExams = exams.filter(e => e.studentId === selectedChild && e.examType === 'Midterm');
  const subjects = [...new Set(midtermExams.map(e => e.subject))];

  const subjectData = subjects.map(sub => {
    const exam = midtermExams.find(e => e.subject === sub)!;
    return {
      subject: sub,
      score: exam.score,
      total: exam.total,
      percentage: Math.round(exam.score / exam.total * 100),
      grade: getGrade(Math.round(exam.score / exam.total * 100)),
    };
  });

  const totalScore = subjectData.reduce((s, d) => s + d.score, 0);
  const totalMarks = subjectData.reduce((s, d) => s + d.total, 0);
  const overallAvg = subjectData.length > 0
    ? Math.round(subjectData.reduce((s, d) => s + d.percentage, 0) / subjectData.length)
    : 0;

  // Calculate rank among classmates (simple position)
  let rank = '—';
  if (child && subjectData.length > 0) {
    const classmates = allStudents.filter(s => s.className === child.className);
    const classMidtermAvgs = classmates.map(cm => {
      const cmExams = exams.filter(e => e.studentId === cm.id && e.examType === 'Midterm');
      if (cmExams.length === 0) return { id: cm.id, avg: 0 };
      const avg = Math.round(cmExams.reduce((s, e) => s + (e.score / e.total * 100), 0) / cmExams.length);
      return { id: cm.id, avg };
    }).filter(cm => cm.avg > 0).sort((a, b) => b.avg - a.avg);

    const pos = classMidtermAvgs.findIndex(cm => cm.id === selectedChild) + 1;
    if (pos > 0) {
      const suffix = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
      rank = `${pos}${suffix} / ${classMidtermAvgs.length}`;
    }
  }

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

          {subjectData.length > 0 ? (
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {subjectData.map(row => (
                      <tr key={row.subject} className="hover:bg-slate-50">
                        <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{row.subject}</td>
                        <td className="px-5 py-4 text-center font-bold text-slate-700">{row.score}</td>
                        <td className="px-5 py-4 text-center text-slate-500">{row.total}</td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn("font-bold",
                            row.percentage >= 80 ? 'text-emerald-600' : row.percentage >= 60 ? 'text-amber-600' : 'text-red-600'
                          )}>{row.percentage}%</span>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn("px-3 py-1 rounded-full text-xs font-bold",
                            row.grade === 'A' ? 'bg-emerald-100 text-emerald-700' :
                            row.grade === 'B' ? 'bg-blue-100 text-blue-700' :
                            row.grade === 'C' ? 'bg-amber-100 text-amber-700' :
                            row.grade === 'D' ? 'bg-orange-100 text-orange-700' :
                            'bg-red-100 text-red-700'
                          )}>{row.grade}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-bold">
                      <td className="px-5 py-3 text-sm text-slate-800">TOTAL</td>
                      <td className="px-5 py-3 text-center text-slate-800">{totalScore}</td>
                      <td className="px-5 py-3 text-center text-slate-500">{totalMarks}</td>
                      <td className="px-5 py-3 text-center text-indigo-700">{overallAvg}%</td>
                      <td className="px-5 py-3 text-center">
                        <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700">
                          {getGrade(overallAvg)}
                        </span>
                      </td>
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
