import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent, getStudents } from '../../lib/database';
import { Student, Exam, CA_TYPES, getGrade, isPassing } from '../../types';
import { Award, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '../../utils/cn';

export function FinalReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedChild, setSelectedChild] = useState('');
  const [allStudents, setAllStudents] = useState<Student[]>([]);

  useEffect(() => {
    const loadData = async () => {
      if (!session) return;
      const kids = await getStudentsByParent(session.userId);
      setChildren(kids);
      if (kids.length > 0) setSelectedChild(kids[0].id);
      const examsData = await getExamsByParent(session.userId, 'approved');
      setExams(examsData);
      const allStudentsData = await getStudents();
      setAllStudents(allStudentsData);
    };
    loadData();
  }, [session]);

  const child = children.find(c => c.id === selectedChild);
  const childExams = exams.filter(e => e.studentId === selectedChild);

  // Get all subjects that have data
  const allSubjects = [...new Set(childExams.map(e => e.subject))];

  // For each subject, calculate Final Score = CA(30%) + Midterm(30%) + Final(40%)
  const subjectData = allSubjects.map(sub => {
    // CA average (all CA-type exams across all months)
    const caExams = childExams.filter(e => e.subject === sub && CA_TYPES.includes(e.examType));
    const caAvg = caExams.length > 0
      ? Math.round(caExams.reduce((s, e) => s + (e.score / e.total) * 100, 0) / caExams.length)
      : 0;

    // Midterm score
    const midExam = childExams.find(e => e.subject === sub && e.examType === 'Midterm');
    const midScore = midExam ? Math.round(midExam.score / midExam.total * 100) : 0;

    // Final exam score
    const finalExam = childExams.find(e => e.subject === sub && e.examType === 'Final');
    const finalExamScore = finalExam ? Math.round(finalExam.score / finalExam.total * 100) : 0;

    // Weighted final: CA(30%) + Midterm(30%) + Final(40%)
    const hasAllComponents = caExams.length > 0 && midExam && finalExam;
    const finalScore = hasAllComponents
      ? Math.round(caAvg * 0.3 + midScore * 0.3 + finalExamScore * 0.4)
      : 0;

    return {
      subject: sub,
      caAverage: caAvg,
      midtermScore: midScore,
      finalExamScore,
      finalScore,
      grade: getGrade(finalScore),
      passed: isPassing(finalScore),
      hasAllComponents: !!hasAllComponents,
    };
  }).filter(d => d.hasAllComponents);

  // Overall
  const overallFinal = subjectData.length > 0
    ? Math.round(subjectData.reduce((s, d) => s + d.finalScore, 0) / subjectData.length)
    : 0;
  const passedCount = subjectData.filter(d => d.passed).length;
  const allPassed = subjectData.length > 0 && passedCount === subjectData.length;

  // Rank
  let rank = '—';
  if (child && subjectData.length > 0) {
    const classmates = allStudents.filter(s => s.className === child.className);
    const classScores = classmates.map(cm => {
      const cmExams = exams.filter(e => e.studentId === cm.id);
      const cmSubjects = [...new Set(cmExams.map(e => e.subject))];
      const cmFinals = cmSubjects.map(sub => {
        const ca = cmExams.filter(e => e.subject === sub && CA_TYPES.includes(e.examType));
        const caA = ca.length > 0 ? ca.reduce((s, e) => s + (e.score / e.total * 100), 0) / ca.length : 0;
        const mid = cmExams.find(e => e.subject === sub && e.examType === 'Midterm');
        const fin = cmExams.find(e => e.subject === sub && e.examType === 'Final');
        if (!ca.length || !mid || !fin) return null;
        return caA * 0.3 + (mid.score / mid.total * 100) * 0.3 + (fin.score / fin.total * 100) * 0.4;
      }).filter(Boolean) as number[];
      const avg = cmFinals.length > 0 ? cmFinals.reduce((s, f) => s + f, 0) / cmFinals.length : 0;
      return { id: cm.id, avg: Math.round(avg) };
    }).filter(c => c.avg > 0).sort((a, b) => b.avg - a.avg);

    const pos = classScores.findIndex(c => c.id === selectedChild) + 1;
    if (pos > 0) {
      const suffix = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
      rank = `${pos}${suffix} / ${classScores.length}`;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Final Year Reports</h1>
        <p className="text-slate-500 mt-1">Combined result: CA (30%) + Midterm (30%) + Final Exam (40%)</p>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Child</label>
        <div className="flex gap-2 flex-wrap">
          {children.map(c => (
            <button key={c.id} onClick={() => setSelectedChild(c.id)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                selectedChild === c.id ? 'bg-amber-100 text-amber-700 ring-2 ring-offset-1 ring-amber-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{c.name}</button>
          ))}
        </div>
      </div>

      {child && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-500 to-orange-600 p-5">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Final Year Report Card</h2>
                <p className="text-sm text-white/80">{child.name} · {child.className}</p>
              </div>
              <div className="flex gap-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{overallFinal}%</p>
                  <p className="text-xs text-white/70">Final Average</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{rank}</p>
                  <p className="text-xs text-white/70">Position</p>
                </div>
                <div className="text-center">
                  {allPassed ? (
                    <div className="flex flex-col items-center">
                      <CheckCircle className="w-8 h-8 text-white" />
                      <p className="text-xs text-white/70 mt-1">PASSED</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <XCircle className="w-8 h-8 text-white/80" />
                      <p className="text-xs text-white/70 mt-1">{passedCount}/{subjectData.length}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Formula reminder */}
          <div className="bg-amber-50 border-b border-amber-100 px-5 py-3">
            <p className="text-xs text-amber-700 font-medium">
              📊 Final Score = (CA Average × 30%) + (Midterm × 30%) + (Final Exam × 40%) &nbsp;|&nbsp; Pass mark: 60%
            </p>
          </div>

          {subjectData.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">CA (30%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Midterm (30%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Final (40%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Final Score</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Grade</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {subjectData.map(row => (
                    <tr key={row.subject} className="hover:bg-slate-50">
                      <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{row.subject}</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{row.caAverage}%</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{row.midtermScore}%</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{row.finalExamScore}%</td>
                      <td className="px-5 py-4 text-center">
                        <span className={cn("text-lg font-bold",
                          row.finalScore >= 80 ? 'text-emerald-600' : row.finalScore >= 60 ? 'text-amber-600' : 'text-red-600'
                        )}>{row.finalScore}%</span>
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
                      <td className="px-5 py-4 text-center">
                        {row.passed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold">
                            <CheckCircle className="w-4 h-4" /> Pass
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600 text-xs font-semibold">
                            <XCircle className="w-4 h-4" /> Fail
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-bold border-t-2 border-slate-200">
                    <td className="px-5 py-3 text-sm text-slate-800">OVERALL</td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {Math.round(subjectData.reduce((s, d) => s + d.caAverage, 0) / subjectData.length)}%
                    </td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {Math.round(subjectData.reduce((s, d) => s + d.midtermScore, 0) / subjectData.length)}%
                    </td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {Math.round(subjectData.reduce((s, d) => s + d.finalExamScore, 0) / subjectData.length)}%
                    </td>
                    <td className="px-5 py-3 text-center text-lg text-indigo-700 font-bold">{overallFinal}%</td>
                    <td className="px-5 py-3 text-center">
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700">
                        {getGrade(overallFinal)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {allPassed ? (
                        <span className="text-emerald-600 text-xs font-bold">ALL PASSED</span>
                      ) : (
                        <span className="text-amber-600 text-xs font-bold">{passedCount}/{subjectData.length}</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <Award className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">Final report not available yet</p>
              <p className="text-xs mt-1">Requires CA, Midterm, and Final Exam scores for all subjects</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
