import { supabase } from '../supabase';
import { AttendanceRecord } from '../../types';

export async function getAttendanceForDate(className: string, date: string): Promise<AttendanceRecord[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('className', className)
    .eq('date', date);
  if (error) throw error;
  return (data || []) as AttendanceRecord[];
}

export async function upsertAttendanceBatch(
  records: { studentId: string; className: string; date: string; status: 'present' | 'absent' | 'late'; note?: string; teacherId: string }[]
): Promise<void> {
  const rows = records.map(r => {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return {
      id: `attendance-${timestamp}-${rand}`,
      studentId: r.studentId,
      className: r.className,
      date: r.date,
      status: r.status,
      note: r.note || null,
      teacherId: r.teacherId,
      createdAt: new Date().toISOString(),
    };
  });
  const { error } = await supabase.from('attendance').upsert(rows, {
    onConflict: 'studentId,date',
    ignoreDuplicates: false,
  });
  if (error) throw error;
}

export async function hasAttendanceForDate(className: string, date: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('className', className)
    .eq('date', date);
  if (error) throw error;
  return (data || []).length > 0;
}
