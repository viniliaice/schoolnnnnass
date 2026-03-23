import { useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { createDemoAccounts } from '../../lib/database';
import { School, Mail, Lock, Eye, EyeOff, ArrowRight, Sparkles, UserPlus } from 'lucide-react';
import { cn } from '../../utils/cn';

export function LoginPage() {
  const { login, loading } = useRole();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingDemo, setIsCreatingDemo] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      addToast({ title: 'Please fill in all fields', type: 'error' });
      return;
    }

    setIsLoading(true);
    try {
      await login(email, password);
      addToast({ title: 'Welcome back!', type: 'success' });
    } catch (error: any) {
      addToast({ title: error.message || 'Login failed', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateDemoAccounts = async () => {
    setIsCreatingDemo(true);
    try {
      await createDemoAccounts();
      addToast({ title: 'Demo accounts created successfully!', type: 'success' });
    } catch (error: any) {
      addToast({ title: error.message || 'Failed to create demo accounts', type: 'error' });
    } finally {
      setIsCreatingDemo(false);
    }
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-indigo-50 via-white to-teal-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 rounded-2xl mb-4">
            <School className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Welcome Back</h1>
          <p className="text-slate-600">Sign in to your Scholo account</p>
        </div>

        {/* Login Form */}
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  placeholder="Enter your email"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-12 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading || loading}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium transition-all",
                "bg-indigo-600 hover:bg-indigo-700 text-white",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              )}
            >
              {isLoading || loading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign In
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>
          </form>

          {/* Demo Credentials */}
          <div className="mt-8 pt-6 border-t border-slate-200">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-medium text-slate-700">Demo Credentials</span>
            </div>
            {/* Create Demo Accounts Button */}
            <div className="mb-4">
              <button
                onClick={handleCreateDemoAccounts}
                disabled={isCreatingDemo}
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium text-sm transition-all",
                  "bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isCreatingDemo ? (
                  <>
                    <div className="w-4 h-4 border-2 border-amber-800 border-t-transparent rounded-full animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <UserPlus className="w-4 h-4" />
                    Create Demo Accounts
                  </>
                )}
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-600">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="font-medium text-slate-800">Admin:</div>
                <div>admin@scholo.com / admin123</div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="font-medium text-slate-800">Teacher:</div>
                <div>teacher@scholo.com / teacher123</div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="font-medium text-slate-800">Parent:</div>
                <div>parent@scholo.com / parent123</div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-sm text-slate-500">
            Secure login powered by Supabase
          </p>
        </div>
      </div>
    </div>
  );
}
