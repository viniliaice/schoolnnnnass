import { supabase } from '../supabase';
import { HomeworkRecord } from '../../types';

export async function createHomeworkBatch(
  records: { studentId: string; className: string; subject: string; title: string; description?: string; dueDate: string; teacherId: string; }[]
): Promise<void> {
  const rows = records.map(r => {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return {
      id: `homework-${timestamp}-${rand}`,
      studentId: r.studentId,
      className: r.className,
      subject: r.subject,
      title: r.title,
      description: r.description || null,
      dueDate: r.dueDate,
      status: 'assigned',
      teacherId: r.teacherId,
      createdAt: new Date().toISOString(),
    };
  });
  const { error } = await supabase.from('homework').insert(rows);
  if (error) throw error;
}

export async function getHomeworkByClass(className: string): Promise<HomeworkRecord[]> {
  const { data, error } = await supabase
    .from('homework')
    .select('*')
    .eq('className', className)
    .order('dueDate', { ascending: false });
  if (error) throw error;
  return (data || []) as HomeworkRecord[];
}

export async function updateHomework(id: string, data: Partial<HomeworkRecord>): Promise<void> {
  const { error } = await supabase.from('homework').update(data).eq('id', id);
  if (error) throw error;
}

export async function deleteHomework(id: string): Promise<void> {
  const { error } = await supabase.from('homework').delete().eq('id', id);
  if (error) throw error;
}

export async function deleteHomeworkByTitle(className: string, title: string): Promise<void> {
  const { error } = await supabase
    .from('homework')
    .delete()
    .eq('className', className)
    .eq('title', title);
  if (error) throw error;
}

export async function homeworkExists(className: string, title: string, subject: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('homework')
    .select('id', { count: 'exact', head: true })
    .eq('className', className)
    .eq('title', title)
    .eq('subject', subject);
  if (error) throw error;
  return (data || []).length > 0;
}
