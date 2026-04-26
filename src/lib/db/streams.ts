import { supabase } from '../supabase';
import { AttendanceRecord, HomeworkRecord, Role } from '../../types';

export async function getAttendanceHomeworkStreams(params: { role: Role; userId: string }) {
  const { role, userId } = params;

  if (role === 'admin') {
    const [attendance, homework] = await Promise.all([
      supabase.from('attendance').select('*').order('date', { ascending: false }).limit(200),
      supabase.from('homework').select('*').order('dueDate', { ascending: false }).limit(200),
    ]);
    if (attendance.error) throw attendance.error;
    if (homework.error) throw homework.error;
    return {
      attendance: (attendance.data || []) as AttendanceRecord[],
      homework: (homework.data || []) as HomeworkRecord[],
    };
  }

  if (role === 'parent') {
    const { data: students, error: studentErr } = await supabase
      .from('students')
      .select('id')
      .eq('parentId', userId);
    if (studentErr) throw studentErr;
    const studentIds = (students || []).map((row: any) => row.id);
    if (studentIds.length === 0) return { attendance: [], homework: [] };
    const [attendance, homework] = await Promise.all([
      supabase.from('attendance').select('*').in('studentId', studentIds).order('date', { ascending: false }).limit(200),
      supabase.from('homework').select('*').in('studentId', studentIds).order('dueDate', { ascending: false }).limit(200),
    ]);
    if (attendance.error) throw attendance.error;
    if (homework.error) throw homework.error;
    return {
      attendance: (attendance.data || []) as AttendanceRecord[],
      homework: (homework.data || []) as HomeworkRecord[],
    };
  }

  if (role === 'teacher' || role === 'supervisor') {
    const { data: me, error: meErr } = await supabase
      .from('users')
      .select('assignedClasses')
      .eq('id', userId)
      .single();
    if (meErr) throw meErr;
    const classNames = Array.isArray(me.assignedClasses) ? me.assignedClasses : [];
    if (classNames.length === 0) return { attendance: [], homework: [] };
    const [attendance, homework] = await Promise.all([
      supabase.from('attendance').select('*').in('className', classNames).order('date', { ascending: false }).limit(200),
      supabase.from('homework').select('*').in('className', classNames).order('dueDate', { ascending: false }).limit(200),
    ]);
    if (attendance.error) throw attendance.error;
    if (homework.error) throw homework.error;
    return {
      attendance: (attendance.data || []) as AttendanceRecord[],
      homework: (homework.data || []) as HomeworkRecord[],
    };
  }

  return { attendance: [], homework: [] };
}
