import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getExamsByParent } from '../../lib/database';
import { Student, Exam, ExamType, EXAM_TYPES } from '../../types';
import { BookOpen } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ExamResults() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedChild, setSelectedChild] = useState('all');
  const [typeFilter, setTypeFilter] = useState<ExamType | 'all'>('all');

  useEffect(() => {
    if (!session) return;
    const kids = getStudentsByParent(session.userId);
    setChildren(kids);
    setExams(getExamsByParent(session.userId, 'approved'));
  }, [session]);

  const filtered = exams
    .filter(e => selectedChild === 'all' || e.studentId === selectedChild)
    .filter(e => typeFilter === 'all' || e.examType === typeFilter)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exam Results</h1>
        <p className="text-slate-500 mt-1">All approved exam results for your children</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setSelectedChild('all')}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              selectedChild === 'all' ? 'bg-violet-100 text-violet-700 ring-2 ring-offset-1 ring-violet-200' : 'bg-white text-slate-500 border border-slate-200'
            )}>All Children</button>
          {children.map(c => (
            <button key={c.id} onClick={() => setSelectedChild(c.id)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                selectedChild === c.id ? 'bg-violet-100 text-violet-700 ring-2 ring-offset-1 ring-violet-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{c.name}</button>
          ))}
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as ExamType | 'all')}
          className="px-4 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:ring-2 focus:ring-violet-200 outline-none">
          <option value="all">All Types</option>
          {EXAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Type</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Month</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Score</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(exam => {
                const child = children.find(c => c.id === exam.studentId);
                const pct = Math.round(exam.score / exam.total * 100);
                return (
                  <tr key={exam.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium text-slate-800">{child?.name || '—'}</td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.subject}</td>
                    <td className="px-5 py-3">
                      <span className={cn("px-2 py-0.5 rounded-md text-xs font-medium",
                        exam.examType === 'Final' ? 'bg-amber-100 text-amber-700' :
                        exam.examType === 'Midterm' ? 'bg-blue-100 text-blue-700' :
                        'bg-slate-100 text-slate-700'
                      )}>{exam.examType}</span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.month}</td>
                    <td className="px-5 py-3 text-center font-bold text-sm text-slate-800">{exam.score}/{exam.total}</td>
                    <td className="px-5 py-3 text-center">
                      <span className={cn("text-sm font-bold",
                        pct >= 80 ? 'text-emerald-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600'
                      )}>{pct}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No approved results found</p>
          </div>
        )}
      </div>
    </div>
  );
}
