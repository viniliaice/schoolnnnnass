import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getExamsByTeacher, getStudentById } from '../../lib/database';
import { Exam, ExamStatus } from '../../types';
import { FileText, Clock, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '../../utils/cn';

export function AllResults() {
  const { session } = useRole();
  const [exams, setExams] = useState<Exam[]>([]);
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('all');

  useEffect(() => {
    if (!session) return;
    setExams(getExamsByTeacher(session.userId));
  }, [session]);

  const filtered = exams
    .filter(e => statusFilter === 'all' || e.status === statusFilter)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const statusIcon = (s: ExamStatus) => {
    if (s === 'approved') return <CheckCircle className="w-4 h-4 text-emerald-500" />;
    if (s === 'rejected') return <XCircle className="w-4 h-4 text-red-500" />;
    return <Clock className="w-4 h-4 text-amber-500" />;
  };

  const tabs: { label: string; value: ExamStatus | 'all'; count: number }[] = [
    { label: 'All', value: 'all', count: exams.length },
    { label: 'Pending', value: 'pending', count: exams.filter(e => e.status === 'pending').length },
    { label: 'Approved', value: 'approved', count: exams.filter(e => e.status === 'approved').length },
    { label: 'Rejected', value: 'rejected', count: exams.filter(e => e.status === 'rejected').length },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Submissions</h1>
        <p className="text-slate-500 mt-1">All exam results you've submitted</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {tabs.map(tab => (
          <button key={tab.value} onClick={() => setStatusFilter(tab.value)}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              statusFilter === tab.value ? 'bg-teal-100 text-teal-700 ring-2 ring-offset-1 ring-teal-200' : 'bg-white text-slate-500 border border-slate-200'
            )}>
            {tab.label} ({tab.count})
          </button>
        ))}
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
                <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(exam => {
                const student = getStudentById(exam.studentId);
                return (
                  <tr key={exam.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-sm font-medium text-slate-800">{student?.name || '—'}</td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.subject}</td>
                    <td className="px-5 py-3">
                      <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">{exam.examType}</span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.month}</td>
                    <td className="px-5 py-3 text-center">
                      <span className="font-bold text-slate-800 text-sm">{exam.score}/{exam.total}</span>
                      <span className="text-xs text-slate-400 ml-1">({Math.round(exam.score / exam.total * 100)}%)</span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {statusIcon(exam.status)}
                        <span className={cn("text-xs font-semibold",
                          exam.status === 'approved' ? 'text-emerald-600' : exam.status === 'rejected' ? 'text-red-600' : 'text-amber-600'
                        )}>{exam.status}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No submissions found</p>
          </div>
        )}
      </div>
    </div>
  );
}
