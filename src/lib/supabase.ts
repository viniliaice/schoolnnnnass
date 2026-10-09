import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from './transport';
import type { Role } from '../types';
// Former Students / Student Cleanup: the pure matching contract shared with the
// no-backend preview client (the database implements the same rules in SQL).
import { evaluateFormerStudentRows, MAX_FORMER_IMPORT_ROWS } from './import/formerStudents';

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const isPlaceholderEnv = !rawSupabaseUrl || !rawSupabaseAnonKey;
const supabaseUrl = rawSupabaseUrl || 'https://placeholder.supabase.co';
const supabaseAnonKey = rawSupabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder';

if (isPlaceholderEnv) {
  console.warn('[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — using mock client for preview. Set .env to enable real backend.');
}

// Avoid multiple clients in Vite HMR
declare global {
  // eslint-disable-next-line no-var
  var __supabase__: SupabaseClient | undefined;
}

// --- Demo data for preview (when no real Supabase) ---
const demoAcademicYears = [
  { id: 'ay-2026', name: '2026/2027', startDate: '2026-05-30', endDate: '2027-05-31', isCurrent: true, createdAt: '2026-06-01' },
  { id: 'ay-2025', name: '2025/2026', startDate: '2025-06-01', endDate: '2026-05-31', isCurrent: false, createdAt: '2025-06-01' },
];

const demoTerms = [
  {
    id: 'term-1',
    name: 'Term 1',
    academicYearId: 'ay-2026',
    startDate: '2026-06-01',
    endDate: '2026-10-31',
    isCurrent: true,
    months: ['June', 'July', 'August', 'September', 'October'],
    createdAt: '2026-06-01',
    academic_years: { id: 'ay-2026', name: '2026/2027', isCurrent: true },
  },
  {
    id: 'term-2',
    name: 'Term 2',
    academicYearId: 'ay-2026',
    startDate: '2026-11-01',
    endDate: '2027-02-28',
    isCurrent: false,
    months: ['November', 'December', 'January', 'February'],
    createdAt: '2026-06-01',
  },
];

const demoStudents = [
  { id: 'stu-barwaaqo', name: 'Barwaaqo Maxamed Heeban', className: 'Grade 2-C', parentId: 'parent-1', createdAt: '2026-06-01', govId: 'MBK-2C-001', transport: 'Bus 3', parentPhone: '252634506719', familyId: '0001' },
  { id: 'stu-ahmed', name: 'Ahmed Ali Yusuf', className: 'Grade 2-C', parentId: 'parent-2', createdAt: '2026-06-01', govId: 'MBK-2C-002', transport: 'WALKER', parentPhone: null, familyId: '0002' },
  { id: 'stu-aisha', name: 'Aisha Hassan', className: 'Grade 2-C', parentId: null, createdAt: '2026-06-01', govId: 'MBK-2C-003', transport: 'CAR', parentPhone: null, familyId: null },
  { id: 'stu-mohamed', name: 'Mohamed Farah', className: 'Grade 2-C', parentId: 'parent-3', createdAt: '2026-06-01', govId: 'MBK-2C-004', transport: 'Bus 1', parentPhone: '252634500000', familyId: '0003' },
  { id: 'stu-sara', name: 'Sara Abdullahi', className: 'Grade 1-A', parentId: 'parent-1', createdAt: '2026-06-01', govId: 'MBK-1A-001', transport: 'Bus 2', parentPhone: '252634506719', familyId: '0004' },
  { id: 'stu-hassan', name: 'Hassan Jaamac', className: 'Grade 2-C', parentId: 'parent-no-email', createdAt: '2026-06-01', govId: 'MBK-2C-005', transport: 'Bus 2', parentPhone: '252634599999', familyId: '0005' },
  // ── Duplicate Students demo groups ──────────────────────────────────────
  // Axmed yaasiin ismaaciil — HIGH CONFIDENCE (parent assigned vs unassigned, same class, one Gov ID)
  { id: 'stu-axmed-a', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: 'parent-1', createdAt: '2026-03-15T08:00:00Z', govId: '123456', transport: 'WALKER', parentPhone: '252634506719', familyId: '0010' },
  { id: 'stu-axmed-b', name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: null, createdAt: '2026-09-10T08:00:00Z', govId: null, transport: 'WALKER', parentPhone: null, familyId: null },
  // Abshir Cabdi Maxamed — HIGH RISK exam conflicts (canonical 56, duplicate 55 matching)
  { id: 'stu-abshir-a', name: 'Abshir Cabdi Maxamed', className: 'Grade 2-C', parentId: 'parent-2', createdAt: '2026-02-01T08:00:00Z', govId: 'MBK-2C-010', transport: 'Bus 1', parentPhone: '252634511111', familyId: '0011' },
  { id: 'stu-abshir-b', name: 'Abshir Cabdi Maxamed', className: 'Grade 2-C', parentId: null, createdAt: '2026-08-20T08:00:00Z', govId: null, transport: 'Bus 1', parentPhone: null, familyId: null },
  // Ahmed Mohamed — CRITICAL conflicting Gov IDs
  { id: 'stu-ahmed-conf-a', name: 'Ahmed Mohamed', className: 'Grade 5-A', parentId: 'parent-1', createdAt: '2026-01-10T08:00:00Z', govId: '111', transport: 'Bus 2', parentPhone: '252634506719', familyId: '0012' },
  { id: 'stu-ahmed-conf-b', name: 'Ahmed Mohamed', className: 'Grade 5-A', parentId: 'parent-2', createdAt: '2026-01-12T08:00:00Z', govId: '222', transport: 'Bus 2', parentPhone: '252634511111', familyId: '0013' },
  // Leyla Hassan — SAME Gov ID strong match
  { id: 'stu-samegov-a', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: 'parent-3', createdAt: '2026-02-15T08:00:00Z', govId: '999888', transport: 'CAR', parentPhone: '252634500000', familyId: '0014' },
  { id: 'stu-samegov-b', name: 'Leyla Hassan', className: 'Grade 3-B', parentId: null, createdAt: '2026-05-20T08:00:00Z', govId: '999888', transport: 'CAR', parentPhone: null, familyId: null },
];

// ── Former Students / Student Cleanup demo data ─────────────────────────────
// The real database carries students.status ('active' | 'former') after
// migration 20261008_former_students_cleanup.sql. The preview client mirrors
// that: every demo student gets a status, and two are pre-marked as former so
// the Former Students directory, the restore action and the active-only
// rosters all have something to show without a backend.
const demoFormerStudents: any[] = [
  { id: 'student-former-1', name: 'Ayaan Cabdi Nuur', className: 'Grade 4-B', parentId: 'parent-2', createdAt: '2026-01-12T08:00:00Z', govId: 'MBK-4B-021', transport: 'LEFT', parentPhone: '252634511111', familyId: '0021', status: 'former', statusUpdatedAt: '2026-09-28T09:12:00Z', statusUpdatedBy: 'preview-admin' },
  { id: 'student-former-2', name: 'Hodan Maxamuud Faarax', className: 'Grade 2-C', parentId: null, createdAt: '2026-02-02T08:00:00Z', govId: null, transport: 'LEFT', parentPhone: null, familyId: null, status: 'former', statusUpdatedAt: '2026-09-28T09:14:00Z', statusUpdatedBy: 'preview-admin' },
];
(demoStudents as any[]).push(...demoFormerStudents);
for (const student of demoStudents as any[]) {
  if (!('status' in student)) {
    student.status = 'active';
    student.statusUpdatedAt = null;
    student.statusUpdatedBy = null;
  }
}

const demoProfiles: any[] = [
  { id: 'preview-admin', name: 'Preview Admin', email: 'admin@mbk.edu', role: 'admin', phone1: null, phone2: null, assignedClasses: ['Grade 1-A','Grade 2-C'], assignedSubjects: [], createdAt: '2026-06-01', auth_id: 'auth-preview-admin' },
  { id: 'parent-1', name: 'Maxamed Heeban', email: 'parent1@example.com', role: 'parent', phone1: '252634506719', phone2: '252634506720', xafada: 'Jigjiga Yar', createdAt: '2026-06-01', auth_id: 'auth-parent-1' },
  { id: 'parent-2', name: 'Ali Yusuf', email: 'parent2@example.com', role: 'parent', phone1: '252634511111', phone2: null, createdAt: '2026-06-01', auth_id: 'auth-parent-2' },
  { id: 'parent-3', name: 'Farah Mohamed', email: 'parent3@example.com', role: 'parent', phone1: '252634500000', phone2: null, createdAt: '2026-06-01', auth_id: 'auth-parent-3' },
  { id: 'parent-no-email', name: 'Sahra Jaamac', email: '', role: 'parent', phone1: '252634599999', phone2: null, createdAt: '2026-06-01', auth_id: 'auth-parent-no-email' },
  { id: 'teacher-1', name: 'Ms. Fatima', email: 'fatima@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 2-C'], assignedSubjects: ['English','Mathematics'], createdAt: '2026-06-01', auth_id: 'auth-teacher-1' },
  { id: 'teacher-2', name: 'Mr. Omar', email: 'omar@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 1-A'], assignedSubjects: ['Mathematics'], createdAt: '2026-06-01', auth_id: 'auth-teacher-2' },
  { id: 'teacher-3', name: 'Ms. Hodan', email: 'hodan@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 3-B'], assignedSubjects: ['Science'], createdAt: '2026-06-01', auth_id: 'auth-teacher-3' },
  // Submission-tracking demo: assigned to a class but (see demoLessonPlans)
  // never submits the current week — the "Not Submitted" case.
  { id: 'teacher-4', name: 'Mr. Abdirahman', email: 'abdirahman@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 4-A'], assignedSubjects: ['Social Studies'], createdAt: '2026-06-01', auth_id: 'auth-teacher-4' },
  { id: 'supervisor-1', name: 'Mr. Bashir (Supervisor)', email: 'supervisor@mbk.edu', role: 'supervisor', phone1: null, phone2: null, assignedClasses: [], assignedSubjects: [], createdAt: '2026-06-01', auth_id: 'auth-supervisor-1' },
];

/**
 * Preview-only: resolve a demo email to its demo profile so the sign-in form
 * can preview any role (e.g. parent1@example.com → the parent app). Returns
 * null in production (real Supabase handles sign-in) and for unknown emails,
 * where the caller falls back to the demo admin — the long-standing preview
 * behaviour. Mirrors the mock client's signInWithPassword lookup below.
 */
export function resolvePreviewProfile(email: string): { id: string; name: string; email: string; role: Role; authId: string } | null {
  if (!isPlaceholderEnv) return null;
  const wanted = String(email || '').trim().toLowerCase();
  const profile = demoProfiles.find((p: any) => String(p.email || '').toLowerCase() === wanted);
  if (!profile) return null;
  return { id: profile.id, name: profile.name, email: profile.email, role: profile.role as Role, authId: profile.auth_id };
}

// --- Demo subjects + class_subjects (Lesson Planner / Unit Plans preview) ---
const demoSubjects: any[] = [
  { id: 'sub-english', name: 'English', shortName: 'Eng', createdAt: '2026-06-01' },
  { id: 'sub-math', name: 'Mathematics', shortName: 'Math', createdAt: '2026-06-01' },
  { id: 'sub-science', name: 'Science', shortName: 'Sci', createdAt: '2026-06-01' },
  { id: 'sub-social', name: 'Social Studies', shortName: 'Soc', createdAt: '2026-06-01' },
  { id: 'sub-somali', name: 'Somali', shortName: 'Som', createdAt: '2026-06-01' },
  { id: 'sub-arabic', name: 'Arabic', shortName: 'Ara', createdAt: '2026-06-01' },
  { id: 'sub-tarabiya', name: 'Tarabiya', shortName: 'Tar', createdAt: '2026-06-01' },
];

const demoClassSubjects: any[] = [
  { id: 'cs-1a-eng', subjectId: 'sub-english', teacherId: 'teacher-1', className: 'Grade 1-A', createdAt: '2026-06-01', subjects: demoSubjects[0] },
  { id: 'cs-1a-mat', subjectId: 'sub-math', teacherId: 'teacher-2', className: 'Grade 1-A', createdAt: '2026-06-01', subjects: demoSubjects[1] },
  { id: 'cs-1a-sci', subjectId: 'sub-science', teacherId: 'teacher-1', className: 'Grade 1-A', createdAt: '2026-06-01', subjects: demoSubjects[2] },
  { id: 'cs-1a-som', subjectId: 'sub-somali', teacherId: 'teacher-2', className: 'Grade 1-A', createdAt: '2026-06-01', subjects: demoSubjects[4] },
  { id: 'cs-1a-ara', subjectId: 'sub-arabic', teacherId: 'teacher-1', className: 'Grade 1-A', createdAt: '2026-06-01', subjects: demoSubjects[5] },
  { id: 'cs-2c-eng', subjectId: 'sub-english', teacherId: 'teacher-1', className: 'Grade 2-C', createdAt: '2026-06-01', subjects: demoSubjects[0] },
  { id: 'cs-2c-mat', subjectId: 'sub-math', teacherId: 'teacher-1', className: 'Grade 2-C', createdAt: '2026-06-01', subjects: demoSubjects[1] },
  { id: 'cs-2c-sci', subjectId: 'sub-science', teacherId: 'teacher-3', className: 'Grade 2-C', createdAt: '2026-06-01', subjects: demoSubjects[2] },
  { id: 'cs-2c-soc', subjectId: 'sub-social', teacherId: 'teacher-1', className: 'Grade 2-C', createdAt: '2026-06-01', subjects: demoSubjects[3] },
  { id: 'cs-2c-tar', subjectId: 'sub-tarabiya', teacherId: 'teacher-1', className: 'Grade 2-C', createdAt: '2026-06-01', subjects: demoSubjects[6] },
];

// --- Demo authorized-pickup (driver) data for the Manage Drivers preview ---
type DemoDriverStudent = {
  id: string;
  name: string;
  className: string;
  familyId: string | null;
  transport?: string | null;
};
type DemoDriver = {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  photoPath: string | null;
  addedAt: string;
  students: DemoDriverStudent[];
};

function avatarDataUrl(initials: string, bg: string, fg = '#ffffff'): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><rect width='160' height='160' fill='${bg}'/><text x='80' y='104' font-family='Arial, sans-serif' font-size='64' font-weight='700' fill='${fg}' text-anchor='middle'>${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

const demoDriversSeed: DemoDriver[] = [
  {
    id: 'pickup-demo-1',
    name: 'Xasan Cali',
    phoneNumber: '+252 61 2345678',
    relationship: 'Adeer',
    photoPath: 'pickup-demo-1.jpg',
    addedAt: '2026-09-01T08:00:00Z',
    students: [
      { id: 'stu-barwaaqo', name: 'Barwaaqo Maxamed Heeban', className: 'Grade 2-C', familyId: '0001', transport: 'Bus 3' },
      { id: 'stu-sara', name: 'Sara Abdullahi', className: 'Grade 1-A', familyId: '0004', transport: 'Bus 2' },
    ],
  },
  {
    id: 'pickup-demo-2',
    name: 'Cali Yusuf',
    phoneNumber: '0619999999',
    relationship: null,
    photoPath: null,
    addedAt: '2026-09-02T08:00:00Z',
    students: [
      { id: 'stu-ahmed', name: 'Ahmed Ali Yusuf', className: 'Grade 2-C', familyId: '0002', transport: 'WALKER' },
    ],
  },
];

// Mutable preview state (persists for the page session).
const pickupDrivers: DemoDriver[] = demoDriversSeed.map(d => ({ ...d, students: d.students.map(s => ({ ...s })) }));

// path -> data URL for the private-bucket photos in preview.
const pickupPhotoStore = new Map<string, string>([
  ['pickup-demo-1.jpg', avatarDataUrl('XC', '#065f46')],
]);

function demoMonthlyRowsFor(studentId: string, termId: string): any[] {
  if (studentId !== 'stu-barwaaqo') {
    // For other students, return smaller set or empty to test empty state
    if (studentId === 'stu-ahmed') {
      return [
        {
          subject: 'English', month: 'August', average: 88.2, assessment_count: 8, details: [], ca_avg: 85, quiz_avg: 90.33, ca_weight: 40, quiz_weight: 60, ca_weighted: 34, quiz_weighted: 54.2, grade: 'B', remark: 'Very Good', ca_count: 5, quiz_count: 3,
          ca_details: [
            { type: 'ATTENDANCE', examType: 'Attendance', score: 18, total: 20, percentage: 90, date: '2026-08-01', examId: 'e1' },
            { type: 'CPW1', examType: 'Classwork', score: 12, total: 15, percentage: 80, date: '2026-08-02', examId: 'e2' },
            { type: 'HW1', examType: 'Homework', score: 4, total: 5, percentage: 80, date: '2026-08-03', examId: 'e3' },
          ],
          quiz_details: [
            { type: 'MT', examType: 'Quiz', score: 18, total: 20, percentage: 90, date: '2026-08-10', examId: 'e4' },
            { type: 'Quiz', examType: 'Quiz', score: 17, total: 20, percentage: 85, date: '2026-08-15', examId: 'e5' },
          ],
        },
      ];
    }
    return [];
  }
  // Barwaaqo — 5 subjects, matching spec example (English 96.56% 10 assessments etc)
  const englishDetails = {
    ca_details: [
      { type: 'ATTENDANCE', examType: 'Attendance', score: 20, total: 20, percentage: 100, date: '2026-08-01', examId: 'e-att' },
      { type: 'CPW1', examType: 'Classwork', score: 15, total: 15, percentage: 100, date: '2026-08-02', examId: 'e-cpw1' },
      { type: 'CPW2', examType: 'Classwork', score: 15, total: 15, percentage: 100, date: '2026-08-03', examId: 'e-cpw2' },
      { type: 'CPW3', examType: 'Classwork', score: 15, total: 15, percentage: 100, date: '2026-08-04', examId: 'e-cpw3' },
      { type: 'CPW4', examType: 'Classwork', score: 15, total: 15, percentage: 100, date: '2026-08-05', examId: 'e-cpw4' },
      { type: 'HW1', examType: 'Homework', score: 5, total: 5, percentage: 100, date: '2026-08-06', examId: 'e-hw1' },
      { type: 'HW2', examType: 'Homework', score: 4.5, total: 5, percentage: 90, date: '2026-08-07', examId: 'e-hw2' },
      { type: 'HW3', examType: 'Homework', score: 5, total: 5, percentage: 100, date: '2026-08-08', examId: 'e-hw3' },
      { type: 'HW4', examType: 'Homework', score: 5, total: 5, percentage: 100, date: '2026-08-09', examId: 'e-hw4' },
    ],
    quiz_details: [
      { type: 'MT', examType: 'Quiz', score: 19, total: 20, percentage: 95, date: '2026-08-15', examId: 'e-mt' },
    ],
  };
  const baseCA = englishDetails.ca_details;
  const baseQuiz = englishDetails.quiz_details;
  return [
    {
      subject: 'English', month: 'August', average: 96.56, assessment_count: 10,
      details: [...baseCA, ...baseQuiz],
      ca_avg: 98.89, quiz_avg: 95, ca_weight: 40, quiz_weight: 60, ca_weighted: 39.56, quiz_weighted: 57, grade: 'A', remark: 'Excellent', ca_count: 9, quiz_count: 1,
      ca_details: baseCA, quiz_details: baseQuiz,
    },
    {
      subject: 'Mathematics', month: 'August', average: 100, assessment_count: 10,
      details: [...baseCA.map(d => ({ ...d, percentage: 100, score: d.total })), { type: 'MT', examType: 'Quiz', score: 20, total: 20, percentage: 100, date: '2026-08-15', examId: 'e-mt-math' }],
      ca_avg: 100, quiz_avg: 100, ca_weight: 40, quiz_weight: 60, ca_weighted: 40, quiz_weighted: 60, grade: 'A', remark: 'Excellent', ca_count: 9, quiz_count: 1,
      ca_details: baseCA.map(d => ({ ...d, percentage: 100, score: d.total })), quiz_details: [{ type: 'MT', examType: 'Quiz', score: 20, total: 20, percentage: 100, date: '2026-08-15', examId: 'e-mt-math' }],
    },
    {
      subject: 'Science', month: 'August', average: 99.11, assessment_count: 10,
      details: [...baseCA, ...baseQuiz],
      ca_avg: 98.5, quiz_avg: 99.52, ca_weight: 40, quiz_weight: 60, ca_weighted: 39.4, quiz_weighted: 59.71, grade: 'A', remark: 'Excellent', ca_count: 9, quiz_count: 1,
      ca_details: baseCA, quiz_details: [{ type: 'MT', examType: 'Quiz', score: 19.5, total: 20, percentage: 97.5, date: '2026-08-15', examId: 'e-mt-sci' }],
    },
    {
      subject: 'Social Studies', month: 'August', average: 100, assessment_count: 8,
      details: baseCA.slice(0, 7).concat(baseQuiz),
      ca_avg: 100, quiz_avg: 100, ca_weight: 40, quiz_weight: 60, ca_weighted: 40, quiz_weighted: 60, grade: 'A', remark: 'Excellent', ca_count: 7, quiz_count: 1,
      ca_details: baseCA.slice(0, 7).map(d => ({ ...d, percentage: 100, score: d.total })), quiz_details: [{ type: 'MT', examType: 'Quiz', score: 20, total: 20, percentage: 100, date: '2026-08-15', examId: 'e-mt-social' }],
    },
    {
      subject: 'Somali', month: 'August', average: 97, assessment_count: 10,
      details: [...baseCA, ...baseQuiz],
      ca_avg: 97, quiz_avg: 97, ca_weight: 40, quiz_weight: 60, ca_weighted: 38.8, quiz_weighted: 58.2, grade: 'A', remark: 'Excellent', ca_count: 9, quiz_count: 1,
      ca_details: baseCA.map(d => ({ ...d, percentage: Math.round((d.score / d.total) * 100) })), quiz_details: [{ type: 'MT', examType: 'Quiz', score: 19.4, total: 20, percentage: 97, date: '2026-08-15', examId: 'e-mt-som' }],
    },
  ];
}

// Demo lesson plans for the supervisor's weekly Lesson Plan Review preview.
// `week_label` is what the app really stores (and what the week selector groups
// by); `title` is free text the teacher types, so the preview deliberately mixes
// spellings ("week 7", "Week7", "Week 05", "week6") to show that the week
// dropdown follows the stored week, not the title.
const demoLessonPlanTeachers = [
  { id: 'teacher-1', name: 'Ms. Fatima' },
  { id: 'teacher-2', name: 'Mr. Omar' },
  { id: 'teacher-3', name: 'Ms. Hodan' },
];

/**
 * Preview-only: the school's real timetable shape, by grade group.
 *
 *   KG / Foundation -> 4 periods a day (3 planned + 1 free)
 *   Grades 1-6      -> 5 periods a day (4 planned + 1 free)
 *   Grades 7-12     -> 6 periods a day (5 planned + 1 free, or 6 planned + 0 free)
 *
 * Production takes the count from the teacher's own "periods per day" choice
 * on the plan, so this mapping only decides what the mock seed generates.
 */
function demoPeriodCountForClass(className: string): number {
  if (/kg|foundation|prep/i.test(className)) return 4;
  const grade = Number((String(className).match(/\d+/) ?? [])[0]);
  if (Number.isFinite(grade) && grade >= 7 && grade <= 12) return 6;
  return 5;
}

/** Which slot each day is officially Free, keyed by periods-per-day. */
const DEMO_FREE_SLOT: Record<number, Record<string, number | null>> = {
  4: { Saturday: 4, Sunday: 4, Monday: 4, Tuesday: 4, Wednesday: 4 },
  5: { Saturday: 4, Sunday: 3, Monday: 4, Tuesday: 4, Wednesday: null },
  6: { Saturday: 6, Sunday: 4, Monday: null, Tuesday: 5, Wednesday: null },
};

const demoLessonPlans: any[] = (() => {
  const classes = ['Grade 1-A', 'Grade 2-C', 'Grade 3-B', 'Foundation-KG', 'Grade 7-A', 'Grade 10-B'];
  // Oldest week first. 2026-W04..W07 mirror the real submissions the supervisor
  // complained about; 2026-W15 is "this week" for the demo academic year.
  const weeks: Array<{ label: string; titles: string[]; statuses: string[] }> = [
    {
      label: '2026-W04',
      titles: ['Week 2026-W04', 'Week 2026-W04', 'Week 2026-W04', 'Week 2026-W04', 'Week 2026-W04'],
      statuses: ['approved', 'approved', 'approved', 'in_review', 'rejected'],
    },
    {
      label: '2026-W05',
      titles: ['Week 05', 'week 5', 'Week 05', 'week 5'],
      statuses: ['approved', 'in_review', 'in_review', 'approved'],
    },
    {
      label: '2026-W06',
      titles: ['week6', 'week6', 'week6', 'week6', 'week6', 'week6'],
      statuses: ['rejected', 'rejected', 'in_review', 'approved', 'in_review', 'rejected'],
    },
    {
      label: '2026-W07',
      titles: ['week 7', 'Week7', 'week 7', 'Week7', 'week 7', 'Week7', 'week 7', 'Week7'],
      statuses: ['in_review', 'in_review', 'approved', 'approved', 'rejected', 'submitted', 'in_review', 'approved'],
    },
    {
      // One plan per class, so the current week exercises every grade group
      // (KG 4/day, Grades 1-6 5/day, Grades 7-12 6/day). Indices 0-2 keep their
      // class, teacher and status — only the extra 3 plans are new.
      label: '2026-W15',
      titles: ['Week 2026-W15', 'Week 2026-W15', 'Week 2026-W15', 'Week 2026-W15', 'Week 2026-W15', 'Week 2026-W15'],
      statuses: ['submitted', 'in_review', 'submitted', 'in_review', 'submitted', 'in_review'],
    },
    // Isolated preview seed for Parent → This Week’s Learning. The current
    // academic-year week on 15 Sep 2026 is W16. Approved rows are visible to
    // the parent-safe mock RPC; the draft row proves unpublished work is hidden.
    {
      label: '2026-W16',
      titles: ['English Reading', 'Mathematics Fractions', 'Private Draft', 'Science Habitats', 'Somali Writing', 'Arabic Vocabulary'],
      statuses: ['approved', 'approved', 'draft', 'approved', 'approved', 'approved'],
    },
  ];

  const rows: any[] = [];
  weeks.forEach(({ label, titles, statuses }) => {
    statuses.forEach((status, index) => {
      const teacher = demoLessonPlanTeachers[index % demoLessonPlanTeachers.length];
      const className = classes[index % classes.length];
      const stamp = `2026-09-${String(1 + index).padStart(2, '0')}T08:00:00.000Z`;
      rows.push({
        id: `plan-${label}-${index + 1}`,
        teacher_id: teacher.id,
        subject_id: null,
        class_name: className,
        week_label: label,
        title: `${titles[index]} - ${className}`,
        status,
        period_count: demoPeriodCountForClass(className),
        previous_score: null,
        previous_reviewed_at: null,
        created_at: stamp,
        updated_at: stamp,
        ai_started_at: status === 'submitted' ? stamp : null,
        ai_failure_reason: null,
        revision_requested_at: null,
        // The real query embeds profiles through the teacher FK.
        profiles: { name: teacher.name },
      });
    });
  });
  return rows;
})();

const demoLessonPlanPeriods: any[] = demoLessonPlans.flatMap((plan: any) => {
  const previewSubject = plan.title.split(' ')[0] || 'Learning';
  const parentSeed = plan.week_label === '2026-W16';
  const topicBySubject: Record<string, string> = {
    English: 'Reading for Meaning', Mathematics: 'Equivalent Fractions',
    Somali: 'Writing Clear Sentences', Arabic: 'Everyday Vocabulary',
    Science: 'Living Things and Habitats', Private: 'Unpublished Topic',
  };
  const objectiveBySubject: Record<string, string> = {
    English: 'Identify the main idea and two supporting details.',
    Mathematics: 'Compare equivalent fractions using visual models.',
    Somali: 'Write complete sentences using correct punctuation.',
    Arabic: 'Use new everyday words in short spoken sentences.',
    Science: 'Describe how a habitat meets the needs of living things.',
    Private: 'This draft must never appear in the parent view.',
  };
  // A real timetable runs `period_count` periods a day and some of those slots
  // are officially Free (see seed-lesson-plans.mjs). The preview mirrors that
  // shape so the day summary reports the same numbers production would.
  const freeSlot = DEMO_FREE_SLOT[plan.period_count] ?? DEMO_FREE_SLOT[5];
  return ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'].flatMap((day, dayIndex) =>
    Array.from({ length: plan.period_count }, (_, p) => {
      const periodNumber = p + 1;
      const isFree = freeSlot[day] === periodNumber;
      // One genuinely unfinished period in the current week, left blank on
      // the LAST REQUIRED slot of Wednesday so every grade group shows a
      // partial day and the summary is clearly not pinned to 100%.
      const freeOnDay = freeSlot[day] ?? null;
      const lastRequired = freeOnDay === plan.period_count ? plan.period_count - 1 : plan.period_count;
      const isUnfilled = plan.week_label === '2026-W15' && day === 'Wednesday' && periodNumber === lastRequired;
      const hasPlan = !isFree && !isUnfilled;
      return {
        id: `period-${plan.id}-${day}-${periodNumber}`,
        plan_id: plan.id,
        day,
        period_number: periodNumber,
        class_name: plan.class_name,
        subject: hasPlan ? (parentSeed ? previewSubject : 'Mathematics') : null,
        is_free: isFree,
        topic: hasPlan
          ? (parentSeed ? topicBySubject[previewSubject] || `${previewSubject} Learning` : `${plan.week_label} — ${day} P${periodNumber}`)
          : '',
        objective: hasPlan
          ? (parentSeed ? objectiveBySubject[previewSubject] || 'Build confidence with this week’s topic.' : 'Students explain the concept in their own words.')
          : null,
        activities: hasPlan
          ? (parentSeed ? 'Read examples together, discuss key ideas, and complete guided practice.' : '1. Warm-up (10min) [] @Board | 2. Guided practice (25min) [] @Desks')
          : '',
        slide_number: null,
        details: hasPlan
          ? (parentSeed ? [
            { activity: 'Review examples together', time: '10min', resource: 'Student book', place: '' },
            { activity: 'Discuss key ideas and complete guided practice', time: '25min', resource: 'Practice sheet', place: 'https://example.com/mbk-practice' },
          ] : [
            { activity: 'Warm-up', time: '10min', resource: 'Board', place: 'Desks' },
            { activity: 'Guided practice', time: '25min', resource: 'Workbook', place: 'Desks' },
          ])
          : [],
        sort_order: dayIndex * plan.period_count + p,
        created_at: plan.created_at,
        updated_at: plan.created_at,
      };
    }),
  );
});

// Demo approved exam results for the parent preview (parent-1's children).
// Matches the Exam row shape; keeps the parent Home "New result" card and the
// Exam Results screens alive in preview mode.
const demoParentExams = [
  { id: 'pex-1', studentId: 'stu-barwaaqo', subject: 'Mathematics', score: 18, total: 20, examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', status: 'approved', parentId: 'parent-1', date: '2026-09-12', createdAt: '2026-09-12T08:00:00Z', teacherId: 'teacher-1', uploadedBy: null },
  { id: 'pex-2', studentId: 'stu-barwaaqo', subject: 'English', score: 17, total: 20, examType: 'Classwork', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', status: 'approved', parentId: 'parent-1', date: '2026-09-08', createdAt: '2026-09-08T08:00:00Z', teacherId: 'teacher-1', uploadedBy: null },
  { id: 'pex-3', studentId: 'stu-sara', subject: 'Mathematics', score: 15, total: 20, examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', status: 'approved', parentId: 'parent-1', date: '2026-09-10', createdAt: '2026-09-10T08:00:00Z', teacherId: 'teacher-2', uploadedBy: null },
  { id: 'pex-4', studentId: 'stu-sara', subject: 'English', score: 14, total: 20, examType: 'CA', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'August', status: 'approved', parentId: 'parent-1', date: '2026-08-20', createdAt: '2026-08-20T08:00:00Z', teacherId: 'teacher-2', uploadedBy: null },
];

// Preview-only marks used by the Monitor Marks Entries page when the app is
// running without VITE_SUPABASE_* credentials. Production uses the secured
// monitor_marks_entries RPC and never reads this data.
const demoMarksMonitorExams = [
  { id: 'monitor-1', studentId: 'stu-sara', subjectId: 'sub-english', subject: 'English', examType: 'CA', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-08T08:00:00Z' },
  { id: 'monitor-2', studentId: 'stu-sara', subjectId: 'sub-english', subject: 'English', examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-09T08:00:00Z' },
  { id: 'monitor-3', studentId: 'stu-sara', subjectId: 'sub-math', subject: 'Mathematics', examType: 'Final', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: null, teacherId: 'teacher-2', createdAt: '2026-09-15T08:00:00Z' },
  { id: 'monitor-4', studentId: 'stu-barwaaqo', subjectId: 'sub-english', subject: 'English', examType: 'CA', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-03T08:00:00Z' },
  { id: 'monitor-5', studentId: 'stu-barwaaqo', subjectId: 'sub-english', subject: 'English', examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-04T08:00:00Z' },
  { id: 'monitor-6', studentId: 'stu-ahmed', subjectId: 'sub-english', subject: 'English', examType: 'Homework', assessmentLabel: 'HW1', entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-05T08:00:00Z' },
  { id: 'monitor-7', studentId: 'stu-ahmed', subjectId: 'sub-english', subject: 'English', examType: 'Classwork', assessmentLabel: 'CPW1', entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-06T08:00:00Z' },
  { id: 'monitor-8', studentId: 'stu-ahmed', subjectId: 'sub-english', subject: 'English', examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-07T08:00:00Z' },
  { id: 'monitor-9', studentId: 'stu-aisha', subjectId: 'sub-english', subject: 'English', examType: 'Classwork', assessmentLabel: 'CPW1', entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-10T08:00:00Z' },
  { id: 'monitor-10', studentId: 'stu-hassan', subjectId: 'sub-english', subject: 'English', examType: 'Quiz', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: 'September', teacherId: 'teacher-1', createdAt: '2026-09-11T08:00:00Z' },
  { id: 'monitor-11', studentId: 'stu-barwaaqo', subjectId: 'sub-math', subject: 'Mathematics', examType: 'Midterm', assessmentLabel: null, entryState: 'scored', termId: 'term-1', month: null, teacherId: 'teacher-1', createdAt: '2026-09-12T08:00:00Z' },
  { id: 'monitor-12', studentId: 'stu-ahmed', subjectId: 'sub-math', subject: 'Mathematics', examType: 'Quiz', assessmentLabel: 'MT', entryState: 'scored', termId: 'term-1', month: null, teacherId: 'teacher-1', createdAt: '2026-09-13T08:00:00Z' },
];

// Demo school announcements for the parent Home "School Messages" card.
// Rows mirror what a joined announcement_recipients select returns.
const demoParentAnnouncementRecipients = [
  {
    id: 'precip-1',
    parentId: 'parent-1',
    announcements: {
      id: 'ann-1',
      className: 'Grade 2-C',
      message: 'Reminder: Midterm exams start next Sunday. Please make sure your child revises the review sheets.',
      createdBy: 'preview-admin',
      createdAt: '2026-09-10T07:00:00Z',
    },
  },
  {
    id: 'precip-2',
    parentId: 'parent-1',
    announcements: {
      id: 'ann-2',
      className: 'All classes',
      message: 'School closes at 12:00 on Thursday for staff training. Pickup starts at 11:30.',
      createdBy: 'preview-admin',
      createdAt: '2026-09-05T07:00:00Z',
    },
  },
];

const demoParentHomework = [{
  id: 'homework-parent-preview-1',
  studentId: 'stu-barwaaqo',
  className: 'Grade 2-C',
  subject: 'Mathematics',
  title: 'Fraction practice',
  description: 'Complete questions 1–6 on the fraction practice sheet.',
  dueDate: '2026-09-16',
  status: 'assigned',
  teacherId: 'teacher-2',
  createdAt: '2026-09-14T09:00:00.000Z',
  lesson_plan_period_id: 'period-plan-2026-W16-2-Tuesday-1',
}];

function demoMarksMonitorRows(params: any): any[] {
  const scope = String(params?.p_exam_scope ?? 'monthly').trim().toLowerCase();
  const selectedMonth = String(params?.p_month ?? '').trim() || null;
  const selectedTeacher = String(params?.p_teacher_id ?? '').trim();
  const selectedClass = String(params?.p_class_name ?? '').trim();
  const selectedSubject = String(params?.p_subject_id ?? '').trim();

  // Mirrors 20260919b_marks_monitor_quiz_component.sql and
  // 20260919c_marks_monitor_homework_ca_tile.sql: every Quiz row is the
  // monthly Quiz component (including bulk-uploaded MT), Midterm still sees
  // Midterm rows plus Quiz/MT rows, and the Homework (CA) count folds legacy
  // CA records in (homework_ca_entered below).
  const inScope = (exam: any) => {
    if (scope === 'monthly') return ['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance'].includes(exam.examType);
    if (scope === 'midterm') return exam.examType === 'Midterm'
      || (exam.examType === 'Quiz' && String(exam.assessmentLabel ?? '').trim().toUpperCase() === 'MT');
    if (scope === 'final') return exam.examType === 'Final';
    if (scope === 'ca') return exam.examType === 'CA';
    if (scope === 'homework') return exam.examType === 'Homework';
    if (scope === 'classwork') return exam.examType === 'Classwork';
    if (scope === 'quiz') return exam.examType === 'Quiz';
    if (scope === 'attendance') return exam.examType === 'Attendance';
    if (scope === 'discipline') return exam.examType === 'Discipline';
    return false;
  };

  return demoClassSubjects
    .filter((assignment: any) => String(assignment.teacherId || '').trim())
    .filter((assignment: any) => !selectedTeacher || assignment.teacherId === selectedTeacher)
    .filter((assignment: any) => !selectedClass || assignment.className === selectedClass)
    .filter((assignment: any) => !selectedSubject || assignment.subjectId === selectedSubject)
    .map((assignment: any) => {
      const subjectName = assignment.subjects?.name ?? assignment.subjectId;
      const expectedStudents = demoStudents.filter((student: any) =>
        student.className === assignment.className && String(student.transport ?? '').toUpperCase() !== 'LEFT'
      );
      const exams = demoMarksMonitorExams.filter((exam: any) =>
        exam.studentId
        && expectedStudents.some((student: any) => student.id === exam.studentId)
        && exam.teacherId === assignment.teacherId
        && (exam.subjectId === assignment.subjectId || exam.subject === subjectName || exam.subject === assignment.subjectId)
        && exam.termId === (params?.p_term_id ?? 'term-1')
        && (!selectedMonth || exam.month === selectedMonth)
        && inScope(exam)
      );
      const flags = new Map<string, { ca: boolean; homework: boolean; classwork: boolean; quiz: boolean; attendance: boolean; any: boolean; lastUpdated: string | null }>();
      for (const student of expectedStudents) {
        const studentExams = exams.filter((exam: any) => exam.studentId === student.id);
        flags.set(student.id, {
          ca: studentExams.some((exam: any) => exam.examType === 'CA'),
          homework: studentExams.some((exam: any) => exam.examType === 'Homework'),
          classwork: studentExams.some((exam: any) => exam.examType === 'Classwork'),
          quiz: studentExams.some((exam: any) => exam.examType === 'Quiz'),
          attendance: studentExams.some((exam: any) => exam.examType === 'Attendance'),
          any: studentExams.length > 0,
          lastUpdated: studentExams.reduce((latest: string | null, exam: any) => !latest || exam.createdAt > latest ? exam.createdAt : latest, null),
        });
      }
      const expected = expectedStudents.length;
      const count = (key: 'ca' | 'homework' | 'classwork' | 'quiz' | 'attendance') => expectedStudents.filter((student: any) => flags.get(student.id)?.[key]).length;
      const caEntered = count('ca');
      const homeworkEntered = count('homework');
      // Mirrors 20260919c: Homework (CA) component coverage — students with a
      // Homework record or a legacy CA record, once per student.
      const homeworkCaEntered = expectedStudents.filter((student: any) => {
        const flag = flags.get(student.id);
        return !!flag && (flag.homework || flag.ca);
      }).length;
      const classworkEntered = count('classwork');
      const quizEntered = count('quiz');
      const attendanceEntered = count('attendance');
      const completeForStudent = (student: any) => {
        const flag = flags.get(student.id);
        if (!flag) return false;
        return scope === 'monthly'
          ? (flag.ca || (flag.homework && flag.classwork)) && flag.quiz
          : flag.any;
      };
      const entered = expectedStudents.filter(completeForStudent).length;
      const courseworkComplete = expected > 0 && (caEntered >= expected || (homeworkEntered >= expected && classworkEntered >= expected));
      const quizComplete = expected > 0 && quizEntered >= expected;
      const courseworkProgress = expected > 0
        ? Math.max(Math.min(caEntered / expected, 1), (Math.min(homeworkEntered / expected, 1) + Math.min(classworkEntered / expected, 1)) / 2)
        : 0;
      const percentage = expected === 0
        ? 0
        : scope === 'monthly'
          ? Math.round(((courseworkProgress + Math.min(quizEntered / expected, 1)) / 2) * 10000) / 100
          : Math.round((entered / expected) * 10000) / 100;
      const componentEntries = caEntered + homeworkEntered + classworkEntered + quizEntered + attendanceEntered;
      const lastUpdated = exams.reduce((latest: string | null, exam: any) => !latest || exam.createdAt > latest ? exam.createdAt : latest, null);
      const status = expected > 0 && entered >= expected
        ? 'complete'
        : percentage > 0 || componentEntries > 0 || entered > 0
          ? 'in_progress'
          : 'not_started';

      return {
        assignment_id: assignment.id,
        teacher_id: assignment.teacherId,
        teacher_name: demoProfiles.find((profile: any) => profile.id === assignment.teacherId)?.name ?? assignment.teacherId,
        class_name: assignment.className,
        subject_id: assignment.subjectId,
        subject_name: subjectName,
        academic_year_id: params?.p_academic_year_id ?? 'ay-2026',
        term_id: params?.p_term_id ?? 'term-1',
        exam_scope: scope,
        month: selectedMonth,
        expected_students: expected,
        entered_students: entered,
        missing_students: expectedStudents.filter((student: any) => !completeForStudent(student)).map((student: any) => ({ id: student.id, name: student.name })),
        percentage,
        completion_status: status,
        last_updated: lastUpdated,
        ca_entered: caEntered,
        homework_entered: homeworkEntered,
        homework_ca_entered: homeworkCaEntered,
        classwork_entered: classworkEntered,
        quiz_entered: quizEntered,
        attendance_entered: attendanceEntered,
        coursework_complete: courseworkComplete,
        quiz_complete: quizComplete,
        monthly_complete_students: entered,
      };
    });
}

// ── Former Students / Student Cleanup: in-memory mirror of the SQL RPCs ─────
// The preview client has no Postgres, so the same contract implemented by
// 20261008_former_students_cleanup.sql is reproduced here on the demo data:
//   * System ID (students.id) is the only match key
//   * missing / unknown / ambiguous IDs can never be applied
//   * an ID match with a different name needs an explicit per-row confirmation
//   * nothing is deleted, everything is recorded in a ledger that a rollback
//     consults before restoring anyone
// Production never reaches this code: with real credentials configured, the
// RPCs run in the database and the database is the only thing that decides.
const mockFormerState: {
  seq: number;
  imports: any[];
  rows: any[];
  ledger: any[];
} = { seq: 0, imports: [], rows: [], ledger: [] };

const MOCK_FORMER_POLICY = {
  policyId: 'former_students_system_id_match',
  version: 1,
  nameEn: 'Former Students / Student Cleanup',
  matchKeyEn: 'System ID (students.id) is the only match key.',
  neverDeleteEn: 'No student record is ever deleted. History is preserved.',
  confirmPhrase: 'MARK AS FORMER STUDENTS',
  rollbackConfirmPhrase: 'ROLLBACK IMPORT',
  maxRows: MAX_FORMER_IMPORT_ROWS,
  statuses: {
    exact_match: 'Exact Match — System ID found and the names agree',
    id_match_name_conflict: 'ID Match but Name Different — manual review required',
    possible_duplicate: 'Possible Duplicate — the same System ID or name appears more than once in the file',
    requires_review: 'Requires Review — the uploaded record cannot be verified',
    not_found: 'System ID Not Found — nothing will be changed',
    already_former: 'Already a Former Student — nothing to do',
  },
  actions: { deactivate: 'Mark as Former Student', keep_active: 'Keep Active', review: 'Review' },
  autoSafeConditions: [
    'system_id_present', 'system_id_matches_exactly_one_student', 'uploaded_name_present',
    'uploaded_name_agrees_with_database_name', 'system_id_unique_in_uploaded_file',
    'uploaded_name_unique_in_uploaded_file', 'student_currently_active',
  ],
  neverDeactivateWhen: [
    'system_id_missing', 'system_id_not_found', 'multiple_database_records_share_the_system_id',
    'uploaded_record_is_ambiguous', 'only_the_name_matches',
    'uploaded_name_is_very_different_from_the_database_name',
  ],
  invariants: {
    noDeletes: 'This feature never deletes a student row or any child row.',
    noFuzzyNameMatch: 'A name match never identifies a student; only System ID does.',
    notInFileStaysActive: 'A student who is not in the uploaded file is never touched.',
    historyPreserved: 'Marks, attendance, payments, parents, messages and historical classes stay intact.',
    rollbackIsChecked: 'Rollback consults the status ledger and skips students changed after the import.',
  },
};

const MOCK_FORMER_ACTOR = { id: 'preview-admin', name: 'Preview Admin' };

function mockFormerLedgerPush(entry: Record<string, unknown>) {
  const record = {
    id: `ssc-mock-${mockFormerState.ledger.length + 1}`,
    createdAt: new Date().toISOString(),
    ...entry,
  };
  mockFormerState.ledger.push(record);
  return record;
}

function mockFormerPreview(pRows: any) {
  const rows = Array.isArray(pRows) ? pRows : [];
  if (rows.length > MOCK_FORMER_POLICY.maxRows) {
    return { data: null, error: { message: `Too many rows in one import (max ${MOCK_FORMER_POLICY.maxRows}). Split the file.`, code: '54000' } };
  }
  const evaluation = evaluateFormerStudentRows(rows, demoStudents as any[]);
  return {
    data: { ...evaluation, dryRun: true, writesPerformed: 0, policy: MOCK_FORMER_POLICY, evaluatedAt: new Date().toISOString() },
    error: null,
  };
}

function mockFormerApply(pRows: any, pFileName: any, pReason: any) {
  const preview = mockFormerPreview(pRows);
  if (preview.error) return preview;
  const evaluation = preview.data!;
  const requestedByRow = new Map<number, { action?: string; adminConfirmed?: boolean }>(
    (Array.isArray(pRows) ? pRows : []).map((r: any) => [Number(r.rowNumber), r]),
  );

  mockFormerState.seq += 1;
  const importId = `fsi-mock-${mockFormerState.seq}`;
  const summary = evaluation.summary;
  const record: any = {
    id: importId,
    importNumber: mockFormerState.seq,
    seq: mockFormerState.seq,
    fileName: pFileName ?? null,
    adminId: MOCK_FORMER_ACTOR.id,
    adminName: MOCK_FORMER_ACTOR.name,
    reason: pReason ?? null,
    status: 'applied',
    uploadedCount: summary.totalUploaded,
    validCount: summary.validRecords,
    missingNameCount: summary.missingNames,
    missingSystemIdCount: summary.missingSystemIds,
    duplicateSystemIdCount: summary.duplicateSystemIds,
    duplicateNameCount: summary.duplicateNames,
    foundCount: summary.foundInDatabase,
    notFoundCount: summary.notFoundInDatabase,
    exactMatchCount: summary.exactMatches,
    nameConflictCount: summary.nameConflicts,
    possibleDuplicateCount: summary.possibleDuplicates,
    reviewCount: summary.requiresReview,
    alreadyFormerCount: summary.alreadyFormer,
    readyCount: summary.readyToDeactivate,
    deactivatedCount: 0,
    skippedCount: 0,
    restoredCount: 0,
    rollbackSkippedCount: 0,
    rolledBackAt: null,
    rolledBackBy: null,
    rolledBackByName: null,
    summary,
    createdAt: new Date().toISOString(),
  };
  mockFormerState.imports.push(record);

  let deactivated = 0;
  let skipped = 0;
  let keptActive = 0;
  let blocked = 0;
  const deactivatedIds: string[] = [];
  const skippedRows: any[] = [];

  for (const evaluated of evaluation.rows) {
    const requested = requestedByRow.get(evaluated.rowNumber);
    const action = requested?.action === 'deactivate' || requested?.action === 'keep_active' ? requested.action : 'review';
    const confirmed = Boolean(requested?.adminConfirmed);
    let actionTaken: string;
    let actionReason: string;

    if (action === 'keep_active') {
      actionTaken = 'kept_active'; actionReason = 'admin_kept_active'; keptActive += 1;
    } else if (action !== 'deactivate') {
      actionTaken = 'skipped'; actionReason = 'not_selected_for_deactivation'; skipped += 1;
    } else if (evaluated.blocked) {
      actionTaken = 'blocked'; actionReason = evaluated.reasons[0] ?? 'blocked_by_safety_rule'; blocked += 1;
      skippedRows.push({ rowNumber: evaluated.rowNumber, uploadedSystemId: evaluated.uploadedSystemId, reason: actionReason });
    } else if (evaluated.matchStatus === 'already_former') {
      actionTaken = 'already_former'; actionReason = 'already_former'; skipped += 1;
    } else if (evaluated.requiresReview && !confirmed) {
      actionTaken = 'blocked'; actionReason = 'requires_manual_review'; blocked += 1;
      skippedRows.push({ rowNumber: evaluated.rowNumber, uploadedSystemId: evaluated.uploadedSystemId, reason: actionReason });
    } else if (!evaluated.matchedStudentId) {
      actionTaken = 'blocked'; actionReason = 'no_matched_student'; blocked += 1;
    } else {
      const student = (demoStudents as any[]).find(s => s.id === evaluated.matchedStudentId);
      if (!student || student.status === 'former') {
        actionTaken = 'already_former'; actionReason = 'already_former'; skipped += 1;
      } else {
        const previousStatus = student.status ?? 'active';
        const previousTransport = student.transport ?? null;
        // STATUS + the school's existing LEFT marker only. Name, System ID,
        // class, parent, Gov ID and family ID are preserved.
        student.status = 'former';
        student.transport = 'LEFT';
        student.statusUpdatedAt = new Date().toISOString();
        student.statusUpdatedBy = MOCK_FORMER_ACTOR.id;
        mockFormerLedgerPush({
          studentId: student.id, studentName: student.name,
          previousStatus, newStatus: 'former', reason: 'former_import',
          previousTransport, changedBy: MOCK_FORMER_ACTOR.id, changedByName: MOCK_FORMER_ACTOR.name,
          importId, fileName: record.fileName, note: record.reason,
        });
        actionTaken = 'deactivated';
        actionReason = confirmed && evaluated.requiresReview ? 'admin_confirmed_review_row' : 'exact_system_id_match';
        deactivated += 1;
        deactivatedIds.push(student.id);
      }
    }

    mockFormerState.rows.push({
      id: `fsr-mock-${mockFormerState.rows.length + 1}`,
      importId,
      rowNumber: evaluated.rowNumber,
      uploadedName: evaluated.uploadedName,
      uploadedSystemId: evaluated.uploadedSystemId,
      studentId: evaluated.matchedStudentId,
      studentName: evaluated.databaseName,
      className: evaluated.className,
      matchStatus: evaluated.matchStatus,
      nameMatch: evaluated.nameMatch,
      nameSimilarity: evaluated.nameSimilarity,
      reasons: evaluated.reasons,
      requestedAction: action,
      adminConfirmed: confirmed,
      actionTaken,
      actionReason,
      previousStatus: actionTaken === 'deactivated' ? 'active' : null,
      newStatus: actionTaken === 'deactivated' ? 'former' : null,
      restoredAt: null,
      restoredBy: null,
      createdAt: new Date().toISOString(),
    });
  }

  record.deactivatedCount = deactivated;
  record.skippedCount = skipped + keptActive + blocked;

  return {
    data: {
      importId,
      importNumber: record.importNumber,
      committed: true,
      atomic: true,
      fileName: record.fileName,
      adminId: MOCK_FORMER_ACTOR.id,
      adminName: MOCK_FORMER_ACTOR.name,
      deactivated,
      skipped,
      keptActive,
      blocked,
      deleted: 0,
      formerStudentIds: deactivatedIds,
      skippedRows,
      summary,
      invariants: MOCK_FORMER_POLICY.invariants,
      completedAt: new Date().toISOString(),
    },
    error: null,
  };
}

function mockFormerRollback(pImportId: any, pPhrase: any) {
  const expected = MOCK_FORMER_POLICY.rollbackConfirmPhrase;
  if (String(pPhrase ?? '').trim().toUpperCase() !== expected) {
    return { data: null, error: { message: `Rollback confirmation phrase required: type ${expected} to undo this import.`, code: '22023' } };
  }
  const record = mockFormerState.imports.find(i => i.id === pImportId);
  if (!record) return { data: null, error: { message: `Import ${pImportId} not found.`, code: 'P0002' } };
  if (record.status === 'rolled_back') {
    return { data: null, error: { message: `Import ${pImportId} was already rolled back.`, code: '55000' } };
  }

  let restored = 0;
  let skipped = 0;
  const restoredIds: string[] = [];
  const skippedRows: any[] = [];

  for (const row of mockFormerState.rows.filter(r => r.importId === pImportId && r.actionTaken === 'deactivated')) {
    const student = (demoStudents as any[]).find(s => s.id === row.studentId);
    if (!student) {
      skipped += 1; skippedRows.push({ studentId: row.studentId, reason: 'student_missing' });
      continue;
    }
    // Audit check: the most recent ledger entry for this student must still be
    // the one this import wrote, and the student must still be former.
    const latest = [...mockFormerState.ledger]
      .filter(l => l.studentId === row.studentId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .pop();
    if (!latest || latest.importId !== pImportId || latest.reason !== 'former_import' || student.status !== 'former') {
      skipped += 1;
      skippedRows.push({ studentId: row.studentId, studentName: row.studentName, reason: 'changed_after_import' });
      continue;
    }
    student.status = latest.previousStatus ?? 'active';
    student.transport = latest.previousTransport ?? null;
    student.statusUpdatedAt = new Date().toISOString();
    student.statusUpdatedBy = MOCK_FORMER_ACTOR.id;
    mockFormerLedgerPush({
      studentId: student.id, studentName: student.name, previousStatus: 'former',
      newStatus: student.status, reason: 'import_rollback', previousTransport: 'LEFT',
      changedBy: MOCK_FORMER_ACTOR.id, changedByName: MOCK_FORMER_ACTOR.name,
      importId: pImportId, fileName: record.fileName, note: `Rollback of import ${pImportId}`,
    });
    row.restoredAt = new Date().toISOString();
    row.restoredBy = MOCK_FORMER_ACTOR.id;
    restored += 1;
    restoredIds.push(student.id);
  }

  record.status = skipped === 0 ? 'rolled_back' : 'partially_rolled_back';
  record.restoredCount += restored;
  record.rollbackSkippedCount += skipped;
  record.rolledBackAt = new Date().toISOString();
  record.rolledBackBy = MOCK_FORMER_ACTOR.id;
  record.rolledBackByName = MOCK_FORMER_ACTOR.name;

  return {
    data: {
      importId: pImportId, restored, skipped, restoredStudentIds: restoredIds, skippedRows,
      importStatus: record.status, completedAt: new Date().toISOString(),
    },
    error: null,
  };
}

function mockFormerListImports(pLimit: any, pOffset: any) {
  const limit = Math.min(Math.max(Number(pLimit ?? 25) || 25, 1), 200);
  const offset = Math.max(Number(pOffset ?? 0) || 0, 0);
  const sorted = [...mockFormerState.imports].sort((a, b) => b.seq - a.seq);
  return { data: { total: sorted.length, imports: sorted.slice(offset, offset + limit) }, error: null };
}

function mockFormerGetImport(pImportId: any, pLimit: any, pOffset: any) {
  const record = mockFormerState.imports.find(i => i.id === pImportId);
  if (!record) return { data: null, error: { message: `Import ${pImportId} not found.`, code: 'P0002' } };
  const limit = Math.min(Math.max(Number(pLimit ?? 200) || 200, 1), 2000);
  const offset = Math.max(Number(pOffset ?? 0) || 0, 0);
  const rows = mockFormerState.rows.filter(r => r.importId === pImportId);
  return { data: { import: record, rows: rows.slice(offset, offset + limit), rowTotal: rows.length }, error: null };
}

function mockFormerListStudents(pSearch: any, pClass: any, pLimit: any, pOffset: any) {
  const q = String(pSearch ?? '').trim().toLowerCase();
  const cls = pClass ? String(pClass) : null;
  const limit = Math.min(Math.max(Number(pLimit ?? 50) || 50, 1), 500);
  const offset = Math.max(Number(pOffset ?? 0) || 0, 0);
  const former = (demoStudents as any[]).filter(s => s.status === 'former');
  const matched = former.filter(s => {
    if (cls && s.className !== cls) return false;
    if (!q) return true;
    return [s.name, s.id, s.govId ?? ''].some(v => String(v).toLowerCase().includes(q));
  });
  matched.sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
  const classes = Array.from(new Set(former.map(s => s.className).filter(Boolean))).sort();
  const students = matched.slice(offset, offset + limit).map(s => {
    const last = [...mockFormerState.ledger]
      .filter(l => l.studentId === s.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const parent = demoProfiles.find(p => p.id === s.parentId);
    const actor = demoProfiles.find(p => p.id === s.statusUpdatedBy);
    return {
      id: s.id, name: s.name, className: s.className, govId: s.govId ?? null,
      parentId: s.parentId ?? null, parentName: parent?.name ?? null, parentPhone: s.parentPhone ?? null,
      transport: s.transport ?? null, familyId: s.familyId ?? null, status: 'former',
      markedFormerAt: s.statusUpdatedAt ?? null, markedFormerBy: s.statusUpdatedBy ?? null,
      markedFormerByName: actor?.name ?? null, createdAt: s.createdAt,
      lastChange: last
        ? { reason: last.reason, at: last.createdAt, by: last.changedByName ?? null, fileName: last.fileName ?? null, importId: last.importId ?? null }
        : null,
    };
  });
  return { data: { total: matched.length, students, classes }, error: null };
}

function mockFormerSetStatus(pStudentId: any, pStatus: any, pReason: any) {
  const target = String(pStatus ?? '').trim().toLowerCase();
  if (target !== 'active' && target !== 'former') {
    return { data: null, error: { message: 'Status must be "active" or "former".', code: '22023' } };
  }
  const student = (demoStudents as any[]).find(s => s.id === pStudentId);
  if (!student) return { data: null, error: { message: `Student ${pStudentId} does not exist.`, code: 'P0002' } };
  const previousStatus = student.status ?? 'active';
  if (previousStatus === target) {
    return { data: { studentId: student.id, status: target, changed: false, reason: 'already_in_state' }, error: null };
  }
  const previousTransport = student.transport ?? null;
  if (target === 'former') {
    student.transport = 'LEFT';
  } else {
    const lastFormer = [...mockFormerState.ledger]
      .filter(l => l.studentId === student.id && l.newStatus === 'former')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    student.transport = lastFormer ? (lastFormer.previousTransport ?? null) : null;
  }
  student.status = target;
  student.statusUpdatedAt = new Date().toISOString();
  student.statusUpdatedBy = MOCK_FORMER_ACTOR.id;
  mockFormerLedgerPush({
    studentId: student.id, studentName: student.name, previousStatus, newStatus: target,
    reason: target === 'former' ? 'former_manual' : 'manual_restore',
    previousTransport, changedBy: MOCK_FORMER_ACTOR.id, changedByName: MOCK_FORMER_ACTOR.name,
    importId: null, fileName: null, note: pReason ?? null,
  });
  return {
    data: { studentId: student.id, studentName: student.name, previousStatus, status: target, changed: true, changedBy: MOCK_FORMER_ACTOR.id, changedAt: new Date().toISOString() },
    error: null,
  };
}

function createMockSupabase(): SupabaseClient {
  const demoClasses = Array.from(new Set(demoStudents.map(s => s.className))).sort();

  // Mutable in-memory "database" for the preview. Insert/update/delete go
  // through this store so a created lesson plan (or unit plan) is visible to
  // subsequent queries in the same preview session — the closest match to how
  // the real backend behaves without any network.
  // Demo exams for duplicate merge preview (Axmed safe, Abshir blocked)
  const demoDuplicateExams: any[] = (() => {
    const exams: any[] = [];
    // Abshir: canonical 56 exams, duplicate 55 matching identities (critical conflict)
    // Distinct per-exam keys ensure 55 distinct conflicts (not cross-product 605)
    for (let i = 0; i < 56; i++) {
      exams.push({
        id: `exam-abshir-a-${i}`,
        studentId: 'stu-abshir-a',
        subject: `Subject-${i}`,
        subjectId: `sub-${i}`,
        score: 15,
        total: 20,
        examType: 'Quiz',
        assessmentLabel: `MT-${i}`,
        termId: 'term-1',
        month: 'September',
        entryState: 'scored',
        status: 'approved',
        date: '2026-09-01',
        createdAt: '2026-09-01T08:00:00Z',
        teacherId: 'teacher-1',
      });
    }
    for (let i = 0; i < 55; i++) {
      exams.push({
        id: `exam-abshir-b-${i}`,
        studentId: 'stu-abshir-b',
        subject: `Subject-${i}`,
        subjectId: `sub-${i}`,
        score: 14,
        total: 20,
        examType: 'Quiz',
        assessmentLabel: `MT-${i}`,
        termId: 'term-1',
        month: 'September',
        entryState: 'scored',
        status: 'approved',
        date: '2026-09-01',
        createdAt: '2026-09-01T08:00:00Z',
        teacherId: 'teacher-1',
      });
    }
    // Axmed: canonical 0, duplicate 1 enrollment history etc — no exam conflicts
    // Leyla same gov strong match — duplicate has 2 exams distinct from canonical 3 (no conflict)
    for (let i = 0; i < 3; i++) {
      exams.push({
        id: `exam-leyla-a-${i}`,
        studentId: 'stu-samegov-a',
        subject: `Subject-${i}`,
        subjectId: `sub-leyla-${i}`,
        score: 18, total: 20, examType: 'Midterm', assessmentLabel: null, termId: 'term-1', month: 'September', entryState: 'scored', status: 'approved', date: '2026-09-02', createdAt: '2026-09-02T08:00:00Z', teacherId: 'teacher-1',
      });
    }
    for (let i = 0; i < 2; i++) {
      exams.push({
        id: `exam-leyla-b-${i}`,
        studentId: 'stu-samegov-b',
        subject: `Subject-${10 + i}`,
        subjectId: `sub-leyla-${10 + i}`,
        score: 16, total: 20, examType: 'Midterm', assessmentLabel: null, termId: 'term-1', month: 'September', entryState: 'scored', status: 'approved', date: '2026-09-03', createdAt: '2026-09-03T08:00:00Z', teacherId: 'teacher-1',
      });
    }
    return exams;
  })();

  const demoDuplicateAttendance: any[] = [];
  const demoDuplicateHomework: any[] = [];
  const demoDuplicatePromotions: any[] = [
    { id: 'promo-axmed-a', studentId: 'stu-axmed-a', fromClass: 'Grade 1-A', toClass: 'Grade 1-B', academicYearId: 'ay-2026', createdAt: '2026-09-01' },
  ];
  const demoDuplicateEnrollments: any[] = [
    { id: 'enr-axmed-a-open', studentId: 'stu-axmed-a', className: 'Grade 1-B', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
    { id: 'enr-axmed-b-open', studentId: 'stu-axmed-b', className: 'Grade 1-B', academicYearId: 'ay-2026', effectiveFrom: '2026-09-10', effectiveTo: null, reason: 'import', sourceRef: 'demo' },
    { id: 'enr-abshir-a-open', studentId: 'stu-abshir-a', className: 'Grade 2-C', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
    { id: 'enr-abshir-b-open', studentId: 'stu-abshir-b', className: 'Grade 2-C', academicYearId: 'ay-2026', effectiveFrom: '2026-08-20', effectiveTo: null, reason: 'import', sourceRef: 'demo' },
    { id: 'enr-ahmed-a-open', studentId: 'stu-ahmed-conf-a', className: 'Grade 5-A', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
    { id: 'enr-ahmed-b-open', studentId: 'stu-ahmed-conf-b', className: 'Grade 5-A', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
    { id: 'enr-leyla-a-open', studentId: 'stu-samegov-a', className: 'Grade 3-B', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
    { id: 'enr-leyla-b-open', studentId: 'stu-samegov-b', className: 'Grade 3-B', academicYearId: 'ay-2026', effectiveFrom: '2026-06-01', effectiveTo: null, reason: 'promotion', sourceRef: 'demo' },
  ];
  const demoMergeAudits: any[] = [];

  // Teacher push-notification demo rows (preview mode): the notification
  // centre and history render with realistic content without a real backend.
  const demoNow = Date.now();
  const demoNotifications: any[] = [
    {
      id: 'ntf-demo-1',
      title: 'Staff Meeting',
      body: 'Staff meeting tomorrow at 8:00 AM.',
      url: '/teacher/announcements',
      category: 'announcement',
      sender_id: 'preview-admin',
      created_at: new Date(demoNow - 10 * 60000).toISOString(),
    },
    {
      id: 'ntf-demo-2',
      title: 'Lesson Plan Reminder',
      body: 'Please submit your lesson plan.',
      url: '/teacher/lesson-plans',
      category: 'lesson_plan',
      sender_id: 'preview-admin',
      created_at: new Date(demoNow - 26 * 3600000).toISOString(),
    },
  ];
  // Flat (mock has no joins): the recipient rows carry the notification
  // fields inline so getMyNotifications() can render them.
  const demoNotificationRecipients: any[] = demoNotifications.map((n, i) => ({
    title: n.title,
    body: n.body,
    url: n.url,
    category: n.category,
    id: `ntr-demo-${i + 1}`,
    notification_id: n.id,
    user_id: 'teacher-1',
    status: 'sent',
    delivered_devices: 1,
    failed_devices: 0,
    last_error: null,
    read_at: i === 0 ? null : new Date(demoNow - 25 * 3600000).toISOString(),
    created_at: n.created_at,
  }));

  const mockTables: Record<string, any[]> = {
    academic_years: [...demoAcademicYears],
    terms: [...demoTerms],
    students: [...demoStudents],
    profiles: [...demoProfiles],
    report_comments: [],
    exams: [...demoParentExams, ...demoDuplicateExams],
    announcement_recipients: [...demoParentAnnouncementRecipients],
    homework: [...demoParentHomework, ...demoDuplicateHomework],
    attendance: [...demoDuplicateAttendance],
    quizzes: [],
    quiz_attempts: [],
    grade_scales: [],
    report_config: [{ id: 'default', caWeight: 60, midtermWeight: 20, finalWeight: 20, caTypes: ['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance'], updatedAt: new Date().toISOString() }],
    lesson_plans: [...demoLessonPlans],
    lesson_plan_periods: [...demoLessonPlanPeriods],
    ai_reviews: [],
    lesson_period_ai_reviews: [],
    lesson_plan_quizzes: [],
    unit_plans: [],
    subjects: [...demoSubjects],
    class_subjects: [...demoClassSubjects],
    student_enrollments: [...demoDuplicateEnrollments],
    student_promotions: [...demoDuplicatePromotions],
    authorized_pickup_students: [],
    release_log: [],
    student_merge_audits: [...demoMergeAudits],
    audit_logs: [],
    student_merge_batches: [],
    push_subscriptions: [],
    notification_preferences: [],
    notifications: [...demoNotifications],
    notification_recipients: [...demoNotificationRecipients],
  };

  // Helper to build a query chain that mimics supabase-js
  const makeChain = (table: string, opts: any = {}) => {
    let filters: Array<{ col: string; val: any; op: string }> = [];
    let selectedCols: string | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitVal: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let inFilter: Array<{ col: string; vals: any[] }> = [];
    let ilikeFilter: { col: string; pattern: string } | null = null;
    let orFilter: string | null = null;
    let insertRows: any[] | null = null;
    let updatePayload: Record<string, any> | null = null;
    let deleteMode = false;

    const getTableData = (): any[] => {
      return [...(mockTables[table] ?? [])];
    };

    const applyFilters = (rows: any[]) => {
      let out = [...rows];
      for (const f of filters) {
        if (f.op === 'eq') {
          out = out.filter(r => String(r[f.col] ?? r[f.col.replace(/"/g,'')]) === String(f.val));
          // handle quoted cols like "studentId"
          if (out.length === 0) {
            // try without quotes
            out = rows.filter(r => {
              const keys = Object.keys(r);
              const matchKey = keys.find(k => k.toLowerCase() === f.col.replace(/"/g,'').toLowerCase());
              return matchKey ? String(r[matchKey]) === String(f.val) : false;
            });
            // re-apply other filters? For simplicity, if eq on studentId etc, we already filtered; if not matched, keep empty
            // We'll just keep out as filtered by second attempt
          }
        } else if (f.op === 'is') {
          out = out.filter(r => (r[f.col] == null && f.val === null) || r[f.col] === f.val);
        } else if (f.op === 'lt' || f.op === 'lte' || f.op === 'gt' || f.op === 'gte') {
          // Comparison filters (used by the parent portal's quiz window:
          // openDate <= today AND dueDate >= today). Numbers compare
          // numerically; anything else compares as strings (ISO dates sort
          // correctly lexicographically).
          out = out.filter(r => {
            const rv = r[f.col];
            if (rv == null) return false;
            const rn = Number(rv);
            const vn = Number(f.val);
            const c = !Number.isNaN(rn) && !Number.isNaN(vn) && String(rv).trim() !== '' && String(f.val).trim() !== ''
              ? rn - vn
              : String(rv).localeCompare(String(f.val));
            if (f.op === 'lt') return c < 0;
            if (f.op === 'lte') return c <= 0;
            if (f.op === 'gt') return c > 0;
            return c >= 0;
          });
        }
      }
      if (inFilter.length > 0) {
        for (const f of inFilter) {
          out = out.filter(r => f.vals.map(String).includes(String(r[f.col] ?? '')));
        }
      }
      if (ilikeFilter) {
        const pat = ilikeFilter.pattern.replace(/%/g, '').toLowerCase();
        out = out.filter(r => String(r[ilikeFilter!.col] ?? '').toLowerCase().includes(pat));
      }
      if (orFilter) {
        // very simplified: or contains ilike patterns for name/email/phone
        // We'll just not filter for preview
      }
      if (orderCol) {
        out.sort((a, b) => {
          const av = a[orderCol!]; const bv = b[orderCol!];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'string' && typeof bv === 'string') return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          return orderAsc ? (av - bv) : (bv - av);
        });
      }
      if (rangeFrom != null && rangeTo != null) {
        out = out.slice(rangeFrom, rangeTo + 1);
      } else if (limitVal != null) {
        out = out.slice(0, limitVal);
      }
      return out;
    };

    const chain: any = {
      select: (cols?: string, opts?: any) => {
        selectedCols = cols || null;
        if (opts?.count === 'exact') chain._count = true;
        return chain;
      },
      eq: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'eq' }); return chain; },
      neq: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'neq' }); return chain; },
      in: (col: string, vals: any[]) => { inFilter.push({ col: col.replace(/"/g,''), vals }); return chain; },
      is: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'is' }); return chain; },
      lt: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'lt' }); return chain; },
      lte: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'lte' }); return chain; },
      gt: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'gt' }); return chain; },
      gte: (col: string, val: any) => { filters.push({ col: col.replace(/"/g,''), val, op: 'gte' }); return chain; },
      maybeSingle: async () => {
        const rows = resolveRows();
        return { data: rows[0] || null, error: null };
      },
      single: async () => {
        const rows = resolveRows();
        if (rows.length === 0) return { data: null, error: { message: 'No rows', code: 'PGRST116' } };
        return { data: rows[0], error: null };
      },
      order: (col: string, opts?: any) => { orderCol = col.replace(/"/g,''); orderAsc = opts?.ascending ?? true; return chain; },
      limit: (n: number) => { limitVal = n; return chain; },
      range: (from: number, to: number) => { rangeFrom = from; rangeTo = to; return chain; },
      ilike: (col: string, pat: string) => { ilikeFilter = { col, pattern: pat }; return chain; },
      or: (expr: string) => { orFilter = expr; return chain; },
      returns: () => chain,
      delete: () => { deleteMode = true; return chain; },
      insert: (payload: any) => {
        const now = new Date().toISOString();
        insertRows = (Array.isArray(payload) ? payload : [payload]).map((row: any) => ({
          // Real DB defaults that the mock does not apply automatically.
          ...(table === 'lesson_plans' ? { status: 'draft' } : {}),
          created_at: now,
          updated_at: now,
          ...row,
        }));
        mockTables[table] = [...(mockTables[table] ?? []), ...insertRows];
        return chain;
      },
      update: (payload: any) => { updatePayload = payload ?? {}; return chain; },
      upsert: (payload: any, opts?: any) => {
        // Minimal onConflict support (notification_preferences uses
        // onConflict: 'user_id'): matching rows merge, missing rows insert.
        const conflictCols = String(opts?.onConflict ?? 'id').split(',').map((c: string) => c.trim()).filter(Boolean);
        const rows = Array.isArray(payload) ? payload : [payload];
        const tableRows = mockTables[table] ?? [];
        const touched: any[] = [];
        for (const row of rows) {
          const existing = tableRows.find((r) => conflictCols.every((c) => String(r[c]) === String(row[c])));
          if (existing) {
            Object.assign(existing, row);
            touched.push(existing);
          } else {
            tableRows.push(row);
            touched.push(row);
          }
        }
        mockTables[table] = tableRows;
        insertRows = touched;
        return chain;
      },
      // For queries that are awaited directly (supabase.from(...).select(...))
      then: (onFulfilled: any, onRejected: any) => {
        const rows = resolveRows();
        const result: any = { data: rows, error: null };
        if (chain._count) result.count = rows.length;
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };

    // Resolve what a chain returns: inserted rows as-is, updates/deletes
    // applied to the matching rows of the in-memory table, otherwise the
    // filtered table snapshot.
    const resolveRows = (): any[] => {
      if (insertRows) return insertRows;
      if (deleteMode) {
        const matched = applyFilters(getTableData());
        const ids = new Set(matched.map(r => r.id));
        mockTables[table] = (mockTables[table] ?? []).filter(row => !ids.has(row.id));
        return matched;
      }
      if (updatePayload) {
        const matched = applyFilters(getTableData());
        const ids = new Set(matched.map(r => r.id));
        const now = new Date().toISOString();
        mockTables[table] = (mockTables[table] ?? []).map(row =>
          ids.has(row.id) ? { ...row, ...updatePayload, updated_at: now } : row,
        );
        return matched.map(row => ({ ...row, ...updatePayload }));
      }
      return applyFilters(getTableData());
    };
    // Handle className distinct for getClasses: if selecting only className, we still return objects with className
    if (table === 'students' && selectedCols === 'className') {
      // Will be handled via getTableData filtering
    }
    return chain;
  };

  const mockAuth = {
    onAuthStateChange: (cb: (event: string, session: any) => void) => {
      setTimeout(() => cb('INITIAL_SESSION', null), 50);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    getSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async ({ email, password }: any) => {
      // In preview, accept any password. A known demo email signs in as that
      // demo profile (so the supervisor pages are reachable); anything else
      // signs in as the demo admin, as before.
      const wanted = String(email || '').trim().toLowerCase();
      const profile = demoProfiles.find((p: any) => String(p.email || '').toLowerCase() === wanted)
        || demoProfiles.find((p: any) => p.id === 'preview-admin');
      const mockUser = { id: profile.auth_id, email: profile.email };
      const mockSession = { user: mockUser, access_token: 'mock-token', refresh_token: 'mock-refresh' };
      return { data: { user: mockUser, session: mockSession }, error: null } as any;
    },
    signUp: async () => ({ data: { user: null, session: null }, error: { message: 'Preview mode — auth disabled' } } as any),
    signOut: async () => ({ error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
  } as unknown as SupabaseClient['auth'];

  const mockFrom = (table: string) => makeChain(table);

  const mockRpc = async (fn: string, params?: any) => {
    // Former Students / Student Cleanup: same contract as the SQL RPCs, run on
    // the demo data (see mockFormer* helpers above).
    if (fn === 'former_students_policy') return { data: MOCK_FORMER_POLICY, error: null };
    if (fn === 'preview_former_student_import') return mockFormerPreview(params?.p_rows);
    if (fn === 'apply_former_student_import') {
      return mockFormerApply(params?.p_rows, params?.p_file_name, params?.p_reason);
    }
    if (fn === 'rollback_former_student_import') {
      return mockFormerRollback(params?.p_import_id, params?.p_confirm_phrase);
    }
    if (fn === 'list_former_student_imports') return mockFormerListImports(params?.p_limit, params?.p_offset);
    if (fn === 'get_former_student_import') {
      return mockFormerGetImport(params?.p_import_id, params?.p_limit, params?.p_offset);
    }
    if (fn === 'list_former_students') {
      return mockFormerListStudents(params?.p_search, params?.p_class, params?.p_limit, params?.p_offset);
    }
    if (fn === 'set_student_former_status') {
      return mockFormerSetStatus(params?.p_student_id, params?.p_status, params?.p_reason);
    }

    // The real app calls the SECURITY DEFINER monitor RPC. In the no-env
    // preview there is no Postgres, so return the same derived, assignment-
    // first shape from sanitized demo data rather than reporting a missing
    // function. This branch is unreachable when real Supabase credentials are
    // configured; production permissions remain enforced by SQL.
    if (fn === 'monitor_marks_entries') {
      return { data: demoMarksMonitorRows(params), error: null };
    }
    if (fn === 'get_monthly_report') {
      const rows = demoMonthlyRowsFor(params?.p_student_id, params?.p_term_id);
      return { data: rows, error: null };
    }
    if (fn === 'get_midterm_report') {
      if (params?.p_student_id === 'stu-barwaaqo') {
        return {
          data: {
            scores: [
              { subject: 'English', score: 17, total: 20, percentage: 85, grade: 'B', remark: 'Very Good', subject_rank: 3, class_average: 78, highest_in_class: 95, examId: 'mid-en' },
              { subject: 'Mathematics', score: 19, total: 20, percentage: 95, grade: 'A', remark: 'Excellent', subject_rank: 1, class_average: 82, highest_in_class: 95, examId: 'mid-math' },
              { subject: 'Science', score: 18, total: 20, percentage: 90, grade: 'A', remark: 'Excellent', subject_rank: 2, class_average: 80, highest_in_class: 95, examId: 'mid-sci' },
            ],
            overall_rank: 2, total_students: 12,
          }, error: null
        };
      }
      return { data: { scores: [], overall_rank: 0, total_students: 0 }, error: null };
    }
    if (fn === 'get_final_report') {
      if (params?.p_student_id === 'stu-barwaaqo') {
        return {
          data: {
            weights: { ca: 60, midterm: 20, final: 20 },
            results: [
              { subject: 'English', ca_avg: 88, ca_weighted: 52.8, midterm_score: 85, midterm_weighted: 17, final_score: 90, final_weighted: 18, total: 87.8, grade: 'B' },
              { subject: 'Mathematics', ca_avg: 95, ca_weighted: 57, midterm_score: 95, midterm_weighted: 19, final_score: 98, final_weighted: 19.6, total: 95.6, grade: 'A' },
              { subject: 'Science', ca_avg: 90, ca_weighted: 54, midterm_score: 90, midterm_weighted: 18, final_score: 92, final_weighted: 18.4, total: 90.4, grade: 'A' },
            ],
            overall_rank: 1, total_students: 12,
            comment: { teacher: 'Excellent progress!', principal: '' }
          }, error: null
        };
      }
      return { data: { weights: { ca: 60, midterm: 20, final: 20 }, results: [], overall_rank: 0, total_students: 0, comment: { teacher: '', principal: '' } }, error: null };
    }
    if (fn === 'get_students_by_classes' || fn === 'get_students' || fn === 'update_student') {
      return { data: null, error: { message: 'Not implemented in mock', code: 'PGRST202' } };
    }

    // ── Lesson plans — parent-safe projection + staff preview RPCs ─────────
    if (fn === 'get_parent_weekly_learning') {
      const student = demoStudents.find(s => s.id === params?.p_student_id && s.parentId === 'parent-1');
      if (!student) return { data: null, error: { message: 'Student not available.', code: '42501' } };
      const plans = demoLessonPlans.filter(plan =>
        plan.week_label === params?.p_week_label
        && plan.class_name === student.className
        && plan.status === 'approved'
      );
      const start = new Date('2026-05-30T00:00:00');
      const weekNumber = Number(String(params?.p_week_label || '').slice(-2));
      start.setDate(start.getDate() + (Math.max(1, weekNumber) - 1) * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 4);
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      const rows = demoLessonPlanPeriods
        .filter(period => plans.some(plan => plan.id === period.plan_id) && !period.is_free)
        .map(period => {
          const homework = demoParentHomework.find(item =>
            item.studentId === student.id && item.lesson_plan_period_id === period.id
          );
          return {
            student_id: student.id,
            student_name: student.name,
            class_name: student.className,
            week_label: params?.p_week_label,
            week_start: iso(start),
            week_end: iso(end),
            lesson_id: period.id,
            day: period.day,
            subject: period.subject,
            topic: period.topic,
            learning_objective: period.objective,
            what_we_are_learning: period.details.map((item: any) => item.activity).join(' · '),
            resources: period.details.map((item: any) => ({
              label: item.resource || null,
              url: String(item.place || '').startsWith('https://') ? item.place : null,
            })).filter((item: any) => item.label || item.url),
            practice_title: homework?.title || null,
            practice_description: homework?.description || null,
            practice_due_date: homework?.dueDate || null,
          };
        });
      return { data: rows, error: null };
    }
    if (fn === 'list_lesson_plan_weeks') {
      const statuses = Array.isArray(params?.p_statuses) ? params.p_statuses : null;
      const counts = new Map<string, number>();
      for (const plan of demoLessonPlans) {
        if (statuses && !statuses.includes(plan.status)) continue;
        counts.set(plan.week_label, (counts.get(plan.week_label) ?? 0) + 1);
      }
      return { data: [...counts].map(([week_label, plan_count]) => ({ week_label, plan_count })), error: null };
    }
    if (fn === 'list_lesson_plan_submitters') {
      // One row per (teacher, assigned class) — same shape as the SQL function.
      const rows: Array<{ teacher_id: string; teacher_name: string; class_name: string }> = [];
      for (const profile of demoProfiles) {
        if (String(profile.role || '').toLowerCase().trim() !== 'teacher') continue;
        for (const className of Array.isArray(profile.assignedClasses) ? profile.assignedClasses : []) {
          rows.push({ teacher_id: profile.id, teacher_name: profile.name, class_name: String(className) });
        }
      }
      return { data: rows, error: null };
    }
    if (fn === 'expire_stuck_ai_reviews') {
      return { data: [], error: null };
    }
    if (fn === 'save_lesson_plan_periods') {
      const periods = Array.isArray(params?.p_periods) ? params.p_periods : [];
      const now = new Date().toISOString();
      const saved = periods.map((p: any) => ({
        ...p,
        id: p.id || `period-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: now,
        updated_at: now,
      }));
      // Persist into the in-memory table so the grid + plan detail read them back.
      mockTables.lesson_plan_periods = [
        ...mockTables.lesson_plan_periods.filter((row: any) => row.plan_id !== params?.p_plan_id),
        ...saved,
      ];
      return { data: saved, error: null };
    }
    if (fn === 'submit_lesson_plan_for_review') {
      const plan = mockTables.lesson_plans.find((p: any) => p.id === params?.p_plan_id);
      if (!plan) return { data: null, error: { message: `Lesson plan ${params?.p_plan_id} was not found.`, code: 'P0002' } };
      const now = new Date().toISOString();
      plan.status = 'submitted';
      plan.ai_started_at = now;
      plan.updated_at = now;
      return { data: [plan], error: null };
    }

    // ── Authorized pickups ("drivers") — full preview implementation ────────
    const studentObj = (id: string): DemoDriverStudent => {
      const s = demoStudents.find(x => x.id === id);
      return { id, name: s?.name ?? id, className: s?.className ?? '', familyId: s?.familyId ?? null, transport: s?.transport ?? null };
    };
    const driverSummary = (d: DemoDriver) => ({
      id: d.id, name: d.name, phoneNumber: d.phoneNumber, relationship: d.relationship,
      photoPath: d.photoPath, addedAt: d.addedAt,
    });
    const listDrivers = () =>
      pickupDrivers.map(d => ({
        ...driverSummary(d),
        studentCount: d.students.length,
        familyCount: new Set(d.students.map(s => s.familyId).filter(Boolean)).size,
        students: d.students.map(s => ({ ...s })),
      }));

    if (fn === 'list_authorized_pickups') {
      return { data: listDrivers(), error: null };
    }
    if (fn === 'create_authorized_pickup') {
      const p = params;
      const phone = (p.p_phone_number ?? '').trim();
      if (!p.p_allow_duplicate_phone && normalizePhone(phone) && pickupDrivers.some(d => normalizePhone(d.phoneNumber) === normalizePhone(phone))) {
        return { data: null, error: { message: 'A driver with this phone number already exists.' } };
      }
      const students: DemoDriverStudent[] = (p.p_student_ids ?? []).map(studentObj);
      const driver: DemoDriver = {
        id: p.p_id,
        name: (p.p_name ?? '').trim(),
        phoneNumber: phone,
        relationship: (p.p_relationship ?? '').trim() || null,
        photoPath: p.p_photo_path || null,
        addedAt: new Date().toISOString(),
        students,
      };
      pickupDrivers.push(driver);
      return { data: { ...driverSummary(driver), studentIds: students.map(s => s.id) }, error: null };
    }
    if (fn === 'attach_students_to_authorized_pickup') {
      const d = pickupDrivers.find(x => x.id === params.p_pickup_id);
      if (!d) return { data: null, error: { message: 'Driver not found.' } };
      for (const id of params.p_student_ids ?? []) {
        if (!d.students.some(s => s.id === id)) d.students.push(studentObj(id));
      }
      return { data: { ...driverSummary(d), studentIds: d.students.map(s => s.id) }, error: null };
    }
    if (fn === 'remove_student_from_authorized_pickup') {
      const d = pickupDrivers.find(x => x.id === params.p_pickup_id);
      if (!d) return { data: null, error: { message: 'Driver not found.' } };
      d.students = d.students.filter(s => s.id !== params.p_student_id);
      return { data: { personId: params.p_pickup_id, studentId: params.p_student_id, removed: true }, error: null };
    }
    if (fn === 'update_authorized_pickup_photo') {
      const d = pickupDrivers.find(x => x.id === params.p_pickup_id);
      if (!d) return { data: null, error: { message: 'Driver not found.' } };
      d.photoPath = params.p_photo_path || null;
      return { data: driverSummary(d), error: null };
    }
    if (fn === 'find_authorized_pickup_by_phone') {
      const phone = params.p_phone ?? '';
      const d = pickupDrivers.find(x => normalizePhone(x.phoneNumber) === normalizePhone(phone) && normalizePhone(phone) !== '');
      return { data: d ? driverSummary(d) : null, error: null };
    }
    if (fn === 'search_authorized_pickups') {
      const q = (params.p_query ?? '').trim().toLowerCase();
      const list = pickupDrivers
        .filter(d => !q || d.name.toLowerCase().includes(q) || d.phoneNumber.includes(q))
        .map(driverSummary);
      return { data: list, error: null };
    }
    if (fn === 'get_family_pickups') {
      return { data: [], error: null };
    }

    // ── Duplicate Students — preview & merge (mock) ────────────────────────
    const govKey = (v: string | null | undefined) => (v || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    const findStudent = (id: string) => mockTables.students.find((s: any) => s.id === id);
    const mockRole = (globalThis as any).__mockRole ?? 'admin';
    const isAnon = mockRole === 'anon';
    const isAdmin = mockRole === 'admin';
    if (fn === 'get_duplicate_candidates') {
      if (isAnon || !isAdmin) {
        return { data: null, error: { message: 'Only administrators may view duplicate candidates.', code: '42501' } };
      }
      const map = new Map<string, { ids: string[]; className: string }>();
      for (const s of mockTables.students as any[]) {
        const norm = (s.name || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
        const key = `${norm}|${s.className}`;
        const entry: { ids: string[]; className: string } = map.get(key) || { ids: [], className: s.className };
        (entry.ids as string[]).push(String(s.id));
        map.set(key, entry);
      }
      const out: any[] = [];
      for (const [key, v] of map.entries()) {
        if (v.ids.length > 1) out.push({ group_key: key, student_ids: v.ids, class_name: v.className, member_count: v.ids.length });
      }
      return { data: out, error: null };
    }
    if (fn === 'preview_student_merge' || fn === 'preview_merge') {
      if (isAnon || !isAdmin) return { data: null, error: { message: 'Only administrators may preview student merges.', code: '42501' } };
      const canId = params?.p_canonical_id ?? params?.p_canonicalId;
      const dupId = params?.p_duplicate_id ?? params?.p_duplicateId;
      const can = findStudent(canId);
      const dup = findStudent(dupId);
      if (!can || !dup) return { data: null, error: { message: 'Student not found', code: 'PGRST116' } };
      const canExams = mockTables.exams.filter((e: any) => e.studentId === canId);
      const dupExams = mockTables.exams.filter((e: any) => e.studentId === dupId);
      // exam conflicts: same subjectId/examType/assessmentLabel/termId
      let examConflicts = 0;
      for (const d of dupExams) {
        for (const c of canExams) {
          const sameSub = (c.subjectId || null) === (d.subjectId || null);
          const sameType = c.examType === d.examType;
          const sameLabel = (c.assessmentLabel || null) === (d.assessmentLabel || null);
          const sameTerm = (c.termId || null) === (d.termId || null);
          if (sameSub && sameType && sameLabel && sameTerm) { examConflicts++; break; }
        }
      }
      const canHasGov = !!can.govId;
      const dupHasGov = !!dup.govId;
      const sameGov = canHasGov && dupHasGov && govKey(can.govId) !== '' && govKey(can.govId) === govKey(dup.govId);
      const govConflict = canHasGov && dupHasGov && govKey(can.govId) !== '' && govKey(dup.govId) !== '' && govKey(can.govId) !== govKey(dup.govId);
      const bothHaveParents = !!can.parentId && !!dup.parentId;
      const oneHasParent = !!can.parentId !== !!dup.parentId;
      const canOpen = mockTables.student_enrollments.find((e: any) => e.studentId === canId && e.effectiveTo == null) || null;
      const dupOpen = mockTables.student_enrollments.find((e: any) => e.studentId === dupId && e.effectiveTo == null) || null;
      const canOpenCnt = mockTables.student_enrollments.filter((e: any) => e.studentId === canId && e.effectiveTo == null).length;
      const dupOpenCnt = mockTables.student_enrollments.filter((e: any) => e.studentId === dupId && e.effectiveTo == null).length;
      let blocked: string[] = [];
      let canMerge = true;
      let risk: string = 'low';
      let evidence: string = 'possible';
      // Multiple open enrollments → blocked (safety)
      if (canOpenCnt > 1 || dupOpenCnt > 1) {
        blocked.push('enrollment_conflict');
        blocked.push('multiple_open_enrollments');
        canMerge = false;
      }
      // ClassName + academicYearId must match to consolidate
      if (canOpen && dupOpen && (canOpen.className !== dupOpen.className || (canOpen.academicYearId || null) !== (dupOpen.academicYearId || null))) {
        if (!blocked.includes('enrollment_conflict')) blocked.push('enrollment_conflict');
        canMerge = false;
      }
      if (govConflict) { blocked.push('gov_id_conflict'); canMerge = false; risk = 'critical'; evidence = 'conflicting'; }
      else if (sameGov) { evidence = 'strong'; risk = 'low'; }
      else if (bothHaveParents && !sameGov) { blocked.push('both_have_parents'); canMerge = false; risk = 'critical'; evidence = 'conflicting'; }
      else if (oneHasParent) { evidence = 'strong'; risk = 'low'; }
      else { evidence = 'possible'; risk = 'high'; }
      if (examConflicts > 0) { blocked.push('exam_conflict'); canMerge = false; if (risk !== 'critical') risk = 'high'; evidence = 'conflicting'; }
      // special case: Abshir pair must be blocked with exam conflict
      // Axmed pair remains mergeable
      const preview: any = {
        canonical: { id: can.id, name: can.name, className: can.className, govId: can.govId, parentId: can.parentId, parentPhone: can.parentPhone, transport: can.transport, familyId: can.familyId, createdAt: can.createdAt },
        duplicate: { id: dup.id, name: dup.name, className: dup.className, govId: dup.govId, parentId: dup.parentId, parentPhone: dup.parentPhone, transport: dup.transport, familyId: dup.familyId, createdAt: dup.createdAt },
        counts: {
          exams: { canonical: canExams.length, duplicate: dupExams.length, conflicts: examConflicts },
          attendance: { canonical: mockTables.attendance.filter((a: any) => a.studentId === canId).length, duplicate: mockTables.attendance.filter((a: any) => a.studentId === dupId).length, conflicts: 0 },
          homework: { canonical: mockTables.homework.filter((h: any) => h.studentId === canId).length, duplicate: mockTables.homework.filter((h: any) => h.studentId === dupId).length },
          promotions: { canonical: mockTables.student_promotions.filter((p: any) => p.studentId === canId).length, duplicate: mockTables.student_promotions.filter((p: any) => p.studentId === dupId).length },
          quizAttempts: { canonical: mockTables.quiz_attempts.filter((q: any) => q.studentId === canId).length, duplicate: mockTables.quiz_attempts.filter((q: any) => q.studentId === dupId).length, conflicts: 0 },
          authorizedPickups: { canonical: mockTables.authorized_pickup_students.filter((x: any) => x.studentId === canId).length, duplicate: mockTables.authorized_pickup_students.filter((x: any) => x.studentId === dupId).length },
          releaseLogs: { canonical: mockTables.release_log.filter((r: any) => r.studentId === canId).length, duplicate: mockTables.release_log.filter((r: any) => r.studentId === dupId).length, conflicts: 0 },
          reportComments: { canonical: mockTables.report_comments.filter((r: any) => r.studentId === canId).length, duplicate: mockTables.report_comments.filter((r: any) => r.studentId === dupId).length },
          enrollments: {
            canonicalOpen: canOpen ? { className: canOpen.className, academicYearId: canOpen.academicYearId, effectiveFrom: canOpen.effectiveFrom } : null,
            duplicateOpen: dupOpen ? { className: dupOpen.className, academicYearId: dupOpen.academicYearId, effectiveFrom: dupOpen.effectiveFrom } : null,
            canonicalHistory: mockTables.student_enrollments.filter((e: any) => e.studentId === canId && e.effectiveTo != null).length,
            duplicateHistory: mockTables.student_enrollments.filter((e: any) => e.studentId === dupId && e.effectiveTo != null).length,
          },
        },
        enrollment: {
          canonicalOpen: canOpen ? { className: canOpen.className, academicYearId: canOpen.academicYearId } : null,
          duplicateOpen: dupOpen ? { className: dupOpen.className, academicYearId: dupOpen.academicYearId } : null,
          action: dupOpen && canOpen && canOpen.className === dupOpen.className && (canOpen.academicYearId || null) === (dupOpen.academicYearId || null) ? 'consolidate' : dupOpen ? (canOpen && (canOpen.className !== dupOpen.className || (canOpen.academicYearId || null) !== (dupOpen.academicYearId || null)) ? 'blocked' : 'transfer') : 'preserve_history',
          willConsolidate: !!(dupOpen && canOpen && canOpen.className === dupOpen.className && (canOpen.academicYearId || null) === (dupOpen.academicYearId || null)),
          canMerge,
        },
        conflicts: { examConflicts, attendanceConflicts: 0, quizConflicts: 0, releaseConflicts: 0, govConflict, bothHaveParents, sameGov },
        canMerge,
        blockedReasons: blocked,
        riskLevel: risk,
        evidence,
      };
      return { data: preview, error: null };
    }
    if (fn === 'merge_duplicate_students' || fn === 'merge_students') {
      if (isAnon || !isAdmin) return { data: null, error: { message: 'Only administrators may merge students.', code: '42501' } };
      const canId = params?.p_canonical_id ?? params?.p_canonicalId;
      const dupId = params?.p_duplicate_id ?? params?.p_duplicateId;
      const reason = params?.p_reason ?? null;
      const can = findStudent(canId);
      const dup = findStudent(dupId);
      if (!can || !dup) return { data: null, error: { message: 'Student not found' } };
      const canHasGov = !!can.govId;
      const dupHasGov = !!dup.govId;
      const govConflict = canHasGov && dupHasGov && govKey(can.govId) !== '' && govKey(dup.govId) !== '' && govKey(can.govId) !== govKey(dup.govId);
      if (govConflict) return { data: null, error: { message: 'Merge blocked: different Government IDs' } };
      const bothHaveParents = !!can.parentId && !!dup.parentId;
      const sameGov = canHasGov && dupHasGov && govKey(can.govId) !== '' && govKey(can.govId) === govKey(dup.govId);
      if (bothHaveParents && !sameGov) return { data: null, error: { message: 'Merge blocked: both records have different parents' } };
      // Enrollment safety: multiple opens and academicYear check
      const canOpenCntChk = mockTables.student_enrollments.filter((e: any) => e.studentId === canId && e.effectiveTo == null).length;
      const dupOpenCntChk = mockTables.student_enrollments.filter((e: any) => e.studentId === dupId && e.effectiveTo == null).length;
      if (canOpenCntChk > 1 || dupOpenCntChk > 1) return { data: null, error: { message: 'Merge blocked: multiple open enrollments detected. ENROLLMENT_CONFLICT' } };
      const canOpenChk = mockTables.student_enrollments.find((e: any) => e.studentId === canId && e.effectiveTo == null) || null;
      const dupOpenChk = mockTables.student_enrollments.find((e: any) => e.studentId === dupId && e.effectiveTo == null) || null;
      if (canOpenChk && dupOpenChk && (canOpenChk.className !== dupOpenChk.className || (canOpenChk.academicYearId || null) !== (dupOpenChk.academicYearId || null))) {
        return { data: null, error: { message: `Merge blocked: enrollment histories are contradictory (${canOpenChk.className} vs ${dupOpenChk.className} / year ${canOpenChk.academicYearId || 'null'} vs ${dupOpenChk.academicYearId || 'null'}). ENROLLMENT_CONFLICT` } };
      }
      const canExams = mockTables.exams.filter((e: any) => e.studentId === canId);
      const dupExams = mockTables.exams.filter((e: any) => e.studentId === dupId);
      let examConflicts = 0;
      for (const d of dupExams) for (const c of canExams) if ((c.subjectId||null)===(d.subjectId||null) && c.examType===d.examType && (c.assessmentLabel||null)===(d.assessmentLabel||null) && (c.termId||null)===(d.termId||null)) { examConflicts++; break; }
      if (examConflicts > 0) return { data: null, error: { message: `Merge blocked: ${examConflicts} exam identity conflicts detected.` } };
      // Preserve gov if canonical blank
      if (!can.govId && dup.govId) {
        can.govId = dup.govId;
        dup.govId = null as any;
      }
      // Transfer enrollments: consolidate duplicate open only if same class AND same academicYearId
      const canOpen = mockTables.student_enrollments.find((e: any) => e.studentId === canId && e.effectiveTo == null);
      const dupOpen = mockTables.student_enrollments.find((e: any) => e.studentId === dupId && e.effectiveTo == null);
      if (dupOpen) {
        if (canOpen && canOpen.className === dupOpen.className && (canOpen.academicYearId || null) === (dupOpen.academicYearId || null)) {
          mockTables.student_enrollments = mockTables.student_enrollments.filter((e: any) => e.id !== dupOpen.id);
        } else {
          dupOpen.studentId = canId;
        }
      }
      // Transfer remaining enrollments
      for (const e of mockTables.student_enrollments) if (e.studentId === dupId) e.studentId = canId;
      // Transfer history tables
      for (const t of ['exams','attendance','homework','student_promotions','quiz_attempts','report_comments','release_log'] as const) {
        for (const r of mockTables[t] as any[]) if (r.studentId === dupId) r.studentId = canId;
      }
      // authorized_pickup_students
      const toMove = mockTables.authorized_pickup_students.filter((x: any) => x.studentId === dupId);
      for (const r of toMove) {
        const exists = mockTables.authorized_pickup_students.some((x: any) => x.authorizedPickupId === r.authorizedPickupId && x.studentId === canId);
        if (!exists) { r.studentId = canId; } else { mockTables.authorized_pickup_students = mockTables.authorized_pickup_students.filter((x: any) => x !== r); }
      }
      // Delete duplicate student
      mockTables.students = mockTables.students.filter((s: any) => s.id !== dupId);
      const auditId = `merge-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      const before = { exams: { canonical: canExams.length, duplicate: dupExams.length } };
      const after = { exams: mockTables.exams.filter((e: any) => e.studentId === canId).length };
      const enrollmentAction = dupOpen && canOpen && canOpen.className === dupOpen.className ? { action: 'consolidate', canonicalOpen: canOpen.className, duplicateOpen: dupOpen.className } : { action: 'preserve' };
      const audit = { id: auditId, canonical_id: canId, duplicate_id: dupId, admin_id: 'preview-admin', reason, before_counts: before, after_counts: after, enrollment_action: enrollmentAction, created_at: new Date().toISOString() };
      mockTables.student_merge_audits.push(audit);
      mockTables.audit_logs.push({ id: mockTables.audit_logs.length + 1, action: 'students.merge', details: { auditId, canonicalId: canId, duplicateId: dupId, reason }, createdAt: new Date().toISOString() });
      return { data: { auditId, canonicalId: canId, duplicateId: dupId, before, after, enrollmentAction, createdAt: new Date().toISOString() }, error: null };
    }

    // ── Student creation / import — Axmed-type duplicate prevention (mock) ──
    const normalizeName = (n: string) => (n || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const findStrongDuplicate = (name: string, cls: string, parentId: string | null | undefined, govId: string | null | undefined, parentPhone: string | null | undefined) => {
      const inGov = govKey(govId);
      const inParent = !!parentId;
      for (const s of mockTables.students as any[]) {
        const norm = normalizeName(s.name);
        if (norm !== normalizeName(name) || s.className !== cls) continue;
        const candGov = govKey(s.govId);
        const candParent = !!s.parentId;
        const sameGov = candGov !== '' && inGov !== '' && candGov === inGov;
        const conflictingGov = candGov !== '' && inGov !== '' && candGov !== inGov;
        if (sameGov) return s.id;
        if (conflictingGov && candParent && inParent) continue; // genuine distinct, allow
        if (candParent !== inParent) {
          if (candParent && candGov !== '' && !inParent) return s.id;
          if (inParent && inGov !== '' && !candParent) return s.id;
        }
      }
      return null;
    };
    if (fn === 'create_student') {
      const p_name = params?.p_name ?? '';
      const p_class = params?.p_class ?? '';
      const p_parent_id = params?.p_parent_id ?? null;
      const p_gov_id = params?.p_gov_id ?? null;
      const p_parent_phone = params?.p_parent_phone ?? null;
      if (!p_name?.trim() || !p_class?.trim()) return { data: null, error: { message: 'Student name is required.' } };
      const gov = govKey(p_gov_id);
      if (gov !== '' && mockTables.students.some((s:any) => govKey(s.govId) === gov)) {
        return { data: null, error: { message: `Gov ID ${gov} is already assigned to another student.` } };
      }
      const dup = findStrongDuplicate(p_name, p_class, p_parent_id, p_gov_id, p_parent_phone);
      if (dup) {
        return { data: null, error: { message: `Possible duplicate detected: same name/class with strong identity (parent vs unassigned + Gov ID). Existing student ${dup} — manual review required via Duplicate Students page.` } };
      }
      const newId = `student-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      const newStudent: any = { id: newId, name: p_name.trim(), className: p_class.trim(), parentId: p_parent_id || null, govId: p_gov_id?.trim() ? p_gov_id.trim() : null, parentPhone: p_parent_phone ? String(p_parent_phone).trim() : null, createdAt: new Date().toISOString(), transport: null, familyId: null };
      mockTables.students.push(newStudent);
      const ay = params?.p_academic_year_id || 'ay-2026';
      mockTables.student_enrollments.push({ id: `enr-${newId}-open`, studentId: newId, className: newStudent.className, academicYearId: ay, effectiveFrom: new Date().toISOString().slice(0,10), effectiveTo: null, reason: 'import', sourceRef: 'create_student' });
      return { data: { id: newId, name: newStudent.name, className: newStudent.className }, error: null };
    }
    if (fn === 'bulk_create_students') {
      const rows = params?.p_students ?? [];
      if (!Array.isArray(rows)) return { data: null, error: { message: 'Payload must be a JSON array.' } };
      const seenGov = new Set<string>();
      for (const r of rows) {
        const name = r.name ?? r.studentName ?? '';
        const cls = r.className ?? r.class ?? '';
        const gov = govKey(r.govId);
        const parentId = r.parentId ?? null;
        const phone = r.parentPhone ?? null;
        if (!name?.trim() || !cls?.trim()) return { data: null, error: { message: 'Every new student requires a name and a class.' } };
        if (gov !== '') {
          if (seenGov.has(gov) || mockTables.students.some((s:any) => govKey(s.govId) === gov)) {
            return { data: null, error: { message: `Duplicate Gov ID ${gov} in bulk create.` } };
          }
          seenGov.add(gov);
        }
        const dup = findStrongDuplicate(name, cls, parentId, r.govId, phone);
        if (dup) return { data: null, error: { message: `Possible duplicate in bulk create: ${name} / ${cls} matches existing student ${dup} (parent vs unassigned + Gov). Manual review required.` } };
      }
      // All clear — create
      for (const r of rows) {
        const newId = `student-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        const gov = r.govId?.trim() ? r.govId.trim() : null;
        const newStudent: any = { id: newId, name: r.name.trim(), className: r.className.trim(), parentId: r.parentId || null, govId: gov, parentPhone: r.parentPhone ? String(r.parentPhone).trim() : null, createdAt: new Date().toISOString(), transport: null, familyId: null };
        mockTables.students.push(newStudent);
        mockTables.student_enrollments.push({ id: `enr-${newId}-open`, studentId: newId, className: newStudent.className, academicYearId: 'ay-2026', effectiveFrom: new Date().toISOString().slice(0,10), effectiveTo: null, reason: 'import', sourceRef: 'bulk_create' });
      }
      return { data: { createdCount: rows.length }, error: null };
    }
    if (fn === 'apply_student_class_import') {
      const p_changes = params?.p_changes ?? [];
      const p_new_students = params?.p_new_students ?? [];
      const p_academic_year_id = params?.p_academic_year_id ?? 'ay-2026';
      // Handle stable ID class changes
      for (const ch of p_changes) {
        const sid = ch.studentId ?? ch.student_id;
        const toClass = ch.toClass ?? ch.to_class;
        if (!sid || !toClass) return { data: null, error: { message: 'A class change is missing its student ID.' } };
        const stu = mockTables.students.find((s:any) => s.id === sid);
        if (!stu) return { data: null, error: { message: `Student ID "${sid}" does not exist.` } };
        if (stu.className !== toClass) {
          stu.className = toClass;
          // update or create enrollment open
          const enr = mockTables.student_enrollments.find((e:any) => e.studentId === sid && e.effectiveTo == null);
          if (enr) { enr.className = toClass; enr.academicYearId = p_academic_year_id; }
          else mockTables.student_enrollments.push({ id: `enr-${sid}-open`, studentId: sid, className: toClass, academicYearId: p_academic_year_id, effectiveFrom: new Date().toISOString().slice(0,10), effectiveTo: null, reason: 'transfer', sourceRef: 'import' });
        }
      }
      // Handle new students with prevention
      const seenIds = new Set<string>();
      for (const ch of p_changes) seenIds.add(ch.studentId);
      const seenGov2 = new Set<string>();
      for (const ns of p_new_students) {
        const nid = ns.id ?? ns.studentId ?? '';
        const name = ns.name ?? '';
        const cls = ns.className ?? ns.class ?? '';
        const gov = govKey(ns.govId);
        if (nid && seenIds.has(nid)) return { data: null, error: { message: `Student ID "${nid}" appears more than once in the import.` } };
        if (nid && mockTables.students.some((s:any) => s.id === nid)) return { data: null, error: { message: `Student ID "${nid}" already exists — a duplicate student was not created. Use class_change for existing Student ID.` } };
        if (!name?.trim()) return { data: null, error: { message: 'Student name is required for a new student.' } };
        if (gov !== '') {
          if (seenGov2.has(gov) || mockTables.students.some((s:any) => govKey(s.govId) === gov)) return { data: null, error: { message: `Gov ID ${gov} is already assigned — duplicate student not created.` } };
          seenGov2.add(gov);
        }
        if (nid) seenIds.add(nid);
        const dup = findStrongDuplicate(name, cls, ns.parentId ?? null, ns.govId ?? null, ns.parentPhone ?? null);
        if (dup) return { data: null, error: { message: `Possible duplicate in import: ${name} / ${cls} matches existing student ${dup} (strong identity: parent vs unassigned + Gov). Manual review required via Duplicate Students.` } };
      }
      // All checks passed — create new
      const created: any[] = [];
      for (const ns of p_new_students) {
        const nid = ns.id && String(ns.id).trim() ? String(ns.id).trim() : `student-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        const gov = ns.govId?.trim() ? ns.govId.trim() : null;
        const newStudent: any = { id: nid, name: ns.name.trim(), className: ns.className.trim(), parentId: ns.parentId || null, govId: gov, parentPhone: ns.parentPhone ? String(ns.parentPhone).trim() : null, createdAt: new Date().toISOString(), transport: null, familyId: null };
        mockTables.students.push(newStudent);
        mockTables.student_enrollments.push({ id: `enr-${nid}-open`, studentId: nid, className: newStudent.className, academicYearId: p_academic_year_id, effectiveFrom: new Date().toISOString().slice(0,10), effectiveTo: null, reason: 'import', sourceRef: 'apply_import' });
        created.push({ studentId: nid, name: newStudent.name, className: newStudent.className });
      }
      return { data: { importRef: params?.p_import_ref || `class-import-${Date.now()}`, updatedCount: p_changes.length, createdCount: created.length, skippedCount: 0, changes: p_changes.map((c:any)=>({ studentId: c.studentId, name: mockTables.students.find((s:any)=>s.id===c.studentId)?.name || '', fromClass: '', toClass: c.toClass })), created }, error: null };
    }
    if (fn === 'check_class_import_payload' || fn === 'resolve_class_import_rows') {
      // For preview, return ok (real check would be similar but we simplify)
      if (fn === 'check_class_import_payload') return { data: { ok: true, problemCount: 0, problems: [] }, error: null };
      if (fn === 'resolve_class_import_rows') return { data: [], error: null };
    }


    // ── Detailed merge conflicts (lazy loading) ──
    if (fn === 'get_merge_conflicts') {
      if (isAnon || !isAdmin) return { data: null, error: { message: 'Only administrators may view merge conflicts.', code: '42501' } };
      const canId = params?.p_canonical_id ?? params?.p_canonicalId;
      const dupId = params?.p_duplicate_id ?? params?.p_duplicateId;
      const can = findStudent(canId);
      const dup = findStudent(dupId);
      if (!can || !dup) return { data: null, error: { message: 'Student not found', code: 'PGRST116' } };
      const profile = {
        govIdConflict: (can.govId||'') !== (dup.govId||''),
        parentConflict: (can.parentId||null) !== (dup.parentId||null),
        nameConflict: can.name !== dup.name,
        classConflict: can.className !== dup.className,
        transportConflict: (can.transport||'') !== (dup.transport||''),
        phoneConflict: (can.parentPhone||'') !== (dup.parentPhone||''),
        canonical: { id: can.id, name: can.name, className: can.className, govId: can.govId, parentId: can.parentId, parentPhone: can.parentPhone, transport: can.transport, familyId: can.familyId },
        duplicate: { id: dup.id, name: dup.name, className: dup.className, govId: dup.govId, parentId: dup.parentId, parentPhone: dup.parentPhone, transport: dup.transport, familyId: dup.familyId },
      };
      const canExams = mockTables.exams.filter((e:any)=>e.studentId===canId);
      const dupExams = mockTables.exams.filter((e:any)=>e.studentId===dupId);
      const examConflicts:any[] = [];
      for (const c of canExams) for (const d of dupExams) if ((c.subjectId||null)===(d.subjectId||null) && c.examType===d.examType && (c.assessmentLabel||null)===(d.assessmentLabel||null) && (c.termId||null)===(d.termId||null)) examConflicts.push({ identity: { subjectId: c.subjectId, examType: c.examType, assessmentLabel: c.assessmentLabel, termId: c.termId, subject: c.subject }, canonical: { id: c.id, score: c.score, total: c.total, status: c.status, createdAt: c.createdAt, date: c.date, subjectId: c.subjectId, examType: c.examType, assessmentLabel: c.assessmentLabel, termId: c.termId }, duplicate: { id: d.id, score: d.score, total: d.total, status: d.status, createdAt: d.createdAt, date: d.date, subjectId: d.subjectId, examType: d.examType, assessmentLabel: d.assessmentLabel, termId: d.termId }, identical: c.score===d.score && c.total===d.total && (c.subjectId||null)===(d.subjectId||null) });
      // Attendance same date
      const attConflicts:any[] = [];
      const canAtt = mockTables.attendance.filter((a:any)=>a.studentId===canId);
      const dupAtt = mockTables.attendance.filter((a:any)=>a.studentId===dupId);
      for (const c of canAtt) for (const d of dupAtt) if (c.date===d.date) attConflicts.push({ identity: { date: c.date }, canonical: { id: c.id, status: c.status, date: c.date, className: c.className, createdAt: c.createdAt }, duplicate: { id: d.id, status: d.status, date: d.date, className: d.className, createdAt: d.createdAt } });
      // Quiz same quizId
      const quizConflicts:any[] = [];
      const canQuiz = mockTables.quiz_attempts.filter((q:any)=>q.studentId===canId);
      const dupQuiz = mockTables.quiz_attempts.filter((q:any)=>q.studentId===dupId);
      for (const c of canQuiz) for (const d of dupQuiz) if (c.quizId===d.quizId) quizConflicts.push({ identity: { quizId: c.quizId }, canonical: { id: c.id, quizId: c.quizId, totalEarned: c.totalEarned, status: c.status, submittedAt: c.submittedAt }, duplicate: { id: d.id, quizId: d.quizId, totalEarned: d.totalEarned, status: d.status, submittedAt: d.submittedAt } });
      // Release same UTC day
      const relConflicts:any[] = [];
      const canRel = mockTables.release_log.filter((r:any)=>r.studentId===canId);
      const dupRel = mockTables.release_log.filter((r:any)=>r.studentId===dupId);
      for (const c of canRel) for (const d of dupRel) if ((c.createdAt||'').slice(0,10)===(d.createdAt||'').slice(0,10)) relConflicts.push({ identity: { day: (c.createdAt||'').slice(0,10) }, canonical: { id: c.id, createdAt: c.createdAt, studentId: c.studentId }, duplicate: { id: d.id, createdAt: d.createdAt, studentId: d.studentId } });
      // Report same termId
      const repConflicts:any[] = [];
      const canRep = mockTables.report_comments.filter((r:any)=>r.studentId===canId);
      const dupRep = mockTables.report_comments.filter((r:any)=>r.studentId===dupId);
      for (const c of canRep) for (const d of dupRep) if (c.termId===d.termId) repConflicts.push({ identity: { termId: c.termId }, canonical: { id: c.id, termId: c.termId, teacherComment: c.teacherComment, principalComment: c.principalComment }, duplicate: { id: d.id, termId: d.termId, teacherComment: d.teacherComment, principalComment: d.principalComment } });
      const canOpen = mockTables.student_enrollments.find((e:any)=>e.studentId===canId && e.effectiveTo==null) || null;
      const dupOpen = mockTables.student_enrollments.find((e:any)=>e.studentId===dupId && e.effectiveTo==null) || null;
      const enrollments = {
        canonicalOpen: canOpen ? { id: canOpen.id, className: canOpen.className, academicYearId: canOpen.academicYearId, effectiveFrom: canOpen.effectiveFrom } : null,
        duplicateOpen: dupOpen ? { id: dupOpen.id, className: dupOpen.className, academicYearId: dupOpen.academicYearId, effectiveFrom: dupOpen.effectiveFrom } : null,
        canonicalHistory: mockTables.student_enrollments.filter((e:any)=>e.studentId===canId && e.effectiveTo!=null).length,
        duplicateHistory: mockTables.student_enrollments.filter((e:any)=>e.studentId===dupId && e.effectiveTo!=null).length,
      };
      return { data: { profile, exams: examConflicts, attendance: attConflicts, quizAttempts: quizConflicts, releaseLogs: relConflicts, reportComments: repConflicts, enrollments, counts: { exams: examConflicts.length, attendance: attConflicts.length, quizAttempts: quizConflicts.length, releaseLogs: relConflicts.length, reportComments: repConflicts.length } }, error: null };
    }

    // ── Resolved merge (guided resolution) ──
    if (fn === 'merge_duplicate_students_resolved' || fn === 'merge_with_resolution') {
      if (isAnon || !isAdmin) return { data: null, error: { message: 'Only administrators may merge students.', code: '42501' } };
      const canId = params?.p_canonical_id ?? params?.p_canonicalId ?? params?.p_canonical_id;
      const dupId = params?.p_duplicate_id ?? params?.p_duplicateId ?? params?.p_duplicate_id;
      const resolution = params?.p_resolution ?? params?.p_resolution ?? params?.p_resolution ?? {};
      const reason = params?.p_reason ?? null;
      // Normalize resolution shape: allow both snake and camel, also allow p_profile_resolution etc if passed directly
      const prof = resolution?.profile_resolution ?? resolution?.profileResolution ?? resolution?.profile ?? {};
      const examRes = resolution?.exam_resolution ?? resolution?.examResolution ?? resolution?.exams ?? [];
      const attRes = resolution?.attendance_resolution ?? resolution?.attendanceResolution ?? resolution?.attendance ?? [];
      const quizRes = resolution?.quiz_resolution ?? resolution?.quizResolution ?? resolution?.quizAttempts ?? [];
      const relRes = resolution?.release_resolution ?? resolution?.releaseResolution ?? resolution?.releaseLogs ?? [];
      const repRes = resolution?.report_comment_resolution ?? resolution?.reportCommentResolution ?? resolution?.reportComments ?? [];
      const enrRes = resolution?.enrollment_resolution ?? resolution?.enrollmentResolution ?? resolution?.enrollment ?? null;
      // Also support top-level params if caller passed p_profile_resolution etc separately (older spec)
      const p_prof = params?.p_profile_resolution ?? params?.p_profileResolution;
      const finalProf = p_prof ? p_prof : prof;
      const finalExamRes = params?.p_exam_resolution ?? params?.p_examResolution ?? examRes;
      const finalAttRes = params?.p_attendance_resolution ?? attRes;
      const finalQuizRes = params?.p_quiz_resolution ?? quizRes;
      const finalRelRes = params?.p_release_resolution ?? relRes;
      const finalRepRes = params?.p_report_comment_resolution ?? repRes;
      const finalEnrRes = params?.p_enrollment_resolution ?? enrRes;
      const can = findStudent(canId);
      const dup = findStudent(dupId);
      if (!can || !dup) return { data: null, error: { message: 'Student not found' } };
      // Snapshot for rollback
      const backup = JSON.parse(JSON.stringify(mockTables));
      try {
        // Validate Gov not belonging to third student if final gov chosen
        const choiceGov = (finalProf?.gov_id ?? finalProf?.govId ?? finalProf?.gov ?? 'canonical');
        let finalGov: string | null = null;
        if (choiceGov === 'remove' || choiceGov === 'blank') finalGov = null;
        else if (choiceGov === 'duplicate' || choiceGov === 'B') finalGov = dup.govId ? String(dup.govId).trim() : null;
        else finalGov = can.govId ? String(can.govId).trim() : null;
        // Normalize empty
        if (finalGov === '') finalGov = null;
        if (finalGov) {
          const gkey = govKey(finalGov);
          if (gkey !== '' && mockTables.students.some((s:any)=> s.id!==canId && s.id!==dupId && govKey(s.govId)===gkey)) {
            throw new Error('This Government ID belongs to another student.');
          }
          // Also check duplicate gov in same batch? Already validated
          // Verify chosen gov is actually from canonical or duplicate (or blank)
          const canG = can.govId ? String(can.govId).trim() : null;
          const dupG = dup.govId ? String(dup.govId).trim() : null;
          const canGkey = canG ? govKey(canG) : '';
          const dupGkey = dupG ? govKey(dupG) : '';
          const finalGkey = govKey(finalGov);
          if (finalGkey !== '' && finalGkey !== canGkey && finalGkey !== dupGkey) {
            // Allow if one is blank? But if finalGov is non-blank not matching either, reject
            if (!(finalGov===canG || finalGov===dupG)) {
              // Check if caller tried to inject arbitrary gov
              throw new Error('Selected Gov ID does not belong to either student.');
            }
          }
        }
        // Validate parent exists if chosen
        const choiceParent = (finalProf?.parent_id ?? finalProf?.parentId ?? finalProf?.parent ?? 'canonical');
        let finalParent: string | null = null;
        let cp = choiceParent;
        if (cp === 'A') cp='canonical'; if (cp==='B') cp='duplicate';
        if (cp==='unassigned' || cp==='remove' || cp==='blank' || cp==='null') cp='remove';
        if (cp==='remove') finalParent=null;
        else if (cp==='duplicate') finalParent=dup.parentId;
        else finalParent=can.parentId;
        if (finalParent) {
          const exists = mockTables.profiles.some((p:any)=>p.id===finalParent) || mockTables.students.some((s:any)=>s.id===finalParent);
          // Also check demoProfiles via mockTables.profiles already includes demo
          // If not found in mock, check demoProfiles directly (already in mockTables.profiles)
          if (!mockTables.profiles.some((p:any)=>p.id===finalParent)) {
            // Check if it's a valid profile in mockTables (maybe not seeded)
            // To keep lenient, allow if parentId is from either student (since they were valid at creation)
            const isFromEither = finalParent===can.parentId || finalParent===dup.parentId;
            if (!isFromEither) throw new Error(`Selected parent ${finalParent} does not exist.`);
          }
        }
        // Validate parentPhone choice
        const choicePhone = (finalProf?.parent_phone ?? finalProf?.parentPhone ?? 'canonical');
        // No strict validation beyond belonging check (phone is free form)
        // Validate transport, name, class
        const choiceName = (finalProf?.name ?? 'canonical');
        const choiceClass = (finalProf?.class_name ?? finalProf?.className ?? finalProf?.class ?? 'canonical');
        const choiceTransport = (finalProf?.transport ?? 'canonical');
        // Validate enrollment
        const canOpen = mockTables.student_enrollments.find((e:any)=>e.studentId===canId && e.effectiveTo==null) || null;
        const dupOpen = mockTables.student_enrollments.find((e:any)=>e.studentId===dupId && e.effectiveTo==null) || null;
        const canOpenCnt = mockTables.student_enrollments.filter((e:any)=>e.studentId===canId && e.effectiveTo==null).length;
        const dupOpenCnt = mockTables.student_enrollments.filter((e:any)=>e.studentId===dupId && e.effectiveTo==null).length;
        if (canOpenCnt>1 || dupOpenCnt>1) throw new Error('Merge blocked: multiple open enrollments detected. ENROLLMENT_CONFLICT');
        let enrollAction = 'consolidate';
        let enrollKeep = 'canonical';
        if (finalEnrRes && typeof finalEnrRes==='object' && !Array.isArray(finalEnrRes)) {
          enrollAction = finalEnrRes.action ?? finalEnrRes.keep ?? 'consolidate';
          enrollKeep = finalEnrRes.keep ?? 'canonical';
          // Normalize aliases (preserve canonical/duplicate semantics)
          if (enrollAction==='keep_canonical') { enrollAction='preserve_history'; enrollKeep='canonical'; }
          else if (enrollAction==='keep_duplicate') { enrollAction='transfer'; enrollKeep='duplicate'; }
        } else {
          if (canOpen && dupOpen && canOpen.className===dupOpen.className && (canOpen.academicYearId||null)===(dupOpen.academicYearId||null)) enrollAction='consolidate';
          else if (dupOpen && !canOpen) enrollAction='transfer';
          else if (!dupOpen) enrollAction='preserve_history';
          else enrollAction='blocked';
        }
        if (canOpen && dupOpen && (canOpen.className!==dupOpen.className || (canOpen.academicYearId||null)!==(dupOpen.academicYearId||null))) {
          if (!finalEnrRes) throw new Error(`Enrollment histories are contradictory (${canOpen.className} vs ${dupOpen.className} / year ${canOpen.academicYearId||'null'} vs ${dupOpen.academicYearId||'null'}). Provide explicit enrollment_resolution.`);
          if (enrollAction==='consolidate') throw new Error('Cannot consolidate enrollments with different class or academic year. Choose transfer or preserve.');
        }
        // Validate exam conflicts: need resolution for each
        const canExams = mockTables.exams.filter((e:any)=>e.studentId===canId);
        const dupExams = mockTables.exams.filter((e:any)=>e.studentId===dupId);
        const examConflicts: any[] = [];
        for (const d of dupExams) for (const c of canExams) if ((c.subjectId||null)===(d.subjectId||null) && c.examType===d.examType && (c.assessmentLabel||null)===(d.assessmentLabel||null) && (c.termId||null)===(d.termId||null)) examConflicts.push({c,d});
        // Attendance
        const canAtt = mockTables.attendance.filter((a:any)=>a.studentId===canId);
        const dupAtt = mockTables.attendance.filter((a:any)=>a.studentId===dupId);
        const attConflicts:any[]=[]; for (const c of canAtt) for (const d of dupAtt) if (c.date===d.date) attConflicts.push({c,d});
        const canQuiz = mockTables.quiz_attempts.filter((q:any)=>q.studentId===canId);
        const dupQuiz = mockTables.quiz_attempts.filter((q:any)=>q.studentId===dupId);
        const quizConflicts:any[]=[]; for (const c of canQuiz) for (const d of dupQuiz) if (c.quizId===d.quizId) quizConflicts.push({c,d});
        const canRel = mockTables.release_log.filter((r:any)=>r.studentId===canId);
        const dupRel = mockTables.release_log.filter((r:any)=>r.studentId===dupId);
        const relConflicts:any[]=[]; for (const c of canRel) for (const d of dupRel) if ((c.createdAt||'').slice(0,10)===(d.createdAt||'').slice(0,10)) relConflicts.push({c,d});
        const canRep = mockTables.report_comments.filter((r:any)=>r.studentId===canId);
        const dupRep = mockTables.report_comments.filter((r:any)=>r.studentId===dupId);
        const repConflicts:any[]=[]; for (const c of canRep) for (const d of dupRep) if (c.termId===d.termId) repConflicts.push({c,d});

        const examResArr = Array.isArray(finalExamRes) ? finalExamRes : [];
        const attResArr = Array.isArray(finalAttRes) ? finalAttRes : [];
        const quizResArr = Array.isArray(finalQuizRes) ? finalQuizRes : [];
        const relResArr = Array.isArray(finalRelRes) ? finalRelRes : [];
        const repResArr = Array.isArray(finalRepRes) ? finalRepRes : [];

        if (examConflicts.length!==examResArr.length) {
          if (examConflicts.length>0 && examResArr.length===0) throw new Error(`Exam conflicts require resolution: ${examConflicts.length} conflicts, 0 provided`);
          if (examConflicts.length!==examResArr.length) throw new Error(`Exam resolution incomplete: ${examConflicts.length} conflicts, ${examResArr.length} provided`);
        }
        if (attConflicts.length!==attResArr.length) {
          if (attConflicts.length>0 && attResArr.length===0) throw new Error(`Attendance conflicts require resolution: ${attConflicts.length} conflicts`);
          if (attConflicts.length!==attResArr.length) throw new Error('Attendance resolution incomplete');
        }
        if (quizConflicts.length!==quizResArr.length) {
          if (quizConflicts.length>0 && quizResArr.length===0) throw new Error(`Quiz conflicts require resolution: ${quizConflicts.length} conflicts`);
          if (quizConflicts.length!==quizResArr.length) throw new Error('Quiz resolution incomplete');
        }
        if (relConflicts.length!==relResArr.length) {
          if (relConflicts.length>0 && relResArr.length===0) throw new Error(`Release conflicts require resolution: ${relConflicts.length} conflicts`);
          if (relConflicts.length!==relResArr.length) throw new Error('Release resolution incomplete');
        }
        if (repConflicts.length!==repResArr.length) {
          if (repConflicts.length>0 && repResArr.length===0) throw new Error(`Report comment conflicts require resolution: ${repConflicts.length} conflicts`);
          if (repConflicts.length!==repResArr.length) throw new Error('Report resolution incomplete');
        }
        // Validate each exam resolution points to valid ids belonging to correct students and matching identity
        for (let i=0;i<examResArr.length;i++) {
          const r = examResArr[i];
          const keep = r.keep ?? r.Keep ?? '';
          const canIdR = r.canonical_exam_id ?? r.canonicalExamId ?? r.canonical_id ?? r.canId;
          const dupIdR = r.duplicate_exam_id ?? r.duplicateExamId ?? r.duplicate_id ?? r.dupId;
          if (!['canonical','duplicate','A','B'].includes(keep)) throw new Error(`Invalid exam keep ${keep} at ${i}`);
          if (canIdR && !mockTables.exams.some((e:any)=>e.id===canIdR && e.studentId===canId)) throw new Error(`Exam ${canIdR} does not belong to canonical ${canId}`);
          if (dupIdR && !mockTables.exams.some((e:any)=>e.id===dupIdR && e.studentId===dupId)) throw new Error(`Exam ${dupIdR} does not belong to duplicate ${dupId}`);
          if (canIdR && dupIdR) {
            const c = mockTables.exams.find((e:any)=>e.id===canIdR);
            const d = mockTables.exams.find((e:any)=>e.id===dupIdR);
            if (!c || !d || (c.subjectId||null)!==(d.subjectId||null) || c.examType!==d.examType || (c.assessmentLabel||null)!==(d.assessmentLabel||null) || (c.termId||null)!==(d.termId||null)) throw new Error(`Exams ${canIdR} and ${dupIdR} do not share identity`);
          }
        }
        for (let i=0;i<attResArr.length;i++) {
          const r=attResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (!['canonical','duplicate','A','B'].includes(keep)) throw new Error(`Invalid attendance keep ${keep}`);
          if (canI && !mockTables.attendance.some((a:any)=>a.id===canI && a.studentId===canId)) throw new Error(`Attendance ${canI} not canonical`);
          if (dupI && !mockTables.attendance.some((a:any)=>a.id===dupI && a.studentId===dupId)) throw new Error(`Attendance ${dupI} not duplicate`);
          if (canI && dupI) {
            const c = mockTables.attendance.find((a:any)=>a.id===canI);
            const d = mockTables.attendance.find((a:any)=>a.id===dupI);
            if (!c || !d || c.date !== d.date) throw new Error(`Attendance ${canI} and ${dupI} do not share identical date`);
          }
        }
        for (let i=0;i<quizResArr.length;i++) {
          const r=quizResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (!['canonical','duplicate','A','B'].includes(keep)) throw new Error(`Invalid quiz keep ${keep}`);
          if (canI && !mockTables.quiz_attempts.some((q:any)=>q.id===canI && q.studentId===canId)) throw new Error(`Quiz ${canI} not canonical`);
          if (dupI && !mockTables.quiz_attempts.some((q:any)=>q.id===dupI && q.studentId===dupId)) throw new Error(`Quiz ${dupI} not duplicate`);
          if (canI && dupI) {
            const c = mockTables.quiz_attempts.find((q:any)=>q.id===canI);
            const d = mockTables.quiz_attempts.find((q:any)=>q.id===dupI);
            if (!c || !d || c.quizId !== d.quizId) throw new Error(`Quiz attempts ${canI} and ${dupI} do not share identical quizId`);
          }
        }
        for (let i=0;i<relResArr.length;i++) {
          const r=relResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (!['canonical','duplicate','A','B'].includes(keep)) throw new Error(`Invalid release keep ${keep}`);
          if (canI && !mockTables.release_log.some((x:any)=>x.id===canI && x.studentId===canId)) throw new Error(`Release ${canI} not canonical`);
          if (dupI && !mockTables.release_log.some((x:any)=>x.id===dupI && x.studentId===dupId)) throw new Error(`Release ${dupI} not duplicate`);
          if (canI && dupI) {
            const c = mockTables.release_log.find((x:any)=>x.id===canI);
            const d = mockTables.release_log.find((x:any)=>x.id===dupI);
            const cDay = (c?.createdAt||'').slice(0,10);
            const dDay = (d?.createdAt||'').slice(0,10);
            if (!c || !d || cDay !== dDay) throw new Error(`Release logs ${canI} and ${dupI} do not share identical UTC date`);
          }
        }
        for (let i=0;i<repResArr.length;i++) {
          const r=repResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (!['canonical','duplicate','A','B'].includes(keep)) throw new Error(`Invalid report keep ${keep}`);
          if (canI && !mockTables.report_comments.some((x:any)=>x.id===canI && x.studentId===canId)) throw new Error(`Report ${canI} not canonical`);
          if (dupI && !mockTables.report_comments.some((x:any)=>x.id===dupI && x.studentId===dupId)) throw new Error(`Report ${dupI} not duplicate`);
          if (canI && dupI) {
            const c = mockTables.report_comments.find((x:any)=>x.id===canI);
            const d = mockTables.report_comments.find((x:any)=>x.id===dupI);
            if (!c || !d || c.termId !== d.termId) throw new Error(`Report comments ${canI} and ${dupI} do not share identical termId`);
          }
        }

        // ── Apply profile ──
        // Gov: need to null duplicate first if moving
        if (finalGov !== (can.govId ? String(can.govId).trim() : null)) {
          if (finalGov === null) {
            can.govId = null;
          } else {
            if (dup.govId && govKey(dup.govId)===govKey(finalGov)) {
              dup.govId = null;
            }
            can.govId = finalGov;
          }
        }
        // Determine final values for other fields
        let finalName = can.name;
        if (choiceName==='duplicate' || choiceName==='B') finalName = dup.name;
        let finalClass = can.className;
        if (choiceClass==='duplicate' || choiceClass==='B') finalClass = dup.className;
        if (!finalClass || !String(finalClass).trim()) throw new Error('Class resolution yields empty');
        let finalTransport: string|null = can.transport ?? null;
        if (choiceTransport==='duplicate' || choiceTransport==='B') finalTransport = dup.transport ?? null;
        else if (choiceTransport==='remove' || choiceTransport==='blank') finalTransport = null;
        let finalPhone: string|null = can.parentPhone ?? null;
        if (choicePhone==='duplicate' || choicePhone==='B') finalPhone = dup.parentPhone ?? null;
        else if (choicePhone==='remove' || choicePhone==='blank') finalPhone = null;

        can.name = finalName;
        can.className = finalClass;
        can.parentId = finalParent;
        can.parentPhone = finalPhone;
        can.transport = finalTransport;

        // Enrollment handling — SAFE: exactly ONE open must remain
        const canOpen2 = mockTables.student_enrollments.find((e:any)=>e.studentId===canId && e.effectiveTo==null) || null;
        const dupOpen2 = mockTables.student_enrollments.find((e:any)=>e.studentId===dupId && e.effectiveTo==null) || null;
        const today = new Date().toISOString().slice(0,10);
        if (canOpen2 && dupOpen2) {
          const sameClassYear = canOpen2.className === dupOpen2.className && (canOpen2.academicYearId||null) === (dupOpen2.academicYearId||null);
          if (sameClassYear) {
            if (enrollAction==='consolidate') {
              mockTables.student_enrollments = mockTables.student_enrollments.filter((e:any)=>e.id!==dupOpen2.id);
            } else if ((enrollAction==='transfer' || enrollAction==='keep_duplicate') && enrollKeep==='duplicate') {
              // replace canonical with duplicate
              canOpen2.effectiveTo = today;
              dupOpen2.studentId = canId;
            } else {
              // keep canonical, close duplicate as historical
              dupOpen2.studentId = canId;
              dupOpen2.effectiveTo = today;
            }
          } else {
            // different class/year -> explicit required, exactly ONE open
            if (!finalEnrRes) throw new Error(`Enrollment histories are contradictory (${canOpen2.className} vs ${dupOpen2.className} / year ${canOpen2.academicYearId||'null'} vs ${dupOpen2.academicYearId||'null'}). Provide explicit enrollment_resolution.`);
            if (enrollAction==='consolidate') throw new Error('Cannot consolidate enrollments with different class or academic year. Choose transfer or preserve.');
            if (enrollKeep==='duplicate' || enrollAction==='keep_duplicate') {
              canOpen2.effectiveTo = today;
              dupOpen2.studentId = canId;
            } else {
              dupOpen2.studentId = canId;
              dupOpen2.effectiveTo = today;
            }
          }
        } else if (dupOpen2) {
          dupOpen2.studentId = canId;
        }
        for (const e of mockTables.student_enrollments) if (e.studentId===dupId) e.studentId=canId;
        // Update open enrollment class to match finalClass (only open)
        const finalOpen = mockTables.student_enrollments.find((e:any)=>e.studentId===canId && e.effectiveTo==null);
        if (finalOpen && finalOpen.className!==finalClass) finalOpen.className = finalClass;

        // Resolve conflicting history: delete losers
        for (let i=0;i<examResArr.length;i++) {
          const r=examResArr[i];
          const keep=r.keep; const canI=r.canonical_exam_id??r.canonicalExamId??r.canonical_id??r.canId; const dupI=r.duplicate_exam_id??r.duplicateExamId??r.duplicate_id??r.dupId;
          if (keep==='duplicate' || keep==='B') {
            if (canI) mockTables.exams = mockTables.exams.filter((e:any)=>e.id!==canI);
          } else {
            if (dupI) mockTables.exams = mockTables.exams.filter((e:any)=>e.id!==dupI);
          }
        }
        for (let i=0;i<attResArr.length;i++) {
          const r=attResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (keep==='duplicate' || keep==='B') { if (canI) mockTables.attendance = mockTables.attendance.filter((a:any)=>a.id!==canI); }
          else { if (dupI) mockTables.attendance = mockTables.attendance.filter((a:any)=>a.id!==dupI); }
        }
        for (let i=0;i<quizResArr.length;i++) {
          const r=quizResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (keep==='duplicate' || keep==='B') { if (canI) mockTables.quiz_attempts = mockTables.quiz_attempts.filter((q:any)=>q.id!==canI); }
          else { if (dupI) mockTables.quiz_attempts = mockTables.quiz_attempts.filter((q:any)=>q.id!==dupI); }
        }
        for (let i=0;i<relResArr.length;i++) {
          const r=relResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (keep==='duplicate' || keep==='B') { if (canI) mockTables.release_log = mockTables.release_log.filter((x:any)=>x.id!==canI); }
          else { if (dupI) mockTables.release_log = mockTables.release_log.filter((x:any)=>x.id!==dupI); }
        }
        for (let i=0;i<repResArr.length;i++) {
          const r=repResArr[i]; const keep=r.keep; const canI=r.canonical_id??r.canonicalId; const dupI=r.duplicate_id??r.duplicateId;
          if (keep==='duplicate' || keep==='B') { if (canI) mockTables.report_comments = mockTables.report_comments.filter((x:any)=>x.id!==canI); }
          else { if (dupI) mockTables.report_comments = mockTables.report_comments.filter((x:any)=>x.id!==dupI); }
        }

        // Transfer remaining non-conflicting
        for (const t of ['exams','attendance','homework','student_promotions','quiz_attempts','report_comments','release_log'] as const) {
          for (const r of mockTables[t] as any[]) if (r.studentId===dupId) r.studentId=canId;
        }
        const toMove = mockTables.authorized_pickup_students.filter((x:any)=>x.studentId===dupId);
        for (const r of toMove) {
          const exists = mockTables.authorized_pickup_students.some((x:any)=>x.authorizedPickupId===r.authorizedPickupId && x.studentId===canId);
          if (!exists) r.studentId=canId; else mockTables.authorized_pickup_students = mockTables.authorized_pickup_students.filter((x:any)=>x!==r);
        }

        // Final open-enrollment assertion: canonical must have exactly 1 open, duplicate 0 open and 0 total
        const canOpenCntFinal = mockTables.student_enrollments.filter((e:any)=>e.studentId===canId && e.effectiveTo==null).length;
        if (canOpenCntFinal !== 1) throw new Error(`Post-merge verification failed: canonical must have exactly 1 open enrollment, found ${canOpenCntFinal}`);
        const dupOpenCntFinal = mockTables.student_enrollments.filter((e:any)=>e.studentId===dupId && e.effectiveTo==null).length;
        if (dupOpenCntFinal !== 0) throw new Error(`Post-merge verification failed: duplicate still has ${dupOpenCntFinal} open enrollments`);
        const dupTotalEnr = mockTables.student_enrollments.filter((e:any)=>e.studentId===dupId).length;
        if (dupTotalEnr !== 0) throw new Error(`Post-merge verification failed: duplicate still has ${dupTotalEnr} enrollments`);
        // Verify duplicate has no children before delete
        const checks = [
          mockTables.exams.filter((e:any)=>e.studentId===dupId).length,
          mockTables.attendance.filter((a:any)=>a.studentId===dupId).length,
          mockTables.homework.filter((h:any)=>h.studentId===dupId).length,
          mockTables.student_promotions.filter((p:any)=>p.studentId===dupId).length,
          mockTables.quiz_attempts.filter((q:any)=>q.studentId===dupId).length,
          mockTables.authorized_pickup_students.filter((x:any)=>x.studentId===dupId).length,
          mockTables.release_log.filter((r:any)=>r.studentId===dupId).length,
          mockTables.report_comments.filter((r:any)=>r.studentId===dupId).length,
        ];
        if (checks.some(c=>c>0)) throw new Error('Post-merge verification failed: duplicate still has children');

        // Delete duplicate student
        mockTables.students = mockTables.students.filter((s:any)=>s.id!==dupId);

        // Audit
        const auditId = `merge-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        const before = { exams: { canonical: canExams.length, duplicate: dupExams.length } };
        const after = { exams: mockTables.exams.filter((e:any)=>e.studentId===canId).length };
        const enrollmentAction = { action: enrollAction, keep: enrollKeep };
        const audit = { id: auditId, canonical_id: canId, duplicate_id: dupId, admin_id: 'preview-admin', reason, before_counts: before, after_counts: after, enrollment_action: enrollmentAction, exam_conflicts: { examConflicts: examConflicts.length, resolution: resolution }, created_at: new Date().toISOString(), resolution };
        mockTables.student_merge_audits.push(audit);
        mockTables.audit_logs.push({ id: mockTables.audit_logs.length+1, action: 'students.merge', details: { auditId, canonicalId: canId, duplicateId: dupId, reason, resolution }, createdAt: new Date().toISOString() });
        return { data: { auditId, canonicalId: canId, duplicateId: dupId, before, after, enrollmentAction, createdAt: new Date().toISOString(), resolution }, error: null };
      } catch (e:any) {
        // Rollback
        for (const k of Object.keys(mockTables)) mockTables[k] = backup[k];
        return { data: null, error: { message: e.message || 'Merge failed' } };
      }
    }

    // ── SAFE DUPLICATE BATCH ────────────────────────────────────────────────
    // Mock of supabase/migrations/20260925_safe_duplicate_batch.sql so the
    // Admin → Duplicate Students page can exercise the batch flow without a
    // database. Eligibility is decided HERE (the mock server), never in the
    // client wrappers: exactly like production, where only the SECURITY DEFINER
    // RPCs decide. The rules mirror the SQL function _safe_batch_evaluate_pair.
    if (fn === 'get_safe_duplicate_batch' || fn === 'preview_safe_duplicate_batch' || fn === 'merge_safe_duplicate_batch') {
      if (isAnon || !isAdmin) {
        return { data: null, error: { message: 'Only administrators may run the safe duplicate batch merge.', code: '42501' } };
      }

      const batchPolicy = {
        policyId: 'safe_batch_parent_assigned_keeper',
        version: 1,
        nameEn: 'Merge All Safe Duplicates',
        nameAr: 'دمج جميع سجلات الطلاب الآمنة المكررة',
        keeperRuleEn: 'The parent-assigned record will be kept. The unassigned duplicate will be merged into it.',
        keeperRuleAr: 'يُحتفظ بالسجل الذي لديه ولي أمر معيّن، ويُدمج فيه السجل المكرر غير المعیَّن.',
        confirmPhrase: 'MERGE SAFE DUPLICATES',
        chunkSize: { default: 25, min: 1, max: 50, atomicPerChunk: true },
        exclusionDescriptions: {
          group_has_more_than_two_records: 'More than two records share this name and class — ambiguous, individual review',
          student_missing: 'One of the two records no longer exists',
          name_conflict: 'Normalized names differ',
          name_blank: 'Name is blank',
          class_conflict: 'Current class differs — class changes must preserve the stable Student ID',
          class_blank: 'Class is blank',
          both_parents_assigned: 'Parent conflict — both records have a parent assigned',
          parent_conflict: 'Parent conflict — both records point at different parents',
          both_parents_unassigned: 'Neither record has a parent assigned — no keeper under the batch rule',
          parent_profile_missing: 'The assigned parent profile does not exist',
          student_marked_left: 'One record is marked LEFT — ambiguous enrollment state',
          gov_id_conflict: 'Gov ID conflict — two different Government IDs',
          gov_id_belongs_to_third_student: 'Gov ID could belong to a third student',
          parent_phone_conflict: 'Parent phone conflict — the authoritative registry confirms neither number',
          parent_phone_registry_ambiguous: 'Parent phone conflict — the authoritative registry confirms BOTH numbers, so a person must choose',
          parent_phone_belongs_to_other_family: 'The phone on the duplicate already belongs to a different family — copying it would merge two families',
          transport_conflict: 'Transport conflict',
          family_id_transfer_unproven: 'Only the duplicate has a family ID and the database cannot prove the keeper belongs to that family — individual review',
          family_id_conflict: 'Family ID conflict',
          parent_phone_from_removed_preserved: 'Parent phone can be safely transferred to the keeper',
          transport_from_removed_preserved: 'Transport can be safely transferred to the keeper',
          family_id_from_removed_preserved: 'Family ID can be safely transferred to the keeper',
          gov_id_from_removed_preserved: 'Gov ID can be safely transferred to the keeper',
          multiple_open_enrollments: 'Ambiguous enrollment state — more than one open enrollment',
          no_open_enrollment: 'Ambiguous enrollment state — no open enrollment to keep',
          enrollment_class_conflict: 'Enrollment class differs from the current class',
          enrollment_year_conflict: 'Enrollment academic year differs',
          exam_conflict: 'Exam identity conflict — an administrator must choose which result survives',
          attendance_conflict: 'Attendance date conflict — an administrator must choose',
          quiz_conflict: 'Quiz attempt conflict — an administrator must choose',
          release_conflict: 'Release log conflict (same UTC day) — an administrator must choose',
          report_comment_conflict: 'Report comment conflict (same term) — an administrator must choose',
          unhandled_child_dependency: 'The duplicate has rows in a student relationship the merge logic does not move',
          candidate_changed_since_preview: 'Candidate changed since preview',
          candidate_changed_during_batch: 'Candidate changed while the batch was running',
          already_resolved: 'Already resolved (another administrator merged it, or the record is gone)',
          not_eligible_server_side: 'Not eligible on the server — a client list can never authorize a merge',
          not_a_candidate: 'Not a duplicate candidate at all',
        } as Record<string, string>,
        blockedCodes: [
          'gov_id_conflict', 'gov_id_belongs_to_third_student', 'both_parents_assigned', 'parent_conflict',
          'parent_phone_conflict', 'parent_phone_registry_ambiguous', 'transport_conflict', 'family_id_conflict', 'student_missing',
          'parent_profile_missing', 'multiple_open_enrollments', 'enrollment_class_conflict',
          'enrollment_year_conflict', 'exam_conflict', 'attendance_conflict', 'quiz_conflict',
          'release_conflict', 'report_comment_conflict', 'unhandled_child_dependency', 'name_conflict',
          'class_conflict', 'not_eligible_server_side',
        ],
        invariants: [
          'keeper: exactly 1 open enrollment after the merge',
          'removed record: 0 open enrollments and 0 remaining rows before deletion',
          'removed record: deleted only after zero-dependency verification',
          'kept Student ID: unchanged and preserved',
        ],
      };

      const bNameKey = (v: any) => (v ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
      const bPhoneKey = (v: any) => (v ?? '').toString().replace(/\D/g, '').replace(/^252(\d{9})$/, '$1');
      const bFamKey = (v: any) => (v ?? '').toString().replace(/\D/g, '');
      const bBlank = (v: any) => v === null || v === undefined || String(v).trim() === '';
      const bRows = (table: string, id: string) => (mockTables[table] || []).filter((r: any) => r.studentId === id);
      const bOpen = (id: string) => bRows('student_enrollments', id).filter((e: any) => e.effectiveTo == null);
      const bHistory = (id: string) => bRows('student_enrollments', id).filter((e: any) => e.effectiveTo != null).length;
      const bProfile = (id: any) => (mockTables.profiles || []).find((p: any) => p.id === id) || null;
      const bHash = (input: string) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return ('00000000' + (h >>> 0).toString(16)).slice(-8) + ('00000000' + (Math.imul(h ^ input.length, 0x85ebca6b) >>> 0).toString(16)).slice(-8);
      };

      const kIdSafe = (s: any) => String(s?.id ?? '?');

      const evaluateSafePair = (aIn: any, bIn: any, groupSize: number, deep: boolean) => {
        const codes: string[] = [];
        const okCodes: string[] = [];
        let blocked = false;
        const addBlocked = (c: string) => { codes.push(c); blocked = true; };
        const addReview = (c: string) => { codes.push(c); };

        // Keeper: THE parent-assigned record (never chosen by age or caller label)
        const aHas = !bBlank(aIn?.parentId);
        const bHas = !bBlank(bIn?.parentId);
        let keeper: any; let removed: any;
        if (aHas && !bHas) { keeper = aIn; removed = bIn; }
        else if (bHas && !aHas) { keeper = bIn; removed = aIn; }
        else {
          const ta = String(aIn?.createdAt ?? ''); const tb = String(bIn?.createdAt ?? '');
          if (ta === tb) { keeper = String(aIn?.id) < String(bIn?.id) ? aIn : bIn; removed = keeper === aIn ? bIn : aIn; }
          else if (ta < tb) { keeper = aIn; removed = bIn; }
          else { keeper = bIn; removed = aIn; }
        }
        const className = keeper?.className ?? null;

        if (groupSize > 2) addReview('group_has_more_than_two_records');
        else okCodes.push('candidate_group_has_exactly_two_records');

        if (bBlank(keeper?.name)) addBlocked('name_blank');
        else if (bNameKey(keeper?.name) !== bNameKey(removed?.name)) addBlocked('name_conflict');
        else okCodes.push('same_normalized_name');

        if (bBlank(keeper?.className) || bBlank(removed?.className)) addBlocked('class_blank');
        else if (keeper?.className !== removed?.className) addBlocked('class_conflict');
        else okCodes.push('same_current_class');

        if (!bBlank(keeper?.parentId) && !bBlank(removed?.parentId)) {
          addBlocked('both_parents_assigned');
          if (String(keeper.parentId) !== String(removed.parentId)) codes.push('parent_conflict');
        } else if (bBlank(keeper?.parentId) && bBlank(removed?.parentId)) {
          addReview('both_parents_unassigned');
        } else {
          okCodes.push('exactly_one_parent_assigned', 'keeper_is_parent_assigned');
        }

        if (String(keeper?.transport ?? '').trim().toUpperCase() === 'LEFT' || String(removed?.transport ?? '').trim().toUpperCase() === 'LEFT') {
          addReview('student_marked_left');
        }

        // Gov ID: blank vs X keeps X, identical is safe, X vs Y is a conflict,
        // and a Gov ID owned by a THIRD student is a conflict.
        const gkK = govKey(keeper?.govId); const gkR = govKey(removed?.govId);
        let govChoice = 'canonical';
        if (gkK !== '' && gkR !== '' && gkK === gkR) { okCodes.push('same_gov_id'); govChoice = 'canonical'; }
        else if (gkK !== '' && gkR !== '') addBlocked('gov_id_conflict');
        else if (gkK !== '') { okCodes.push('gov_id_keeper_only'); govChoice = 'canonical'; }
        else if (gkR !== '') { okCodes.push('gov_id_from_removed_preserved'); govChoice = 'duplicate'; }
        else { okCodes.push('no_gov_id'); govChoice = 'canonical'; }
        if (gkK !== '' || gkR !== '') {
          const wanted = gkK > gkR ? gkK : gkR;
          const third = (mockTables.students as any[]).some((s: any) => s.id !== keeper?.id && s.id !== removed?.id && govKey(s.govId) !== '' && govKey(s.govId) === wanted);
          if (third) addBlocked('gov_id_belongs_to_third_student');
        }

        // Policy v2 (20261008) — SAFE UNION per field. This mock mirrors the
        // database so the screen never contradicts it; the server verdict is
        // still the only one that authorises a merge.
        //   both blank -> keep | identical -> keep | keeper only -> keep
        //   duplicate only -> TRANSFER | both different -> BLOCK
        const transfers: Record<string, string | null> = {};
        const fieldStates: Record<string, { state: string; action: string; value?: string | null; proof?: string }> = {};
        let phoneChoice = 'canonical';
        let transportChoice = 'canonical';

        // Parent phone. A one-sided phone transfers, but never onto a keeper
        // whose parent differs from another family already using that number.
        const phK = bPhoneKey(keeper?.parentPhone); const phR = bPhoneKey(removed?.parentPhone);
        if (phK !== '' && phR !== '' && phK === phR) {
          okCodes.push('same_parent_phone');
          fieldStates.parentPhone = { state: 'identical', action: 'keep' };
        } else if (phK !== '' && phR !== '') {
          addBlocked('parent_phone_conflict');
          fieldStates.parentPhone = { state: 'conflict', action: 'block', value: removed?.parentPhone ?? null };
        } else if (phK !== '') {
          okCodes.push('parent_phone_keeper_only');
          fieldStates.parentPhone = { state: 'keeper_only', action: 'keep' };
        } else if (phR !== '') {
          const otherFamily = (mockTables.students as any[]).some(
            (st: any) => st.id !== keeper?.id && st.id !== removed?.id
              && bPhoneKey(st.parentPhone) === phR
              && !bBlank(st.parentId) && String(st.parentId) !== String(keeper?.parentId ?? ''));
          if (otherFamily) {
            addBlocked('parent_phone_belongs_to_other_family');
            fieldStates.parentPhone = { state: 'duplicate_only', action: 'block', value: removed?.parentPhone ?? null };
          } else {
            okCodes.push('parent_phone_from_removed_preserved');
            phoneChoice = 'duplicate';
            transfers.parentPhone = removed?.parentPhone ?? null;
            fieldStates.parentPhone = { state: 'duplicate_only', action: 'transfer', value: removed?.parentPhone ?? null };
          }
        } else {
          okCodes.push('no_parent_phone');
          fieldStates.parentPhone = { state: 'both_blank', action: 'keep' };
        }

        // Transport: a scalar (WALKER | CAR | bus number); the only relational
        // link, authorized_pickup_students, is moved by the merge itself.
        const trK = String(keeper?.transport ?? '').trim(); const trR = String(removed?.transport ?? '').trim();
        if (trK !== '' && trR !== '' && trK.toUpperCase() === trR.toUpperCase()) {
          okCodes.push('same_transport');
          fieldStates.transport = { state: 'identical', action: 'keep' };
        } else if (trK !== '' && trR !== '') {
          addBlocked('transport_conflict');
          fieldStates.transport = { state: 'conflict', action: 'block', value: removed?.transport ?? null };
        } else if (trK !== '') {
          okCodes.push('transport_keeper_only');
          fieldStates.transport = { state: 'keeper_only', action: 'keep' };
        } else if (trR !== '') {
          okCodes.push('transport_from_removed_preserved');
          transportChoice = 'duplicate';
          transfers.transport = removed?.transport ?? null;
          fieldStates.transport = { state: 'duplicate_only', action: 'transfer', value: removed?.transport ?? null };
        } else {
          okCodes.push('no_transport');
          fieldStates.transport = { state: 'both_blank', action: 'keep' };
        }

        // Family ID: the conservative one. Transfer only on sibling proof.
        const famK = bFamKey(keeper?.familyId); const famR = bFamKey(removed?.familyId);
        if (famK !== '' && famR !== '' && famK === famR) {
          okCodes.push('same_family_id');
          fieldStates.familyId = { state: 'identical', action: 'keep' };
        } else if (famK !== '' && famR !== '') {
          addBlocked('family_id_conflict');
          fieldStates.familyId = { state: 'conflict', action: 'block', value: removed?.familyId ?? null };
        } else if (famK !== '') {
          okCodes.push('family_id_keeper_only');
          fieldStates.familyId = { state: 'keeper_only', action: 'keep' };
        } else if (famR !== '') {
          const sibs = (mockTables.students as any[]).filter(
            (st: any) => st.id !== keeper?.id && st.id !== removed?.id
              && !bBlank(keeper?.parentId) && String(st.parentId ?? '') === String(keeper?.parentId));
          const otherFam = sibs.some((st: any) => bFamKey(st.familyId) !== '' && bFamKey(st.familyId) !== famR);
          const sameFam = sibs.filter((st: any) => bFamKey(st.familyId) === famR);
          if (otherFam) {
            addBlocked('family_id_conflict');
            fieldStates.familyId = { state: 'duplicate_only', action: 'block', value: removed?.familyId ?? null };
          } else if (sameFam.length > 0) {
            okCodes.push('family_id_from_removed_preserved');
            transfers.familyId = removed?.familyId ?? null;
            fieldStates.familyId = {
              state: 'duplicate_only', action: 'transfer', value: removed?.familyId ?? null,
              proof: 'keeper_parent_sibling_holds_same_family_id',
            };
          } else {
            addReview('family_id_transfer_unproven');
            fieldStates.familyId = { state: 'duplicate_only', action: 'review', value: removed?.familyId ?? null };
          }
        } else {
          okCodes.push('no_family_id');
          fieldStates.familyId = { state: 'both_blank', action: 'keep' };
        }
        if (gkR !== '' && govChoice === 'duplicate') {
          transfers.govId = removed?.govId ?? null;
          fieldStates.govId = { state: 'duplicate_only', action: 'transfer', value: removed?.govId ?? null };
        } else if (gkK !== '' && gkR !== '' && gkK === gkR) {
          fieldStates.govId = { state: 'identical', action: 'keep' };
        } else if (gkK !== '' && gkR !== '') {
          fieldStates.govId = { state: 'conflict', action: 'block' };
        } else if (gkK !== '') {
          fieldStates.govId = { state: 'keeper_only', action: 'keep' };
        } else {
          fieldStates.govId = { state: 'both_blank', action: 'keep' };
        }

        if (!bBlank(keeper?.parentId)) {
          if (!bProfile(keeper.parentId)) addBlocked('parent_profile_missing');
          else okCodes.push('parent_profile_exists');
        }

        let enrollAction: string | null = null;
        let enrollKeep = 'canonical';
        const history: Record<string, any> = {};
        let fingerprint: string | null = null;

        if (deep && codes.length === 0) {
          const openK = bOpen(String(keeper?.id)); const openR = bOpen(String(removed?.id));
          const enrK = openK[0] || null; const enrR = openR[0] || null;
          if (openK.length > 1 || openR.length > 1) addBlocked('multiple_open_enrollments');
          else if (openK.length === 0 && openR.length === 0) addReview('no_open_enrollment');
          else if (openK.length === 0 && openR.length === 1) {
            enrollAction = 'transfer'; enrollKeep = 'duplicate';
            if (enrR?.className !== keeper?.className) { addBlocked('enrollment_class_conflict'); enrollAction = null; }
            else okCodes.push('enrollment_transfer');
          } else if (openR.length === 0) {
            enrollAction = 'preserve_history';
            if (enrK?.className !== keeper?.className) { addBlocked('enrollment_class_conflict'); enrollAction = null; }
            else okCodes.push('enrollment_preserve_history');
          } else if (enrK?.className !== enrR?.className) addBlocked('enrollment_class_conflict');
          else if ((enrK?.academicYearId ?? null) !== (enrR?.academicYearId ?? null)) addBlocked('enrollment_year_conflict');
          else if (enrK?.className !== keeper?.className) addBlocked('enrollment_class_conflict');
          else { enrollAction = 'consolidate'; okCodes.push('enrollment_consolidate'); }

          const kId = String(keeper?.id); const rId = String(removed?.id);
          const examK = bRows('exams', kId); const examR = bRows('exams', rId);
          const attK = bRows('attendance', kId); const attR = bRows('attendance', rId);
          const quizK = bRows('quiz_attempts', kId); const quizR = bRows('quiz_attempts', rId);
          const relK = bRows('release_log', kId); const relR = bRows('release_log', rId);
          const repK = bRows('report_comments', kId); const repR = bRows('report_comments', rId);
          const examConf = examR.filter((d: any) => examK.some((c: any) => (c.subjectId ?? null) === (d.subjectId ?? null) && c.examType === d.examType && (c.assessmentLabel ?? null) === (d.assessmentLabel ?? null) && (c.termId ?? null) === (d.termId ?? null))).length;
          const attConf = attR.filter((d: any) => attK.some((c: any) => String(c.date).slice(0, 10) === String(d.date).slice(0, 10))).length;
          const quizConf = quizR.filter((d: any) => quizK.some((c: any) => c.quizId === d.quizId)).length;
          const relConf = relR.filter((d: any) => relK.some((c: any) => String(c.createdAt ?? '').slice(0, 10) === String(d.createdAt ?? '').slice(0, 10))).length;
          const repConf = repR.filter((d: any) => repK.some((c: any) => c.termId === d.termId)).length;
          if (examConf > 0) addBlocked('exam_conflict');
          if (attConf > 0) addBlocked('attendance_conflict');
          if (quizConf > 0) addBlocked('quiz_conflict');
          if (relConf > 0) addBlocked('release_conflict');
          if (repConf > 0) addBlocked('report_comment_conflict');
          if (codes.length === 0) okCodes.push('no_history_conflicts', 'history_transfer_safe');

          history.exams = { keeper: examK.length, removed: examR.length, conflicts: examConf };
          history.attendance = { keeper: attK.length, removed: attR.length, conflicts: attConf };
          history.homework = { keeper: bRows('homework', kId).length, removed: bRows('homework', rId).length };
          history.promotions = { keeper: bRows('student_promotions', kId).length, removed: bRows('student_promotions', rId).length };
          history.quizAttempts = { keeper: quizK.length, removed: quizR.length, conflicts: quizConf };
          history.authorizedPickups = { keeper: bRows('authorized_pickup_students', kId).length, removed: bRows('authorized_pickup_students', rId).length };
          history.releaseLogs = { keeper: relK.length, removed: relR.length, conflicts: relConf };
          history.reportComments = { keeper: repK.length, removed: repR.length, conflicts: repConf };
          history.enrollments = { keeperOpen: openK.length, removedOpen: openR.length, keeperHistory: bHistory(kId), removedHistory: bHistory(rId) };
          history.unhandledChildRows = 0;
          history.unhandledChildTables = [];

          if (codes.length === 0) {
            fingerprint = bHash([
              kId, rId, keeper?.name ?? '', removed?.name ?? '', keeper?.className ?? '', removed?.className ?? '',
              keeper?.govId ?? '', removed?.govId ?? '', keeper?.parentId ?? '', removed?.parentId ?? '',
              keeper?.parentPhone ?? '', removed?.parentPhone ?? '', keeper?.transport ?? '', removed?.transport ?? '',
              keeper?.familyId ?? '', removed?.familyId ?? '', String(groupSize),
              String(openK.length), String(openR.length), String(bHistory(kId)), String(bHistory(rId)),
              enrK?.id ?? '', enrR?.id ?? '', enrK?.className ?? '', enrR?.className ?? '',
              enrK?.academicYearId ?? '', enrR?.academicYearId ?? '',
              JSON.stringify(history), enrollAction ?? '', govChoice, phoneChoice, transportChoice,
              JSON.stringify(transfers),
            ].join('|'));
          }
        }

        const eligible = deep && codes.length === 0;
        const side = (s: any) => ({
          id: s?.id ?? null, name: s?.name ?? null, className: s?.className ?? null,
          govId: s?.govId ?? null, parentId: s?.parentId ?? null,
          parentName: bProfile(s?.parentId)?.name ?? null,
          parentPhone: s?.parentPhone ?? null, transport: s?.transport ?? null,
          familyId: s?.familyId ?? null, createdAt: s?.createdAt ?? null,
        });

        return {
          pairKey: `${kIdSafe(keeper)}>${kIdSafe(removed)}`,
          groupKey: `${bNameKey(keeper?.name)}|${className ?? ''}`,
          groupSize,
          keeperId: kIdSafe(keeper),
          removedId: kIdSafe(removed),
          studentName: keeper?.name ?? null,
          className,
          eligible,
          severity: eligible ? null : (blocked ? 'blocked' : 'review'),
          exclusionCodes: codes,
          eligibilityCodes: okCodes,
          fieldStates,
          transfers,
          keeperIsParentAssigned: !bBlank(keeper?.parentId),
          keeper: side(keeper),
          removed: side(removed),
          parentName: bProfile(keeper?.parentId)?.name ?? null,
          resolution: {
            summary: { govId: govChoice, parentPhone: phoneChoice, transport: transportChoice, enrollment: enrollAction ?? 'none' },
            mergeResolution: {
              profile_resolution: {
                name: 'canonical', class_name: 'canonical', gov_id: govChoice,
                parent_id: 'canonical', parent_phone: phoneChoice, transport: transportChoice,
              },
              exam_resolution: [], attendance_resolution: [], quiz_resolution: [],
              release_resolution: [], report_comment_resolution: [],
              enrollment_resolution: enrollAction ? { action: enrollAction, keep: enrollKeep } : null,
            },
          },
          enrollmentAction: enrollAction,
          history,
          fingerprint,
          evaluatedAt: new Date().toISOString(),
        };
      };

      const batchCandidatePairs = (deep: boolean) => {
        const groups = new Map<string, any[]>();
        for (const s of mockTables.students as any[]) {
          const key = `${bNameKey(s.name)}|${s.className ?? ''}`;
          const arr = groups.get(key) || [];
          arr.push(s);
          groups.set(key, arr);
        }
        const eligible: any[] = [];
        const excluded: any[] = [];
        const reasons: Record<string, number> = {};
        for (const members of groups.values()) {
          if (members.length < 2) continue;
          const sorted = [...members].sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')) || String(x.id).localeCompare(String(y.id)));
          for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
              const ev = evaluateSafePair(sorted[i], sorted[j], members.length, deep);
              if (ev.eligible) eligible.push(ev);
              else {
                excluded.push(ev);
                for (const c of ev.exclusionCodes) reasons[c] = (reasons[c] || 0) + 1;
              }
            }
          }
        }
        const order = (x: any, y: any) => String(x.className ?? '').localeCompare(String(y.className ?? '')) || String(x.studentName ?? '').localeCompare(String(y.studentName ?? '')) || String(x.keeper?.createdAt ?? '').localeCompare(String(y.keeper?.createdAt ?? '')) || String(x.pairKey).localeCompare(String(y.pairKey));
        eligible.sort(order);
        excluded.sort(order);
        return { eligible, excluded, reasons, candidatePairs: eligible.length + excluded.length };
      };

      const buildSummary = (r: { eligible: any[]; excluded: any[]; candidatePairs: number }) => ({
        candidatePairs: r.candidatePairs,
        safeCount: r.eligible.length,
        excludedCount: r.excluded.length,
        blockedCount: r.excluded.filter((e) => e.severity === 'blocked').length,
        needsReviewCount: r.excluded.filter((e) => e.severity === 'review').length,
        studentsToMerge: r.eligible.length,
        recordsToRemove: r.eligible.length,
        studentIdsPreserved: r.eligible.length,
      });

      if (fn === 'merge_safe_duplicate_batch') {
        const phrase = (params?.p_confirm_phrase ?? params?.p_confirmPhrase ?? '').toString().trim().toUpperCase();
        if (phrase !== batchPolicy.confirmPhrase) {
          return { data: null, error: { message: 'Batch confirmation phrase required: type MERGE SAFE DUPLICATES to run the safe batch merge.', code: '22023' } };
        }
        const batchIdIn = params?.p_batch_id ?? params?.p_batchId ?? null;
        if (batchIdIn && String(batchIdIn).length > 100) {
          return { data: null, error: { message: 'Batch id must be 100 characters or fewer.', code: '22023' } };
        }
        const requested = params?.p_pairs ?? params?.p_pairs ?? null;
        let reqKeys: string[] | null = null;
        let reqFps: (string | null)[] = [];
        if (requested !== null && requested !== undefined) {
          if (!Array.isArray(requested)) return { data: null, error: { message: 'p_pairs must be a JSON array of reviewed pairs.', code: '22023' } };
          if (requested.length > 5000) return { data: null, error: { message: 'Too many pairs in one batch request (max 5000).', code: '54000' } };
          const malformed = requested.some((x: any) => !x || typeof x !== 'object' || bBlank(x.keeperId) || bBlank(x.removedId));
          if (malformed) {
            return { data: null, error: { message: 'Every reviewed pair must provide both keeperId and removedId. The safe batch never accepts a bare student id or a delete request.', code: '22023' } };
          }
          reqKeys = requested.map((x: any) => `${String(x.keeperId).trim()}>${String(x.removedId).trim()}`);
          reqFps = requested.map((x: any) => (bBlank(x.fingerprint) ? null : String(x.fingerprint).trim()));
        }
        const chunkSize = Math.min(50, Math.max(1, Number(params?.p_chunk_size ?? params?.p_chunkSize ?? 25) || 25));
        const reason = bBlank(params?.p_reason) ? null : String(params.p_reason).trim();
        const batchId = batchIdIn ? String(batchIdIn) : `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const started = Date.now();

        const scan = batchCandidatePairs(true);
        const eligible = scan.eligible;
        const filtered = reqKeys ? eligible.filter((e) => reqKeys!.includes(e.pairKey)) : eligible;
        const ineligibleByKey = new Map<string, any>(scan.excluded.map((e) => [e.pairKey, e]));

        const snapshot = JSON.parse(JSON.stringify(mockTables));
        const merged: any[] = [];
        const skipped: any[] = [];
        const blockedList: any[] = [];
        const seen = new Set<string>();
        let examined = 0;

        for (const ev of filtered) {
          if (merged.length >= chunkSize) break;
          seen.add(ev.pairKey);
          examined += 1;
          const idx = reqKeys ? reqKeys.indexOf(ev.pairKey) : -1;
          const reviewedFp = idx >= 0 ? reqFps[idx] : null;
          if (reviewedFp && ev.fingerprint && reviewedFp !== ev.fingerprint) {
            skipped.push({ pairKey: ev.pairKey, keeperId: ev.keeperId, removedId: ev.removedId, studentName: ev.studentName, className: ev.className, reason: 'candidate_changed_since_preview', codes: ['candidate_changed_since_preview'] });
            continue;
          }
          if (!findStudent(ev.keeperId) || !findStudent(ev.removedId)) {
            skipped.push({ pairKey: ev.pairKey, keeperId: ev.keeperId, removedId: ev.removedId, reason: 'already_resolved', codes: ['already_resolved'] });
            continue;
          }
          const keeperGov = findStudent(ev.keeperId).govId;
          const keeperPhone = findStudent(ev.keeperId).parentPhone;
          // Recursive dispatch into the individual (guided) merge handler: the
          // batch reuses the exact same validation, transfer, verification,
          // audit and delete logic — it never re-implements a merge.
          const callResolved = mockRpc as (name: string, args?: any) => Promise<{ data: any; error: any }>;
          const inner = await callResolved('merge_duplicate_students_resolved', {
            p_canonical_id: ev.keeperId,
            p_duplicate_id: ev.removedId,
            p_resolution: ev.resolution.mergeResolution,
            p_reason: `Safe batch merge (${batchId}): kept the parent-assigned record ${ev.keeperId}, merged the unassigned duplicate ${ev.removedId}. Policy: ${batchPolicy.policyId}${reason ? `. Administrator note: ${reason}` : ''}`,
          });
          if (inner.error) {
            for (const k of Object.keys(mockTables)) mockTables[k] = snapshot[k];
            return {
              data: null,
              error: {
                message: `SAFE BATCH CHUNK ABORTED on pair ${ev.keeperId} -> ${ev.removedId} (${ev.studentName ?? ''}): ${inner.error.message}. The entire chunk rolled back; no student was modified by this chunk.`,
                code: '23000',
              },
            };
          }
          // The batch never rewrites a keeper value it promised to keep.
          const keeperRow = findStudent(ev.keeperId);
          if (keeperRow) { keeperRow.govId = keeperGov; keeperRow.parentPhone = keeperPhone; }
          const auditId = (inner.data as any)?.auditId ?? null;
          const auditRow = (mockTables.student_merge_audits as any[]).find((a: any) => a.id === auditId);
          if (auditRow) {
            auditRow.batch_id = batchId;
            auditRow.batch_policy = batchPolicy.policyId;
            auditRow.batch_size = chunkSize;
            auditRow.merge_kind = 'safe_batch';
          }
          merged.push({
            pairKey: ev.pairKey, keeperId: ev.keeperId, removedId: ev.removedId,
            studentName: ev.studentName, className: ev.className, auditId,
            preservedStudentId: ev.keeperId, removedStudentId: ev.removedId,
            enrollmentAction: (inner.data as any)?.enrollmentAction ?? null,
            before: (inner.data as any)?.before ?? null,
            after: (inner.data as any)?.after ?? null,
          });
        }

        // Report requested pairs the mock server refuses to merge.
        if (reqKeys) {
          for (let i = 0; i < reqKeys.length; i++) {
            const key = reqKeys[i];
            if (seen.has(key)) continue;
            if (eligible.some((e) => e.pairKey === key)) continue; // queued for a later chunk
            const [idA, idB] = key.split('>');
            const alreadyMerged = (mockTables.student_merge_audits as any[]).some((a: any) => a.batch_id === batchId && ((a.canonical_id === idA && a.duplicate_id === idB) || (a.canonical_id === idB && a.duplicate_id === idA)));
            if (alreadyMerged) continue;
            const rejected = ineligibleByKey.get(key);
            if (rejected) {
              blockedList.push({ ...rejected, reason: 'not_eligible_server_side', codes: [...rejected.exclusionCodes, 'not_eligible_server_side'] });
            } else if (findStudent(idA) && !findStudent(idB)) {
              skipped.push({ pairKey: key, keeperId: idA, removedId: idB, reason: 'already_resolved', codes: ['already_resolved'] });
            } else {
              blockedList.push({ pairKey: key, keeperId: idA, removedId: idB, reason: 'not_a_candidate', codes: ['not_a_candidate'] });
            }
          }
        }

        const remainingEligible = Math.max(0, filtered.length - examined);
        const batchRow = (mockTables.student_merge_batches as any[]).find((b: any) => b.id === batchId);
        const chunkResult = { chunkSize, merged, skipped, blocked: blockedList, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString() };
        if (batchRow) {
          batchRow.chunks_run += 1;
          batchRow.merged_count += merged.length;
          batchRow.skipped_count += skipped.length;
          batchRow.blocked_count += blockedList.length;
          batchRow.remaining_eligible = remainingEligible;
          batchRow.chunk_results = [...(batchRow.chunk_results || []), chunkResult];
          batchRow.updated_at = new Date().toISOString();
        } else {
          mockTables.student_merge_batches.push({
            id: batchId, admin_id: 'preview-admin', policy: batchPolicy.policyId, chunk_size: chunkSize,
            chunks_run: 1, reason, requested_pairs: reqKeys ? reqKeys.length : 0,
            merged_count: merged.length, skipped_count: skipped.length, blocked_count: blockedList.length,
            failed_count: 0, remaining_eligible: remainingEligible, chunk_results: [chunkResult],
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
        mockTables.audit_logs.push({
          id: mockTables.audit_logs.length + 1, action: 'students.merge_batch',
          details: {
            batchId, actor: 'preview-admin', policy: batchPolicy.policyId, chunkSize, reason,
            merged: merged.length, skipped: skipped.length, blocked: blockedList.length, failed: 0,
            remainingEligible,
            preservedStudentIds: merged.map((m) => m.preservedStudentId),
            removedStudentIds: merged.map((m) => m.removedStudentId),
            auditIds: merged.map((m) => m.auditId),
          },
          createdAt: new Date().toISOString(),
        });

        return {
          data: {
            batchId, adminId: 'preview-admin', policy: batchPolicy.policyId, policyDetail: batchPolicy,
            chunkSize, atomicChunk: true, committed: true,
            merged, skipped, blocked: blockedList, failed: [],
            totals: { eligibleAtStart: filtered.length, examined, merged: merged.length, skipped: skipped.length, blocked: blockedList.length, failed: 0, remaining: remainingEligible },
            invariants: batchPolicy.invariants,
            durationMs: Date.now() - started,
            startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
          },
          error: null,
        };
      }

      const t0 = Date.now();
      const limit = Math.min(2000, Math.max(1, Number(fn === 'preview_safe_duplicate_batch' ? (params?.p_limit ?? 500) : (params?.p_limit ?? 200)) || 200));
      const offset = Math.max(0, Number(params?.p_offset ?? 0) || 0);
      const includeExcluded = fn === 'preview_safe_duplicate_batch' ? true : (params?.p_include_excluded ?? true) !== false;
      const report = batchCandidatePairs(true);
      const rows = report.eligible.slice(offset, offset + limit);
      const excludedRows = includeExcluded
        ? report.excluded.slice(offset, offset + limit).map((e) => ({
            pairKey: e.pairKey, keeperId: e.keeperId, removedId: e.removedId, studentName: e.studentName,
            className: e.className, severity: e.severity, exclusionCodes: e.exclusionCodes,
            exclusionReasons: e.exclusionCodes.map((c: string) => batchPolicy.exclusionDescriptions[c] ?? c),
            keeper: e.keeper, removed: e.removed,
          }))
        : [];
      const base = {
        policy: batchPolicy,
        summary: buildSummary(report),
        exclusionReasons: report.reasons,
        rows,
        excludedRows,
        paging: { limit, offset, includeExcluded },
        generatedAt: new Date().toISOString(),
        timings: { evaluateMs: Date.now() - t0 },
      };
      if (fn === 'preview_safe_duplicate_batch') {
        const safeCount = rows.length;
        const chunk = batchPolicy.chunkSize.default;
        return {
          data: {
            ...base,
            dryRun: true,
            writesPerformed: 0,
            batchId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            previewToken: bHash(rows.map((r: any) => `${r.pairKey}:${r.fingerprint ?? ''}`).join('|')),
            ready: { studentsToMerge: safeCount, recordsToBeRemoved: safeCount, studentIdsPreserved: safeCount },
            chunkPlan: {
              chunkSize: chunk,
              chunks: safeCount === 0 ? 0 : Math.ceil(safeCount / chunk),
              atomicPerChunk: true,
              strategy: 'One RPC call = one chunk = one atomic transaction. The client asks for the next chunk; the server recomputes eligibility every time.',
            },
            confirmations: [
              { id: 'keeper_rule', textEn: 'I understand the parent-assigned record is kept and the unassigned duplicate is removed.', textAr: 'أفهم أنه سيتم الاحتفاظ بالسجل المرتبط بولي الأمر وحذف السجل المكرر غير المرتبط.' },
              { id: 'excluded_rule', textEn: 'I understand every excluded pair stays in individual review and nothing is discarded silently.', textAr: 'أفهم أن كل زوج مستبعد يبقى في المراجعة الفردية ولا يتم تجاهل أي بيانات بصمت.' },
              { id: 'audit_rule', textEn: 'I understand each merge is audited with the batch id, policy and administrator.', textAr: 'أفهم أن كل عملية دمج تُسجَّل مع معرّف الدفعة والسياسة واسم المسؤول.' },
            ],
            assertions: {
              noGovIdConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => ['gov_id_conflict', 'gov_id_belongs_to_third_student'].includes(c))),
              noParentConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => ['both_parents_assigned', 'parent_conflict', 'both_parents_unassigned', 'parent_profile_missing'].includes(c))),
              // One-sided values are transfers, not conflicts, so only genuine
              // conflicts may appear here.
              noPhoneConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => ['parent_phone_conflict', 'parent_phone_belongs_to_other_family'].includes(c))),
              noTransportConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => c === 'transport_conflict')),
              noFamilyConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => c === 'family_id_conflict')),
              noClassConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => ['class_conflict', 'enrollment_class_conflict'].includes(c))),
              noExamConflicts: rows.every((r: any) => !r.exclusionCodes.includes('exam_conflict')),
              noAttendanceConflicts: rows.every((r: any) => !r.exclusionCodes.includes('attendance_conflict')),
              noQuizConflicts: rows.every((r: any) => !r.exclusionCodes.includes('quiz_conflict')),
              noReleaseConflicts: rows.every((r: any) => !r.exclusionCodes.includes('release_conflict')),
              noReportConflicts: rows.every((r: any) => !r.exclusionCodes.includes('report_comment_conflict')),
              noEnrollmentConflicts: rows.every((r: any) => !r.exclusionCodes.some((c: string) => ['multiple_open_enrollments', 'no_open_enrollment', 'enrollment_year_conflict'].includes(c))),
              noUnhandledChildDependencies: rows.every((r: any) => !r.exclusionCodes.includes('unhandled_child_dependency')),
              everyKeeperIsParentAssigned: rows.every((r: any) => r.keeperIsParentAssigned),
              everyRemovedIsUnassigned: rows.every((r: any) => r.removed?.parentId == null),
            },
            confirmPhrase: batchPolicy.confirmPhrase,
            timings: { ...base.timings, previewMs: Date.now() - t0 },
          },
          error: null,
        };
      }
      return { data: base, error: null };
    }

    // For class_students_for_term etc fallback
    return { data: null, error: { message: `Mock RPC ${fn} not implemented`, code: 'PGRST202' } };

  };

  // Realtime is how the lesson-plan detail, message, and announcement pages
  // stay live in production. The preview has no Postgres to subscribe to, so
  // channels become inert no-ops: pages render from the demo tables and
  // simply never receive push updates. Without these, any page that opens a
  // channel — e.g. selecting a lesson plan on Lesson Plan Review, which the
  // submission tracker's View action does — crashes with
  // "supabase.channel is not a function".
  const makeChannel = () => {
    const builder: Record<string, unknown> = {};
    builder.on = () => builder;
    builder.subscribe = () => builder;
    return builder;
  };

  const mockStorage = {
    from: (_bucket: string) => ({
      upload: async (path: string, blob: Blob) => {
        try {
          const dataUrl = await blobToDataUrl(blob);
          pickupPhotoStore.set(path, dataUrl);
          return { data: { path }, error: null };
        } catch {
          return { data: null, error: { message: 'Could not upload the photo.' } };
        }
      },
      remove: async (paths: string[]) => {
        for (const p of paths) pickupPhotoStore.delete(p);
        return { data: paths, error: null };
      },
      createSignedUrl: async (path: string) => {
        const url = pickupPhotoStore.get(path);
        return url
          ? { data: { signedUrl: url }, error: null }
          : { data: null, error: { message: 'Object not found' } };
      },
    }),
  };

  return {
    // Version marker lets Vite HMR replace an older cached preview client
    // after a new preview-only RPC is added. Without it, globalThis.__supabase__
    // could keep the old mockRpc implementation until a full browser reload.
    __marksMonitorPreviewVersion: 2,
    auth: mockAuth as any,
    from: mockFrom as any,
    rpc: mockRpc as any,
    storage: mockStorage as any,
    channel: (_name?: string) => makeChannel(),
    removeChannel: async () => 'ok' as const,
    // Edge functions only run against a real backend; answer honestly so a
    // preview click on "submit" reports a failure instead of crashing on
    // `supabase.functions is undefined`.
    functions: {
      invoke: async () => ({
        data: null,
        error: { message: 'Preview mode — edge functions are disabled.' },
      }),
    },
  } as unknown as SupabaseClient;
}

const cachedSupabase = globalThis.__supabase__ as (SupabaseClient & { __marksMonitorPreviewVersion?: number }) | undefined;

export const supabase: SupabaseClient = isPlaceholderEnv
  ? cachedSupabase?.__marksMonitorPreviewVersion === 2
    ? cachedSupabase
    : createMockSupabase()
  : cachedSupabase ?? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

/**
 * A Supabase client pinned to a specific access token. Every REST request is
 * authenticated as that user regardless of the shared client's session state.
 * Used by createUser() so create_user_profile runs as the admin even though
 * signUp() swapped the shared client's session to the new user.
 */
export function createAuthedClient(accessToken: string): SupabaseClient {
  if (isPlaceholderEnv) return createMockSupabase();
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    accessToken: async () => accessToken,
  });
}

if (import.meta.env.DEV) {
  globalThis.__supabase__ = supabase;
}
