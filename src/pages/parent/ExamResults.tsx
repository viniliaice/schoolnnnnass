// PARENT — Exam Results: the ONE place for all academic reports.
//
// Monthly, Midterm and Final reports used to be three separate items in a
// long sidebar; parents had to remember which menu entry held which report.
// Now there is a single screen:
//
//   ADE — Grade 2-B
//   [ Monthly ] [ Midterm ] [ Final ]
//
// Picking a child here (or on Home / My Children) makes that child the
// active student everywhere. The three tabs render the same data through the
// same report functions as before — only the presentation changed.

import { useEffect, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent } from '../../lib/db/students';
import { getCurrentTerm } from '../../lib/db/academic';
import type { Student, Term } from '../../types';
import { BookOpen, Calendar, ClipboardList, Award } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { useParentContext } from './ParentContext';
import { MonthlyReportTab } from './MonthlyReport';
import { MidtermReportTab } from './MidtermReport';
import { FinalReportTab } from './FinalReport';

export type ReportTab = 'monthly' | 'midterm' | 'final';

const TABS: Array<{ id: ReportTab; label: string; icon: typeof Calendar; testId: string }> = [
  { id: 'monthly', label: 'Monthly', icon: Calendar, testId: 'results-tab-monthly' },
  { id: 'midterm', label: 'Midterm', icon: ClipboardList, testId: 'results-tab-midterm' },
  { id: 'final', label: 'Final', icon: Award, testId: 'results-tab-final' },
];

export function ExamResults({ initialTab = 'monthly' }: { initialTab?: ReportTab }) {
  const { session } = useRole();
  const { t } = useI18n();
  const parentCtx = useParentContext();

  // Fallback for hosts that render this page outside the parent shell
  // (kept from the pre-redesign page): fetch children locally.
  const [fallbackKids, setFallbackKids] = useState<Student[]>([]);
  const [fallbackActiveId, setFallbackActiveId] = useState('');

  const [activeTab, setActiveTab] = useState<ReportTab>(initialTab);
  const [term, setTerm] = useState<Term | null>(null);

  useEffect(() => {
    getCurrentTerm().then(setTerm).catch(() => setTerm(null));
  }, []);

  useEffect(() => {
    if (parentCtx || !session) return;
    // Fallback list for deep-linked historical results: keep leavers resolvable.
    getStudentsByParent(session.userId, 'all')
      .then(kids => {
        setFallbackKids(kids);
        setFallbackActiveId(prev => (prev && kids.some(k => k.id === prev) ? prev : kids[0]?.id ?? ''));
      })
      .catch(() => setFallbackKids([]));
  }, [parentCtx, session]);

  const kids = parentCtx ? parentCtx.kids : fallbackKids;
  const activeChildId = parentCtx ? parentCtx.activeChildId : fallbackActiveId || null;
  const activeChild = kids.find(k => k.id === activeChildId) ?? kids[0] ?? null;
  const handleSelectChild = (id: string) => {
    if (parentCtx) parentCtx.selectChild(id);
    else setFallbackActiveId(id);
  };

  // Keep the tab in sync when the host deep-links a specific report type.
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  if (kids.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('nav.Exam Results', 'Exam Results')}</h1>
          <p className="mt-1 text-slate-500">{t('parent.resultsSubtitle', 'Monthly, midterm and final reports')}</p>
        </div>
        <div className="py-12 text-center text-slate-400">
          <BookOpen className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
          <p className="font-medium">
            {parentCtx?.loading
              ? t('parent.loadingChildren', 'Loading your children…')
              : t('parent.noChildren', 'No children are linked to your account yet.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="exam-results">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('nav.Exam Results', 'Exam Results')}</h1>
        <p className="mt-1 text-slate-500">{t('parent.resultsSubtitle', 'Monthly, midterm and final reports')}</p>
      </div>

      {/* Child switcher — first names keep chips compact on narrow phones */}
      {kids.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('parent.chooseChild', 'Choose a child')}>
          {kids.map(child => {
            const selected = child.id === activeChild?.id;
            return (
              <button
                key={child.id}
                type="button"
                data-testid={`results-child-${child.id}`}
                aria-pressed={selected}
                onClick={() => handleSelectChild(child.id)}
                className={cn(
                  'min-h-11 max-w-full truncate rounded-full px-4 text-sm font-semibold transition-colors',
                  selected
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {child.name.split(' ')[0]}
              </button>
            );
          })}
        </div>
      )}

      {/* Active child identity */}
      {activeChild && (
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5" data-testid="results-active-child">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-600">
            {activeChild.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold text-slate-900">{activeChild.name}</p>
            <p className="truncate text-xs font-medium text-slate-500">
              {activeChild.className}
              {term?.name ? ` · ${term.name}` : ''}
            </p>
          </div>
        </div>
      )}

      {/* The three report tabs — big, equal, always visible */}
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1" role="tablist" aria-label={t('parent.reportType', 'Report type')}>
        {TABS.map(tab => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={tab.testId}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 transition-all sm:flex-row sm:gap-2',
                selected ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              <tab.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="text-sm font-bold">{t(`parent.tab.${tab.id}`, tab.label)}</span>
            </button>
          );
        })}
      </div>

      {/* Active report — each tab fetches exactly the same data it always did */}
      {activeChild && (
        <div role="tabpanel" key={`${activeChild.id}-${activeTab}`}>
          {activeTab === 'monthly' && <MonthlyReportTab student={activeChild} term={term} />}
          {activeTab === 'midterm' && <MidtermReportTab student={activeChild} term={term} />}
          {activeTab === 'final' && <FinalReportTab student={activeChild} term={term} />}
        </div>
      )}
    </div>
  );
}
