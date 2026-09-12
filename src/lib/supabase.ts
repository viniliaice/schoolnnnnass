import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from './transport';

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
  { id: 'ay-2026', name: '2026/2027', startDate: '2026-06-01', endDate: '2027-05-31', isCurrent: true, createdAt: '2026-06-01' },
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
];

const demoProfiles: any[] = [
  { id: 'preview-admin', name: 'Preview Admin', email: 'admin@mbk.edu', role: 'admin', phone1: null, phone2: null, assignedClasses: ['Grade 1-A','Grade 2-C'], assignedSubjects: [], createdAt: '2026-06-01', auth_id: 'auth-preview-admin' },
  { id: 'parent-1', name: 'Maxamed Heeban', email: 'parent1@example.com', role: 'parent', phone1: '252634506719', phone2: '252634506720', xafada: 'Jigjiga Yar', createdAt: '2026-06-01', auth_id: 'auth-parent-1' },
  { id: 'parent-2', name: 'Ali Yusuf', email: 'parent2@example.com', role: 'parent', phone1: '252634511111', phone2: null, createdAt: '2026-06-01', auth_id: 'auth-parent-2' },
  { id: 'parent-3', name: 'Farah Mohamed', email: 'parent3@example.com', role: 'parent', phone1: '252634500000', phone2: null, createdAt: '2026-06-01', auth_id: 'auth-parent-3' },
  { id: 'teacher-1', name: 'Ms. Fatima', email: 'fatima@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 2-C'], assignedSubjects: ['English','Mathematics'], createdAt: '2026-06-01', auth_id: 'auth-teacher-1' },
  { id: 'teacher-2', name: 'Mr. Omar', email: 'omar@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 1-A'], assignedSubjects: ['Mathematics'], createdAt: '2026-06-01', auth_id: 'auth-teacher-2' },
  { id: 'teacher-3', name: 'Ms. Hodan', email: 'hodan@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 3-B'], assignedSubjects: ['Science'], createdAt: '2026-06-01', auth_id: 'auth-teacher-3' },
  // Submission-tracking demo: assigned to a class but (see demoLessonPlans)
  // never submits the current week — the "Not Submitted" case.
  { id: 'teacher-4', name: 'Mr. Abdirahman', email: 'abdirahman@mbk.edu', role: 'teacher', phone1: null, phone2: null, assignedClasses: ['Grade 4-A'], assignedSubjects: ['Social Studies'], createdAt: '2026-06-01', auth_id: 'auth-teacher-4' },
  { id: 'supervisor-1', name: 'Mr. Bashir (Supervisor)', email: 'supervisor@mbk.edu', role: 'supervisor', phone1: null, phone2: null, assignedClasses: [], assignedSubjects: [], createdAt: '2026-06-01', auth_id: 'auth-supervisor-1' },
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

const demoLessonPlanPeriods: any[] = demoLessonPlans.flatMap((plan: any) =>
  ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'].map((day, index) => ({
    id: `period-${plan.id}-${day}-1`,
    plan_id: plan.id,
    day,
    period_number: 1,
    class_name: plan.class_name,
    subject: 'Mathematics',
    is_free: false,
    topic: `${plan.week_label} — ${day} topic`,
    objective: 'Students explain the concept in their own words.',
    activities: '1. Warm-up (10min) [] @Board | 2. Guided practice (25min) [] @Desks',
    slide_number: null,
    details: [
      { activity: 'Warm-up', time: '10min', resource: 'Board', place: 'Desks' },
      { activity: 'Guided practice', time: '25min', resource: 'Workbook', place: 'Desks' },
    ],
    sort_order: index,
    created_at: plan.created_at,
    updated_at: plan.created_at,
  }))
);

function createMockSupabase(): SupabaseClient {
  const demoClasses = Array.from(new Set(demoStudents.map(s => s.className))).sort();

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

    const getTableData = (): any[] => {
      switch (table) {
        case 'academic_years': return [...demoAcademicYears];
        case 'terms': return [...demoTerms];
        case 'students': return [...demoStudents];
        case 'profiles': return [...demoProfiles];
        case 'report_comments': return [];
        case 'exams': return [];
        case 'grade_scales': return [];
        case 'report_config': return [{ id: 'default', caWeight: 60, midtermWeight: 20, finalWeight: 20, caTypes: ['CA','Homework','Classwork','Quiz','Attendance'], updatedAt: new Date().toISOString() }];
        case 'lesson_plans': return [...demoLessonPlans];
        case 'lesson_plan_periods': return [...demoLessonPlanPeriods];
        case 'ai_reviews': return [];
        case 'lesson_period_ai_reviews': return [];
        case 'lesson_plan_quizzes': return [];
        case 'unit_plans': return [];
        default: return [];
      }
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
      maybeSingle: async () => {
        const rows = applyFilters(getTableData());
        return { data: rows[0] || null, error: null };
      },
      single: async () => {
        const rows = applyFilters(getTableData());
        if (rows.length === 0) return { data: null, error: { message: 'No rows', code: 'PGRST116' } };
        return { data: rows[0], error: null };
      },
      order: (col: string, opts?: any) => { orderCol = col.replace(/"/g,''); orderAsc = opts?.ascending ?? true; return chain; },
      limit: (n: number) => { limitVal = n; return chain; },
      range: (from: number, to: number) => { rangeFrom = from; rangeTo = to; return chain; },
      ilike: (col: string, pat: string) => { ilikeFilter = { col, pattern: pat }; return chain; },
      or: (expr: string) => { orFilter = expr; return chain; },
      returns: () => chain,
      delete: () => chain,
      insert: () => chain,
      update: () => chain,
      // For queries that are awaited directly (supabase.from(...).select(...))
      then: (onFulfilled: any, onRejected: any) => {
        const rows = applyFilters(getTableData());
        const result: any = { data: rows, error: null };
        if (chain._count) result.count = rows.length;
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
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

    // ── Lesson plans — week aggregate + submitter roster (preview) ─────────
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

    // For class_students_for_term etc fallback
    return { data: null, error: { message: `Mock RPC ${fn} not implemented`, code: 'PGRST202' } };
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
    auth: mockAuth as any,
    from: mockFrom as any,
    rpc: mockRpc as any,
    storage: mockStorage as any,
  } as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = globalThis.__supabase__
  ? globalThis.__supabase__
  : isPlaceholderEnv
    ? createMockSupabase()
    : createClient(supabaseUrl, supabaseAnonKey, {
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
