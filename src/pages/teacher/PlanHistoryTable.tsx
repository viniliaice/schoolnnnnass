import { useState } from 'react';
import { useTeacherPlans } from '../../lib/hooks/useLessonPlans';
import { useRole } from '../../context/RoleContext';
import { PlanStatus } from '../../types';
import { FileText, CheckCircle, Clock, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '../../utils/cn';

const statusIcons: Record<PlanStatus, typeof FileText> = {
  draft: Clock,
  submitted: Clock,
  in_review: AlertTriangle,
  approved: CheckCircle,
  rejected: XCircle,
  ai_failed: AlertTriangle,
};

const statusColors: Record<PlanStatus, string> = {
  draft: 'text-slate-500 bg-slate-100',
  submitted: 'text-blue-700 bg-blue-100',
  in_review: 'text-amber-700 bg-amber-100',
  approved: 'text-emerald-700 bg-emerald-100',
  rejected: 'text-rose-700 bg-rose-100',
  ai_failed: 'text-orange-700 bg-orange-100',
};

interface PlanHistoryTableProps {
  onSelectPlan: (planId: string) => void;
}

export function PlanHistoryTable({ onSelectPlan }: PlanHistoryTableProps) {
  const { session } = useRole();
  const [statusFilter, setStatusFilter] = useState<PlanStatus | 'all'>('all');
  const { data: plans, isLoading } = useTeacherPlans(session?.userId);

  const filtered = plans?.filter((p) => statusFilter === 'all' || p.status === statusFilter) || [];

  return (
    <div className="bg-white rounded-2xl border border-slate-200">
      <div className="p-4 border-b border-slate-100 flex items-center gap-2">
        <FileText className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-900">My Lesson Plans</h2>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PlanStatus | 'all')}
          className="ml-auto rounded-lg border border-slate-200 px-2 py-1 text-xs"
        >
          <option value="all">All</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="in_review">In Review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="ai_failed">AI Failed</option>
        </select>
      </div>
      <div className="divide-y divide-slate-100">
        {isLoading && (
          <div className="p-8 text-center text-sm text-slate-500">Loading...</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-500">No plans yet</div>
        )}
        {filtered.map((plan) => {
          const Icon = statusIcons[plan.status];
          return (
            <button
              key={plan.id}
              onClick={() => onSelectPlan(plan.id)}
              className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors"
            >
              <div className="p-2 rounded-lg bg-slate-100 text-slate-600">
                <FileText className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{plan.title}</p>
                <p className="text-xs text-slate-500">{plan.class_name} &middot; {plan.week_label}</p>
              </div>
              <span className={cn('flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium', statusColors[plan.status])}>
                <Icon className="w-3 h-3" />
                {plan.status.replace('_', ' ')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
