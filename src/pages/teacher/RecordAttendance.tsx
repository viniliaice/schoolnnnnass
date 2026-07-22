import { useState, useEffect, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById } from '../../lib/db/profiles';
import { getClasses } from '../../lib/db/classes';
import { getStudentsByClass } from '../../lib/db/students';
import { getAttendanceForDate, hasAttendanceForDate, upsertAttendanceBatch } from '../../lib/db/attendance';
import { Student } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Calendar, CheckCircle, RotateCcw, AlertTriangle } from 'lucide-react';

interface AttendanceRow {
  studentId: string;
  studentName: string;
  status: 'present' | 'absent' | 'late';
  note: string;
}

export function RecordAttendance() {
  const { session } = useRole();
  const { addToast } = useToast();

  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alreadyExists, setAlreadyExists] = useState(false);

  useEffect(() => {
    if (!session) return;
    const loadClasses = async () => {
      if (session.role === 'teacher' || session.role === 'supervisor') {
        const me = await getUserById(session.userId);
        const cls = (me?.assignedClasses || []) as string[];
        setClasses(cls);
        if (cls.length > 0) setSelectedClass(cls[0]);
      } else {
        const all = await getClasses();
        setClasses(all);
        if (all.length > 0) setSelectedClass(all[0]);
      }
    };
    loadClasses();
  }, [session]);

  const handleLoad = useCallback(async () => {
    if (!selectedClass || !date || !session) return;
    setLoading(true);
    setLoaded(false);
    try {
      const students = await getStudentsByClass(selectedClass);

      // Check if attendance already recorded for this date
      const hasExisting = await hasAttendanceForDate(selectedClass, date);
      setAlreadyExists(hasExisting);

      let existingRecords: Record<string, 'present' | 'absent' | 'late'> = {};
      if (hasExisting) {
        const existing = await getAttendanceForDate(selectedClass, date);
        for (const r of existing) {
          existingRecords[r.studentId] = r.status;
        }
      }

      setRows(
        students.map((s: Student) => ({
          studentId: s.id,
          studentName: s.name,
          status: existingRecords[s.id] || 'present',
          note: '',
        }))
      );
      setLoaded(true);
    } catch {
      addToast({ type: 'error', title: 'Failed to load students' });
    } finally {
      setLoading(false);
    }
  }, [selectedClass, date, session, addToast]);

  const updateStatus = (studentId: string, status: 'present' | 'absent' | 'late') => {
    setRows(prev => prev.map(r => r.studentId === studentId ? { ...r, status } : r));
  };

  const updateNote = (studentId: string, note: string) => {
    setRows(prev => prev.map(r => r.studentId === studentId ? { ...r, note } : r));
  };

  const bulkSet = (status: 'present' | 'absent' | 'late') => {
    setRows(prev => prev.map(r => ({ ...r, status })));
  };

  const handleSave = async () => {
    if (!session) return;
    const nonPresent = rows.filter(r => r.status !== 'present');
    if (nonPresent.length === 0) {
      addToast({ type: 'info', title: 'All students present — nothing to save' });
      return;
    }
    setSaving(true);
    try {
      await upsertAttendanceBatch(
        nonPresent.map(r => ({
          studentId: r.studentId,
          className: selectedClass,
          date,
          status: r.status,
          note: r.note || undefined,
          teacherId: session.userId,
        }))
      );
      addToast({ type: 'success', title: `Attendance saved for ${nonPresent.length} student(s)` });
      setAlreadyExists(true);
    } catch {
      addToast({ type: 'error', title: 'Failed to save attendance' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Record Attendance</h1>
        <p className="text-slate-500 mt-1">Mark absences and late arrivals for your classes</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Class</label>
          <select
            value={selectedClass}
            onChange={e => setSelectedClass(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {classes.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={handleLoad}
          disabled={loading || !selectedClass || !date}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          <Calendar className="w-4 h-4" />
          {loading ? 'Loading...' : 'Load'}
        </button>
      </div>

      {alreadyExists && loaded && (
        <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Attendance already recorded for this date. Saving will overwrite existing records.
        </div>
      )}

      {loaded && rows.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <p className="text-slate-500">No students enrolled in this class.</p>
        </div>
      )}

      {loaded && rows.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => bulkSet('absent')} className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">
              Mark all absent
            </button>
            <button onClick={() => bulkSet('late')} className="text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100">
              Mark all late
            </button>
            <button onClick={() => bulkSet('present')} className="text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100">
              <RotateCcw className="w-3 h-3 inline mr-1" />
              Reset to present
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Student</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.studentId} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 text-slate-900">{row.studentName}</td>
                    <td className="px-4 py-2.5">
                      <select
                        value={row.status}
                        onChange={e => updateStatus(row.studentId, e.target.value as any)}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="present">Present</option>
                        <option value="absent">Absent</option>
                        <option value="late">Late</option>
                      </select>
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        type="text"
                        value={row.note}
                        onChange={e => updateNote(row.studentId, e.target.value)}
                        placeholder="Optional note..."
                        className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Attendance'}
            </button>
            <span className="text-xs text-slate-400">
              Only non-present students ({rows.filter(r => r.status !== 'present').length}) will be saved
            </span>
          </div>
        </>
      )}
    </div>
  );
}
