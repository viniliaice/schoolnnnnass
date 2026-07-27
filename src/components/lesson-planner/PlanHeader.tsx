import { Save, Send, Loader2, BookOpen, FileText, History } from 'lucide-react';
import { cn } from '../../utils/cn';

interface PlanHeaderProps {
  title: string;
  weekLabel: string;
  className: string;
  isDirty: boolean;
  loading: boolean;
  submitPending: boolean;
  onNewPlan: () => void;
  onGoToReview: () => void;
  activeTab: 'plan' | 'review' | 'history';
  setActiveTab: (tab: 'plan' | 'review' | 'history') => void;
}

export function PlanHeader({
  title,
  weekLabel,
  className,
  isDirty,
  loading,
  submitPending,
  onNewPlan,
  onGoToReview,
  activeTab,
  setActiveTab,
}: PlanHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-indigo-100 text-indigo-700">
          <BookOpen className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lesson Plans</h1>
          <p className="text-sm text-slate-500">{weekLabel}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
        <button
          onClick={() => setActiveTab('plan')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all',
            activeTab === 'plan' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          )}
        >
          <BookOpen className="w-4 h-4" />
          Plan
        </button>
        <button
          onClick={() => setActiveTab('review')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all',
            activeTab === 'review' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          )}
        >
          <FileText className="w-4 h-4" />
          Review
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all',
            activeTab === 'history' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          )}
        >
          <History className="w-4 h-4" />
          History
        </button>
      </div>
    </div>
  );
}