import { Exam, TeacherExamProgress } from '../../types';
import { supabase } from '../supabase';

const REQUIRED_MONTHLY_EXAM_TYPES = ['CA', 'Homework', 'Classwork', 'Quiz'] as const;
type RequiredMonthlyExamType = (typeof REQUIRED_MONTHLY_EXAM_TYPES)[number];

const teacherExamProgressCache = new Map<string, Promise<TeacherExamProgress[]>>();

export async function getTeacherExamProgress(filters: {
  month?: string;
  className?: string;
  classNames?: string[];
  teacherId?: string;
}): Promise<TeacherExamProgress[]> {
  const cacheKey = JSON.stringify(filters);
  if (teacherExamProgressCache.has(cacheKey)) {
    return teacherExamProgressCache.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    // Always compute from source tables. The `teacher_exam_progress` view has
    // produced stale/incorrect CA counters in production for some records.
    return getTeacherExamProgressFallback(filters);
  })();

  teacherExamProgressCache.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } catch (error) {
    teacherExamProgressCache.delete(cacheKey);
    throw error;
  }
}

async function getTeacherExamProgressFallback(filters: {
  month?: string;
  className?: string;
  classNames?: string[];
  teacherId?: string;
}): Promise<TeacherExamProgress[]> {
  const classNames = filters.classNames?.length
    ? filters.classNames
    : filters.className
    ? [filters.className]
    : undefined;

  let classSubjectQuery: any = supabase.from('class_subjects').select('id,className,subjectId,teacherId,subjects(name)');
  if (filters.teacherId) classSubjectQuery = classSubjectQuery.eq('teacherId', filters.teacherId);
  if (classNames && classNames.length > 0) classSubjectQuery = classSubjectQuery.in('className', classNames);
  const { data: csData, error: csError } = await classSubjectQuery;
  if (csError) throw csError;
  const classSubjects = (csData || []) as Array<{
    id: string;
    className: string;
    subjectId: string;
    teacherId: string;
    subjects?: { name: string };
  }>;
  if (classSubjects.length === 0) return [];

  const classList = Array.from(new Set(classSubjects.map(cs => cs.className)));
  const { data: students, error: studentError } = await supabase.from('students').select('id,className').in('className', classList);
  if (studentError) throw studentError;
  const studentMap = new Map((students || []).map((s: any) => [s.id, s.className]));
  const studentIds = students?.map((s: any) => s.id) || [];

  if (studentIds.length === 0) return [];

  let examQuery: any = supabase.from('exams').select('*').in('studentId', studentIds);
  if (filters.month) examQuery = examQuery.eq('month', filters.month);
  if (filters.teacherId) examQuery = examQuery.eq('teacherId', filters.teacherId);
  const { data: exams, error: examError } = await examQuery;
  if (examError) throw examError;
  const examRows = (exams || []) as Array<Exam>;
  const months = filters.month ? [filters.month] : Array.from(new Set(examRows.map(e => e.month)));
  if (months.length === 0) return [];

  const groups = new Map<string, TeacherExamProgress>();
  for (const cs of classSubjects) {
    const subjectName = cs.subjects?.name || cs.subjectId;
    const teacherId = cs.teacherId;
    const className = cs.className;

    const groupedRows = months.length > 0 ? months : [''];
    for (const monthValue of groupedRows) {
      const rowKey = `${teacherId}:${className}:${cs.subjectId}:${monthValue}`;
      const relevantExams = examRows.filter(e =>
        e.teacherId === teacherId &&
        (e.subject === subjectName || e.subject === cs.subjectId) &&
        studentMap.get(e.studentId) === className &&
        (!monthValue || e.month === monthValue)
      );

      const completedTypes = new Set<string>(
        relevantExams
          .map(e => e.examType)
          .filter((value): value is RequiredMonthlyExamType => REQUIRED_MONTHLY_EXAM_TYPES.includes(value as RequiredMonthlyExamType))
      );
      const missingExamTypes = REQUIRED_MONTHLY_EXAM_TYPES.filter(type => !completedTypes.has(type));
      const uniqueStudentsInClass = new Set(
        students
          .filter((student: any) => student.className === className)
          .map((student: any) => student.id)
      );
      const caEntered = new Set(relevantExams.filter(e => e.examType === 'CA').map(e => e.studentId)).size;
      const homeworkEntered = new Set(relevantExams.filter(e => e.examType === 'Homework').map(e => e.studentId)).size;
      const classworkEntered = new Set(relevantExams.filter(e => e.examType === 'Classwork').map(e => e.studentId)).size;
      const quizEntered = new Set(relevantExams.filter(e => e.examType === 'Quiz').map(e => e.studentId)).size;
      const attendanceEntered = new Set(relevantExams.filter(e => e.examType === 'Attendance').map(e => e.studentId)).size;

      groups.set(rowKey, {
        teacherId,
        teacherName: '',
        className,
        subjectId: cs.subjectId,
        subjectName,
        month: monthValue || '',
        requiredEntries: REQUIRED_MONTHLY_EXAM_TYPES.length,
        completedEntries: completedTypes.size,
        completionStatus: completedTypes.size === REQUIRED_MONTHLY_EXAM_TYPES.length ? 'complete' : 'incomplete',
        completionPercent: Math.round((100.0 * completedTypes.size) / REQUIRED_MONTHLY_EXAM_TYPES.length * 100) / 100,
        caEntered,
        homeworkEntered,
        classworkEntered,
        attendanceEntered,
        quizEntered,
        totalStudents: uniqueStudentsInClass.size,
        missingExamTypes,
      });
    }
  }

  if (groups.size === 0) return [];

  const teacherIds = Array.from(new Set(classSubjects.map(cs => cs.teacherId)));
  const { data: teachers, error: teacherError } = await supabase.from('users').select('id,name').in('id', teacherIds);
  if (teacherError) throw teacherError;
  const teacherMap = new Map((teachers || []).map((t: any) => [t.id, t.name]));

  return Array.from(groups.values()).map(entry => ({
    ...entry,
    teacherName: teacherMap.get(entry.teacherId) || '',
  }));
}
