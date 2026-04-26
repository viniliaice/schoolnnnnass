import { useEffect, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { getAttendanceHomeworkStreams } from '../../lib/database';
import { AttendanceRecord, HomeworkRecord } from '../../types';
import { useToast } from '../../context/ToastContext';

export function StreamsPage() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [homework, setHomework] = useState<HomeworkRecord[]>([]);

  useEffect(() => {
    if (!session) return;
    getAttendanceHomeworkStreams({ role: session.role, userId: session.userId })
      .then(data => {
        setAttendance(data.attendance);
        setHomework(data.homework);
      })
      .catch(() => addToast({ type: 'error', title: 'Failed to load attendance/homework streams' }));
  }, [session, addToast]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Attendance & Homework Streams</h1>
        <p className="text-slate-500 mt-1">Live class activity stream by your role permissions</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-900 mb-3">Attendance</h2>
          <div className="space-y-2">
            {attendance.map(item => (
              <div key={item.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                <div className="text-xs text-slate-500">{item.className} • {item.date}</div>
                <div className="text-sm text-slate-700">Student: {item.studentId} • Status: {item.status}</div>
              </div>
            ))}
            {attendance.length === 0 && <p className="text-sm text-slate-400">No attendance records available.</p>}
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-900 mb-3">Homework</h2>
          <div className="space-y-2">
            {homework.map(item => (
              <div key={item.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                <div className="text-xs text-slate-500">{item.className} • Due {item.dueDate}</div>
                <div className="text-sm text-slate-700">{item.subject}: {item.title}</div>
              </div>
            ))}
            {homework.length === 0 && <p className="text-sm text-slate-400">No homework records available.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
