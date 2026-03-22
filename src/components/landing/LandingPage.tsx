import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { seedDatabase, isSeeded as checkIsSeeded } from '../../lib/database';
import { Role } from '../../types';
import { Shield, BookOpen, Heart, Database, School, Sparkles, ArrowRight, CheckCircle } from 'lucide-react';
import { cn } from '../../utils/cn';

const roles: { role: Role; label: string; description: string; icon: typeof Shield; color: string; bgColor: string; borderColor: string; userId: string; userName: string }[] = [
  {
    role: 'admin',
    label: 'Enter as Admin',
    description: 'Full system access. Manage users, students, verify exams, and view analytics.',
    icon: Shield,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50 hover:bg-indigo-100',
    borderColor: 'border-indigo-200 hover:border-indigo-300',
    userId: 'admin-001',
    userName: 'Dr. Sarah Mitchell',
  },
  {
    role: 'teacher',
    label: 'Enter as Teacher',
    description: 'Upload exam results for your assigned classes and track submission status.',
    icon: BookOpen,
    color: 'text-teal-600',
    bgColor: 'bg-teal-50 hover:bg-teal-100',
    borderColor: 'border-teal-200 hover:border-teal-300',
    userId: 'teacher-001',
    userName: 'Prof. James Wilson',
  },
  {
    role: 'parent',
    label: 'Enter as Parent',
    description: 'View your children\'s Monthly, Midterm, and Final reports with detailed analytics.',
    icon: Heart,
    color: 'text-violet-600',
    bgColor: 'bg-violet-50 hover:bg-violet-100',
    borderColor: 'border-violet-200 hover:border-violet-300',
    userId: 'parent-001',
    userName: 'Michael Johnson',
  },
];

export function LandingPage() {
  const { login } = useRole();
  const { addToast } = useToast();
  const [seeded, setSeeded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSeeded = async () => {
      try {
        const isDatabaseSeeded = await checkIsSeeded();
        setSeeded(isDatabaseSeeded);
      } catch (error) {
        console.error('Error checking if database is seeded:', error);
      } finally {
        setLoading(false);
      }
    };
    checkSeeded();
  }, []);

  const handleSeed = async () => {
    try {
      setLoading(true);
      await seedDatabase();
      addToast({ type: 'success', title: 'Database Seeded!', description: '6 users, 5 students, and comprehensive exam records created.' });
      setSeeded(true);
      setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      console.error('Error seeding database:', error);
      addToast({ type: 'error', title: 'Seeding Failed', description: 'Failed to seed the database. Check console for details.' });
      setLoading(false);
    }
  };

  const handleRoleSelect = (roleConfig: typeof roles[0]) => {
    if (!seeded) {
      addToast({ type: 'error', title: 'Database not seeded', description: 'Please seed the database first before entering.' });
      return;
    }
    login(roleConfig.role, roleConfig.userId, roleConfig.userName);
    addToast({ type: 'success', title: `Welcome, ${roleConfig.userName}!`, description: `Logged in as ${roleConfig.role}` });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-80 h-80 bg-indigo-100 rounded-full opacity-40 blur-3xl" />
          <div className="absolute top-20 -left-20 w-60 h-60 bg-teal-100 rounded-full opacity-30 blur-3xl" />
          <div className="absolute bottom-0 right-1/3 w-72 h-72 bg-violet-100 rounded-full opacity-30 blur-3xl" />
        </div>

        <div className="relative max-w-5xl mx-auto px-4 pt-12 pb-8 sm:pt-20 sm:pb-12">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-600 text-sm font-medium mb-6">
              <Sparkles className="w-4 h-4" />
              School Management System
            </div>
            <div className="flex items-center justify-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-lg shadow-indigo-200">
                <School className="w-8 h-8 text-white" />
              </div>
            </div>
            <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-4">
              Campus<span className="text-indigo-600">Connect</span>
            </h1>
            <p className="text-lg text-slate-500 max-w-2xl mx-auto leading-relaxed">
              Comprehensive academic management with Monthly, Midterm, and Final reports.
              Track CA scores, exam results, and student performance.
            </p>
          </div>

          <div className="max-w-md mx-auto mb-12">
            <div className={cn(
              "rounded-2xl border-2 border-dashed p-6 text-center transition-all",
              seeded ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white hover:border-indigo-200"
            )}>
              {seeded ? (
                <div className="flex items-center justify-center gap-3">
                  <CheckCircle className="w-6 h-6 text-emerald-500" />
                  <div className="text-left">
                    <p className="font-semibold text-emerald-700">Database Ready</p>
                    <p className="text-sm text-emerald-600/70">Demo data loaded with comprehensive exam records</p>
                  </div>
                </div>
              ) : (
                <>
                  <Database className="w-8 h-8 text-slate-400 mx-auto mb-3" />
                  <p className="text-sm text-slate-500 mb-4">Initialize with demo data — users, students, and exam records</p>
                  <button
                    onClick={handleSeed}
                    disabled={loading}
                    className={cn(
                      "inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium text-sm shadow-lg transition-all active:scale-[0.98]",
                      loading
                        ? "bg-slate-400 cursor-not-allowed"
                        : "bg-gradient-to-r from-indigo-600 to-indigo-700 text-white hover:from-indigo-700 hover:to-indigo-800 shadow-indigo-200 hover:shadow-xl"
                    )}
                  >
                    <Database className="w-4 h-4" />
                    {loading ? 'Seeding...' : 'Seed Database'}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
            {roles.map(roleConfig => (
              <button
                key={roleConfig.role}
                onClick={() => handleRoleSelect(roleConfig)}
                className={cn(
                  "group relative rounded-2xl border-2 p-6 text-left transition-all duration-200",
                  "hover:shadow-xl hover:-translate-y-1 active:scale-[0.98]",
                  roleConfig.borderColor,
                  roleConfig.bgColor,
                  (!seeded || loading) && "opacity-50 cursor-not-allowed"
                )}
                disabled={!seeded || loading}
              >
                <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mb-4", roleConfig.color, "bg-white shadow-sm")}>
                  <roleConfig.icon className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-2">
                  {roleConfig.label}
                  <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed">{roleConfig.description}</p>
                <div className="mt-3 text-xs text-slate-400">
                  Demo: {roleConfig.userName}
                </div>
              </button>
            ))}
          </div>

          {seeded && (
            <div className="text-center mt-8">
              <button
                onClick={handleSeed}
                className="text-sm text-slate-400 hover:text-indigo-600 transition-colors underline underline-offset-4"
              >
                Reset & Re-seed Database
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
