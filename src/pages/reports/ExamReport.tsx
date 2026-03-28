import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import {
  getStudents,
  getUserById,
  getStudentsByClasses,
  getStudentsByClass,
  getCurrentTerm,
  getMonthlyReport,
  getMidtermReport,
  getFinalReport,
} from '../../lib/database';
import { Student, MONTHS, MonthlyScore, getGrade } from '../../types';
import type { MidtermReport, FinalReport } from '../../types';
import { Calendar, FileBarChart, FileText, Award } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ExamReport() {
  const { session } = useRole();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState('');

  const [reportType, setReportType] = useState<'Monthly' | 'Midterm' | 'Final'>('Monthly');
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);

  const [monthlyData, setMonthlyData] = useState<MonthlyScore[]>([]);
  const [midtermData, setMidtermData] = useState<MidtermReport | null>(null);
  const [finalData, setFinalData] = useState<FinalReport | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('All');

  // Load available classes and set default selected class
  useEffect(() => {
    if (!session) return;

    const init = async () => {
      setLoading(true);
      try {
        if (session.role === 'teacher') {
          const teacher = await getUserById(session.userId);
          const assigned = teacher?.assignedClasses || [];
          if (assigned.length > 0) {
            setClasses(assigned);
            // default to 'All' when teacher has multiple classes
            setSelectedClass(assigned.length > 1 ? 'All' : assigned[0]);
          } else {
            // fallback: discover classes from students
            const all = await getStudents();
            const unique = [...new Set(all.map(s => s.className))].filter(Boolean);
            setClasses(unique);
            setSelectedClass(unique[0] || 'All');
          }
        } else if (session.role === 'admin') {
          const all = await getStudents();
          const unique = [...new Set(all.map(s => s.className))].filter(Boolean);
          setClasses(unique);
          setSelectedClass('All');
        }
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [session]);

  // Load students when selected class changes
  useEffect(() => {
    if (!session) return;
    if (!selectedClass) return;

    const loadByClass = async () => {
      setLoading(true);
      try {
        if (selectedClass === 'All') {
          if (session.role === 'teacher') {
            const teacher = await getUserById(session.userId);
            const classesList = teacher?.assignedClasses || [];
            const list = classesList.length > 0 ? await getStudentsByClasses(classesList) : await getStudents();
            setStudents(list);
            if (list.length > 0) setSelectedStudent(list[0].id);
          } else {
            const list = await getStudents();
            setStudents(list);
            if (list.length > 0) setSelectedStudent(list[0].id);
          }
        } else {
          const list = await getStudentsByClass(selectedClass);
          setStudents(list);
          if (list.length > 0) setSelectedStudent(list[0].id);
        }
      } finally {
        setLoading(false);
      }
    };

    loadByClass();
  }, [selectedClass, session]);

  useEffect(() => {
    if (!selectedStudent) return;

    const loadReport = async () => {
      setLoading(true);
      try {
        const term = await getCurrentTerm();
        if (!term) return;

        if (reportType === 'Monthly') {
          const rep = await getMonthlyReport(selectedStudent, term.id);
          setMonthlyData(rep || []);
        } else if (reportType === 'Midterm') {
          const rep = await getMidtermReport(selectedStudent, term.id);
          setMidtermData(rep || null);
        } else if (reportType === 'Final') {
          const rep = await getFinalReport(selectedStudent, term.id);
          setFinalData(rep || null);
        }
      } finally {
        setLoading(false);
      }
    };

    loadReport();
  }, [selectedStudent, reportType]);

  const student = students.find(s => s.id === selectedStudent);

  // Monthly UI
  const monthlyFiltered = monthlyData.filter(d => d.month === selectedMonth);
  const overallMonthly = monthlyFiltered.length
    ? Math.round(monthlyFiltered.reduce((s, d) => s + d.average, 0) / monthlyFiltered.length)
    : 0;

  const overallMidterm = midtermData?.scores.length
    ? Math.round(midtermData.scores.reduce((s, sc) => s + sc.percentage, 0) / midtermData.scores.length)
    : 0;

  const overallFinal = finalData?.results.length
    ? Math.round(finalData.results.reduce((s, r) => s + r.total, 0) / finalData.results.length)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exam Reports</h1>
        <p className="text-slate-500 mt-1">View Monthly, Midterm or Final reports for your students</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-end">
        <div className="w-56">
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Class</label>
          <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)}
            className="w-full px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm">
            <option value="All">All classes</option>
            {classes.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Student</label>
          <select value={selectedStudent} onChange={e => setSelectedStudent(e.target.value)}
            className="w-full px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm">
            <option value="">-- Select student --</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>{s.name} · {s.className}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Report Type</label>
          <div className="flex gap-2">
            {(['Monthly', 'Midterm', 'Final'] as const).map(rt => (
              <button key={rt} onClick={() => setReportType(rt)}
                className={cn('px-4 py-2 rounded-xl text-sm font-medium transition-all',
                  reportType === rt ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 border border-slate-200')}
              >{rt}</button>
            ))}
          </div>
        </div>

        {reportType === 'Monthly' && (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Month</label>
            <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
              className="px-4 py-2 rounded-xl border border-slate-200 text-sm bg-white">
              {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      {!student ? (
        <div className="text-center py-12 text-slate-400">{loading ? 'Loading...' : 'No students available'}</div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white">{reportType} Report {reportType === 'Monthly' ? `— ${selectedMonth}` : ''}</h2>
                <p className="text-sm text-white/80">{student.name} · {student.className}</p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-white">{reportType === 'Monthly' ? `${overallMonthly}%` : reportType === 'Midterm' ? `${overallMidterm}%` : `${overallFinal}%`}</p>
                <p className="text-xs text-white/70">{reportType === 'Monthly' ? 'Monthly Avg' : reportType === 'Midterm' ? 'Midterm Avg' : 'Final Avg'}</p>
              </div>
            </div>
          </div>

          {/* Details */}
          {reportType === 'Monthly' ? (
            monthlyFiltered.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Assessments</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Monthly Average</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Remarks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {monthlyFiltered.map(row => (
                      <tr key={row.subject} className="hover:bg-slate-50">
                        <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{row.subject}</td>
                        <td className="px-5 py-4 text-center">
                          <div className="flex flex-wrap gap-1.5 justify-center">
                            {row.details.map((d, i) => (
                              <span key={i} className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">{d.type}: {d.score}/{d.total}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-center">
                          <span className={cn('text-lg font-bold', row.average >= 80 ? 'text-emerald-600' : row.average >= 60 ? 'text-amber-600' : 'text-red-600')}>{row.average}%</span>
                        </td>
                        <td className="px-5 py-4 text-center text-sm">
                          {row.average >= 90 ? <span className="text-emerald-600 font-medium">Excellent</span> :
                           row.average >= 80 ? <span className="text-emerald-600 font-medium">Very Good</span> :
                           row.average >= 70 ? <span className="text-blue-600 font-medium">Good</span> :
                           row.average >= 60 ? <span className="text-amber-600 font-medium">Satisfactory</span> :
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
              </div>
            )
          ) : reportType === 'Midterm' ? (
            midtermData && midtermData.scores.length > 0 ? (
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
                    {midtermData.scores.map(score => (
                      <tr key={score.subject} className="hover:bg-slate-50">
                        <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{score.subject}</td>
                        <td className="px-5 py-4 text-center font-bold text-slate-700">{score.score}</td>
                        <td className="px-5 py-4 text-center text-slate-500">{score.total}</td>
                        <td className="px-5 py-4 text-center"><span className={cn('font-bold', score.percentage >= 80 ? 'text-emerald-600' : score.percentage >= 60 ? 'text-amber-600' : 'text-red-600')}>{score.percentage}%</span></td>
                        <td className="px-5 py-4 text-center"><span className={cn('px-3 py-1 rounded-full text-xs font-bold', score.grade === 'A' ? 'bg-emerald-100 text-emerald-700' : score.grade === 'B' ? 'bg-blue-100 text-blue-700' : score.grade === 'C' ? 'bg-amber-100 text-amber-700' : score.grade === 'D' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700')}>{score.grade}</span></td>
                        <td className="px-5 py-4 text-center text-slate-600">{score.subject_rank}</td>
                        <td className="px-5 py-4 text-center text-slate-600">{score.class_average}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">No midterm results available</div>
            )
          ) : (
            finalData && finalData.results.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">CA</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Midterm</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Final</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Total</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Grade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {finalData.results.map(r => (
                      <tr key={r.subject} className="hover:bg-slate-50">
                        <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{r.subject}</td>
                        <td className="px-5 py-4 text-center text-slate-600">{r.ca_avg}%</td>
                        <td className="px-5 py-4 text-center text-slate-600">{r.midterm_score}%</td>
                        <td className="px-5 py-4 text-center text-slate-600">{r.final_score}%</td>
                        <td className="px-5 py-4 text-center"><span className={cn('text-lg font-bold', r.total >= 80 ? 'text-emerald-600' : r.total >= 60 ? 'text-amber-600' : 'text-red-600')}>{r.total}%</span></td>
                        <td className="px-5 py-4 text-center"><span className={cn('px-3 py-1 rounded-full text-xs font-bold', getGrade(r.total) === 'A' ? 'bg-emerald-100 text-emerald-700' : getGrade(r.total) === 'B' ? 'bg-blue-100 text-blue-700' : getGrade(r.total) === 'C' ? 'bg-amber-100 text-amber-700' : getGrade(r.total) === 'D' ? 'bg-orange-100 text-orange-700' : 'bg-red-100 text-red-700')}>{getGrade(r.total)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">Final report not available yet</div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// Generated by Copilot
