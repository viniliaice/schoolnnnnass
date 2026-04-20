import { supabase } from '../supabase';
import { Exam, Student, User } from '../../types';

export async function bulkCreateUsers(dataList: Omit<User, 'id' | 'createdAt'>[]): Promise<User[]> {
  const users = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `${data.role}-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });

  const { data, error } = await supabase.from('users').insert(users).select();
  if (error) throw error;
  return data || [];
}

export async function bulkCreateStudents(dataList: Omit<Student, 'id' | 'createdAt'>[]): Promise<Student[]> {
  const studentsWithTimestamps = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `student-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });

  const { data, error } = await supabase.from('students').insert(studentsWithTimestamps).select();
  if (error) throw error;
  return data || [];
}

export async function bulkCreateExams(dataList: Omit<Exam, 'id' | 'createdAt'>[]): Promise<Exam[]> {
  const examsWithTimestamps = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `exam-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });

  const { data, error } = await supabase.from('exams').insert(examsWithTimestamps).select();
  if (error) throw error;
  return data || [];
}
