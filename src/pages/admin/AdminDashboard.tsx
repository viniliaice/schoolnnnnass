import { useState, useEffect } from 'react';
import { getSystemStats, getStudents, getExams, getUsers } from '../../lib/database';
import { Users, GraduationCap, FileText, CheckCircle, XCircle, Clock, TrendingUp, BookOpen } from 'lucide-react';

export function AdminDashboard() {
  const [stats, setStats] = useState(getSystemStats());
  const [recentExams, setRecentExams] = useState(getExams().slice(-5).reverse());

  useEffect(() => {
    setStats(getSystemStats());
    setRecentExams(getExams().slice(-5).reverse());
  }, []);

  const students = getStudents();
  const users = getUsers();
  const classes = [...new Set(students.map(s => s.className))];

  const statCards = [
    { label: 'Teachers', value: stats.totalTeachers, icon: Users, color: 'bg-teal-500', bg: 'bg-teal-50' },
    { label: 'Parents', value: stats.totalParents, icon: Users, color: 'bg-violet-500', bg: 'bg-violet-50' },
    { label: 'Students', value: stats.totalStudents, icon: GraduationCap, color: 'bg-blue-500', bg: 'bg-blue-50' },
    { label: 'Total Exams', value: stats.totalExams, icon: FileText, color: 'bg-amber-500', bg: 'bg-amber-50' },
    { label: 'Pending', value: stats.pendingExams, icon: Clock, color: 'bg-orange-500', bg: 'bg-orange-50' },
    { label: 'Approved', value: stats.approvedExams, icon: CheckCircle, color: 'bg-emerald-500', bg: 'bg-emerald-50' },
    { label: 'Rejected', value: stats.rejectedExams, icon: XCircle, color: 'bg-red-500', bg: 'bg-red-50' },
    { label: 'Avg Score', value: `${stats.averageScore}%`, icon: TrendingUp, color: 'bg-indigo-500', bg: 'bg-indigo-50' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
        <p className="text-slate-500 mt-1">System overview and key metrics</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {statCards.map(card => (
          <div key={card.label} className={`${card.bg} rounded-2xl p-4 border border-white/50`}>
            <div className={`w-10 h-10 ${card.color} rounded-xl flex items-center justify-center mb-3`}>
              <card.icon className="w-5 h-5 text-white" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{card.value}</p>
            <p className="text-sm text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Classes Overview */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="w-5 h-5 text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900">Classes Overview</h2>
          </div>
          <div className="space-y-3">
            {classes.map(cls => {
              const count = students.filter(s => s.className === cls).length;
              const teacher = users.find(u => u.role === 'teacher' && u.assignedClasses?.includes(cls));
              return (
                <div key={cls} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{cls}</p>
                    <p className="text-xs text-slate-500">{teacher?.name || 'No teacher assigned'}</p>
                  </div>
                  <span className="bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full text-xs font-semibold">
                    {count} students
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900">Recent Exam Submissions</h2>
          </div>
          <div className="space-y-3">
            {recentExams.map(exam => {
              const student = students.find(s => s.id === exam.studentId);
              return (
                <div key={exam.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{student?.name || 'Unknown'}</p>
                    <p className="text-xs text-slate-500">{exam.subject} · {exam.examType} · {exam.month}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-slate-700">{exam.score}/{exam.total}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      exam.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                      exam.status === 'rejected' ? 'bg-red-100 text-red-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {exam.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
