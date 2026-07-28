import { supabase } from '../supabase';
import { ClassSubject, Exam, Student, User } from '../../types';

export async function bulkCreateUsers(dataList: Omit<User, 'id' | 'createdAt'>[]): Promise<User[]> {
  const users = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `${data.role}-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });

  const { data, error } = await supabase.from('profiles').insert(users).select();
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

// ─── Bulk Teacher + Assignments Import ───────────────────────────────────────

/** Result of a bulk teacher + assignments import */
export interface BulkTeacherImportResult {
  teachers: User[];
  assignments: ClassSubject[];
  skippedTeachers: string[];
  skippedAssignments: string[];
}

/**
 * Bulk-create teachers and auto-create class_subject mappings for their
 * assigned classes and subjects.
 */
export async function bulkCreateTeachersWithAssignments(
  entries: Array<{
    name: string;
    email: string;
    password: string;
    assignedClasses: string[];
    assignedSubjects: string[];
    weeklyPeriods: number;
  }>,
): Promise<BulkTeacherImportResult> {
  const teachers: User[] = [];
  const assignments: ClassSubject[] = [];
  const skippedTeachers: string[] = [];
  const skippedAssignments: string[] = [];

  for (const entry of entries) {
    try {
      // Check if teacher with this email already exists
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .ilike('email', entry.email)
        .maybeSingle();

      if (existing) {
        skippedTeachers.push(`${entry.name} (${entry.email}) — already exists`);
        // Still try to create assignments with the existing teacher
        for (const className of entry.assignedClasses) {
          for (const subjectId of entry.assignedSubjects) {
            const { data: existingMapping } = await supabase
              .from('class_subjects')
              .select('id')
              .eq('className', className)
              .eq('subjectId', subjectId)
              .maybeSingle();

            if (existingMapping) {
              await supabase
                .from('class_subjects')
                .update({ teacherId: existing.id })
                .eq('id', existingMapping.id);
            } else {
              const csId = `class-subject-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
              const { data: csRow, error: csErr } = await supabase
                .from('class_subjects')
                .insert({
                  id: csId,
                  className,
                  subjectId,
                  teacherId: existing.id,
                  createdAt: new Date().toISOString(),
                })
                .select()
                .single();
              if (csErr) {
                skippedAssignments.push(`${className} / ${subjectId}`);
              } else if (csRow) {
                assignments.push(csRow);
              }
            }
          }
        }
        continue;
      }

      // Create new teacher profile
      const teacherId = `teacher-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: entry.email,
        password: entry.password,
      });
      if (authError) throw authError;

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: teacherId,
          name: entry.name,
          email: entry.email,
          role: 'teacher',
          assignedClasses: entry.assignedClasses,
          assignedSubjects: entry.assignedSubjects,
          auth_id: authData.user?.id,
          createdAt: new Date().toISOString(),
        })
        .select()
        .single();
      if (profileError) throw profileError;
      teachers.push(profileData as User);

      // Create class-subject mappings
      for (const className of entry.assignedClasses) {
        for (const subjectId of entry.assignedSubjects) {
          const { data: existingMapping } = await supabase
            .from('class_subjects')
            .select('id')
            .eq('className', className)
            .eq('subjectId', subjectId)
            .maybeSingle();

          if (existingMapping) {
            await supabase
              .from('class_subjects')
              .update({ teacherId: teacherId })
              .eq('id', existingMapping.id);
          } else {
            const csId = `class-subject-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const { data: csRow, error: csErr } = await supabase
              .from('class_subjects')
              .insert({
                id: csId,
                className,
                subjectId,
                teacherId,
                createdAt: new Date().toISOString(),
              })
              .select()
              .single();
            if (csErr) {
              skippedAssignments.push(`${className} / ${subjectId}`);
            } else if (csRow) {
              assignments.push(csRow);
            }
          }
        }
      }
    } catch (err) {
      skippedTeachers.push(`${entry.name} (${entry.email}) — ${String(err)}`);
    }
  }

  return { teachers, assignments, skippedTeachers, skippedAssignments };
}
