import { supabase } from '../supabase';
import { ClassSubject, Exam, Student, User } from '../../types';

export async function bulkCreateUsers(dataList: Omit<User, 'id' | 'createdAt'>[]): Promise<User[]> {
  const created: User[] = [];
  const errors: string[] = [];

  for (const data of dataList) {
    try {
      const { password, ...rest } = data;
      if (!password) throw new Error('Password is required');

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: data.email,
        password,
      });
      if (authError) throw authError;
      if (!authData.user) throw new Error('Failed to create auth user');

      const id = `${data.role}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .insert({ id, ...rest, auth_id: authData.user.id, createdAt: new Date().toISOString() })
        .select()
        .single();
      if (profileError) throw profileError;
      created.push(profile as User);
    } catch (err) {
      errors.push(`${data.email}: ${String(err)}`);
    }
  }

  if (errors.length > 0) throw new Error(`Bulk user creation errors:\n${errors.join('\n')}`);
  return created;
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

/**
 * Legacy/general exam insert used by the single-subject entry flow.
 *
 * Do not use this for Excel bulk grades: that flow must use
 * submitBulkGrades(), whose RPC validates assessment slots, authorization,
 * idempotency, and update-vs-insert behavior atomically.
 */
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
      console.log('[bulkCreateTeachersWithAssignments] Processing entry:', entry.name, entry.email);
      // Check if teacher with this email already exists
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .ilike('email', entry.email)
        .maybeSingle();

      console.log('[bulkCreateTeachersWithAssignments] Existing check for', entry.email, ':', existing);

      if (existing) {
        console.log('[bulkCreateTeachersWithAssignments] Teacher already exists, skipping:', entry.email);
        skippedTeachers.push(`${entry.name} (${entry.email}) — already exists`);
        // Still try to create assignments with the existing teacher
        console.log('[bulkCreateTeachersWithAssignments] Creating assignments for existing teacher:', existing.id);
        for (const className of entry.assignedClasses) {
          for (const subjectId of entry.assignedSubjects) {
            const { data: existingMapping } = await supabase
              .from('class_subjects')
              .select('id')
              .eq('className', className)
              .eq('subjectId', subjectId)
              .maybeSingle();

            if (existingMapping) {
              console.log('[bulkCreateTeachersWithAssignments] Updating existing class_subject:', existingMapping.id, 'with teacherId:', existing.id);
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
                console.warn('[bulkCreateTeachersWithAssignments] Assignment insert failed for existing teacher:', className, subjectId, csErr);
                skippedAssignments.push(`${className} / ${subjectId}`);
              } else if (csRow) {
                console.log('[bulkCreateTeachersWithAssignments] Assignment created for existing teacher:', csRow);
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
      console.log('[bulkCreateTeachersWithAssignments] Creating auth user for:', entry.email);
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: entry.email,
        password: entry.password,
      });
      console.log('[bulkCreateTeachersWithAssignments] Auth signup result:', { authData, authError });
      if (authError) throw authError;

      console.log('[bulkCreateTeachersWithAssignments] Creating profile for:', entry.name);
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
      if (profileError) {
        console.error('[bulkCreateTeachersWithAssignments] Profile insert error:', profileError);
        throw profileError;
      }
      console.log('[bulkCreateTeachersWithAssignments] Profile created:', profileData);
      teachers.push(profileData as User);

      // Create class-subject mappings
      console.log('[bulkCreateTeachersWithAssignments] Creating assignments for:', entry.name, 'classes:', entry.assignedClasses, 'subjects:', entry.assignedSubjects);
      for (const className of entry.assignedClasses) {
        for (const subjectId of entry.assignedSubjects) {
          const { data: existingMapping } = await supabase
            .from('class_subjects')
            .select('id')
            .eq('className', className)
            .eq('subjectId', subjectId)
            .maybeSingle();

          if (existingMapping) {
            console.log('[bulkCreateTeachersWithAssignments] Updating existing class_subject:', existingMapping.id, 'with teacherId:', teacherId);
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
              console.warn('[bulkCreateTeachersWithAssignments] Assignment insert failed:', className, subjectId, csErr);
              skippedAssignments.push(`${className} / ${subjectId}`);
            } else if (csRow) {
              console.log('[bulkCreateTeachersWithAssignments] Assignment created:', csRow);
              assignments.push(csRow);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[bulkCreateTeachersWithAssignments] Error processing', entry.name, entry.email, ':', err);
      skippedTeachers.push(`${entry.name} (${entry.email}) — ${String(err)}`);
    }
  }

  console.log('[bulkCreateTeachersWithAssignments] Final result:', { teachers: teachers.length, assignments: assignments.length, skippedTeachers, skippedAssignments });
  return { teachers, assignments, skippedTeachers, skippedAssignments };
}
