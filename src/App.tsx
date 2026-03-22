import { RoleProvider, useRole } from './context/RoleContext';
import { ToastProvider } from './context/ToastContext';
import { ToastContainer } from './components/ui/Toast';
import { LandingPage } from './components/landing/LandingPage';
import { DashboardLayout } from './components/layout/DashboardLayout';

// Admin Pages
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { ManageUsers } from './pages/admin/ManageUsers';
import { ManageStudents } from './pages/admin/ManageStudents';
import { BulkUpload } from './pages/admin/BulkUpload';
import { ExamVerification } from './pages/admin/ExamVerification';

// Teacher Pages
import { TeacherDashboard } from './pages/teacher/TeacherDashboard';
import { TeacherStudents } from './pages/teacher/TeacherStudents';
import { UploadResults } from './pages/teacher/UploadResults';
import { AllResults } from './pages/teacher/AllResults';

// Parent Pages
import { ParentDashboard } from './pages/parent/ParentDashboard';
import { ChildrenView } from './pages/parent/ChildrenView';
import { ExamResults } from './pages/parent/ExamResults';
import { MonthlyReport } from './pages/parent/MonthlyReport';
import { MidtermReport } from './pages/parent/MidtermReport';
import { FinalReport } from './pages/parent/FinalReport';

function AppContent() {
  const { session, isLoggedIn } = useRole();

  if (!isLoggedIn || !session) {
    return <LandingPage />;
  }

  return (
    <DashboardLayout>
      {(currentPath) => {
        // Admin routes
        if (session.role === 'admin') {
          switch (currentPath) {
            case '/dashboard': return <AdminDashboard />;
            case '/admin/users': return <ManageUsers />;
            case '/admin/students': return <ManageStudents />;
            case '/admin/bulk': return <BulkUpload />;
            case '/admin/exams': return <ExamVerification />;
            default: return <AdminDashboard />;
          }
        }

        // Teacher routes
        if (session.role === 'teacher') {
          switch (currentPath) {
            case '/dashboard': return <TeacherDashboard />;
            case '/teacher/students': return <TeacherStudents />;
            case '/teacher/results': return <UploadResults />;
            case '/teacher/all-results': return <AllResults />;
            default: return <TeacherDashboard />;
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
    <ToastProvider>
      <RoleProvider>
        <AppContent />
        <ToastContainer />
      </RoleProvider>
    </ToastProvider>
  );
}
