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
  'Grade 7-A', 'Grade 7-B', 'Grade 7-C',
  'Grade 8-A', 'Grade 8-B',
  'Grade 9-A', 'Grade 9-B',
  'Grade 10-A', 'Grade 10-B',
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
  paymentNumber?: string;
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
