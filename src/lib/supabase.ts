import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from './transport';
import type { Role } from '../types';

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

const demoLessonPlans: any[] = (() => {
  const classes = ['Grade 1-A', 'Grade 2-C', 'Grade 3-B', 'Foundation-KG'];
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
      label: '2026-W15',
      titles: ['Week 2026-W15', 'Week 2026-W15', 'Week 2026-W15'],
      statuses: ['submitted', 'in_review', 'submitted'],
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
        period_count: 5,
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
  return ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'].map((day, index) => ({
    id: `period-${plan.id}-${day}-1`,
    plan_id: plan.id,
    day,
    period_number: 1,
    class_name: plan.class_name,
    subject: parentSeed ? previewSubject : 'Mathematics',
    is_free: false,
    topic: parentSeed ? topicBySubject[previewSubject] || `${previewSubject} Learning` : `${plan.week_label} — ${day} topic`,
    objective: parentSeed ? objectiveBySubject[previewSubject] || 'Build confidence with this week’s topic.' : 'Students explain the concept in their own words.',
    activities: parentSeed ? 'Read examples together, discuss key ideas, and complete guided practice.' : '1. Warm-up (10min) [] @Board | 2. Guided practice (25min) [] @Desks',
    slide_number: null,
    details: parentSeed ? [
      { activity: 'Review examples together', time: '10min', resource: 'Student book', place: '' },
      { activity: 'Discuss key ideas and complete guided practice', time: '25min', resource: 'Practice sheet', place: 'https://example.com/mbk-practice' },
    ] : [
      { activity: 'Warm-up', time: '10min', resource: 'Board', place: 'Desks' },
      { activity: 'Guided practice', time: '25min', resource: 'Workbook', place: 'Desks' },
    ],
    sort_order: index,
    created_at: plan.created_at,
    updated_at: plan.created_at,
  }));
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
    // Generate 56 for canonical (stu-abshir-a) with varying subject/term, 55 matching for duplicate
    for (let i = 0; i < 56; i++) {
      exams.push({
        id: `exam-abshir-a-${i}`,
        studentId: 'stu-abshir-a',
        subject: `Subject-${i % 5}`,
        subjectId: `sub-${i % 5}`,
        score: 15,
        total: 20,
        examType: 'Quiz',
        assessmentLabel: `MT`,
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
        subject: `Subject-${i % 5}`,
        subjectId: `sub-${i % 5}`,
        score: 14,
        total: 20,
        examType: 'Quiz',
        assessmentLabel: `MT`,
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
    if (fn === 'get_students_by_classes' || fn === 'get_students' || fn === 'create_student' || fn === 'update_student') {
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
    if (fn === 'get_duplicate_candidates') {
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
      let blocked: string[] = [];
      let canMerge = true;
      let risk: string = 'low';
      let evidence: string = 'possible';
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
          action: dupOpen && canOpen && canOpen.className === dupOpen.className ? 'consolidate' : dupOpen ? 'transfer' : 'preserve_history',
          willConsolidate: !!(dupOpen && canOpen && canOpen.className === dupOpen.className),
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
      // Transfer enrollments: consolidate duplicate open if same class
      const canOpen = mockTables.student_enrollments.find((e: any) => e.studentId === canId && e.effectiveTo == null);
      const dupOpen = mockTables.student_enrollments.find((e: any) => e.studentId === dupId && e.effectiveTo == null);
      if (dupOpen) {
        if (canOpen && canOpen.className === dupOpen.className) {
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
    __marksMonitorPreviewVersion: 1,
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
  ? cachedSupabase?.__marksMonitorPreviewVersion === 1
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
