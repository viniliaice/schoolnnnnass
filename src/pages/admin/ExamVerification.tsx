import { useState, useEffect } from 'react';
import { getExams, updateExamStatus, getStudentById, getUserById, getStudents, getUsersByRole } from '../../lib/database';
import { Exam, ExamStatus, Student, User } from '../../types';
import { useToast } from '../../context/ToastContext';
import { CheckCircle, XCircle, Clock, FileText } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ExamVerification() {
  const { addToast } = useToast();
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<User[]>([]);
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('pending');

  const refresh = async () => {
    const [examsData, studentsData, teachersData] = await Promise.all([
      getExams(),
      getStudents(),
      getUsersByRole('teacher')
    ]);
    setExams(examsData);
    setStudents(studentsData);
    setTeachers(teachersData);
  };

  useEffect(() => { refresh(); }, []);

  const getStudent = (studentId: string) => students.find(s => s.id === studentId);
  const getTeacher = (teacherId: string) => teachers.find(t => t.id === teacherId);

  const filtered = exams
    .filter(e => statusFilter === 'all' || e.status === statusFilter)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const handleAction = async (id: string, status: ExamStatus) => {
    try {
      await updateExamStatus(id, status);
      addToast({ type: 'success', title: `Exam ${status}` });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to update exam status' });
    }
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
        <h1 className="text-2xl font-bold text-slate-900">Exam Verification Center</h1>
        <p className="text-slate-500 mt-1">Review and approve/reject exam submissions</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {tabs.map(tab => (
          <button key={tab.value} onClick={() => setStatusFilter(tab.value)}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              statusFilter === tab.value
                ? (tab.value === 'pending' ? 'bg-amber-100 text-amber-700' : tab.value === 'approved' ? 'bg-emerald-100 text-emerald-700' : tab.value === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700') + ' ring-2 ring-offset-1 ring-slate-200'
                : 'bg-white text-slate-500 border border-slate-200'
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
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Teacher</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(exam => {
                const student = getStudent(exam.studentId);
                const teacher = getTeacher(exam.teacherId);
                return (
                  <tr key={exam.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{student?.name || '—'}</p>
                        <p className="text-xs text-slate-400">{student?.className}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.subject}</td>
                    <td className="px-5 py-3">
                      <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">{exam.examType}</span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.month}</td>
                    <td className="px-5 py-3 text-center font-bold text-sm text-slate-800">{exam.score}/{exam.total}</td>
                    <td className="px-5 py-3 text-sm text-slate-600">{teacher?.name || '—'}</td>
                    <td className="px-5 py-3 text-center">
                      <span className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold",
                        exam.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                        exam.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      )}>
                        {exam.status === 'approved' ? <CheckCircle className="w-3 h-3" /> : exam.status === 'rejected' ? <XCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                        {exam.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {exam.status === 'pending' ? (
                        <div className="flex justify-center gap-1.5">
                          <button onClick={() => handleAction(exam.id, 'approved')}
                            className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 transition-colors" title="Approve">
                            <CheckCircle className="w-4 h-4" />
                          </button>
                          <button onClick={() => handleAction(exam.id, 'rejected')}
                            className="p-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors" title="Reject">
                            <XCircle className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
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
            <p className="font-medium">No exams to review</p>
          </div>
        )}
      </div>
    </div>
  );
}
