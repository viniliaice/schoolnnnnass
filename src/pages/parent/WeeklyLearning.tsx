import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronLeft, Home, RefreshCw } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { getCurrentAcademicYear } from '../../lib/db/academic';
import {
  getParentLearningChildren,
  getParentWeeklyLearning,
  type ParentWeeklyLesson,
} from '../../lib/db/parentWeeklyLearning';
import { DAYS_OF_WEEK, type Student } from '../../types';
import { makeWeekLabel, weekNumberForDate, weekRangeForNumber } from '../../utils/weekDates';

interface WeeklyLearningProps {
  navigate: (path: string) => void;
}

const DAY_INDEX = new Map(DAYS_OF_WEEK.map((day, index) => [day, index]));
const SUBJECT_ACCENTS = [
  'border-l-violet-500', 'border-l-blue-500', 'border-l-emerald-500',
  'border-l-amber-500', 'border-l-rose-500', 'border-l-cyan-500',
];

function hashSubject(subject: string): number {
  return [...subject].reduce((sum, char) => sum + char.charCodeAt(0), 0) % SUBJECT_ACCENTS.length;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDayDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }).toUpperCase();
}

function practiceText(lesson: ParentWeeklyLesson): string | null {
  if (!lesson.practiceTitle && !lesson.practiceDescription) return null;
  return lesson.practiceDescription || lesson.practiceTitle;
}

function LessonCard({ lesson }: { lesson: ParentWeeklyLesson }) {
  const [expanded, setExpanded] = useState(false);
  const practice = practiceText(lesson);
  const panelId = `lesson-details-${lesson.lessonId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <article className={`overflow-hidden rounded-2xl border border-slate-200 border-l-4 bg-white shadow-sm ${SUBJECT_ACCENTS[hashSubject(lesson.subject)]}`}>
      <button
        type="button"
        className="flex min-h-11 w-full items-start justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-inset"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded(value => !value)}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-violet-700">{lesson.subject}</span>
          <span className="mt-1 block break-words text-base font-bold text-slate-900">{lesson.topic}</span>
          {lesson.whatWeAreLearning && (
            <span className="mt-1 line-clamp-2 block break-words text-sm leading-6 text-slate-600">
              {lesson.whatWeAreLearning}
            </span>
          )}
          {practice ? (
            <span className="mt-3 flex items-start gap-2 text-sm font-medium leading-5 text-emerald-700">
              <Home className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span><strong>Practice:</strong> {practice}</span>
            </span>
          ) : (
            <span className="mt-3 block text-sm text-slate-500">Practice information not provided</span>
          )}
          <span className="mt-3 block text-sm font-semibold text-violet-700">
            {expanded ? 'Hide lesson' : 'View lesson'}
          </span>
        </span>
        <ChevronDown className={`mt-1 h-5 w-5 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div id={panelId} className="space-y-4 border-t border-slate-100 bg-slate-50/70 px-4 py-5">
          <Detail label="Topic" value={lesson.topic} />
          <Detail label="Learning objective" value={lesson.learningObjective || 'Not provided'} />
          <Detail label="What we are learning" value={lesson.whatWeAreLearning || 'Not provided'} />
          <Detail label="Homework / Practice" value={practice || 'Practice information not provided'} />
          {lesson.resources.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">Resources</h4>
              <ul className="mt-1 space-y-1 text-sm leading-6 text-slate-800">
                {lesson.resources.map((resource, index) => (
                  <li key={`${resource.label}-${resource.url}-${index}`} className="break-words">
                    {resource.url ? (
                      <a className="font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2" href={resource.url} target="_blank" rel="noreferrer">
                        {resource.label || 'Open resource'}
                      </a>
                    ) : resource.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</h4>
      <p className="mt-1 break-words text-sm leading-6 text-slate-800">{value}</p>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading weekly learning" aria-busy="true">
      {[1, 2, 3].map(item => <div key={item} className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white" />)}
    </div>
  );
}

export function WeeklyLearning({ navigate }: WeeklyLearningProps) {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [academicStart, setAcademicStart] = useState<string | null>(null);
  const [currentWeekNumber, setCurrentWeekNumber] = useState(1);
  const [lessons, setLessons] = useState<ParentWeeklyLesson[]>([]);
  const [loadingSetup, setLoadingSetup] = useState(true);
  const [loadingLessons, setLoadingLessons] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function setup() {
      if (!session) return;
      setLoadingSetup(true);
      setError(null);
      try {
        const [parentChildren, academicYear] = await Promise.all([
          getParentLearningChildren(session.userId),
          getCurrentAcademicYear(),
        ]);
        if (cancelled) return;
        const ownChildren = [...parentChildren].sort((a, b) => a.name.localeCompare(b.name));
        setChildren(ownChildren);
        const stored = window.localStorage.getItem('parent-weekly-learning-child');
        const initial = ownChildren.some(child => child.id === stored) ? stored! : ownChildren[0]?.id || '';
        setSelectedStudentId(initial);
        if (!academicYear?.startDate) throw new Error('The current school year is not configured.');
        setAcademicStart(academicYear.startDate);
        setCurrentWeekNumber(weekNumberForDate(academicYear.startDate));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load weekly learning.');
      } finally {
        if (!cancelled) setLoadingSetup(false);
      }
    }
    setup();
    return () => { cancelled = true; };
  }, [session]);

  const selectedWeekNumber = currentWeekNumber;
  const selectedWeekLabel = academicStart ? makeWeekLabel(academicStart, selectedWeekNumber) : '';
  const weekRange = academicStart ? weekRangeForNumber(academicStart, selectedWeekNumber) : null;
  const selectedChild = children.find(child => child.id === selectedStudentId);

  const loadLessons = useCallback(async () => {
    if (!selectedStudentId || !selectedWeekLabel) {
      setLessons([]);
      return;
    }
    setLoadingLessons(true);
    setError(null);
    setLessons([]); // prevents stale child/week content while switching
    try {
      setLessons(await getParentWeeklyLearning(selectedStudentId, selectedWeekLabel));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load weekly learning.');
    } finally {
      setLoadingLessons(false);
    }
  }, [selectedStudentId, selectedWeekLabel]);

  useEffect(() => { void loadLessons(); }, [loadLessons]);

  useEffect(() => {
    if (!loadingLessons && todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [loadingLessons, lessons]);

  const lessonsByDay = useMemo(() => {
    const grouped = new Map<string, ParentWeeklyLesson[]>();
    for (const day of DAYS_OF_WEEK) grouped.set(day, []);
    for (const lesson of lessons) {
      if (DAY_INDEX.has(lesson.day as typeof DAYS_OF_WEEK[number])) grouped.get(lesson.day)?.push(lesson);
    }
    return grouped;
  }, [lessons]);

  const effectiveClass = lessons[0]?.className || selectedChild?.className || 'Class not available';
  const todayKey = dateKey(new Date());
  const currentDayName = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  const todayLessons = lessonsByDay.get(currentDayName) || [];

  function selectChild(id: string) {
    window.localStorage.setItem('parent-weekly-learning-child', id);
    setSelectedStudentId(id);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 overflow-x-hidden">
      <button type="button" onClick={() => navigate('/dashboard')} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-slate-600 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
        <ChevronLeft className="h-4 w-4" /> Dashboard
      </button>

      <header>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-700"><BookOpen className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold text-slate-900">Today’s Learning</h1>
            <p className="mt-1 text-sm font-medium text-slate-500">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</p>
          </div>
        </div>
      </header>

      {children.length > 1 && (
        <label className="block rounded-2xl border border-slate-200 bg-white p-4">
          <span className="mb-2 block text-sm font-bold text-slate-700">Select Child</span>
          <select value={selectedStudentId} onChange={event => selectChild(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-semibold text-slate-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200">
            {children.map(child => <option key={child.id} value={child.id}>{child.name} · {child.className}</option>)}
          </select>
        </label>
      )}

      {selectedChild && (
        <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <p className="break-words font-bold text-slate-900">{selectedChild.name}</p>
          <p className="mt-1 text-sm text-slate-600">Class: {effectiveClass}</p>
        </div>
      )}



      {(loadingSetup || loadingLessons) && <PageSkeleton />}

      {!loadingSetup && error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center" role="alert">
          <p className="font-bold text-rose-900">We couldn’t load this week’s learning.</p>
          <button type="button" onClick={() => void loadLessons()} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-rose-700 px-5 font-semibold text-white"><RefreshCw className="h-4 w-4" /> Try again</button>
        </div>
      )}

      {!loadingSetup && !loadingLessons && !error && children.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-slate-600">No children are linked to this parent account yet.</div>
      )}

      {!loadingSetup && !loadingLessons && !error && selectedChild && todayLessons.length === 0 && (
        <div className="rounded-2xl border border-violet-100 bg-violet-50 p-6 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-violet-400" />
          <p className="mt-3 font-semibold text-slate-700">Lesson information for today is not available yet.</p>
        </div>
      )}

      {!loadingSetup && !loadingLessons && !error && todayLessons.length > 0 && weekRange && (
        <div className="space-y-8">
          {DAYS_OF_WEEK.filter(day => day === currentDayName).map((day) => {
            const index = DAY_INDEX.get(day) ?? 0;
            const dayDate = new Date(weekRange.start);
            dayDate.setDate(dayDate.getDate() + index);
            const isToday = dateKey(dayDate) === todayKey;
            const dayLessons = lessonsByDay.get(day) || [];
            return (
              <section key={day} ref={isToday ? todayRef : undefined} className="scroll-mt-24" aria-labelledby={`day-${day}`}>
                <div className={`mb-3 rounded-xl px-3 py-2 ${isToday ? 'bg-violet-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700'}`}>
                  <h2 id={`day-${day}`} className="text-sm font-extrabold tracking-wide">
                    {isToday && <span className="mr-2 rounded-md bg-white/20 px-2 py-1">TODAY</span>}
                    {formatDayDate(dayDate)}
                  </h2>
                </div>
                {dayLessons.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {dayLessons.map(lesson => <LessonCard key={lesson.lessonId} lesson={lesson} />)}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">Lesson information is not available yet.</div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
