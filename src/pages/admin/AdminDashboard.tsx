import { useState, useEffect } from 'react';
import { getSystemStats, getStudents, getExams, getUsers } from '../../lib/database';

import { Users, GraduationCap, FileText, CheckCircle, XCircle, Clock, TrendingUp, BookOpen, FileBarChart } from 'lucide-react';

export function AdminDashboard({ navigate }: { navigate?: (path: string) => void }) {
  const [stats, setStats] = useState<any>(null);
  const [recentExams, setRecentExams] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [classesPage, setClassesPage] = useState(1);
  const [recentPage, setRecentPage] = useState(1);
  const CLASSES_PER_PAGE = 5;
  const RECENT_PER_PAGE = 5; // show 5 per page from the 15 loaded

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      // Parallelize independent fetches to avoid waterfalls
      const [statsData, examsData, studentsData, usersData] = await Promise.all([
        getSystemStats(),
        getExams(),
        getStudents(),
        getUsers(),
      ]);

      setStats(statsData);
      // limit recent exams to last 15
      setRecentExams(examsData.slice(-15).reverse());
      setStudents(studentsData);
      setUsers(usersData);
      setLoading(false);
    };
    loadData();
  }, []);

  if (loading || !stats) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-slate-500 mt-1">System overview and key metrics</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-2xl p-4 border border-white/50 bg-slate-50 h-24 animate-pulse" />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 min-h-56">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-5 w-5 bg-slate-100 rounded animate-pulse" />
              <div className="h-6 w-48 bg-slate-100 rounded animate-pulse" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: CLASSES_PER_PAGE }).map((_, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <div className="h-4 w-32 bg-slate-100 rounded mb-2 animate-pulse" />
                    <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
                  </div>
                  <div className="h-6 w-20 bg-slate-100 rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 min-h-56">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-5 w-5 bg-slate-100 rounded animate-pulse" />
              <div className="h-6 w-48 bg-slate-100 rounded animate-pulse" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: RECENT_PER_PAGE }).map((_, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <div className="h-4 w-32 bg-slate-100 rounded mb-2 animate-pulse" />
                    <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
                  </div>
                  <div className="h-6 w-20 bg-slate-100 rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const classes = [...new Set(students.map(s => s.className))];
  const classesPaged = classes.slice((classesPage - 1) * CLASSES_PER_PAGE, classesPage * CLASSES_PER_PAGE);
  const recentPaged = recentExams.slice((recentPage - 1) * RECENT_PER_PAGE, recentPage * RECENT_PER_PAGE);

  const statCards: any[] = [
    { label: 'Teachers', value: stats.totalTeachers, icon: Users, color: 'bg-teal-500', bg: 'bg-teal-50' },
    { label: 'Parents', value: stats.totalParents, icon: Users, color: 'bg-violet-500', bg: 'bg-violet-50' },
    { label: 'Students', value: stats.totalStudents, icon: GraduationCap, color: 'bg-blue-500', bg: 'bg-blue-50' },
    { label: 'Total Exams', value: stats.totalExams, icon: FileText, color: 'bg-amber-500', bg: 'bg-amber-50' },
    { label: 'Pending', value: stats.pendingExams, icon: Clock, color: 'bg-orange-500', bg: 'bg-orange-50' },
    { label: 'Approved', value: stats.approvedExams, icon: CheckCircle, color: 'bg-emerald-500', bg: 'bg-emerald-50' },
    { label: 'Rejected', value: stats.rejectedExams, icon: XCircle, color: 'bg-red-500', bg: 'bg-red-50' },
    { label: 'Avg Score', value: `${stats.averageScore}%`, icon: TrendingUp, color: 'bg-indigo-500', bg: 'bg-indigo-50' },
    { label: 'Exam Reports', value: 'Open', icon: FileBarChart, color: 'bg-indigo-500', bg: 'bg-indigo-50', onClick: () => navigate?.('/admin/exam-reports') },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
        <p className="text-slate-500 mt-1">System overview and key metrics</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {statCards.map(card => (
          <div key={card.label} onClick={() => card.onClick?.()} className={`${card.bg} rounded-2xl p-4 border border-white/50 ${card.onClick ? 'cursor-pointer hover:shadow-md' : ''}`}>
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
            {loading ? (
              Array.from({ length: CLASSES_PER_PAGE }).map((_, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <div className="h-4 w-32 bg-slate-100 rounded mb-2 animate-pulse" />
                    <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
                  </div>
                  <div className="h-6 w-20 bg-slate-100 rounded animate-pulse" />
                </div>
              ))
            ) : (
              classesPaged.map(cls => {
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
              })
            )}
            {/* classes pagination */}
            {!loading && classes.length > CLASSES_PER_PAGE && (
              <div className="flex items-center justify-end gap-2 mt-2">
                <button onClick={() => setClassesPage(1)} disabled={classesPage === 1} className="px-2 py-1 text-sm rounded disabled:opacity-50">First</button>
                <button onClick={() => setClassesPage(p => Math.max(1, p - 1))} disabled={classesPage === 1} className="px-2 py-1 text-sm rounded disabled:opacity-50">Prev</button>
                <div className="px-2 text-sm">{classesPage} / {Math.ceil(classes.length / CLASSES_PER_PAGE)}</div>
                <button onClick={() => setClassesPage(p => Math.min(Math.ceil(classes.length / CLASSES_PER_PAGE), p + 1))} disabled={classesPage === Math.ceil(classes.length / CLASSES_PER_PAGE)} className="px-2 py-1 text-sm rounded disabled:opacity-50">Next</button>
                <button onClick={() => setClassesPage(Math.ceil(classes.length / CLASSES_PER_PAGE))} disabled={classesPage === Math.ceil(classes.length / CLASSES_PER_PAGE)} className="px-2 py-1 text-sm rounded disabled:opacity-50">Last</button>
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900">Recent Exam Submissions</h2>
          </div>
          <div className="space-y-3">
            {loading ? (
              Array.from({ length: RECENT_PER_PAGE }).map((_, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <div className="h-4 w-32 bg-slate-100 rounded mb-2 animate-pulse" />
                    <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
                  </div>
                  <div className="h-6 w-20 bg-slate-100 rounded animate-pulse" />
                </div>
              ))
            ) : (
              recentPaged.map(exam => {
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
              }))}

            {/* recent pagination */}
            {!loading && recentExams.length > RECENT_PER_PAGE && (
              <div className="flex items-center justify-end gap-2 mt-2">
                <button onClick={() => setRecentPage(1)} disabled={recentPage === 1} className="px-2 py-1 text-sm rounded disabled:opacity-50">First</button>
                <button onClick={() => setRecentPage(p => Math.max(1, p - 1))} disabled={recentPage === 1} className="px-2 py-1 text-sm rounded disabled:opacity-50">Prev</button>
                <div className="px-2 text-sm">{recentPage} / {Math.ceil(recentExams.length / RECENT_PER_PAGE)}</div>
                <button onClick={() => setRecentPage(p => Math.min(Math.ceil(recentExams.length / RECENT_PER_PAGE), p + 1))} disabled={recentPage === Math.ceil(recentExams.length / RECENT_PER_PAGE)} className="px-2 py-1 text-sm rounded disabled:opacity-50">Next</button>
                <button onClick={() => setRecentPage(Math.ceil(recentExams.length / RECENT_PER_PAGE))} disabled={recentPage === Math.ceil(recentExams.length / RECENT_PER_PAGE)} className="px-2 py-1 text-sm rounded disabled:opacity-50">Last</button>
              </div>
            )}
          </div>
        </div>
      </div>
      
     
    </div>
  );
}
