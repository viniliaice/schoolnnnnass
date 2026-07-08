import type { Exam, ExamType, TeacherExamProgress, TeacherExamProgressVerification, ClassStudentSubjectProgress } from '../../types';
import { supabase } from '../supabase';
import { warnFallback } from '../logger';

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
  const total = Math.max(counts.totalStudents, 0);
  const quizComplete = total > 0 && counts.quizEntered >= total;
  const caComplete = total > 0 && counts.caEntered >= total;
  const homeworkComplete = total > 0 && counts.homeworkEntered >= total;
  const classworkComplete = total > 0 && counts.classworkEntered >= total;
  const courseworkComplete = caComplete || (homeworkComplete && classworkComplete);

  const courseworkProgress = total > 0
    ? Math.max(
        Math.min(counts.caEntered / total, 1),
        (Math.min(counts.homeworkEntered / total, 1) + Math.min(counts.classworkEntered / total, 1)) / 2,
      )
    : 0;
  const quizProgress = total > 0 ? Math.min(counts.quizEntered / total, 1) : 0;

  const requiredItems = ['Coursework (CA or Homework + Classwork)', 'Quiz'];
  const completedRequiredItems = [
    courseworkComplete ? requiredItems[0] : null,
    quizComplete ? requiredItems[1] : null,
  ].filter(Boolean) as string[];
  const missingRequiredItems = [
    courseworkComplete ? null : requiredItems[0],
    quizComplete ? null : requiredItems[1],
  ].filter(Boolean) as string[];

  return {
    requiredItems,
    completedRequiredItems,
    missingRequiredItems,
    requiredCount: requiredItems.length,
    completedCount: completedRequiredItems.length,
    completionPercent: Math.round(((courseworkProgress + quizProgress) / 2) * 100),
    isComplete: courseworkComplete && quizComplete,
  };
}

function isMissingRpcError(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return false;
  return error.code === 'PGRST202'
    || error.code === '42883'
    || error.message?.toLowerCase().includes('function')
    || error.details?.includes('get_class_student_subject_progress');
}

function normalizeClassStudentSubjectProgressRows(value: unknown): ClassStudentSubjectProgress[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row: any) => ({
    studentId: String(row.studentId ?? row.student_id ?? ''),
    studentName: String(row.studentName ?? row.student_name ?? ''),
    className: String(row.className ?? row.class_name ?? ''),
    month: String(row.month ?? ''),
    subject: String(row.subject ?? ''),
    caEntered: Boolean(row.caEntered ?? row.ca_entered ?? false),
    homeworkEntered: Boolean(row.homeworkEntered ?? row.homework_entered ?? false),
    classworkEntered: Boolean(row.classworkEntered ?? row.classwork_entered ?? false),
    attendanceEntered: Boolean(row.attendanceEntered ?? row.attendance_entered ?? false),
    quizEntered: Boolean(row.quizEntered ?? row.quiz_entered ?? false),
    totalExamRows: Number(row.totalExamRows ?? row.total_exam_rows ?? 0),
    examEntries: Array.isArray(row.examEntries ?? row.exam_entries)
      ? (row.examEntries ?? row.exam_entries).map((entry: any) => ({
          examType: entry.examType ?? entry.exam_type,
          score: Number(entry.score ?? 0),
          total: Number(entry.total ?? 0),
        }))
      : [],
  })).sort((a, b) => {
    const studentCompare = a.studentName.localeCompare(b.studentName);
    return studentCompare !== 0 ? studentCompare : a.subject.localeCompare(b.subject);
  });
}

export async function getClassStudentSubjectProgress(
  className: string,
  month: string
): Promise<ClassStudentSubjectProgress[]> {
  if (!className || !month) return [];

  const { data, error } = await supabase.rpc('get_class_student_subject_progress', {
    p_class_name: className,
    p_month: month,
  });

  if (!error) return normalizeClassStudentSubjectProgressRows(data);
  if (!isMissingRpcError(error)) throw error;

  warnFallback('getClassStudentSubjectProgress RPC missing; using client fallback', error);
  return getClassStudentSubjectProgressFallback(className, month);
}

export async function getClassStudentSubjectProgressFallback(
  className: string,
  month: string
): Promise<ClassStudentSubjectProgress[]> {
  if (!className || !month) return [];

  const { data: students, error: studentError } = await supabase
    .from('students')
    .select('id,name')
    .eq('className', className);
  if (studentError) throw studentError;

  const studentIds = (students || []).map((student: any) => student.id);
  if (studentIds.length === 0) return [];

  const { data: classSubjects, error: csError } = await supabase
    .from('class_subjects')
    .select('subjectId,subjects(name)')
    .eq('className', className);
  if (csError) throw csError;

  const subjectNames = (classSubjects || []).map((cs: any) => (cs.subjects as any)?.name || cs.subjectId);
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
  for (const cs of classSubjects || []) {
    const subjectName = (cs.subjects as any)?.name || cs.subjectId;
    subjectNameByKey.set(cs.subjectId, subjectName);
    if (subjectName !== cs.subjectId) subjectNameByKey.set(subjectName, subjectName);
  }

  for (const exam of exams || []) {
    const subjectKey = subjectNameByKey.get(exam.subject) ?? exam.subject;
    const key = `${exam.studentId}:${subjectKey}`;
    const existing = baselineRows.get(key);
    if (!existing) continue;

    baselineRows.set(key, {
      ...existing,
      caEntered: existing.caEntered || exam.examType === 'CA',
      homeworkEntered: existing.homeworkEntered || exam.examType === 'Homework',
      classworkEntered: existing.classworkEntered || exam.examType === 'Classwork',
      attendanceEntered: existing.attendanceEntered || exam.examType === 'Attendance',
      quizEntered: existing.quizEntered || exam.examType === 'Quiz',
      totalExamRows: existing.totalExamRows + 1,
      examEntries: [...existing.examEntries, { examType: exam.examType, score: exam.score, total: exam.total }],
    });
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

    warnFallback('teacher_exam_progress view returned invalid rows; using client fallback');
    return getTeacherExamProgressFallback(filters);
  } catch (error) {
    warnFallback('teacher_exam_progress view failed; using client fallback', error);
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
    const subjectName = (cs.subjects as any)?.name || cs.subjectId;
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
    .from('profiles')
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
