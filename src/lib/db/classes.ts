import { ClassSubject, Subject } from '../../types';
import { supabase } from '../supabase';

export async function getClassAssignmentsForTeacher(teacherId: string) {
  const { data, error } = await supabase
    .from('class_subjects')
    .select('className, subjectId')
    .eq('teacherId', teacherId);
  if (error) throw error;
  return data || [];
}

export async function getClasses(): Promise<string[]> {
  const { data, error } = await supabase
    .from('class_subjects')
    .select('className', { count: 'exact' });
  if (error) throw error;
  return Array.from(new Set((data || []).map((row: any) => row.className)));
}

export async function getClassSubjects(): Promise<Array<ClassSubject & { subjects?: { name: string }; users?: { name: string } }>> {
  const { data, error } = await supabase
    .from('class_subjects')
    .select('*, subjects(name), users(name)');
  if (error) throw error;
  return data || [];
}

export async function getClassSubjectsForTeacher(teacherId: string, className?: string): Promise<Subject[]> {
  let query = supabase
    .from('class_subjects')
    .select('subjectId, teacherId, className, subjects(*)');

  if (teacherId) query = query.eq('teacherId', teacherId);
  if (className) query = query.eq('className', className);

  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  // Map to the subjects payload returned by the join
  return rows
    .map((r: any) => r.subjects)
    .filter(Boolean) as Subject[];
}

export async function createClassSubject(data: Omit<ClassSubject, 'id'>): Promise<ClassSubject> {
  const { data: row, error } = await supabase
    .from('class_subjects')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return row;
}

export async function updateClassSubject(id: string, data: Partial<Omit<ClassSubject, 'id'>>): Promise<ClassSubject> {
  const { data: row, error } = await supabase
    .from('class_subjects')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return row;
}

export async function deleteClassSubject(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('class_subjects')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return true;
}
