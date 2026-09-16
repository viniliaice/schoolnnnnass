// PARENT — My Children.
//
// One simple card per child: photo/initials, name, class, average, and two
// clear actions — "View Results" and "View Details". Tapping a card (or the
// action buttons) makes that child the ACTIVE student for the whole app:
// Exam Results, reports and Today's Learning then open on the same child.

import { useEffect, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent } from '../../lib/db/students';
import { getExamsByParent } from '../../lib/db/exams';
import { isScoredExam, type Exam, type Student } from '../../types';
import { BookOpen, CheckCircle2, ChevronDown, GraduationCap } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useParentContext } from './ParentContext';

function childAverage(examsForChild: Exam[]): number {
  const scored = examsForChild.filter(isScoredExam);
  if (scored.length === 0) return 0;
  return Math.round(scored.reduce((sum, e) => sum + ((e.score ?? 0) / e.total) * 100, 0) / scored.length);
}

/** Details panel — subject bars from the pre-redesign page, unchanged logic. */
function ChildDetails({ childExams }: { childExams: Exam[] }) {
  const scored = childExams.filter(isScoredExam);
  const subjects = [...new Set(scored.map(e => e.subject))];

  return (
    <div className="border-t border-slate-100 px-4 py-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
        <BookOpen className="h-4 w-4 text-indigo-600" aria-hidden="true" /> Subject performance
      </h3>
      {subjects.length > 0 ? (
        <div className="space-y-3">
          {subjects.map(sub => {
            const subExams = scored.filter(e => e.subject === sub);
            const avg = Math.round(
              subExams.reduce((s, e) => s + ((e.score ?? 0) / e.total) * 100, 0) / subExams.length,
            );
            return (
              <div key={sub} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-sm font-medium text-slate-700">{sub}</span>
                <div className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      avg >= 80 ? 'bg-emerald-500' : avg >= 60 ? 'bg-amber-500' : 'bg-red-500',
                    )}
                    style={{ width: `${avg}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-sm font-bold text-slate-700">{avg}%</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm italic text-slate-400">No approved results yet</p>
      )}
    </div>
  );
}

export function ChildrenView({ navigate }: { navigate?: (path: string) => void }) {
  const { session } = useRole();
  const parentCtx = useParentContext();

  const [fallbackKids, setFallbackKids] = useState<Student[]>([]);
  const [fallbackActiveId, setFallbackActiveId] = useState('');
  const [exams, setExams] = useState<Exam[]>([]);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);

  const kids = parentCtx ? parentCtx.kids : fallbackKids;
  const activeChildId = parentCtx ? parentCtx.activeChildId : fallbackActiveId || null;
  const selectChild = (id: string) => {
    if (parentCtx) parentCtx.selectChild(id);
    else setFallbackActiveId(id);
  };

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const examsData = await getExamsByParent(session.userId, 'approved').catch(() => [] as Exam[]);
      setExams(examsData);
      if (parentCtx) return; // the shell owns the children list
      const childrenData = await getStudentsByParent(session.userId).catch(() => [] as Student[]);
      setFallbackKids(childrenData);
      setFallbackActiveId(prev => (prev && childrenData.some(k => k.id === prev) ? prev : childrenData[0]?.id ?? ''));
    };

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, Boolean(parentCtx)]);

  const viewResults = (child: Student) => {
    selectChild(child.id);
    navigate?.('/parent/results');
  };

  return (
    <div className="space-y-5" data-testid="children-view">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Children</h1>
        <p className="mt-1 text-slate-500">Tap a child to see their results and reports</p>
      </div>

      {kids.length === 0 ? (
        <div className="py-12 text-center text-slate-400">
          <GraduationCap className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
          <p className="font-medium">
            {parentCtx?.loading ? 'Loading your children…' : 'No children are linked to your account yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {kids.map(child => {
            const childExams = exams.filter(e => e.studentId === child.id);
            const isActive = child.id === activeChildId;
            const detailsOpen = detailsFor === child.id;

            return (
              <div
                key={child.id}
                data-testid={`child-card-${child.id}`}
                className={cn(
                  'overflow-hidden rounded-2xl border-2 bg-white transition-colors',
                  isActive ? 'border-indigo-300' : 'border-slate-200',
                )}
              >
                {/* Card header — tapping selects this child for the whole app */}
                <button
                  type="button"
                  onClick={() => selectChild(child.id)}
                  className="flex w-full items-center gap-3 p-4 text-left"
                >
                  <div
                    className={cn(
                      'flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-bold',
                      isActive ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-600',
                    )}
                  >
                    {child.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-lg font-bold text-slate-900">{child.name}</h2>
                      {isActive && (
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-indigo-600" aria-label="Selected child" />
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500">
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-600">
                        {child.className}
                      </span>
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xl font-extrabold text-slate-900">{childAverage(childExams)}%</p>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Average</p>
                  </div>
                </button>

                {/* Two big, thumb-friendly actions */}
                <div className="grid grid-cols-2 gap-0 border-t border-slate-100">
                  <button
                    type="button"
                    data-testid={`child-view-results-${child.id}`}
                    onClick={() => viewResults(child)}
                    className="flex min-h-[52px] items-center justify-center gap-2 bg-indigo-600 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
                  >
                    <BookOpen className="h-5 w-5" aria-hidden="true" />
                    View Results
                  </button>
                  <button
                    type="button"
                    data-testid={`child-view-details-${child.id}`}
                    aria-expanded={detailsOpen}
                    onClick={() => {
                      selectChild(child.id);
                      setDetailsFor(detailsOpen ? null : child.id);
                    }}
                    className="flex min-h-[52px] items-center justify-center gap-2 bg-white text-sm font-bold text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    View Details
                    <ChevronDown className={cn('h-4 w-4 transition-transform', detailsOpen && 'rotate-180')} aria-hidden="true" />
                  </button>
                </div>

                {detailsOpen && <ChildDetails childExams={childExams} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
