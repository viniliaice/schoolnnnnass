import { useState, useEffect, useCallback, useRef } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { useTeacherPlans, useCreatePlan, useSavePeriods, useSubmitForReview, usePlanWithPeriods, useReview } from '../../lib/hooks/useLessonPlans';
import { DayOfWeek, DAYS_OF_WEEK, LessonPlanPeriod, PeriodActivity, Subject, AcademicYear } from '../../types';
import { Loader2, Send, Save, BookOpen, FileText, Clock, History, Upload, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';
import { cn } from '../../utils/cn';
import { getUserById } from '../../lib/db/profiles';
import { getClassSubjectsForTeacher } from '../../lib/db/classes';
import { getCurrentAcademicYear, getCurrentTerm } from '../../lib/db/academic';
import { fetchUnitPlanByClassSubjectTerm } from '../../lib/db/unitPlans';
import { PlanHistoryTable } from './PlanHistoryTable';
import { PlanHeader } from '../../components/lesson-planner/PlanHeader';
import { PlanConfigBar } from '../../components/lesson-planner/PlanConfigBar';
import { PlanGrid } from '../../components/lesson-planner/PlanGrid';
import { CreatePlanForm } from '../../components/lesson-planner/CreatePlanForm';
import { ReviewStep } from '../../components/lesson-planner/ReviewStep';

function getWeekLabel(date: Date, academicYearStart?: string): string {
  const baseDate = academicYearStart ? new Date(academicYearStart) : new Date();
  const start = new Date(baseDate);
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((target.getTime() - start.getTime()) / 86400000);
  if (diffDays < 0) return `${start.getFullYear()}-W00`;
  const weekNum = Math.floor(diffDays / 7) + 1;
  return `${start.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getWeekDateRange(academicYearStart: string, weekOffset: number): { dates: string[]; startDate: string; endDate: string } {
  const baseDate = new Date(academicYearStart);
  baseDate.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((now.getTime() - baseDate.getTime()) / 86400000);
  const currentWeek = Math.floor(diffDays / 7);
  const targetWeek = currentWeek + weekOffset;
  const weekStart = new Date(baseDate);
  weekStart.setDate(weekStart.getDate() + targetWeek * 7);
  const dates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
  }
  const formatShort = (d: Date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
  };
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);
  return { dates, startDate: formatShort(weekStart), endDate: formatShort(weekEnd) };
}

interface PeriodCell {
  day: DayOfWeek;
  period_number: number;
  subject: string;
  className: string;
  isFree: boolean;
  topic: string;
  objective: string;
  slide_number: string;
  details: PeriodActivity[];
}

type Tab = 'plan' | 'review' | 'history';

function createEmptyPeriods(periodCount: number): PeriodCell[] {
  const cells: PeriodCell[] = [];
  for (const day of DAYS_OF_WEEK) {
    for (let p = 1; p <= periodCount; p++) {
      cells.push({ day, period_number: p, subject: '', className: '', isFree: false, topic: '', objective: '', slide_number: '', details: [] });
    }
  }
  return cells;
}

function generateActivitiesText(details: PeriodActivity[]): string {
  return details
    .map((a, i) => {
      let s = `${i + 1}. ${a.activity}`;
      if (a.time) s += ` (${a.time})`;
      if (a.resource) s += ` [${a.resource}]`;
      if (a.place) s += ` @${a.place}`;
      return s;
    })
    .join(' | ');
}

function periodsFromDb(periods: LessonPlanPeriod[], periodCount: number): PeriodCell[] {
  const map = new Map<string, LessonPlanPeriod>();
  for (const p of periods) {
    map.set(`${p.day}-${p.period_number}`, p);
  }
  const cells: PeriodCell[] = [];
  for (const day of DAYS_OF_WEEK) {
    for (let p = 1; p <= periodCount; p++) {
      const existing = map.get(`${day}-${p}`);
      cells.push({
        day,
        period_number: p,
        subject: existing?.subject || '',
        className: existing?.class_name || '',
        isFree: existing?.is_free || false,
        topic: existing?.topic || '',
        objective: existing?.objective || '',
        slide_number: existing?.slide_number || '',
        details: existing?.details || [],
      });
    }
  }
  return cells;
}

export function LessonPlanner() {
  const { session } = useRole();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSubmittingRef = useRef(false);

  const [tab, setTab] = useState<Tab>('plan');
  const [academicYear, setAcademicYear] = useState<AcademicYear | null>(null);
  const [weekLabel, setWeekLabel] = useState(() => getWeekLabel(new Date()));
  const [periodCount, setPeriodCount] = useState(5);
  const [className, setClassName] = useState('');
  const [title, setTitle] = useState('');
  const [teacherClasses, setTeacherClasses] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PeriodCell[]>(() => createEmptyPeriods(5));
  const [isDirty, setIsDirty] = useState(false);
  const [selectedWeekOffset, setSelectedWeekOffset] = useState(0);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  const { data: existingPlans } = useTeacherPlans(session?.userId);
  const { data: planWithPeriods } = usePlanWithPeriods(planId || undefined);
  const { data: review } = useReview(planId || undefined);
  const createPlanMut = useCreatePlan();
  const savePeriodsMut = useSavePeriods();
  const submitMut = useSubmitForReview();

  useEffect(() => {
    if (!session) return;
    getUserById(session.userId).then((u) => {
      setTeacherClasses(u?.assignedClasses || []);
      if (u?.assignedClasses?.length) setClassName(u.assignedClasses[0]);
    });
  }, [session]);

  useEffect(() => {
    getCurrentAcademicYear().then((ay) => {
      if (ay) setAcademicYear(ay);
    });
  }, []);

  useEffect(() => {
    if (academicYear) {
      setWeekLabel(getWeekLabel(new Date(), academicYear.startDate));
    }
  }, [academicYear]);

  useEffect(() => {
    if (!session || !className) { setSubjects([]); return; }
    getClassSubjectsForTeacher(session.userId, className).then((subs) => {
      setSubjects(subs);
    });
  }, [session, className]);

  useEffect(() => {
    if (planWithPeriods) {
      setPeriodCount(planWithPeriods.plan.period_count);
      setPeriods(periodsFromDb(planWithPeriods.periods, planWithPeriods.plan.period_count));
      setTitle(planWithPeriods.plan.title);
      setClassName(planWithPeriods.plan.class_name);
    }
  }, [planWithPeriods]);

  const updateCell = useCallback((day: DayOfWeek, periodNumber: number, field: string, value: any) => {
    setPeriods((prev) => prev.map((c) => (c.day === day && c.period_number === periodNumber ? { ...c, [field]: value } : c)));
    setIsDirty(true);
  }, []);

  const updateActivity = useCallback((day: DayOfWeek, periodNumber: number, activityIndex: number, field: keyof PeriodActivity, value: string) => {
    setPeriods((prev) => prev.map((c) => {
      if (c.day !== day || c.period_number !== periodNumber) return c;
      const newDetails = c.details.map((a, i) => (i === activityIndex ? { ...a, [field]: value } : a));
      return { ...c, details: newDetails };
    }));
    setIsDirty(true);
  }, []);

  const addActivity = useCallback((day: DayOfWeek, periodNumber: number) => {
    setPeriods((prev) => prev.map((c) => {
      if (c.day !== day || c.period_number !== periodNumber) return c;
      return { ...c, details: [...c.details, { activity: '', time: '', resource: '', place: '' }] };
    }));
    setIsDirty(true);
  }, []);

  const removeActivity = useCallback((day: DayOfWeek, periodNumber: number, activityIndex: number) => {
    setPeriods((prev) => prev.map((c) => {
      if (c.day !== day || c.period_number !== periodNumber) return c;
      return { ...c, details: c.details.filter((_, i) => i !== activityIndex) };
    }));
    setIsDirty(true);
  }, []);

  const periodsForSave = periods.map((p) => ({
    day: p.day,
    period_number: p.period_number,
    class_name: p.className || null,
    subject: p.subject || null,
    is_free: p.isFree || false,
    topic: p.topic,
    objective: p.objective || null,
    activities: generateActivitiesText(p.details),
    slide_number: p.slide_number || null,
    details: p.details,
  }));

  const doSave = useCallback(async () => {
    if (!session || !planId || isSubmittingRef.current) return;
    const nonEmpty = periodsForSave.filter((p) => p.topic.trim());
    if (nonEmpty.length === 0) return;
    setIsDirty(false);
    try {
      await savePeriodsMut.mutateAsync({ plan_id: planId, periods: periodsForSave });
    } catch {
      addToast({ type: 'error', title: 'Failed to save', description: 'Please try again.' });
    }
  }, [session, planId, periodsForSave, savePeriodsMut, addToast]);

  useEffect(() => {
    if (!isDirty || isSubmittingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(doSave, 10000);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isDirty, doSave]);

  const handleCreateOrSelectPlan = useCallback(async () => {
    if (!session) return;
    if (existingPlans?.length) {
      setPlanId(existingPlans[0].id);
      return;
    }
    try {
      const plan = await createPlanMut.mutateAsync({
        teacher_id: session.userId,
        subject_id: null,
        class_name: className,
        week_label: weekLabel,
        title: title || `Week ${weekLabel}`,
        period_count: periodCount,
      });
      setPlanId(plan.id);
      addToast({ type: 'success', title: 'Plan created' });
    } catch {
      addToast({ type: 'error', title: 'Failed to create plan' });
    }
  }, [session, existingPlans, createPlanMut, className, weekLabel, title, periodCount, addToast]);

  const handleSubmit = useCallback(async () => {
    if (!planId || isSubmittingRef.current) return;
    const emptyCells = periods.filter((p) => !p.isFree && !p.topic.trim());
    if (emptyCells.length > 0) {
      addToast({ type: 'error', title: 'All periods must have a topic' });
      return;
    }
    isSubmittingRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    try {
      await savePeriodsMut.mutateAsync({ plan_id: planId, periods: periodsForSave });

      // Auto-resolve unit plan at submit time (fresh — not cached from mount)
      const subjectsSet = new Set(
        periodsForSave.filter((p) => !p.is_free && p.subject).map((p) => p.subject)
      );
      const subjectId = subjectsSet.size === 1 ? [...subjectsSet][0] : null;
      let unitContext: { name: string; objectives: string } | undefined;
      if (subjectId) {
        const currentTerm = await getCurrentTerm();
        if (currentTerm) {
          const matchedUnit = await fetchUnitPlanByClassSubjectTerm(className, subjectId, currentTerm.id);
          if (matchedUnit) {
            unitContext = { name: matchedUnit.name, objectives: matchedUnit.objectives };
          }
        }
      }

      await submitMut.mutateAsync({ planId, periods: periodsForSave, unitContext });
      addToast({ type: 'success', title: 'Submitted for AI review' });
    } catch (err: any) {
      addToast({ type: 'error', title: 'Submission failed', description: err.message });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [planId, periods, periodsForSave, savePeriodsMut, submitMut, addToast, className]);

  const handleSelectFromHistory = useCallback((selectedPlanId: string) => {
    setPlanId(selectedPlanId);
    setTab('plan');
  }, []);

  const handleNewPlan = useCallback(() => {
    setPlanId(null);
    setUploadedFileName(null);
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target!.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        const subjectMap = new Map(subjects.map((s) => [s.name.toLowerCase().trim(), s.id]));

        const parseDay = (raw: unknown): DayOfWeek | null => {
          if (!raw && raw !== 0) return null;
          let d: Date;
          if (raw instanceof Date) {
            d = raw;
          } else if (typeof raw === 'number') {
            const dc = XLSX.SSF.parse_date_code(raw);
            if (!dc) return null;
            d = new Date(dc.y, dc.m - 1, dc.d);
          } else if (typeof raw === 'string') {
            const parts = raw.split('/');
            if (parts.length === 3) {
              d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
            } else {
              d = new Date(raw);
            }
          } else {
            return null;
          }
          if (isNaN(d.getTime())) return null;
          const dayOfWeek = d.getDay();
          return DAYS_OF_WEEK[dayOfWeek === 6 ? 0 : dayOfWeek + 1];
        };

        const parseActivities = (row: Record<string, string>): PeriodActivity[] => {
          const activities: PeriodActivity[] = [];
          for (let i = 1; i <= 5; i++) {
            const activity = row[`Activity ${i}`] || row[`activity ${i}`] || '';
            const time = row[`Time ${i}`] || row[`time ${i}`] || '';
            const resource = row[`Resource ${i}`] || row[`resource ${i}`] || '';
            const place = row[`Place/url ${i}`] || row[`place/url ${i}`] || '';
            if (activity.trim()) {
              activities.push({ activity: activity.trim(), time: String(time).trim(), resource: String(resource).trim(), place: String(place).trim() });
            }
          }
          return activities;
        };

        const cells: PeriodCell[] = [];
        const uniquePeriods = new Set<number>();

        for (const row of rows) {
          const periodNum = Number(row['Period'] ?? row['period'] ?? 0);
          if (!periodNum || periodNum < 1) continue;
          const day = parseDay(row['Date'] ?? row['date'] ?? '');
          if (!day) continue;

          const subjectRaw = (row['Subject'] ?? row['subject'] ?? '').trim();
          const isFree = subjectRaw.toUpperCase() === 'FREE' || subjectRaw === '';

          uniquePeriods.add(periodNum);

          cells.push({
            day,
            period_number: periodNum,
            subject: isFree ? '' : (subjectMap.get(subjectRaw.toLowerCase()) || subjectRaw),
            className: className || '',
            isFree,
            topic: (row['Topic'] ?? row['topic'] ?? '').trim(),
            objective: (row['Objective'] ?? row['objective'] ?? '').trim(),
            slide_number: String(row['Weekly Slide Number'] ?? row['weekly slide number'] ?? '').trim(),
            details: parseActivities(row),
          });
        }

        if (cells.length === 0) {
          addToast({ type: 'error', title: 'No valid rows found', description: 'Check that the file has Date, Period, and Subject columns.' });
          return;
        }

        const cellMap = new Map<string, PeriodCell>();
        for (const cell of cells) {
          cellMap.set(`${cell.day}-${cell.period_number}`, cell);
        }

        const maxPeriods = Math.max(5, Math.max(...uniquePeriods));
        const newPeriods: PeriodCell[] = [];
        for (const day of DAYS_OF_WEEK) {
          for (let p = 1; p <= maxPeriods; p++) {
            const match = cellMap.get(`${day}-${p}`);
            newPeriods.push(match || { day, period_number: p, subject: '', className: '', isFree: false, topic: '', objective: '', slide_number: '', details: [] });
          }
        }

        setPeriodCount(maxPeriods);
        setPeriods(newPeriods);
        setIsDirty(true);
        addToast({ type: 'success', title: `${cells.length} periods imported from Excel` });
      } catch (err: any) {
        addToast({ type: 'error', title: 'Failed to parse Excel', description: err.message });
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  }, [subjects, className, addToast]);

  const { dates: weekDates, startDate: weekStartDate, endDate: weekEndDate } =
    academicYear ? getWeekDateRange(academicYear.startDate, selectedWeekOffset)
                : { dates: [] as string[], startDate: '', endDate: '' };

  const loading = createPlanMut.isPending || savePeriodsMut.isPending || submitMut.isPending;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <PlanHeader
        title={title}
        weekLabel={weekLabel}
        className={className}
        isDirty={isDirty}
        loading={loading}
        submitPending={submitMut.isPending}
        onNewPlan={handleNewPlan}
        onGoToReview={() => setTab('review')}
        activeTab={tab}
        setActiveTab={setTab}
      />

      {tab === 'review' && planId && (
        <ReviewStep
          periods={periods}
          teacherClasses={teacherClasses}
          subjects={subjects}
          periodCount={periodCount}
          weekLabel={weekLabel}
          title={title}
          planClassName={className}
          onBack={() => setTab('plan')}
          onSubmit={handleSubmit}
          isSubmitting={submitMut.isPending}
        />
      )}

      {tab === 'history' && (
        <PlanHistoryTable onSelectPlan={handleSelectFromHistory} />
      )}

      {tab === 'plan' && !planId && (
        <CreatePlanForm
          className={className}
          setClassName={setClassName}
          periodCount={periodCount}
          setPeriodCount={setPeriodCount}
          title={title}
          setTitle={setTitle}
          teacherClasses={teacherClasses}
          onCreate={handleCreateOrSelectPlan}
          loading={loading}
          weekStartDate={weekStartDate}
          weekEndDate={weekEndDate}
          onPrevWeek={() => setSelectedWeekOffset((o) => o - 1)}
          onNextWeek={() => setSelectedWeekOffset((o) => o + 1)}
        />
      )}

      {tab === 'plan' && planId && (
        <>
          <PlanConfigBar
            className={className}
            setClassName={setClassName}
            teacherClasses={teacherClasses}
            periodCount={periodCount}
            setPeriodCount={setPeriodCount}
            weekLabel={weekLabel}
            weekStartDate={weekStartDate}
            weekEndDate={weekEndDate}
            onPrevWeek={() => setSelectedWeekOffset((o) => o - 1)}
            onNextWeek={() => setSelectedWeekOffset((o) => o + 1)}
          />
          {/* Excel/CSV upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Upload className="w-4 h-4" />
              Upload from Excel
            </button>
            <span className="text-xs text-slate-400">Supports .xlsx, .xls, .csv</span>
            {uploadedFileName && (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1">
                <FileSpreadsheet className="w-3.5 h-3.5" />
                {uploadedFileName}
              </span>
            )}
            <button
              onClick={() => {
                setPeriods(createEmptyPeriods(periodCount));
                setUploadedFileName(null);
                setIsDirty(true);
              }}
              className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-rose-600 hover:bg-rose-50 transition-colors"
            >
              Clear All
            </button>
          </div>
          <PlanGrid
            periods={periods}
            periodCount={periodCount}
            teacherClasses={teacherClasses}
            subjects={subjects}
            planClassName={className}
            weekDates={weekDates}
            onUpdateCell={updateCell}
            onUpdateActivity={updateActivity}
            onAddActivity={addActivity}
            onRemoveActivity={removeActivity}
          />

          {/* Bottom navigation */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-200">
            <button
              onClick={() => setTab('history')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <span>&larr;</span>
              Back to History
            </button>
            <button
              onClick={() => setTab('review')}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
            >
              Proceed to Review
              <span>&rarr;</span>
            </button>
          </div>
        </>
      )}

      {/* Loading overlay */}
      {submitMut.isPending && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
            <p className="text-lg font-semibold text-slate-900">Analyzing lesson plan...</p>
            <p className="text-sm text-slate-500">Checking plan content &rarr; Analyzing objectives &rarr; Generating scores</p>
          </div>
        </div>
      )}

      {/* AI Review Results */}
      {review && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700">
              <FileText className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-bold text-slate-900">AI Review</h2>
            <span className={cn(
              'ml-auto px-3 py-1 rounded-full text-xs font-bold',
              review.percentage >= 90 ? 'bg-emerald-100 text-emerald-700' :
              review.percentage >= 80 ? 'bg-blue-100 text-blue-700' :
              review.percentage >= 70 ? 'bg-amber-100 text-amber-700' :
              review.percentage >= 60 ? 'bg-orange-100 text-orange-700' :
              'bg-rose-100 text-rose-700'
            )}>
              {review.percentage}% &middot; {review.performance_level}
            </span>
          </div>
          <p className="text-sm text-slate-600">{review.executive_summary}</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(review.scores).map(([key, val]: [string, any]) => (
              <div key={key} className="bg-slate-50 rounded-xl p-3">
                <p className="text-xs text-slate-500 capitalize mb-1">{key.replace(/_/g, ' ')}</p>
                <p className="text-lg font-bold text-slate-900">{val.score}/5</p>
                <p className="text-xs text-slate-400 mt-1">{val.explanation}</p>
              </div>
            ))}
          </div>
          {review.strengths.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Strengths</h3>
              <ul className="list-disc list-inside text-sm text-slate-600 space-y-1">
                {review.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {review.improvements.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Improvements</h3>
              <ul className="space-y-2">
                {review.improvements.map((imp, i) => (
                  <li key={i} className="bg-amber-50 rounded-xl p-3 text-sm">
                    <p className="font-medium text-amber-800">{imp.area}</p>
                    <p className="text-amber-700 text-xs mt-0.5">{imp.why}</p>
                    <p className="text-amber-600 text-xs mt-1">{imp.recommendation}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}