import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AppLanguage = 'en' | 'ar';

type Direction = 'ltr' | 'rtl';

type Dictionary = Record<string, string>;

const dictionaries: Record<AppLanguage, Dictionary> = {
  en: {
    'language.english': 'English',
    'language.arabic': 'Arabic',
    'language.switch': 'Change language',
    'language.switchTo': 'Switch language to',
    'app.madeBy': 'Made by',
    'session.active': 'Active Session',
    'session.signOut': 'Sign Out',
    'role.admin': 'Admin',
    'role.teacher': 'Teacher',
    'role.parent': 'Parent',
    'role.supervisor': 'Supervisor',
    'role.office': 'Office',

    'nav.Dashboard': 'Dashboard',
    'nav.Manage Users': 'Manage Users',
    'nav.Manage Students': 'Manage Students',
    'nav.Manage Academic': 'Manage Academic',
    'nav.Unit Plans': 'Unit Plans',
    'nav.Bulk Import': 'Bulk Import',
    'nav.Bulk Upload Grades': 'Bulk Upload Grades',
    'nav.Announcements': 'Announcements',
    'nav.Messages': 'Messages',
    'nav.Streams': 'Streams',
    'nav.Record Attendance': 'Record Attendance',
    'nav.Assign Homework': 'Assign Homework',
    'nav.Create Quiz': 'Create Quiz',
    'nav.Grade Quizzes': 'Grade Quizzes',
    'nav.Exam Verification': 'Exam Verification',
    'nav.Exam Verifications': 'Exam Verifications',
    'nav.Class Progress': 'Class Progress',
    'nav.Promote Classes': 'Promote Classes',
    'nav.Monitor Teacher': 'Monitor Teacher',
    'nav.AI Review Logs': 'AI Review Logs',
    'nav.Exam Reports': 'Exam Reports',
    'nav.Family IDs': 'Family IDs',
    'nav.My Classes': 'My Classes',
    'nav.Lesson Plans': 'Lesson Plans',
    'nav.Bulk Upload': 'Bulk Upload',
    'nav.My Submissions': 'My Submissions',
    'nav.My Children': 'My Children',
    'nav.Exam Results': 'Exam Results',
    'nav.Take Quiz': 'Take Quiz',
    'nav.Monthly Reports': 'Monthly Reports',
    'nav.Midterm Reports': 'Midterm Reports',
    'nav.Final Reports': 'Final Reports',
    'nav.Dismissal Gate': 'Dismissal Gate',
    'nav.Student Directory': 'Student Directory',

    'lessonReview.title': 'Lesson Plan Review',
    'lessonReview.subtitle': 'Read the plan, check the AI score, then approve or request revisions.',
    'lessonReview.regenerate': 'Regenerate AI Review',
    'lessonReview.regenerating': 'Regenerating…',
    'lessonReview.generateNow': 'Generate missing AI review + quizzes',
    'lessonReview.generatingNow': 'Generating AI review + quizzes…',
    'lessonReview.generateQuizzes': 'Generate quizzes now',
    'lessonReview.generatingQuizzes': 'Generating quizzes…',
    'lessonReview.redo': 'Redo AI Review',
    'lessonReview.redoing': 'Redoing AI review…',
    'lessonReview.quizzes': 'Quizzes',
    'lessonReview.noQuizzes': 'No auto-generated quizzes saved for this lesson plan yet.',
    'lessonReview.supervisorDecision': 'Supervisor Decision',
    'lessonReview.approve': 'Approve',
    'lessonReview.reject': 'Reject',
    'lessonReview.requestRevisions': 'Request Revisions (unlock for editing)',
    'lessonReview.commentPlaceholder': 'Add your comments for the teacher (optional, but recommended when requesting revisions)',

    'aiReview.title': 'AI Review',
    'aiReview.failed': 'AI review failed',
    'aiReview.retry': 'Retry AI review',
    'aiReview.retrying': 'Retrying AI review…',
    'aiReview.inProgress': 'AI review in progress',
    'aiReview.takingLong': 'AI review is taking longer than usual',
    'aiReview.strengths': 'Strengths',
    'aiReview.improvements': 'Improvements',
    'aiReview.supervisorComment': 'Supervisor comment',
  },
  ar: {
    'language.english': 'الإنجليزية',
    'language.arabic': 'العربية',
    'language.switch': 'تغيير اللغة',
    'language.switchTo': 'تغيير اللغة إلى',
    'app.madeBy': 'صنع بواسطة',
    'session.active': 'جلسة نشطة',
    'session.signOut': 'تسجيل الخروج',
    'role.admin': 'مدير',
    'role.teacher': 'معلم',
    'role.parent': 'ولي أمر',
    'role.supervisor': 'مشرف',
    'role.office': 'مكتب',

    'nav.Dashboard': 'لوحة التحكم',
    'nav.Manage Users': 'إدارة المستخدمين',
    'nav.Manage Students': 'إدارة الطلاب',
    'nav.Manage Academic': 'إدارة الأكاديميات',
    'nav.Unit Plans': 'خطط الوحدات',
    'nav.Bulk Import': 'استيراد جماعي',
    'nav.Bulk Upload Grades': 'رفع الدرجات جماعياً',
    'nav.Announcements': 'الإعلانات',
    'nav.Messages': 'الرسائل',
    'nav.Streams': 'المتابعات',
    'nav.Record Attendance': 'تسجيل الحضور',
    'nav.Assign Homework': 'تعيين الواجب',
    'nav.Create Quiz': 'إنشاء اختبار',
    'nav.Grade Quizzes': 'تصحيح الاختبارات',
    'nav.Exam Verification': 'مراجعة الاختبارات',
    'nav.Exam Verifications': 'مراجعات الاختبارات',
    'nav.Class Progress': 'تقدم الصف',
    'nav.Promote Classes': 'ترقية الصفوف',
    'nav.Monitor Teacher': 'متابعة المعلم',
    'nav.AI Review Logs': 'سجلات مراجعة الذكاء الاصطناعي',
    'nav.Exam Reports': 'تقارير الاختبارات',
    'nav.Family IDs': 'بطاقات العائلات',
    'nav.My Classes': 'صفوفي',
    'nav.Lesson Plans': 'خطط الدروس',
    'nav.Bulk Upload': 'رفع جماعي',
    'nav.My Submissions': 'تسليماتي',
    'nav.My Children': 'أطفالي',
    'nav.Exam Results': 'نتائج الاختبارات',
    'nav.Take Quiz': 'حل الاختبار',
    'nav.Monthly Reports': 'التقارير الشهرية',
    'nav.Midterm Reports': 'تقارير منتصف الفصل',
    'nav.Final Reports': 'التقارير النهائية',
    'nav.Dismissal Gate': 'بوابة الانصراف',
    'nav.Student Directory': 'دليل الطلاب',

    'lessonReview.title': 'مراجعة خطة الدرس',
    'lessonReview.subtitle': 'اقرأ الخطة، راجع درجة الذكاء الاصطناعي، ثم وافق أو اطلب تعديلات.',
    'lessonReview.regenerate': 'إعادة إنشاء مراجعة الذكاء الاصطناعي',
    'lessonReview.regenerating': 'جاري إعادة الإنشاء…',
    'lessonReview.generateNow': 'إنشاء مراجعة الذكاء الاصطناعي والاختبارات الآن',
    'lessonReview.generatingNow': 'جاري إنشاء المراجعة والاختبارات…',
    'lessonReview.generateQuizzes': 'إنشاء الاختبارات الآن',
    'lessonReview.generatingQuizzes': 'جاري إنشاء الاختبارات…',
    'lessonReview.redo': 'إعادة مراجعة الذكاء الاصطناعي',
    'lessonReview.redoing': 'جاري إعادة المراجعة…',
    'lessonReview.quizzes': 'الاختبارات',
    'lessonReview.noQuizzes': 'لا توجد اختبارات منشأة تلقائياً لهذه الخطة بعد.',
    'lessonReview.supervisorDecision': 'قرار المشرف',
    'lessonReview.approve': 'موافقة',
    'lessonReview.reject': 'رفض',
    'lessonReview.requestRevisions': 'طلب تعديلات وفتح التحرير',
    'lessonReview.commentPlaceholder': 'أضف تعليقاتك للمعلم (اختياري، ومفضل عند طلب التعديلات)',

    'aiReview.title': 'مراجعة الذكاء الاصطناعي',
    'aiReview.failed': 'فشلت مراجعة الذكاء الاصطناعي',
    'aiReview.retry': 'إعادة محاولة مراجعة الذكاء الاصطناعي',
    'aiReview.retrying': 'جاري إعادة المحاولة…',
    'aiReview.inProgress': 'مراجعة الذكاء الاصطناعي قيد التنفيذ',
    'aiReview.takingLong': 'تستغرق مراجعة الذكاء الاصطناعي وقتاً أطول من المعتاد',
    'aiReview.strengths': 'نقاط القوة',
    'aiReview.improvements': 'التحسينات',
    'aiReview.supervisorComment': 'تعليق المشرف',
  },
};

const directionByLanguage: Record<AppLanguage, Direction> = {
  en: 'ltr',
  ar: 'rtl',
};

interface I18nContextValue {
  language: AppLanguage;
  direction: Direction;
  setLanguage: (language: AppLanguage) => void;
  t: (key: string, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'en';
  return window.localStorage.getItem('mbk-language') === 'ar' ? 'ar' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(initialLanguage);

  useEffect(() => {
    const direction = directionByLanguage[language];
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
    window.localStorage.setItem('mbk-language', language);
  }, [language]);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    direction: directionByLanguage[language],
    setLanguage,
    t: (key, fallback) => dictionaries[language][key] ?? dictionaries.en[key] ?? fallback ?? key,
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}
