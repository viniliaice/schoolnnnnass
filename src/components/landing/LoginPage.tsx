import { useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { isPlaceholderEnv } from '../../lib/supabase';
import { useToast } from '../../context/ToastContext';
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import logo from '../../../assets/logo.png';

export function LoginPage() {
  const { login, loading } = useRole();
  const { addToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

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

  return (
    <div className="min-h-screen bg-linear-to-br from-indigo-50 via-white to-teal-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <img src={logo} alt="MBK International School" className="w-32 h-32 mx-auto mb-4 object-contain" />
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Welcome Back</h1>
          <p className="text-slate-600">Sign in to your MBK International School account</p>
        </div>

        {/* Login Form */}
        <div className="theme-ornamented bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
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
                  name="email"
                  type="email"
                  autoComplete="username"
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
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
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

          {/* Preview only (no .env / mock backend): one-click demo emails so
              every role can be checked without remembering them. Never shown
              against the real Supabase project. Any password is accepted. */}
          {isPlaceholderEnv && (
            <div className="mt-5 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/70 p-3">
              <p className="text-xs font-bold text-indigo-900">
                Preview mode — demo sign-ins (any password)
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  ['Office', 'office@mbk.edu'],
                  ['Admin', 'admin@mbk.edu'],
                  ['Supervisor', 'supervisor@mbk.edu'],
                  ['Teacher', 'fatima@mbk.edu'],
                  ['Parent', 'parent1@example.com'],
                ].map(([role, demoEmail]) => (
                  <button
                    key={demoEmail}
                    type="button"
                    onClick={() => setEmail(demoEmail)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
                      email === demoEmail
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : 'border-indigo-300 bg-white text-indigo-800 hover:bg-indigo-100',
                    )}
                  >
                    {role}: {demoEmail}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 space-y-2 text-center">
          <p className="text-xs text-slate-500">Made by Eng. Akso</p>
          {/* The sign-in screen is the only page a signed-out visitor sees, so the
              public privacy-policy link lives here (no account required). */}
          <p className="text-xs">
            <a
              href="/privacy-policy"
              className="font-medium text-indigo-600 underline underline-offset-2 transition-colors hover:text-indigo-700"
            >
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
