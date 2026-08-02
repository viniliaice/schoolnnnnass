export type Role = 'admin' | 'teacher' | 'parent' | 'supervisor';
export type ExamStatus = 'pending' | 'approved' | 'rejected';
export type ExamType = 'CA' | 'Homework' | 'Classwork' | 'Quiz' | 'Midterm' | 'Final'| 'Attendance' | 'Discipline';

export const EXAM_TYPES: ExamType[] = ['CA', 'Homework', 'Classwork', 'Quiz', 'Midterm', 'Final', 'Attendance', 'Discipline'];
export const CA_TYPES: ExamType[] = ['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance'];

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const CLASSES = [
  // Kindergarten
  'Foundation A','Foundation C','Foundation D', 'Foundation B',
  'KG-A', 'KG-B', 'KG-C','KG-D','KG-E',

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

export const DEPARTMENTS = [
  'Mathematics', 'Science', 'English & Languages', 'Humanities',
  'Islamic Studies', 'Somali & Arabic', 'Arts & PE',
];

export interface User {
  id: string;
  name: string;
  email: string;
  password?: string;
  role: Role;
  // Parent-specific fields
  phone1?: string;
  phone2?: string;
  xafada?: string;
  udow?: string;
  paymentnumber?: string;
  // Teacher-specific fields
  assignedClasses?: string[];
  assignedSubjects?: string[];
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
  color?: string;
  weeklyLessons?: number;
  department?: string;
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
  score: number | null;
  total: number;
  examType: ExamType;
  month: string;
  status: ExamStatus;
  parentId: string | null;
  date: string;
  createdAt: string;
  teacherId: string;
  assessmentLabel?: string | null;
  entryState?: 'scored' | 'absent' | 'not_applicable';
  uploadedBy?: string | null;
}

export function isScoredExam(exam: Pick<Exam, 'score' | 'entryState'>): boolean {
  return exam.score !== null && (exam.entryState == null || exam.entryState === 'scored');
}

export interface TeacherExamProgress {
  teacherId: string;
  teacherName: string;
  className: string;
  subjectId: string;
  subjectName: string;
  month: string;
  requiredEntries: number;
  completedEntries: number;
  completionStatus: 'complete' | 'incomplete';
  completionPercent: number;
  homeworkEntered: number;
  caEntered: number;
  classworkEntered: number;
  attendanceEntered: number;
  quizEntered: number;
  totalStudents: number;
  missingExamTypes: string[];
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
  examEntries: { examType: ExamType; score: number; total: number }[];
}

export interface TeacherExamProgressVerification {
  teacherId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  month: string;
  totalStudents: number;
  totalExamRows: number;
  rowCountsByExamType: Partial<Record<ExamType, number>>;
  studentCountsByExamType: Partial<Record<ExamType, number>>;
}

export interface RoleSession {
  role: Role;
  userId: string;
  userName: string;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info' | 'loading';
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
  color?: string;
  weeklyLessons?: number;
  department?: string;
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
  examId?: string;
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
  score: number | null;
  total: number;
  examType: ExamType;
  month: string;
  status: ExamStatus;
  parentId: string | null;
  date: string;
  createdAt: string;
  teacherId: string;
  assessmentLabel?: string | null;
  entryState?: 'scored' | 'absent' | 'not_applicable';
  uploadedBy?: string | null;
  termId?: string;
  subjectId?: string;
  comment?: string;
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
    examId?: string;
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
  examId?: string;
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

export interface AttendanceRecord {
  id: string;
  studentId: string;
  className: string;
  date: string;
  status: 'present' | 'absent' | 'late';
  note?: string | null;
  teacherId: string;
  createdAt: string;
}

export type QuestionType = 'multiple_choice' | 'direct_answer';

export interface Question {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: { label: string; text: string }[] | null;
  correctAnswer?: string | null;
  rubric?: string | null;
  teacherId: string;
  createdAt: string;
}

export interface Quiz {
  id: string;
  className: string;
  subject: string;
  title: string;
  description?: string | null;
  openDate: string;
  dueDate: string;
  timeLimit?: number | null;
  questionOrder: 'created' | 'randomized';
  teacherId: string;
  status: 'draft' | 'active' | 'closed';
  createdAt: string;
}

export interface QuizQuestion {
  id: string;
  quizId: string;
  questionId: string;
  orderIndex: number;
  points: number;
  promptSnapshot: string;
  optionsSnapshot?: { label: string; text: string }[] | null;
  correctAnswerSnapshot?: string | null;
  typeSnapshot: QuestionType;
}

export interface QuizAttemptAnswer {
  questionId: string;
  answer: string;
  pointsEarned?: number | null;
  isCorrect?: boolean | null;
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  studentId: string;
  answers: QuizAttemptAnswer[];
  totalEarned: number;
  totalPossible: number;
  startedAt: string;
  submittedAt?: string | null;
  status: 'in_progress' | 'submitted' | 'graded';
}

export interface HomeworkRecord {
  id: string;
  studentId: string;
  className: string;
  subject: string;
  title: string;
  description?: string | null;
  dueDate: string;
  status: 'assigned' | 'submitted' | 'graded';
  teacherId: string;
  createdAt: string;
}

export interface Announcement {
  id: string;
  className: string;
  message: string;
  createdBy: string;
  createdAt: string;
}

export interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  subject: string;
  body: string;
  readAt?: string | null;
  createdAt: string;
}

export interface StudentPromotion {
  id: string;
  studentId: string;
  fromClass: string;
  toClass: string;
  academicYearId?: string | null;
  createdAt: string;
}

export interface PromoteResult {
  promoted_id: string;
  student_name: string;
  old_class: string;
  new_class: string;
}

const GRADE_PATTERN = /^Grade (\d+)-([A-Z])$/;
const FOUNDATION_PATTERN = /^Foundation\s+([A-Z])$/i;
const KG_PATTERN = /^KG-([A-Z])$/;
const YEAR12_PATTERN = /^Year\s+12-([A-Z])$/i;

export function getNextClass(currentClass: string): string | null {
  const trimmed = currentClass.trim();

  // KG -> Foundation (same section)
  const kgMatch = trimmed.match(KG_PATTERN);
  if (kgMatch) {
    return `Foundation ${kgMatch[1].toUpperCase()}`;
  }

  // Foundation -> Grade 1 (same section)
  const foundationMatch = trimmed.match(FOUNDATION_PATTERN);
  if (foundationMatch) {
    return `Grade 1-${foundationMatch[1].toUpperCase()}`;
  }

  // Grade N -> Grade N+1 (same section)
  const gradeMatch = trimmed.match(GRADE_PATTERN);
  if (gradeMatch) {
    const gradeNum = parseInt(gradeMatch[1], 10);
    if (gradeNum >= 12) return null; // Graduated
    return `Grade ${gradeNum + 1}-${gradeMatch[2].toUpperCase()}`;
  }

  // Year 12 -> graduated
  if (YEAR12_PATTERN.test(trimmed)) return null;

  return null;
}

// ============================================================================
// AI Lesson & Unit Plan Review System
// ============================================================================

export type DayOfWeek = 'Saturday' | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday';
export const DAYS_OF_WEEK: DayOfWeek[] = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];

export type PlanStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'ai_failed'
  | 'revision_requested';

/**
 * A plan's content may only be edited while it is a draft or has been
 * explicitly reopened by a supervisor. Mirrors lesson_plan_is_editable() in SQL.
 */
export const EDITABLE_PLAN_STATUSES: PlanStatus[] = ['draft', 'revision_requested'];

export function isPlanEditable(status: PlanStatus | null | undefined): boolean {
  return !!status && EDITABLE_PLAN_STATUSES.includes(status);
}

export type ReviewStatus = 'pending' | 'reviewed';

export interface LessonPlan {
  id: string;
  teacher_id: string;
  subject_id: string | null;
  class_name: string;
  week_label: string;
  title: string;
  status: PlanStatus;
  period_count: number;
  previous_score: number | null;
  previous_reviewed_at: string | null;
  /** When the AI review call started — used to time out stuck plans. */
  ai_started_at?: string | null;
  /** Human-readable reason the last AI review failed. */
  ai_failure_reason?: string | null;
  /** Supervisor's note when reopening the plan for edits. */
  revision_note?: string | null;
  revision_requested_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type AiReviewOutcome =
  | 'success'
  | 'timeout'
  | 'api_error'
  | 'unit_match_error'
  | 'malformed_json'
  | 'rate_limit'
  | 'save_error'
  | 'unknown';

/** One row per AI review attempt, for admin-facing failure monitoring. */
export interface AiReviewLog {
  id: string;
  plan_id: string | null;
  teacher_id: string | null;
  outcome: AiReviewOutcome;
  error_code: string | null;
  message: string | null;
  latency_ms: number | null;
  attempt: number;
  created_at: string;
}

export interface PeriodActivity {
  activity: string;
  time: string;
  resource: string;
  place: string;
}

export interface LessonPlanPeriod {
  id: string;
  plan_id: string;
  day: DayOfWeek;
  period_number: number;
  class_name: string | null;
  subject: string | null;
  is_free: boolean | null;
  topic: string;
  objective: string | null;
  activities: string;
  slide_number: string | null;
  details: PeriodActivity[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryScore {
  score: number;
  explanation: string;
}

export interface ImprovementItem {
  area: string;
  why: string;
  recommendation: string;
}

export interface SupervisorNotes {
  status_recommendation: string;
  reasoning: string;
}

export interface AIReviewScores {
  learning_objectives: CategoryScore;
  lesson_structure: CategoryScore;
  student_engagement: CategoryScore;
  teaching_strategies: CategoryScore;
  differentiation: CategoryScore;
  assessment_methods: CategoryScore;
  curriculum_alignment: CategoryScore;
  classroom_management: CategoryScore;
  resources_materials: CategoryScore;
  overall_quality: CategoryScore;
}

export interface AdditionalData {
  latency_ms: number;
  model_used: string;
  input_tokens?: number;
  output_tokens?: number;
  retries?: number;
}

export interface AIReview {
  id: string;
  plan_id: string;
  scores: AIReviewScores;
  executive_summary: string;
  total_score: number;
  percentage: number;
  performance_level: string;
  strengths: string[];
  improvements: ImprovementItem[];
  ai_summary_notes: SupervisorNotes;
  additional_data: AdditionalData;
  status: ReviewStatus;
  supervisor_comment: string | null;
  created_at: string;
  updated_at: string;
}

// Raw LLM output shape (matches the system prompt JSON schema)
export interface ReviewResult {
  schema_version: number;
  executive_summary: string;
  category_scores: AIReviewScores;
  total_score: number;
  percentage: number;
  performance_level: string;
  score_explanation: string;
  strengths: string[];
  improvements: ImprovementItem[];
  supervisor_notes: SupervisorNotes;
}

// Edge Function request payload
export interface ReviewPayload {
  plan_id: string;
  periods: {
    day: DayOfWeek;
    period_number: number;
    class_name?: string | null;
    subject?: string | null;
    is_free?: boolean | null;
    topic: string;
    objective?: string | null;
    activities: string;
    slide_number?: string | null;
    details?: PeriodActivity[];
  }[];
  unit_context?: {
    name: string;
    objectives: string;
  };
}

// Edge Function success response
export interface ReviewResponse {
  review_id: string;
  plan_id: string;
  executive_summary: string;
  total_score: number;
  percentage: number;
  performance_level: string;
  category_scores: AIReviewScores;
  strengths: string[];
  improvements: ImprovementItem[];
  ai_summary_notes: SupervisorNotes;
  latency_ms: number;
  model_used: string;
}

// Edge Function error response
export interface ReviewErrorResponse {
  error: string;
  code: 'TIMEOUT' | 'API_KEY_ERROR' | 'TOKEN_OVERFLOW' | 'RATE_LIMIT' | 'MALFORMED_JSON' | 'SAVE_ERROR' | 'INTERNAL_ERROR' | 'UNKNOWN';
  latency_ms?: number;
}

// ============================================================================
// Unit Plans
// ============================================================================

export interface UnitPlan {
  id: string;
  name: string;
  subject_id: string;
  class_name: string;
  term_id: string;
  week_number_start: number;
  week_number_end: number;
  objectives: string;
  teacher_id: string;
  created_at: string;
  updated_at: string;
}

export interface UnitPlanInput {
  name: string;
  subject_id: string;
  class_name: string;
  term_id: string;
  week_number_start: number;
  week_number_end: number;
  objectives: string;
}

// Period save payload (for the atomic RPC)
export interface SavePeriodsPayload {
  plan_id: string;
  periods: {
    day: DayOfWeek;
    period_number: number;
    class_name?: string | null;
    subject?: string | null;
    is_free?: boolean | null;
    topic: string;
    objective?: string | null;
    activities?: string;
    slide_number?: string | null;
    details?: PeriodActivity[];
  }[];
}

// Performance level helpers
export const PERFORMANCE_LEVELS = [
  { key: 'excellent', label: 'Excellent', min: 90, color: 'emerald' },
  { key: 'very_good', label: 'Very Good', min: 80, color: 'blue' },
  { key: 'good', label: 'Good', min: 70, color: 'amber' },
  { key: 'needs_improvement', label: 'Needs Improvement', min: 60, color: 'orange' },
  { key: 'requires_revision', label: 'Requires Significant Revision', min: 0, color: 'rose' },
] as const;

export function getPerformanceLevel(percentage: number): typeof PERFORMANCE_LEVELS[number] {
  for (const level of PERFORMANCE_LEVELS) {
    if (percentage >= level.min) return level;
  }
  return PERFORMANCE_LEVELS[PERFORMANCE_LEVELS.length - 1];
}
