import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent } from '../../lib/database';
import { Student, Exam, CA_TYPES, getGrade } from '../../types';
import { GraduationCap, BookOpen, TrendingUp, Award } from 'lucide-react';

export function ParentDashboard() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const [childrenData, examsData] = await Promise.all([
        getStudentsByParent(session.userId),
        getExamsByParent(session.userId, 'approved')
      ]);
      setChildren(childrenData);
      setExams(examsData);
    };

    loadData();
  }, [session]);

  const totalExams = exams.length;
  const overallAvg = totalExams > 0
    ? Math.round(exams.reduce((sum, e) => sum + (e.score / e.total) * 100, 0) / totalExams)
    : 0;

  // Best subject
  const subjectAvgs: Record<string, { total: number; count: number }> = {};
  exams.forEach(e => {
    if (!subjectAvgs[e.subject]) subjectAvgs[e.subject] = { total: 0, count: 0 };
    subjectAvgs[e.subject].total += (e.score / e.total) * 100;
    subjectAvgs[e.subject].count += 1;
  });
  const bestSubject = Object.entries(subjectAvgs).sort((a, b) =>
    (b[1].total / b[1].count) - (a[1].total / a[1].count)
  )[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Parent Dashboard</h1>
        <p className="text-slate-500 mt-1">Welcome, {session?.userName}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-violet-50 rounded-2xl p-4 border border-violet-100">
          <div className="w-10 h-10 bg-violet-500 rounded-xl flex items-center justify-center mb-3">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <p className="text-2xl font-bold text-slate-900">{children.length}</p>
          <p className="text-sm text-slate-500">Children</p>
        </div>
        <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
          <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center mb-3">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <p className="text-2xl font-bold text-slate-900">{totalExams}</p>
          <p className="text-sm text-slate-500">Approved Results</p>
        </div>
        <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center mb-3">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <p className="text-2xl font-bold text-slate-900">{overallAvg}%</p>
          <p className="text-sm text-slate-500">Overall Average</p>
        </div>
        <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
          <div className="w-10 h-10 bg-amber-500 rounded-xl flex items-center justify-center mb-3">
            <Award className="w-5 h-5 text-white" />
          </div>
          <p className="text-2xl font-bold text-slate-900">{bestSubject ? getGrade(bestSubject[1].total / bestSubject[1].count) : '—'}</p>
          <p className="text-sm text-slate-500">Best: {bestSubject?.[0] || 'N/A'}</p>
        </div>
      </div>

      {/* Children cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {children.map(child => {
          const childExams = exams.filter(e => e.studentId === child.id);
          const childAvg = childExams.length > 0
            ? Math.round(childExams.reduce((sum, e) => sum + (e.score / e.total) * 100, 0) / childExams.length)
            : 0;
          const caExams = childExams.filter(e => CA_TYPES.includes(e.examType));
          const midExams = childExams.filter(e => e.examType === 'Midterm');
          const finalExams = childExams.filter(e => e.examType === 'Final');

          return (
            <div key={child.id} className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center text-violet-700 font-bold">
                  {child.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">{child.name}</h3>
                  <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full font-medium">{child.className}</span>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-slate-50 rounded-xl p-2">
                  <p className="text-lg font-bold text-slate-800">{childAvg}%</p>
                  <p className="text-xs text-slate-500">Average</p>
                </div>
                <div className="bg-teal-50 rounded-xl p-2">
                  <p className="text-lg font-bold text-teal-700">{caExams.length}</p>
                  <p className="text-xs text-slate-500">CA</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-2">
                  <p className="text-lg font-bold text-blue-700">{midExams.length}</p>
                  <p className="text-xs text-slate-500">Midterm</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-2">
                  <p className="text-lg font-bold text-amber-700">{finalExams.length}</p>
                  <p className="text-xs text-slate-500">Final</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
