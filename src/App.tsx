import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RoleProvider, useRole } from './context/RoleContext';
import { ToastProvider } from './context/ToastContext';
import { ToastContainer } from './components/ui/Toast';
import { applyStoredAppearance } from './components/ui/ThemeSwitcher';
import { LoginPage } from './components/landing/LoginPage';
import { DashboardLayout } from './components/layout/DashboardLayout';
import { queryClient } from './lib/queryClient';
import { I18nProvider } from './lib/i18n/AppLanguageContext';

// Admin Pages
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { ManageUsers } from './pages/admin/ManageUsers';
import { ManageClassSubjects } from './pages/admin/ManageClassSubjects';
import { ManageStudents } from './pages/admin/ManageStudents';
import { ClassImport } from './pages/admin/ClassImport';
import { ManageAcademic } from './pages/admin/ManageAcademic';
import { BulkUpload } from './pages/admin/BulkUpload';
import { FamilyIds } from './pages/admin/FamilyIds';
import { canAccessRoute, DEFAULT_ROUTE } from './lib/routing';
import { GateScreen } from './pages/admin/gate/GateScreen';
import { ManageDrivers } from './pages/admin/drivers/ManageDrivers';
import { OfficeDashboard } from './pages/office/OfficeDashboard';
import { StudentDirectory } from './pages/office/StudentDirectory';
import { ExamVerification } from './pages/admin/ExamVerification';
import { GradeCorrections } from './pages/admin/GradeCorrections';
import { MonitorTeachers } from './pages/admin/MonitorTeachers';
import { MonitorMarksEntries } from './pages/supervisor/MonitorMarksEntries';
import { ClassProgress } from './pages/admin/ClassProgress';
import { ClassAnnouncements } from './pages/admin/ClassAnnouncements';
import { ClassPromotion } from './pages/admin/ClassPromotion';
import { AiReviewLogs } from './pages/admin/AiReviewLogs';
import { DuplicateStudents } from './pages/admin/DuplicateStudents';

// Supervisor Pages
import { SupervisorDashboard } from './pages/supervisor/SupervisorDashboard';

// Teacher Pages
import { TeacherDashboard } from './pages/teacher/TeacherDashboard';
import { TeacherStudents } from './pages/teacher/TeacherStudents';
import { UploadResults } from './pages/teacher/UploadResults';
import { BulkUploadGrades } from './pages/teacher/BulkUploadGrades';
import { AllResults } from './pages/teacher/AllResults';
import { RecordAttendance } from './pages/teacher/RecordAttendance';
import { AssignHomework } from './pages/teacher/AssignHomework';
import { CreateQuiz } from './pages/teacher/CreateQuiz';
import { GradeQuizzes } from './pages/teacher/GradeQuizzes';
import { LessonPlanner } from './pages/teacher/LessonPlanner';
import { LessonPlanReview } from './pages/supervisor/LessonPlanReview';
import { LessonPlanSubmissions } from './pages/supervisor/LessonPlanSubmissions';
import { UnitPlans } from './pages/teacher/UnitPlans';

// Shared Reports
import { ExamReport } from './pages/reports/ExamReport';

// Parent Pages (mobile-first parent app — see components/layout/ParentAppShell)
import { ParentAppShell } from './components/layout/ParentAppShell';
import { ParentDashboard } from './pages/parent/ParentDashboard';
import { ParentQuizzes } from './pages/parent/ParentQuizzes';
import { ChildrenView } from './pages/parent/ChildrenView';
import { ExamResults } from './pages/parent/ExamResults';
import { MorePage, PickupCardPage } from './pages/parent/MorePage';
import { WeeklyLearning } from './pages/parent/WeeklyLearning';
import { MessagesPage } from './pages/shared/MessagesPage';
import { StreamsPage } from './pages/shared/StreamsPage';


function AppContent() {
  const { session, isLoggedIn, loading } = useRole();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-teal-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900 mb-2">Loading...</h2>
          <p className="text-slate-600">Please wait while we set up your session</p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn || !session) {
    return <LoginPage />;
  }

  // ── Parent app ──────────────────────────────────────────────────────────
  // Parents get the mobile-first shell (bottom navigation: Home · Children ·
  // Results · Messages · More) instead of the staff sidebar. Monthly/Midterm/
  // Final are no longer separate destinations — their old paths open the
  // unified Exam Results screen on the matching tab, so existing links keep
  // working.
  if (session.role === 'parent') {
    return (
      <ParentAppShell>
        {(currentPath, navigate) => {
          if (!canAccessRoute(session.role, currentPath)) {
            return <RouteRedirect to={DEFAULT_ROUTE[session.role]} navigate={navigate} />;
          }
          switch (currentPath) {
            case '/dashboard': return <ParentDashboard navigate={navigate} />;
            case '/parent/children': return <ChildrenView navigate={navigate} />;
            case '/parent/results': return <ExamResults key="results" />;
            case '/parent/monthly': return <ExamResults key="results-monthly" initialTab="monthly" />;
            case '/parent/midterm': return <ExamResults key="results-midterm" initialTab="midterm" />;
            case '/parent/final': return <ExamResults key="results-final" initialTab="final" />;
            case '/parent/more': return <MorePage navigate={navigate} />;
            case '/parent/pickup-card': return <PickupCardPage />;
            case '/parent/weekly-learning': return <WeeklyLearning navigate={navigate} />;
            case '/parent/quizzes': return <ParentQuizzes />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <ParentDashboard navigate={navigate} />;
          }
        }}
      </ParentAppShell>
    );
  }

  return (
    <DashboardLayout fullscreenPaths={['/gate']}>
      {(currentPath, navigate) => {
        // Single enforcement point for ROUTE_ACCESS. Previously canAccessRoute()
        // was exported and unit-tested but never called, so the per-role
        // switches below were the only guard. Anything the map denies is sent
        // to the role's default route before any page renders.
        if (!canAccessRoute(session.role, currentPath)) {
          return <RouteRedirect to={DEFAULT_ROUTE[session.role]} navigate={navigate} />;
        }
        // Admin routes
        if (session.role === 'admin') {
          switch (currentPath) {
            case '/gate': return <GateScreen navigate={navigate} />;
            case '/dashboard': return <AdminDashboard navigate={navigate} />;
            case '/admin/users': return <ManageUsers />;
            case '/admin/class-subjects': return <ManageClassSubjects />;
            case '/admin/students': return <ManageStudents />;
            case '/admin/class-import': return <ClassImport />;
            case '/admin/academic': return <ManageAcademic />;
            case '/admin/bulk': return <BulkUpload />;
            case '/admin/family-ids': return <FamilyIds mode="browse" navigate={navigate} />;
            case '/admin/family-ids/setup': return <FamilyIds mode="setup" navigate={navigate} />;
            case '/admin/drivers': return <ManageDrivers />;
            case '/directory': return <StudentDirectory />;
            case '/admin/bulk-grades': return <BulkUploadGrades />;
            case '/admin/exams': return <ExamVerification />;
            case '/admin/grade-corrections': return <GradeCorrections />;
            case '/admin/monitor': return <MonitorTeachers />;
            case '/admin/monitor-marks': return <MonitorMarksEntries />;
            case '/supervisor/monitor-marks': return <MonitorMarksEntries />;
            case '/admin/ai-logs': return <AiReviewLogs />;
            case '/admin/class-progress': return <ClassProgress />;
            case '/admin/exam-reports': return <ExamReport />;
            case '/admin/announcements': return <ClassAnnouncements />;
            case '/admin/promotion': return <ClassPromotion />;
            case '/admin/duplicate-students': return <DuplicateStudents />;
            case '/admin/unit-plans': return <UnitPlans />;
            // Admin reviews lesson plans exactly like a supervisor: the DB
            // already grants both roles the same rights (admin_all_plans RLS
            // plus the ('supervisor','admin') checks in decide_lesson_plan_review,
            // request_lesson_plan_revision, retry_lesson_plan_ai_review and the
            // quiz-replacement RPC). The supervisor URL is honoured too, so a
            // link shared by a supervisor opens for an admin.
            case '/admin/lesson-plans': return <LessonPlanReview navigate={navigate} submissionTrackingPath="/admin/lesson-plan-submissions" />;
            case '/supervisor/lesson-plans': return <LessonPlanReview navigate={navigate} />;
            // Admin lesson-plan creation (same wizard teachers use, with every
            // class/subject available — LessonPlanner is admin-aware).
            case '/admin/lesson-planner': return <LessonPlanner />;
            // Lesson-plan submission tracking (who submitted / who hasn't) —
            // same supervisor+admin rights as review (list_lesson_plan_submitters
            // allows exactly those roles), on the admin path so the admin
            // sidebar stays under /admin/*.
            case '/admin/lesson-plan-submissions': return <LessonPlanSubmissions navigate={navigate} reviewPath="/admin/lesson-plans" />;
            case '/supervisor/lesson-plan-submissions': return <LessonPlanSubmissions navigate={navigate} />;
            case '/admin/attendance': return <RecordAttendance />;
            case '/admin/homework': return <AssignHomework />;
            case '/admin/quizzes': return <CreateQuiz />;
            case '/admin/grade-quizzes': return <GradeQuizzes />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <AdminDashboard navigate={navigate} />;
          }
        }

          // Supervisor routes
          if (session.role === 'supervisor') {
            switch (currentPath) {
              case '/gate': return <GateScreen navigate={navigate} />;
              case '/admin/family-ids': return <FamilyIds mode="browse" navigate={navigate} />;
              case '/admin/duplicate-students': return <DuplicateStudents />;
              case '/directory': return <StudentDirectory />;
              case '/dashboard': return <SupervisorDashboard />;
              case '/supervisor/students': return <TeacherStudents />;
              case '/supervisor/verifications': return <ExamVerification />;
              case '/supervisor/reports': return <ExamReport />;
              case '/supervisor/lesson-plans': return <LessonPlanReview navigate={navigate} />;
              case '/supervisor/lesson-plan-submissions': return <LessonPlanSubmissions navigate={navigate} />;
              case '/supervisor/monitor-marks': return <MonitorMarksEntries />;
              case '/supervisor/unit-plans': return <UnitPlans />;
              case '/supervisor/attendance': return <RecordAttendance />;
              case '/supervisor/homework': return <AssignHomework />;
              case '/supervisor/quizzes': return <CreateQuiz />;
              case '/supervisor/grade-quizzes': return <GradeQuizzes />;
              case '/messages': return <MessagesPage />;
              case '/streams': return <StreamsPage />;
              default: return <SupervisorDashboard />;
            }
          }

        // Teacher routes
          if (session.role === 'teacher') {
          switch (currentPath) {
            case '/dashboard': return <TeacherDashboard navigate={navigate} />;
            case '/teacher/students': return <TeacherStudents />;
            case '/teacher/results': return <UploadResults navigate={navigate} />;
            case '/teacher/bulk-grades': return <BulkUploadGrades />;
            case '/teacher/all-results': return <AllResults />;
            case '/teacher/exam-reports': return <ExamReport />;
            case '/teacher/announcements': return <ClassAnnouncements />;
            case '/teacher/attendance': return <RecordAttendance />;
            case '/teacher/homework': return <AssignHomework />;
            case '/teacher/quizzes': return <CreateQuiz />;
            case '/teacher/grade-quizzes': return <GradeQuizzes />;
            case '/teacher/unit-plans': return <UnitPlans />;
            case '/teacher/lesson-plans': return <LessonPlanner />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <TeacherDashboard navigate={navigate} />;
          }
        }

        // Office routes (gate staff — read/lookup only)
        if (session.role === 'office') {
          switch (currentPath) {
            case '/gate': return <GateScreen navigate={navigate} />;
            case '/admin/family-ids': return <FamilyIds mode="browse" navigate={navigate} />;
            case '/admin/drivers': return <ManageDrivers />;
            case '/directory': return <StudentDirectory />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <OfficeDashboard navigate={navigate} />;
          }
        }

        return <div>Unknown role</div>;
      }}
    </DashboardLayout>
  );
}

/** Redirect helper for the central route guard (no router dependency). */
function RouteRedirect({ to, navigate }: { to: string; navigate: (path: string) => void }) {
  useEffect(() => { navigate(to); }, [to, navigate]);
  return null;
}

export default function App() {
  useEffect(() => {
    applyStoredAppearance();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <I18nProvider>
          <RoleProvider>
            <AppContent />
            <ToastContainer />
          </RoleProvider>
        </I18nProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
