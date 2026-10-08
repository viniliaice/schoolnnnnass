import { supabase } from '../supabase';
import type { Student } from '../../types';
import { filterStudentsByStatus } from './students';

export interface ParentLearningResource {
  label: string | null;
  url: string | null;
}

export interface ParentWeeklyLesson {
  studentId: string;
  studentName: string;
  className: string;
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  lessonId: string;
  day: string;
  subject: string;
  topic: string;
  learningObjective: string | null;
  whatWeAreLearning: string | null;
  resources: ParentLearningResource[];
  practiceTitle: string | null;
  practiceDescription: string | null;
  practiceDueDate: string | null;
}

type RpcRow = {
  student_id: string;
  student_name: string;
  class_name: string;
  week_label: string;
  week_start: string;
  week_end: string;
  lesson_id: string;
  day: string;
  subject: string;
  topic: string;
  learning_objective: string | null;
  what_we_are_learning: string | null;
  resources: ParentLearningResource[] | null;
  practice_title: string | null;
  practice_description: string | null;
  practice_due_date: string | null;
};

/** Child choices are still protected by the existing parent-scoped students RLS. */
export async function getParentLearningChildren(parentId: string): Promise<Student[]> {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('parentId', parentId);
  if (error) throw new Error(error.message || 'Could not load children.');
  // Weekly learning is current work: a child who left the school is not offered
  // a learning plan. Client-side filter keeps this working pre-migration.
  return filterStudentsByStatus((data ?? []) as Student[], 'active');
}

/** Parent UI must use this allowlisted RPC, never the raw lesson-plan tables. */
export async function getParentWeeklyLearning(
  studentId: string,
  weekLabel: string,
): Promise<ParentWeeklyLesson[]> {
  const { data, error } = await supabase.rpc('get_parent_weekly_learning', {
    p_student_id: studentId,
    p_week_label: weekLabel,
  });
  if (error) throw new Error(error.message || 'Could not load weekly learning.');

  return ((data ?? []) as RpcRow[]).map((row) => ({
    studentId: row.student_id,
    studentName: row.student_name,
    className: row.class_name,
    weekLabel: row.week_label,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    lessonId: row.lesson_id,
    day: row.day,
    subject: row.subject,
    topic: row.topic,
    learningObjective: row.learning_objective,
    whatWeAreLearning: row.what_we_are_learning,
    resources: Array.isArray(row.resources) ? row.resources : [],
    practiceTitle: row.practice_title,
    practiceDescription: row.practice_description,
    practiceDueDate: row.practice_due_date,
  }));
}
