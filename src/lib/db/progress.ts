import { Exam, ExamType, TeacherExamProgress, TeacherExamProgressVerification, ClassStudentSubjectProgress } from '../../types';
import { supabase } from '../supabase';

const teacherExamProgressColumns = `
  teacherId,
  teacherName,
  className,
  subjectId,
  subjectName,
  month,
  requiredEntries,
  completedEntries,
  completionStatus,
  completionPercent,
  caEntered,
  homeworkEntered,
  classworkEntered,
  attendanceEntered,
  quizEntered,
  totalStudents,
  missingExamTypes
`;

function isTeacherExamProgressRow(row: any): row is TeacherExamProgress {
  return (
    row &&
    typeof row.teacherId === 'string' &&
    typeof row.teacherName === 'string' &&
    typeof row.className === 'string' &&
    typeof row.subjectId === 'string' &&
    typeof row.month === 'string' &&
    typeof row.completionPercent === 'number' &&
    typeof row.totalStudents === 'number'
  );
}

function sortTeacherExamProgressRows(rows: TeacherExamProgress[]) {
  return rows.slice().sort((a, b) => b.completionPercent - a.completionPercent);
}

function getRequiredEntryInfoFromCounts(counts: {
  caEntered: number;
  homeworkEntered: number;
  classworkEntered: number;
  quizEntered: number;
  totalStudents: number;
}) {
  const total = counts.totalStudents || 1;
  const progress = {
    CA: counts.caEntered / total,
    Homework: counts.homeworkEntered / total,
    Classwork: counts.classworkEntered / total,
    Quiz: counts.quizEntered / total,
  };
  const requiredItems = ['CA', 'Quiz'];
  const completedRequiredItems = requiredItems.filter(
    item => progress[item as keyof typeof progress] > 0
  );
  const missingRequiredItems = requiredItems.filter(
    item => progress[item as keyof typeof progress] === 0
  );
  const averageProgress =
    requiredItems.reduce(
      (sum, item) => sum + progress[item as keyof typeof progress],
      0
    ) / requiredItems.length;

  return {
    requiredItems,
    completedRequiredItems,
    missingRequiredItems,
    requiredCount: requiredItems.length,
    completedCount: completedRequiredItems.length,
    completionPercent: Math.round(averageProgress * 100),
    isComplete: requiredItems.every(
      item => progress[item as keyof typeof progress] === 1
    ),
  };
}

export interface ClassStudentSubjectProgress {
  studentId: string;
  studentName: string;
  className: string;
  month: string;
  subject: string;
  caEntered: boolean;
  homeworkEntered: boolean;
  classworkEntered: boolean;
  attendanceEntered: boolean;
  quizEntered: boolean;
  totalExamRows: number;
}

export async function getClassStudentSubjectProgress(
  className: string,
  month: string
): Promise<ClassStudentSubjectProgress[]> {
  if (!className || !month) return [];

  const { data: students, error: studentError } = await supabase
    .from('students')
    .select('id,name')
    .eq('className', className);
  if (studentError) throw studentError;

  const studentMap = new Map((students || []).map((student: any) => [student.id, student.name]));
  const studentIds = (students || []).map((student: any) => student.id);
  if (studentIds.length === 0) return [];

  const { data: classSubjects, error: csError } = await supabase
    .from('class_subjects')
    .select('subjectId,subjects(name)')
    .eq('className', className);
  if (csError) throw csError;

  const subjectNames = (classSubjects || []).map((cs: any) => cs.subjects?.name || cs.subjectId);
  const baselineRows = new Map<string, ClassStudentSubjectProgress>();

  for (const student of students || []) {
    for (const subjectName of subjectNames) {
      const key = `${student.id}:${subjectName}`;
      baselineRows.set(key, {
        studentId: student.id,
        studentName: student.name,
        className,
        month,
        subject: subjectName,
        caEntered: false,
        homeworkEntered: false,
        classworkEntered: false,
        attendanceEntered: false,
        quizEntered: false,
        totalExamRows: 0,
        examEntries: [],
      });
    }
  }

  const { data: exams, error: examError } = await supabase
    .from('exams')
    .select('studentId,subject,examType,score,total')
    .in('studentId', studentIds)
    .eq('month', month);
  if (examError) throw examError;

  const subjectNameByKey = new Map<string, string>();
  for (const cs of classSubjects) {
    const subjectName = cs.subjects?.name || cs.subjectId;
    subjectNameByKey.set(cs.subjectId, subjectName);
    if (subjectName !== cs.subjectId) {
      subjectNameByKey.set(subjectName, subjectName);
    }
  }

  for (const exam of exams || []) {
    const subjectKey = subjectNameByKey.get(exam.subject) ?? exam.subject;
    const key = `${exam.studentId}:${subjectKey}`;
    const existing = baselineRows.get(key);
    if (!existing) continue;

    const updated: ClassStudentSubjectProgress = {
      ...existing,
      caEntered: existing.caEntered || exam.examType === 'CA',
      homeworkEntered: existing.homeworkEntered || exam.examType === 'Homework',
      classworkEntered: existing.classworkEntered || exam.examType === 'Classwork',
      attendanceEntered: existing.attendanceEntered || exam.examType === 'Attendance',
      quizEntered: existing.quizEntered || exam.examType === 'Quiz',
      totalExamRows: existing.totalExamRows + 1,
      examEntries: [...existing.examEntries, { examType: exam.examType, score: exam.score, total: exam.total }],
    };

    baselineRows.set(key, updated);
  }

  return Array.from(baselineRows.values()).sort((a, b) => {
    const studentCompare = a.studentName.localeCompare(b.studentName);
    return studentCompare !== 0 ? studentCompare : a.subject.localeCompare(b.subject);
  });
}

export async function getTeacherExamProgress(filters: {
  month?: string;
  className?: string;
  classNames?: string[];
  teacherId?: string;
}): Promise<TeacherExamProgress[]> {
  const createBaseQuery = () => {
    let query = supabase.from('teacher_exam_progress').select(teacherExamProgressColumns);

    if (filters.month) query = query.eq('month', filters.month);
    if (filters.className) query = query.eq('className', filters.className);
    if (filters.classNames && filters.classNames.length > 0) query = query.in('className', filters.classNames);
    if (filters.teacherId) query = query.eq('teacherId', filters.teacherId);

    return query;
  };

  try {
    const { data, error } = await createBaseQuery().order('completionPercent', { ascending: false });
    if (!error && data && data.every(isTeacherExamProgressRow)) {
      return data;
    }

    // If the view query fails, retry without ordering and sort client-side.
    if (error) {
      const { data: unorderedData, error: unorderedError } = await createBaseQuery();
      if (!unorderedError && unorderedData && unorderedData.every(isTeacherExamProgressRow)) {
        return sortTeacherExamProgressRows(unorderedData);
      }
    }

    return getTeacherExamProgressFallback(filters);
  } catch (error) {
    return getTeacherExamProgressFallback(filters);
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

  let classSubjectQuery: any = supabase
    .from('class_subjects')
    .select('id,className,subjectId,teacherId,subjects(name)');

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
  const { data: students, error: studentError } = await supabase
    .from('students')
    .select('id,className')
    .in('className', classList);
  if (studentError) throw studentError;

  const studentMap = new Map((students || []).map((s: any) => [s.id, s.className]));
  const studentIds = (students || []).map((s: any) => s.id);
  if (studentIds.length === 0) return [];

  let examQuery: any = supabase
    .from('exams')
    .select('studentId,subject,examType,month,teacherId')
    .in('studentId', studentIds);

  if (filters.month) examQuery = examQuery.eq('month', filters.month);
  if (filters.teacherId) examQuery = examQuery.eq('teacherId', filters.teacherId);

  const { data: exams, error: examError } = await examQuery;
  if (examError) throw examError;

  const examRows = (exams || []) as Array<Exam>;
  const months = filters.month
    ? [filters.month]
    : Array.from(new Set(examRows.map(e => e.month).filter(Boolean)));

  const studentsByClass = new Map<string, string[]>();
  for (const s of students || []) {
    if (!studentsByClass.has(s.className)) {
      studentsByClass.set(s.className, []);
    }
    studentsByClass.get(s.className)!.push(s.id);
  }

  if (months.length === 0) return [];

  const groups = new Map<string, TeacherExamProgress>();

  for (const cs of classSubjects) {
    const subjectName = cs.subjects?.name || cs.subjectId;
    const teacherId = cs.teacherId;
    const className = cs.className;

    for (const monthValue of months) {
      const studentIdsInClass = studentsByClass.get(className) || [];
      const totalStudents = studentIdsInClass.length;
      const rowKey = `${teacherId}:${className}:${cs.subjectId}:${monthValue}`;

      const relevantExams = examRows.filter(e =>
        (e.subject === cs.subjectId || e.subject === subjectName) &&
        e.teacherId === teacherId &&
        studentMap.get(e.studentId) === className &&
        (!monthValue || e.month === monthValue)
      );

      const countUnique = (type: string) =>
        new Set(relevantExams.filter(e => e.examType === type).map(e => e.studentId)).size;

      const caEntered = countUnique('CA');
      const homeworkEntered = countUnique('Homework');
      const classworkEntered = countUnique('Classwork');
      const quizEntered = countUnique('Quiz');
      const attendanceEntered = countUnique('Attendance');

      const entryInfo = getRequiredEntryInfoFromCounts({
        caEntered,
        homeworkEntered,
        classworkEntered,
        quizEntered,
        totalStudents,
      });

      groups.set(rowKey, {
        teacherId,
        teacherName: '',
        className,
        subjectId: cs.subjectId,
        subjectName,
        month: monthValue,
        requiredEntries: entryInfo.requiredCount,
        completedEntries: entryInfo.completedCount,
        completionStatus: entryInfo.isComplete ? 'complete' : 'incomplete',
        completionPercent: entryInfo.completionPercent,
        caEntered,
        homeworkEntered,
        classworkEntered,
        attendanceEntered,
        quizEntered,
        totalStudents,
        missingExamTypes: entryInfo.missingRequiredItems,
      });
    }
  }

  if (groups.size === 0) return [];

  const teacherIds = Array.from(new Set(classSubjects.map(cs => cs.teacherId)));
  const { data: teachers, error: teacherError } = await supabase
    .from('users')
    .select('id,name')
    .in('id', teacherIds);
  if (teacherError) throw teacherError;

  const teacherMap = new Map((teachers || []).map((t: any) => [t.id, t.name]));

  return sortTeacherExamProgressRows(
    Array.from(groups.values()).map(entry => ({
      ...entry,
      teacherName: teacherMap.get(entry.teacherId) || '',
    }))
  );
}

export async function getTeacherExamProgressVerification(filters: {
  teacherId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  month: string;
}): Promise<TeacherExamProgressVerification> {
  const { teacherId, className, subjectId, subjectName, month } = filters;

  const { data: students, error: studentError } = await supabase
    .from('students')
    .select('id')
    .eq('className', className);
  if (studentError) throw studentError;

  const studentIds = (students || []).map((s: any) => s.id);
  const totalStudents = studentIds.length;

  if (studentIds.length === 0) {
    return {
      teacherId,
      className,
      subjectId,
      subjectName,
      month,
      totalStudents,
      totalExamRows: 0,
      rowCountsByExamType: {},
      studentCountsByExamType: {},
    };
  }

  let examQuery: any = supabase
    .from('exams')
    .select('studentId,subject,examType,month,teacherId')
    .in('studentId', studentIds)
    .eq('month', month)
    .eq('teacherId', teacherId);

  const subjectFilters = [subjectId, subjectName].filter((value): value is string => Boolean(value));
  if (subjectFilters.length === 1) {
    examQuery = examQuery.eq('subject', subjectFilters[0]);
  } else if (subjectFilters.length > 1) {
    examQuery = examQuery.in('subject', subjectFilters);
  }

  const { data: exams, error: examError } = await examQuery;
  if (examError) throw examError;

  const examRows = (exams || []) as Exam[];
  const rowCountsByExamType: Partial<Record<ExamType, number>> = {};
  const studentSetsByExamType: Partial<Record<ExamType, Set<string>>> = {};

  for (const exam of examRows) {
    rowCountsByExamType[exam.examType] = (rowCountsByExamType[exam.examType] ?? 0) + 1;
    studentSetsByExamType[exam.examType] = studentSetsByExamType[exam.examType] ?? new Set();
    studentSetsByExamType[exam.examType]!.add(exam.studentId);
  }

  const studentCountsByExamType: Partial<Record<ExamType, number>> = {};
  for (const [examType, set] of Object.entries(studentSetsByExamType) as [ExamType, Set<string>][]) {
    studentCountsByExamType[examType] = set.size;
  }

  return {
    teacherId,
    className,
    subjectId,
    subjectName,
    month,
    totalStudents,
    totalExamRows: examRows.length,
    rowCountsByExamType,
    studentCountsByExamType,
  };
}

export async function getAvailableMonths(): Promise<string[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('month')
    .neq('month', null)
    .limit(1000);

  if (error) throw error;

  if (data && data.length > 0) {
    return Array.from(new Set(data.map((row: any) => row.month)))
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
  }

  return [];
}

export async function getMonthsForClass(className: string): Promise<string[]> {
  if (!className) return [];

  const { data, error } = await supabase
    .from('teacher_exam_progress')
    .select('month')
    .eq('className', className);

  if (error) throw error;

  if (data && data.length > 0) {
    return Array.from(new Set(data.map((row: any) => row.month)))
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
  }

  return [];
}
