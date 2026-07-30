import { useMemo, useRef, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { useTeacherPlans, usePlanWithPeriods, useReview } from '../../lib/hooks/useLessonPlans';
import { LessonPlanPeriod, PlanStatus, Subject, DAYS_OF_WEEK } from '../../types';
import {
  FileText, CheckCircle, Clock, AlertTriangle, XCircle, Download,
  ChevronLeft, Pencil, Search, FolderOpen, Loader2,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { PlanReadView, ReadPeriod } from '../../components/lesson-planner/PlanReadView';
import { AiReviewPanel } from '../../components/lesson-planner/AiReviewPanel';
import { printElementAsPdf } from '../../utils/printToPdf';

const STATUS_META: Record<PlanStatus, { label: string; icon: typeof FileText; chip: string; help: string }> = {
  draft:      { label: 'Draft',      icon: Pencil,        chip: 'bg-slate-100 text-slate-600',     help: 'Not submitted yet — only you can see this.' },
  submitted:  { label: 'Submitted',  icon: Clock,         chip: 'bg-blue-100 text-blue-700',       help: 'Sent to your supervisor. The AI review is being generated.' },
  in_review:  { label: 'In review',  icon: Clock,         chip: 'bg-amber-100 text-amber-700',     help: 'AI review is done — waiting on your supervisor’s decision.' },
  approved:   { label: 'Approved',   icon: CheckCircle,   chip: 'bg-emerald-100 text-emerald-700', help: 'Your supervisor approved this plan.' },
  rejected:   { label: 'Revisions',  icon: XCircle,       chip: 'bg-rose-100 text-rose-700',       help: 'Your supervisor asked for revisions — see their comment.' },
  ai_failed:  { label: 'AI failed',  icon: AlertTriangle, chip: 'bg-orange-100 text-orange-700',   help: 'The AI review did not run. It can be retried, or your supervisor can decide without it.' },
};

function toReadPeriods(periods: LessonPlanPeriod[]): ReadPeriod[] {
  return periods.map((p) => ({
    day: p.day,
    period_number: p.period_number,
    subject: p.subject || '',
    className: p.class_name || '',
    isFree: !!p.is_free,
    topic: p.topic || '',
    objective: p.objective || '',
    slide_number: p.slide_number || '',
    details: p.details || [],
  }));
}

interface SubmittedPlansViewProps {
  subjects?: Subject[];
  /** Load a plan back into the editor */
  onEditPlan?: (planId: string) => void;
  onBack?: () => void;
}

/**
 * "My Lesson Plans" — browse every plan you have created and open a
 * read-only view of any submitted plan, with its AI review and a PDF export.
 */
export function SubmittedPlansView({ subjects, onEditPlan, onBack }: SubmittedPlansViewProps) {
  const { session } = useRole();
  const { data: plans, isLoading } = useTeacherPlans(session?.userId);
  const [statusFilter, setStatusFilter] = useState<PlanStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plans || []).filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!q) return true;
      return `${p.title} ${p.class_name} ${p.week_label}`.toLowerCase().includes(q);
    });
  }, [plans, statusFilter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: plans?.length || 0 };
    for (const p of plans || []) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [plans]);

  if (selectedId) {
    return (
      <PlanDetail
        planId={selectedId}
        subjects={subjects}
        onBack={() => setSelectedId(null)}
        onEditPlan={onEditPlan}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-100 text-violet-700">
            <FolderOpen className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">My Lesson Plans</h2>
            <p className="text-sm text-slate-500">Open any plan to read it, check the AI review, or export a PDF.</p>
          </div>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, class or week"
            className="pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm w-full sm:w-72 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
          />
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'draft', 'submitted', 'in_review', 'approved', 'rejected', 'ai_failed'] as const).map((key) => {
          const label = key === 'all' ? 'All' : STATUS_META[key as PlanStatus].label;
          const n = counts[key] || 0;
          return (
            <button
              key={key}
              onClick={() => setStatusFilter(key as PlanStatus | 'all')}
              className={cn(
                'px-3.5 py-1.5 rounded-xl text-sm font-medium border transition-all',
                statusFilter === key
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200 ring-2 ring-offset-1 ring-indigo-100'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
              )}
            >
              {label} <span className="text-xs opacity-60">({n})</span>
            </button>
          );
        })}
      </div>

      {/* Plan cards */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {isLoading && (
          <div className="p-10 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your plans…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="p-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-slate-300 mb-3" />
            <p className="font-medium text-slate-600">No lesson plans here yet</p>
            <p className="text-sm text-slate-400 mt-1">
              {statusFilter === 'all' ? 'Start on the first step to create one.' : 'Try a different filter.'}
            </p>
          </div>
        )}
        <div className="divide-y divide-slate-100">
          {filtered.map((plan) => {
            const meta = STATUS_META[plan.status];
            const Icon = meta.icon;
            return (
              <button
                key={plan.id}
                onClick={() => setSelectedId(plan.id)}
                className="w-full flex items-center gap-4 p-4 text-left hover:bg-slate-50 transition-colors"
              >
                <div className="p-2.5 rounded-xl bg-slate-100 text-slate-500 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{plan.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {plan.class_name} · Week {plan.week_label} · {plan.period_count} periods/day
                  </p>
                  <p className="text-xs text-slate-400 mt-1">{meta.help}</p>
                </div>
                <span className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0', meta.chip)}>
                  <Icon className="w-3.5 h-3.5" />
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {onBack && (
        <div className="pt-4 border-t border-slate-200">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all"
          >
            <ChevronLeft className="w-4 h-4" /> Back to Review
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function PlanDetail({
  planId,
  subjects,
  onBack,
  onEditPlan,
}: {
  planId: string;
  subjects?: Subject[];
  onBack: () => void;
  onEditPlan?: (planId: string) => void;
}) {
  const { data, isLoading } = usePlanWithPeriods(planId);
  const { data: review } = useReview(planId);
  const printRef = useRef<HTMLDivElement>(null);

  if (isLoading || !data) {
    return (
      <div className="p-12 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading plan…
      </div>
    );
  }

  const { plan, periods } = data;
  const meta = STATUS_META[plan.status];
  const Icon = meta.icon;
  const read = toReadPeriods(periods);
  const canEdit = plan.status === 'draft' || plan.status === 'rejected' || plan.status === 'ai_failed';

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" /> All plans
        </button>
        <div className="flex items-center gap-2">
          {canEdit && onEditPlan && (
            <button
              onClick={() => onEditPlan(plan.id)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Pencil className="w-4 h-4" /> Edit plan
            </button>
          )}
          <button
            onClick={() => printElementAsPdf(printRef.current, `${plan.title} — ${plan.class_name} — ${plan.week_label}`)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            <Download className="w-4 h-4" /> Export PDF
          </button>
        </div>
      </div>

      <div ref={printRef} className="space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-900">{plan.title}</h2>
              <p className="text-sm text-slate-500 mt-1">
                {plan.class_name} · Week {plan.week_label} · {plan.period_count} periods/day
              </p>
            </div>
            <span className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold', meta.chip)}>
              <Icon className="w-3.5 h-3.5" /> {meta.label}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-3 bg-slate-50 rounded-xl p-3">{meta.help}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <Stat label="Days" value={DAYS_OF_WEEK.length} />
            <Stat label="Periods planned" value={read.filter((p) => !p.isFree && p.topic.trim()).length} />
            <Stat label="Free periods" value={read.filter((p) => p.isFree).length} />
            <Stat label="Activities" value={read.reduce((n, p) => n + p.details.length, 0)} />
          </div>
        </div>

        <PlanReadView
          periods={read}
          periodCount={plan.period_count}
          subjects={subjects}
          planClassName={plan.class_name}
        />

        <AiReviewPanel review={review} status={plan.status} updatedAt={plan.updated_at} audience="teacher" />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3 text-center">
      <p className="text-xl font-bold text-slate-800">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}
