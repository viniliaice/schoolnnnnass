import {
  LayoutDashboard, Users, GraduationCap, FileText,
  Upload, BookOpen,
  FileBarChart, Award, DatabaseBackup, BellRing, Mail, Activity, ArrowUpDown,
  CalendarCheck, BookOpenCheck, HelpCircle, NotepadText, Layers,
  UserCog, Library, CheckCheck, BadgeCheck, Eye, TrendingUp, CalendarDays
} from 'lucide-react';
import { Role } from '../../types';

export interface NavItem {
  label: string;
  icon: typeof LayoutDashboard;
  path: string;
}

export interface NavGroup {
  /** Section heading; `null` renders the items without a heading. */
  title: string | null;
  items: NavItem[];
}

/** Shared across every role — kept in one place so paths can't drift. */
const DASHBOARD: NavItem = { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' };
const COMMUNICATION_ITEMS: NavItem[] = [
  { label: 'Messages', icon: Mail, path: '/messages' },
  { label: 'Streams', icon: Activity, path: '/streams' },
];

export const navGroups: Record<Role, NavGroup[]> = {
  admin: [
    { title: null, items: [DASHBOARD] },
    {
      title: 'People',
      items: [
        { label: 'Manage Users', icon: UserCog, path: '/admin/users' },
        { label: 'Manage Students', icon: GraduationCap, path: '/admin/students' },
        { label: 'Promote Classes', icon: ArrowUpDown, path: '/admin/promotion' },
      ],
    },
    {
      title: 'Academics',
      items: [
        { label: 'Manage Academic', icon: Library, path: '/admin/academic' },
        { label: 'Lesson Plans', icon: NotepadText, path: '/admin/lesson-plans' },
        { label: 'Unit Plans', icon: Layers, path: '/admin/unit-plans' },
        { label: 'Bulk Import', icon: DatabaseBackup, path: '/admin/bulk' },
      ],
    },
    {
      title: 'Teaching',
      items: [
        { label: 'Record Attendance', icon: CalendarCheck, path: '/admin/attendance' },
        { label: 'Assign Homework', icon: BookOpenCheck, path: '/admin/homework' },
        { label: 'Create Quiz', icon: HelpCircle, path: '/admin/quizzes' },
      ],
    },
    {
      title: 'Assessment',
      items: [
        { label: 'Grade Quizzes', icon: CheckCheck, path: '/admin/grade-quizzes' },
        { label: 'Exam Verification', icon: BadgeCheck, path: '/admin/exams' },
        { label: 'Monitor Teachers', icon: Eye, path: '/admin/monitor' },
      ],
    },
    {
      title: 'Insights',
      items: [
        { label: 'Class Progress', icon: TrendingUp, path: '/admin/class-progress' },
        { label: 'Exam Reports', icon: FileBarChart, path: '/admin/exam-reports' },
      ],
    },
    {
      title: 'Communication',
      items: [
        { label: 'Announcements', icon: BellRing, path: '/admin/announcements' },
        ...COMMUNICATION_ITEMS,
      ],
    },
  ],
  teacher: [
    { title: null, items: [DASHBOARD] },
    {
      title: 'Classroom',
      items: [
        { label: 'My Classes', icon: GraduationCap, path: '/teacher/students' },
        { label: 'Record Attendance', icon: CalendarCheck, path: '/teacher/attendance' },
        { label: 'Assign Homework', icon: BookOpenCheck, path: '/teacher/homework' },
      ],
    },
    {
      title: 'Planning',
      items: [
        { label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' },
        { label: 'Unit Plans', icon: Layers, path: '/teacher/unit-plans' },
      ],
    },
    {
      title: 'Assessment',
      items: [
        { label: 'Create Quiz', icon: HelpCircle, path: '/teacher/quizzes' },
        { label: 'Grade Quizzes', icon: CheckCheck, path: '/teacher/grade-quizzes' },
        { label: 'Upload Results', icon: Upload, path: '/teacher/results' },
        { label: 'My Submissions', icon: FileText, path: '/teacher/all-results' },
      ],
    },
    {
      title: 'Insights',
      items: [
        { label: 'Exam Reports', icon: FileBarChart, path: '/teacher/exam-reports' },
      ],
    },
    {
      title: 'Communication',
      items: [
        { label: 'Announcements', icon: BellRing, path: '/teacher/announcements' },
        ...COMMUNICATION_ITEMS,
      ],
    },
  ],
  supervisor: [
    { title: null, items: [DASHBOARD] },
    {
      title: 'Classroom',
      items: [
        { label: 'My Classes', icon: GraduationCap, path: '/supervisor/students' },
        { label: 'Record Attendance', icon: CalendarCheck, path: '/supervisor/attendance' },
        { label: 'Assign Homework', icon: BookOpenCheck, path: '/supervisor/homework' },
      ],
    },
    {
      title: 'Planning',
      items: [
        { label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' },
        { label: 'Unit Plans', icon: Layers, path: '/supervisor/unit-plans' },
      ],
    },
    {
      title: 'Assessment',
      items: [
        { label: 'Create Quiz', icon: HelpCircle, path: '/supervisor/quizzes' },
        { label: 'Grade Quizzes', icon: CheckCheck, path: '/supervisor/grade-quizzes' },
        { label: 'Exam Verification', icon: BadgeCheck, path: '/supervisor/verifications' },
      ],
    },
    {
      title: 'Insights',
      items: [
        { label: 'Exam Reports', icon: FileBarChart, path: '/supervisor/reports' },
      ],
    },
    { title: 'Communication', items: COMMUNICATION_ITEMS },
  ],
  parent: [
    { title: null, items: [DASHBOARD] },
    {
      title: 'Family',
      items: [
        { label: 'My Children', icon: Users, path: '/parent/children' },
        { label: 'Take Quiz', icon: HelpCircle, path: '/parent/quizzes' },
      ],
    },
    {
      title: 'Reports',
      items: [
        { label: 'Exam Results', icon: BookOpen, path: '/parent/results' },
        { label: 'Monthly Reports', icon: CalendarDays, path: '/parent/monthly' },
        { label: 'Midterm Reports', icon: FileBarChart, path: '/parent/midterm' },
        { label: 'Final Reports', icon: Award, path: '/parent/final' },
      ],
    },
    { title: 'Communication', items: COMMUNICATION_ITEMS },
  ],
};
