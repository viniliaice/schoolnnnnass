import { supabase } from '../supabase';
import { AttendanceRecord, Exam, HomeworkRecord, Student, Quiz } from '../../types';

export async function getParentPortalSnapshot(parentId: string) {
  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('*')
    .eq('parentId', parentId);
  if (studentsError) throw studentsError;

  const studentIds = (students || []).map((s: Student) => s.id);
  if (studentIds.length === 0) {
    return { students: [], exams: [], attendance: [], homework: [], quizzes: [] };
  }

  const [examsRes, attendanceRes, homeworkRes] = await Promise.all([
    supabase
      .from('exams')
      .select('*')
      .in('studentId', studentIds)
      .eq('status', 'approved')
      .order('date', { ascending: false }),
    supabase
      .from('attendance')
      .select('*')
      .in('studentId', studentIds)
      .order('date', { ascending: false })
      .limit(100),
    supabase
      .from('homework')
      .select('*')
      .in('studentId', studentIds)
      .order('dueDate', { ascending: false })
      .limit(100),
  ]);

  if (examsRes.error) throw examsRes.error;
  if (attendanceRes.error) throw attendanceRes.error;
  if (homeworkRes.error) throw homeworkRes.error;

  // Get class names to find active quizzes
  const classNames = [...new Set((students || []).map(s => s.className))];
  const today = new Date().toISOString().split('T')[0];
  const { data: quizzes } = await supabase
    .from('quizzes')
    .select('*')
    .in('className', classNames)
    .eq('status', 'active')
    .lte('openDate', today)
    .gte('dueDate', today);

  return {
    students: students as Student[],
    exams: (examsRes.data || []) as Exam[],
    attendance: (attendanceRes.data || []) as AttendanceRecord[],
    homework: (homeworkRes.data || []) as HomeworkRecord[],
    quizzes: (quizzes || []) as Quiz[],
  };
}

export interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  total: number;
}

/**
 * Simple per-child attendance tally for the parent portal (shown on the
 * Monthly report tab "where appropriate"). Same RLS boundary as the
 * dashboard snapshot above — a parent can only ever read their own child's
 * attendance rows.
 */
export async function getChildAttendanceSummary(studentId: string): Promise<AttendanceSummary> {
  const { data, error } = await supabase
    .from('attendance')
    .select('status')
    .eq('studentId', studentId)
    .order('date', { ascending: false })
    .limit(180);
  if (error) throw error;
  const summary: AttendanceSummary = { present: 0, absent: 0, late: 0, total: 0 };
  for (const row of (data || []) as Pick<AttendanceRecord, 'status'>[]) {
    if (row.status === 'present') summary.present += 1;
    else if (row.status === 'absent') summary.absent += 1;
    else if (row.status === 'late') summary.late += 1;
    else continue;
    summary.total += 1;
  }
  return summary;
}
