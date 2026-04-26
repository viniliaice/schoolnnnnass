import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RoleProvider, useRole } from './context/RoleContext';
import { ToastProvider } from './context/ToastContext';
import { ToastContainer } from './components/ui/Toast';
import { LoginPage } from './components/landing/LoginPage';
import { SignUpPage } from './components/landing/SignUpPage';
import { DashboardLayout } from './components/layout/DashboardLayout';
import { queryClient } from './lib/queryClient';

// Admin Pages
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { ManageUsers } from './pages/admin/ManageUsers';
import { ManageClassSubjects } from './pages/admin/ManageClassSubjects';
import { ManageStudents } from './pages/admin/ManageStudents';
import { ManageAcademic } from './pages/admin/ManageAcademic';
import { BulkUpload } from './pages/admin/BulkUpload';
import { ExamVerification } from './pages/admin/ExamVerification';
import { MonitorTeachers } from './pages/admin/MonitorTeachers';
import { ClassProgress } from './pages/admin/ClassProgress';
import { ClassAnnouncements } from './pages/admin/ClassAnnouncements';

// Supervisor Pages
import { SupervisorDashboard } from './pages/supervisor/SupervisorDashboard';

// Teacher Pages
import { TeacherDashboard } from './pages/teacher/TeacherDashboard';
import { TeacherStudents } from './pages/teacher/TeacherStudents';
import { UploadResults } from './pages/teacher/UploadResults';
import { AllResults } from './pages/teacher/AllResults';

// Shared Reports
import { ExamReport } from './pages/reports/ExamReport';

// Parent Pages
import { ParentDashboard } from './pages/parent/ParentDashboard';
import { ChildrenView } from './pages/parent/ChildrenView';
import { ExamResults } from './pages/parent/ExamResults';
import { MonthlyReport } from './pages/parent/MonthlyReport';
import { MidtermReport } from './pages/parent/MidtermReport';
import { FinalReport } from './pages/parent/FinalReport';
import { MessagesPage } from './pages/shared/MessagesPage';
import { StreamsPage } from './pages/shared/StreamsPage';


function AppContent() {
  const { session, isLoggedIn, loading } = useRole();
  const [showSignUp, setShowSignUp] = useState(false);

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
    return (
      <>
        {showSignUp ? <SignUpPage /> : <LoginPage />}
        <div className="text-center mt-4">
          {showSignUp ? (
            <button
              className="text-indigo-600 hover:underline font-medium"
              onClick={() => setShowSignUp(false)}
            >
              Already have an account? Log in
            </button>
          ) : (
            <button
              className="text-indigo-600 hover:underline font-medium"
              onClick={() => setShowSignUp(true)}
            >
              Don't have an account? Sign up
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <DashboardLayout>
      {(currentPath, navigate) => {
        // Admin routes
        if (session.role === 'admin') {
          switch (currentPath) {
            case '/dashboard': return <AdminDashboard navigate={navigate} />;
            case '/admin/users': return <ManageUsers />;
            case '/admin/class-subjects': return <ManageClassSubjects />;
            case '/admin/students': return <ManageStudents />;
            case '/admin/academic': return <ManageAcademic />;
            case '/admin/bulk': return <BulkUpload />;
            case '/admin/exams': return <ExamVerification />;
            case '/admin/monitor': return <MonitorTeachers />;
            case '/admin/class-progress': return <ClassProgress />;
            case '/admin/exam-reports': return <ExamReport />;
            case '/admin/announcements': return <ClassAnnouncements />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <AdminDashboard navigate={navigate} />;
          }
        }

          // Supervisor routes
          if (session.role === 'supervisor') {
            switch (currentPath) {
              case '/dashboard': return <SupervisorDashboard />;
              case '/supervisor/students': return <TeacherStudents />;
              case '/supervisor/verifications': return <ExamVerification />;
              case '/supervisor/reports': return <ExamReport />;
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
            case '/teacher/results': return <UploadResults />;
            case '/teacher/all-results': return <AllResults />;
            case '/teacher/exam-reports': return <ExamReport />;
            case '/teacher/announcements': return <ClassAnnouncements />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <TeacherDashboard navigate={navigate} />;
          }
        }

        // Parent routes
        if (session.role === 'parent') {
          switch (currentPath) {
            case '/dashboard': return <ParentDashboard />;
            case '/parent/children': return <ChildrenView />;
            case '/parent/results': return <ExamResults />;
            case '/parent/monthly': return <MonthlyReport />;
            case '/parent/midterm': return <MidtermReport />;
            case '/parent/final': return <FinalReport />;
            case '/messages': return <MessagesPage />;
            case '/streams': return <StreamsPage />;
            default: return <ParentDashboard />;
          }
        }

        return <div>Unknown role</div>;
      }}
    </DashboardLayout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RoleProvider>
          <AppContent />
          <ToastContainer />
        </RoleProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
