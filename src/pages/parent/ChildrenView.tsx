import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent } from '../../lib/database';
import { Student, Exam } from '../../types';
import { GraduationCap, BookOpen } from 'lucide-react';

export function ChildrenView() {
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Children</h1>
        <p className="text-slate-500 mt-1">View your children's profiles and academic overview</p>
      </div>

      {children.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No children assigned to your account</p>
        </div>
      ) : (
        <div className="space-y-6">
          {children.map(child => {
            const childExams = exams.filter(e => e.studentId === child.id);
            const subjects = [...new Set(childExams.map(e => e.subject))];

            return (
              <div key={child.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="bg-gradient-to-r from-violet-500 to-violet-700 p-5">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-lg backdrop-blur-sm">
                      {child.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">{child.name}</h2>
                      <span className="text-sm text-white/80">{child.className}</span>
                    </div>
                  </div>
                </div>

                <div className="p-5">
                  <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-violet-500" /> Subject Performance (Approved)
                  </h3>
                  {subjects.length > 0 ? (
                    <div className="space-y-3">
                      {subjects.map(sub => {
                        const subExams = childExams.filter(e => e.subject === sub);
                        const avg = Math.round(subExams.reduce((s, e) => s + (e.score / e.total) * 100, 0) / subExams.length);
                        return (
                          <div key={sub} className="flex items-center gap-4">
                            <span className="text-sm font-medium text-slate-700 w-32 truncate">{sub}</span>
                            <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${avg >= 80 ? 'bg-emerald-500' : avg >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
                                style={{ width: `${avg}%` }}
                              />
                            </div>
                            <span className="text-sm font-bold text-slate-700 w-12 text-right">{avg}%</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">No approved results yet</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
