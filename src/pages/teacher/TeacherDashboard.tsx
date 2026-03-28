import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById, getStudentsByClasses, getExamsByTeacher } from '../../lib/database';
import { GraduationCap, FileText, Clock, CheckCircle, XCircle, BookOpen, FileBarChart } from 'lucide-react';

export function TeacherDashboard({ navigate }: { navigate?: (path: string) => void }) {
  const { session } = useRole();
  const [stats, setStats] = useState({ classes: 0, students: 0, submissions: 0, pending: 0, approved: 0, rejected: 0 });
  const [assignedClasses, setAssignedClasses] = useState<string[]>([]);
  const [classCounts, setClassCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const teacher = await getUserById(session.userId);
      const classes = teacher?.assignedClasses || [];
      setAssignedClasses(classes);
      const students = await getStudentsByClasses(classes);
      const exams = await getExamsByTeacher(session.userId);
      setStats({
        classes: classes.length,
        students: students.length,
        submissions: exams.length,
        pending: exams.filter(e => e.status === 'pending').length,
        approved: exams.filter(e => e.status === 'approved').length,
        rejected: exams.filter(e => e.status === 'rejected').length,
      });
      // Calculate class counts
      const counts: Record<string, number> = {};
      classes.forEach(cls => {
        counts[cls] = students.filter(s => s.className === cls).length;
      });
      setClassCounts(counts);
    };

    loadData();
  }, [session]);

  const cards: any[] = [
    { label: 'My Classes', value: stats.classes, icon: BookOpen, color: 'bg-teal-500', bg: 'bg-teal-50' },
    { label: 'Students', value: stats.students, icon: GraduationCap, color: 'bg-blue-500', bg: 'bg-blue-50' },
    { label: 'Submissions', value: stats.submissions, icon: FileText, color: 'bg-amber-500', bg: 'bg-amber-50' },
    { label: 'Pending', value: stats.pending, icon: Clock, color: 'bg-orange-500', bg: 'bg-orange-50' },
    { label: 'Approved', value: stats.approved, icon: CheckCircle, color: 'bg-emerald-500', bg: 'bg-emerald-50' },
    { label: 'Rejected', value: stats.rejected, icon: XCircle, color: 'bg-red-500', bg: 'bg-red-50' },
    { label: 'Exam Reports', value: 'Open', icon: FileBarChart, color: 'bg-indigo-500', bg: 'bg-indigo-50', onClick: () => navigate?.('/teacher/exam-reports') },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Teacher Dashboard</h1>
        <p className="text-slate-500 mt-1">Welcome back, {session?.userName}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {cards.map(card => (
          <div key={card.label} onClick={() => card.onClick?.()} className={`${card.bg} rounded-2xl p-4 border border-white/50 ${card.onClick ? 'cursor-pointer hover:shadow-md' : ''}`}>
            <div className={`w-10 h-10 ${card.color} rounded-xl flex items-center justify-center mb-3`}>
              <card.icon className="w-5 h-5 text-white" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{card.value}</p>
            <p className="text-sm text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-teal-500" /> My Assigned Classes
        </h2>
        {assignedClasses.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {assignedClasses.map(cls => {
              const studentCount = classCounts[cls] || 0;
              return (
                <div key={cls} className="bg-teal-50 rounded-xl p-4 border border-teal-100">
                  <p className="font-bold text-teal-800">{cls}</p>
                  <p className="text-sm text-teal-600 mt-1">{studentCount} students</p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-slate-400 italic">No classes assigned yet. Contact the admin.</p>
        )}
      </div>
    </div>
  );
}
