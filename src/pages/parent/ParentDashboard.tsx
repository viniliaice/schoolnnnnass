// PARENT — Home.
//
// The Home screen answers the five things a parent opens the app for, in
// order, on one thumb-reach page:
//   1. Welcome
//   2. My children (tap one → they become the active student + View Results)
//   3. Quick "View Results" action
//   4. The latest published result (live)
//   5. Important school messages
//
// Deliberately REMOVED from this screen (per the parent-UX redesign):
//   - "Your Family ID" card (moved to More → School Pickup Card, where the
//     pickup administrative function lives)
//   - Recent pickup log (same destination)
//   - The admin-style six-stat grid and any technical/account clutter

import { useEffect, useMemo, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { getAnnouncementsForParent } from '../../lib/db/communications';
import { getParentPortalSnapshot } from '../../lib/db/parent-portal';
import { isScoredExam, type Announcement, type Exam } from '../../types';
import { ArrowRight, BellRing, BookOpen, ChevronRight, GraduationCap } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { cn } from '../../utils/cn';
import { useParentContext } from './ParentContext';

/** First name for a warm, readable welcome without overflowing the header. */
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

export function ParentDashboard({ navigate }: { navigate?: (path: string) => void }) {
  const { session } = useRole();
  const parentCtx = useParentContext();
  const [exams, setExams] = useState<Exam[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  const kids = parentCtx?.kids ?? [];
  const selectChild = parentCtx?.selectChild;

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      try {
        const [snapshot, notices] = await Promise.all([
          getParentPortalSnapshot(session.userId),
          getAnnouncementsForParent(session.userId),
        ]);
        setExams(snapshot.exams);
        setAnnouncements(notices);
      } catch {
        // Partial failure must never blank the Home screen — sections simply
        // render their empty states.
      }
    };

    loadData();

    // Live updates: new approved results / announcements refresh Home cards.
    const channel = supabase
      .channel(`parent-home-${session.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exams' }, loadData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => {
        getAnnouncementsForParent(session.userId).then(setAnnouncements).catch(() => null);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcement_recipients' }, () => {
        getAnnouncementsForParent(session.userId).then(setAnnouncements).catch(() => null);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  // Latest published result across all children (snapshot is date-desc).
  const latestResult = useMemo(() => {
    const exam = exams.filter(isScoredExam)[0] ?? null;
    if (!exam) return null;
    const child = kids.find(k => k.id === exam.studentId);
    const pct = Math.round(((exam.score ?? 0) / exam.total) * 100);
    return { exam, childName: child?.name ?? 'Your child', pct };
  }, [exams, kids]);

  const importantNotices = announcements.slice(0, 3);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const openResultsFor = (childId: string | null) => {
    if (childId) selectChild?.(childId);
    navigate?.('/parent/results');
  };

  return (
    <div className="space-y-5" data-testid="parent-home">
      {/* 1 — Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Welcome, {firstNameOf(session?.userName ?? '')} 👋
        </h1>
        <p className="mt-1 text-sm text-slate-500">{today}</p>
      </div>

      {/* 4 — Latest result (shown above the fold when the school publishes one) */}
      {latestResult && (
        <button
          type="button"
          data-testid="home-latest-result"
          onClick={() => openResultsFor(latestResult.exam.studentId)}
          className="flex w-full items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left transition-colors hover:bg-emerald-100/70"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500">
            <BellRing className="h-5 w-5 text-white" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-bold uppercase tracking-wide text-emerald-700">New result</span>
            <span className="mt-0.5 block truncate text-sm font-bold text-slate-900">
              {latestResult.childName} — {latestResult.exam.subject} {latestResult.exam.examType}
            </span>
            <span className="block text-xs font-medium text-slate-600">
              {latestResult.exam.month} · Scored {latestResult.exam.score}/{latestResult.exam.total} ({latestResult.pct}%)
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
        </button>
      )}

      {/* 2 — My children (tap to activate) + 3 — quick View Results */}
      <section aria-label="My children" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">My Children</h2>
          <button
            type="button"
            onClick={() => navigate?.('/parent/children')}
            className="text-sm font-bold text-violet-700 hover:text-violet-900"
          >
            See all
          </button>
        </div>

        {kids.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-5 text-center text-sm text-slate-400">
            {parentCtx?.loading ? 'Loading your children…' : 'No children are linked to your account yet.'}
          </div>
        ) : (
          <>
            <div className="space-y-2.5">
              {kids.map(child => {
                const isActive = child.id === parentCtx?.activeChildId;
                return (
                  <button
                    key={child.id}
                    type="button"
                    data-testid={`home-child-${child.id}`}
                    onClick={() => openResultsFor(child.id)}
                    className={cn(
                      'flex min-h-[64px] w-full items-center gap-3 rounded-2xl border-2 bg-white p-3.5 text-left transition-colors',
                      isActive ? 'border-violet-400' : 'border-slate-200 hover:border-violet-200',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                        isActive ? 'bg-violet-600 text-white' : 'bg-violet-100 text-violet-700',
                      )}
                    >
                      {child.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-bold text-slate-900">{child.name}</span>
                      <span className="block truncate text-xs font-medium text-slate-500">{child.className}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-sm font-bold text-violet-700">
                      Results <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 3 — The primary quick action */}
            <button
              type="button"
              data-testid="home-view-results"
              onClick={() => openResultsFor(null)}
              className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 text-base font-bold text-white shadow-sm transition-colors hover:bg-violet-700"
            >
              <GraduationCap className="h-5 w-5" aria-hidden="true" />
              View Results
            </button>
          </>
        )}
      </section>

      {/* 5 — Important school messages */}
      <section aria-label="School messages" className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">School Messages</h2>
          <button
            type="button"
            onClick={() => navigate?.('/messages')}
            className="text-sm font-bold text-violet-700 hover:text-violet-900"
          >
            See all
          </button>
        </div>
        <div className="space-y-2">
          {importantNotices.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate?.('/messages')}
              className="w-full rounded-xl border border-slate-100 bg-slate-50 p-3 text-left transition-colors hover:bg-slate-100"
            >
              <div className="text-xs font-semibold text-slate-500">{item.className}</div>
              <div className="mt-0.5 line-clamp-2 text-sm text-slate-800">{item.message}</div>
            </button>
          ))}
          {importantNotices.length === 0 && (
            <p className="py-2 text-sm text-slate-400">No school messages right now.</p>
          )}
        </div>
      </section>

      {/* Today's learning — friendly entry kept from the old dashboard */}
      <button
        type="button"
        data-testid="home-weekly-learning"
        onClick={() => navigate?.('/parent/weekly-learning')}
        className="group flex min-h-11 w-full items-center justify-between gap-4 rounded-2xl bg-linear-to-r from-violet-600 to-indigo-700 p-5 text-left text-white shadow-sm transition-shadow hover:shadow-md"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-lg font-bold">
            <BookOpen className="h-5 w-5 shrink-0" aria-hidden="true" />
            Today’s Learning
          </span>
          <span className="mt-1 block text-sm leading-6 text-violet-100">See what your child is learning today.</span>
        </span>
        <ArrowRight className="h-5 w-5 shrink-0 transition-transform group-hover:translate-x-1" aria-hidden="true" />
      </button>
    </div>
  );
}
