import { supabase } from '../supabase';
import { AttendanceRecord, Exam, HomeworkRecord, Student } from '../../types';

export async function getParentPortalSnapshot(parentId: string) {
  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('*')
    .eq('parentId', parentId);
  if (studentsError) throw studentsError;

  const studentIds = (students || []).map((s: Student) => s.id);
  if (studentIds.length === 0) {
    return { students: [], exams: [], attendance: [], homework: [] };
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

  return {
    students: students as Student[],
    exams: (examsRes.data || []) as Exam[],
    attendance: (attendanceRes.data || []) as AttendanceRecord[],
    homework: (homeworkRes.data || []) as HomeworkRecord[],
  };
}
