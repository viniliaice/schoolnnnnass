export type Role = 'admin' | 'teacher' | 'parent';
export type ExamStatus = 'pending' | 'approved' | 'rejected';
export type ExamType = 'CA' | 'Homework' | 'Classwork' | 'Quiz' | 'Midterm' | 'Final';

export const EXAM_TYPES: ExamType[] = ['CA', 'Homework', 'Classwork', 'Quiz', 'Midterm', 'Final'];
export const CA_TYPES: ExamType[] = ['CA', 'Homework', 'Classwork', 'Quiz'];

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const CLASSES = [
  // Kindergarten
  'KG-A', 'KG-B',

  // Primary School (Grades 1-6)
  'Grade 1-A', 'Grade 1-B', 'Grade 1-C',
  'Grade 2-A', 'Grade 2-B', 'Grade 2-C',
  'Grade 3-A', 'Grade 3-B', 'Grade 3-C',
  'Grade 4-A', 'Grade 4-B', 'Grade 4-C',
  'Grade 5-A', 'Grade 5-B', 'Grade 5-C',
  'Grade 6-A', 'Grade 6-B', 'Grade 6-C',

  // Secondary School (Grades 7-12)
  'Grade 7-A', 'Grade 7-B', 'Grade 7-C',
  'Grade 8-A', 'Grade 8-B', 'Grade 8-C',
  'Grade 9-A', 'Grade 9-B', 'Grade 9-C',
  'Grade 10-A', 'Grade 10-B', 'Grade 10-C',
  'Grade 11-A', 'Grade 11-B', 'Grade 11-C',
  'Grade 12-A', 'Grade 12-B', 'Grade 12-C',

  // Alternative naming for Year 12 (if needed)
  'Year 12-A', 'Year 12-B', 'Year 12-C',
];

export const SUBJECTS = [
  'Mathematics', 'English', 'Science', 'Somali', 'Islamic Studies', 'Social Studies',
  'Physics', 'Chemistry', 'Biology', 'History', 'Geography', 'Arabic',
];

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Parent-specific fields
  phone1?: string;
  phone2?: string;
  xafada?: string;
  udow?: string;
  paymentnumber?: string;
  // Teacher-specific fields
  assignedClasses?: string[];
  createdAt: string;
}

export interface Student {
  id: string;
  name: string;
  className: string;
  parentId: string | null;
  createdAt: string;
}

export interface Subject {
  id: string;
  name: string;
  shortName?: string;
  createdAt: string;
}

export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  createdAt: string;
}

export interface Term {
  id: string;
  name: string;
  academicYearId: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  months: string[];
  createdAt: string;
}

export interface Exam {
  id: string;
  studentId: string;
  subject: string;
  score: number;
  total: number;
  examType: ExamType;
  month: string;
  status: ExamStatus;
  parentId: string | null;
  date: string;
  createdAt: string;
  teacherId: string;
}

export interface RoleSession {
  role: Role;
  userId: string;
  userName: string;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'loading';
  title: string;
  description?: string;
}

// Report types
export interface MonthlySubjectScore {
  subject: string;
  scores: { type: ExamType; score: number; total: number }[];
  average: number;
}

export interface MidtermSubjectScore {
  subject: string;
  score: number;
  total: number;
  percentage: number;
}

export interface FinalSubjectScore {
  subject: string;
  caAverage: number;
  midtermScore: number;
  finalExamScore: number;
  finalScore: number;
  grade: string;
  passed: boolean;
}

export function getGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function isPassing(score: number): boolean {
  return score >= 60;
}

// New types for enhanced schema
export interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  createdAt: string;
}

export interface Term {
  id: string;
  name: string;
  academicYearId: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  months: string[];
  createdAt: string;
}

export interface Subject {
  id: string;
  name: string;
  shortName?: string;
  createdAt: string;
}

export interface ClassSubject {
  id: string;
  className: string;
  subjectId: string;
  teacherId?: string;
}

export interface GradeScale {
  id: string;
  minScore: number;
  maxScore: number;
  grade: string;
  remark: string;
  gpa?: number;
}

export interface ReportComment {
  id: string;
  studentId: string;
  termId: string;
  teacherComment?: string;
  principalComment?: string;
  teacherId?: string;
  createdAt: string;
}

export interface ReportConfig {
  id: string;
  caWeight: number;
  midtermWeight: number;
  finalWeight: number;
  caTypes: string[];
  updatedAt: string;
}

// Update Exam interface
export interface Exam {
  id: string;
  studentId: string;
  subject: string;
  score: number;
  total: number;
  examType: ExamType;
  month: string;
  status: ExamStatus;
  parentId: string | null;
  date: string;
  createdAt: string;
  teacherId: string;
  termId?: string;  // New
  subjectId?: string;  // New
}

// Add report types
export interface MonthlyScore {
  subject: string;
  month: string;
  average: number;
  assessment_count: number;
  details: {
    type: string;
    score: number;
    total: number;
    percentage: number;
    date: string;
  }[];
}

export interface MidtermScore {
  subject: string;
  score: number;
  total: number;
  percentage: number;
  grade: string;
  remark: string;
  subject_rank: number;
  class_average: number;
  highest_in_class: number;
}

export interface MidtermReport {
  scores: MidtermScore[];
  overall_rank: number;
  total_students: number;
}

export interface FinalSubject {
  subject: string;
  ca_avg: number;
  ca_weighted: number;
  midterm_score: number;
  midterm_weighted: number;
  final_score: number;
  final_weighted: number;
  total: number;
}

export interface FinalReport {
  weights: { ca: number; midterm: number; final: number };
  results: FinalSubject[];
  overall_rank: number;
  total_students: number;
  comment: { teacher: string; principal: string };
}
