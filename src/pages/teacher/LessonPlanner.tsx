import { useState, useEffect, useCallback, useRef } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { useTeacherPlans, useCreatePlan, useSavePeriods, useSubmitForReview, usePlanWithPeriods, useReview, useAiReviewTimeout } from '../../lib/hooks/useLessonPlans';
import { DayOfWeek, DAYS_OF_WEEK, LessonPlanPeriod, PeriodActivity, Subject, AcademicYear, isPlanEditable } from '../../types';
import { Loader2, Upload, FileSpreadsheet, Lock, Unlock } from 'lucide-react';
import * as XLSX from 'xlsx';
import { cn } from '../../utils/cn';
import { getUserById } from '../../lib/db/profiles';
import { getClassSubjectsForTeacher } from '../../lib/db/classes';
import { getCurrentAcademicYear, getCurrentTerm } from '../../lib/db/academic';
import { fetchUnitPlanByClassSubjectTerm } from '../../lib/db/unitPlans';
import { weekRangeForNumber, weekNumberForDate, weekNumberFromLabel, makeWeekLabel, describePlanWeek } from '../../utils/weekDates';
import { PlanConfigBar } from '../../components/lesson-planner/PlanConfigBar';
import { PlanGrid } from '../../components/lesson-planner/PlanGrid';
import { CreatePlanForm } from '../../components/lesson-planner/CreatePlanForm';
import { ReviewStep } from '../../components/lesson-planner/ReviewStep';
import { PlanStepper, StepNav, PlanTab } from '../../components/lesson-planner/PlanStepper';
import { PlanReadView } from '../../components/lesson-planner/PlanReadView';
import { SubmittedPlansView } from './SubmittedPlansView';

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

  const [tab, setTab] = useState<PlanTab>('setup');
  const [academicYear, setAcademicYear] = useState<AcademicYear | null>(null);
  // Absolute 1-based week number. The week LABEL is always derived from this,
  // so changing week can never leave the label pointing at another week's plan.
  const [selectedWeekNumber, setSelectedWeekNumber] = useState<number | null>(null);
  const [periodCount, setPeriodCount] = useState(5);
  const [className, setClassName] = useState('');
  const [title, setTitle] = useState('');
  const [teacherClasses, setTeacherClasses] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PeriodCell[]>(() => createEmptyPeriods(5));
  const [isDirty, setIsDirty] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  const academicYearStart = academicYear?.startDate;
  const weekRangeInfo = academicYearStart && selectedWeekNumber
    ? weekRangeForNumber(academicYearStart, selectedWeekNumber)
    : null;
  // Single source of truth: label ALWAYS follows the selected week.
  const weekLabel = academicYearStart && selectedWeekNumber
    ? makeWeekLabel(academicYearStart, selectedWeekNumber)
    : '';

  const { data: existingPlans } = useTeacherPlans(session?.userId);
  const { data: planWithPeriods } = usePlanWithPeriods(planId || undefined);
  const { data: review } = useReview(planId || undefined);
  // Guarantees a plan never sits on "waiting" forever (#4).
  useAiReviewTimeout(planWithPeriods?.plan);
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
    if (academicYear && selectedWeekNumber === null) {
      setSelectedWeekNumber(weekNumberForDate(academicYear.startDate, new Date()));
    }
  }, [academicYear, selectedWeekNumber]);

  useEffect(() => {
    if (!session || !className) { setSubjects([]); return; }
    getClassSubjectsForTeacher(session.userId, className).then((subs) => {
      setSubjects(subs);
    });
  }, [session, className]);

  useEffect(() => {
    if (!planWithPeriods) return;
    // If the loaded plan belongs to a different week, update the week selector
    // so the grid header matches, then let the next render hydrate.
    const planWeekNum = weekNumberFromLabel(planWithPeriods.plan.week_label);
    if (planWeekNum && planWeekNum !== selectedWeekNumber) {
      setSelectedWeekNumber(planWeekNum);
      return;
    }
    setPeriodCount(planWithPeriods.plan.period_count);
    setPeriods(periodsFromDb(planWithPeriods.periods, planWithPeriods.plan.period_count));
    setTitle(planWithPeriods.plan.title);
    setClassName(planWithPeriods.plan.class_name);
  }, [planWithPeriods, weekLabel, selectedWeekNumber]);

  /**
   * Switch to a different week.
   *
   * Critically this DISCARDS the currently loaded plan. Without this the
   * previously selected plan stayed loaded and only the displayed date changed,
   * so the old week's content got saved under the new week's label.
   */
  const handleSelectWeek = useCallback((nextWeekNumber: number) => {
    const safe = Math.max(1, nextWeekNumber);
    setSelectedWeekNumber((current) => {
      if (current === safe) return current;
      // Cancel any pending autosave aimed at the plan we are leaving.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setPlanId(null);
      setPeriods(createEmptyPeriods(periodCount));
      setTitle('');
      setUploadedFileName(null);
      setIsDirty(false);
      setTab('setup');
      return safe;
    });
  }, [periodCount]);

  const updateCell = useCallback((day: DayOfWeek, periodNumber: number, field: string, value: any) => {
    setPeriods((prev) => prev.map((c) => {
      if (c.day !== day || c.period_number !== periodNumber) return c;
      // Auto-toggle isFree when subject is set to __FREE__
      if (field === 'subject' && value === '__FREE__') {
        return { ...c, subject: '__FREE__', isFree: true };
      }
      // When unchecking isFree, clear the __FREE__ subject marker
      if (field === 'isFree' && value === false && c.subject === '__FREE__') {
        return { ...c, isFree: false, subject: '' };
      }
      return { ...c, [field]: value };
    }));
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
    subject: (p.isFree || p.subject === '__FREE__') ? null : (p.subject || null),
    is_free: p.isFree || p.subject === '__FREE__',
    topic: p.topic,
    objective: p.objective || null,
    activities: generateActivitiesText(p.details),
    slide_number: p.slide_number || null,
    details: p.details,
  }));

  const doSave = useCallback(async () => {
    if (!session || !planId || isSubmittingRef.current) return;
    // Never autosave a submitted/locked plan.
    if (planWithPeriods && !isPlanEditable(planWithPeriods.plan.status)) return;
    const nonEmpty = periodsForSave.filter((p) => p.topic.trim());
    if (nonEmpty.length === 0) return;
    setIsDirty(false);
    try {
      await savePeriodsMut.mutateAsync({ plan_id: planId, periods: periodsForSave });
    } catch (err: any) {
      if (err?.isLocked) {
        addToast({ type: 'error', title: 'This plan is locked', description: err.message });
        return;
      }
      addToast({ type: 'error', title: 'Failed to save', description: 'Please try again.' });
    }
  }, [session, planId, periodsForSave, savePeriodsMut, addToast, planWithPeriods]);

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
    if (!weekLabel) {
      addToast({ type: 'error', title: 'Select a week first' });
      return;
    }

    // Match on week AND class so one week's record is never reused for another.
    const matchingPlan = existingPlans?.find(
      (p) => p.week_label === weekLabel && p.class_name === className
    );
    if (matchingPlan) {
      setPlanId(matchingPlan.id);
      setTab('plan');
      return;
    }

    // No plan for this exact week — start a blank one carrying only the new
    // week_label. Content from any other week is intentionally not copied.
    setPeriods(createEmptyPeriods(periodCount));
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
      setTab('plan');
      addToast({ type: 'success', title: 'Plan created' });
    } catch {
      addToast({ type: 'error', title: 'Failed to create plan' });
    }
  }, [session, existingPlans, createPlanMut, className, weekLabel, title, periodCount, addToast]);

  const handleSubmit = useCallback(async () => {
    if (!planId || isSubmittingRef.current) return;
    if (planWithPeriods && !isPlanEditable(planWithPeriods.plan.status)) {
      addToast({
        type: 'error',
        title: 'This plan is locked',
        description: 'It has already been submitted. Ask your supervisor to request revisions.',
      });
      return;
    }
    const emptyCells = periods.filter((p) => !p.isFree && p.subject !== '__FREE__' && !p.topic.trim());
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
      addToast({
        type: 'success',
        title: 'Submitted to supervisor',
        description: 'Your plan has been sent to your supervisor for review.',
      });
      setTab('mine');
    } catch (err: any) {
      if (err?.aiFailedOnly) {
        // Plan reached the supervisor; only the AI scoring failed.
        addToast({
          type: 'warning',
          title: 'Submitted, but the AI review failed',
          description: 'Your supervisor can still see and approve the plan. You can retry the AI review below.',
        });
        setTab('mine');
      } else if (err?.isLocked) {
        addToast({ type: 'error', title: 'This plan is locked', description: err.message });
      } else {
        addToast({
          type: 'error',
          title: 'Submission failed — plan not sent',
          description: `${err?.message || 'Unknown error'}. Your work is saved as a draft; please try again.`,
        });
      }
    } finally {
      isSubmittingRef.current = false;
    }
  }, [planId, periods, periodsForSave, savePeriodsMut, submitMut, addToast, className, planWithPeriods]);

  const handleSelectFromHistory = useCallback((selectedPlanId: string) => {
    setPlanId(selectedPlanId);
    setTab('plan');
  }, []);

  /** Guard tab navigation so a step is never opened before it is usable. */
  const handleTabSelect = useCallback((next: PlanTab) => {
    if ((next === 'plan' || next === 'review') && !planId) {
      addToast({ type: 'info', title: 'Create or open a plan first' });
      setTab('setup');
      return;
    }
    setTab(next);
  }, [planId, addToast]);

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

  const weekDates = weekRangeInfo?.dates ?? [];
  const weekStartDate = weekRangeInfo?.startShort ?? '';
  const weekEndDate = weekRangeInfo?.endShort ?? '';
  // Full, unambiguous range shown next to the title everywhere.
  const weekRange = weekRangeInfo?.label ?? '';

  const goPrevWeek = () => handleSelectWeek((selectedWeekNumber ?? 1) - 1);
  const goNextWeek = () => handleSelectWeek((selectedWeekNumber ?? 1) + 1);

  // ── Locking (#1) ──
  const currentStatus = planWithPeriods?.plan.status;
  // A plan with no row yet is a brand-new draft, hence editable.
  const editable = !planId || isPlanEditable(currentStatus);
  const lockedForEditing = !!planId && !editable;

  const loading = createPlanMut.isPending || savePeriodsMut.isPending || submitMut.isPending;
  const emptyPeriodCount = periods.filter((p) => !p.isFree && p.subject !== '__FREE__' && !p.topic.trim()).length;
  const hasAnyTopic = periods.some((p) => p.topic.trim());
  const planStatus = planWithPeriods?.plan.status;
  const isSubmittedPlan = !!planStatus && planStatus !== 'draft';

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <PlanStepper
        activeTab={tab}
        onSelect={handleTabSelect}
        canGoToPlan={!!planId}
        canGoToReview={!!planId && hasAnyTopic}
        weekLabel={weekLabel}
        weekRangeLabel={weekRange}
        className={className}
        isDirty={isDirty}
        saving={savePeriodsMut.isPending}
      />

      {/* STEP 1: SETUP */}
      {tab === 'setup' && (
        <>
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
            weekRangeLabel={weekRange}
            onPrevWeek={goPrevWeek}
            onNextWeek={goNextWeek}
          />
          <StepNav
            onNext={handleCreateOrSelectPlan}
            nextLabel={planId ? 'Continue to grid' : 'Start planning'}
            nextDisabled={!className || loading}
            nextHint={!className ? 'Select a class first' : undefined}
          />
        </>
      )}

      {/* STEP 2: WEEKLY GRID */}
      {tab === 'plan' && planId && (
        <>
          {lockedForEditing && (
            <div className="rounded-2xl border-2 border-slate-300 bg-slate-50 p-4 flex items-start gap-3">
              <Lock className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">
                  This plan is {currentStatus?.replace('_', ' ')} and is read-only
                </p>
                <p className="text-sm text-slate-600 mt-0.5">
                  Submitted plans cannot be edited. Ask your supervisor to request revisions if you
                  need to change it — the edit controls come back automatically once they do.
                </p>
              </div>
            </div>
          )}

          {currentStatus === 'revision_requested' && (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
              <Unlock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-900">Revisions requested — this plan is editable again</p>
                {planWithPeriods?.plan.revision_note && (
                  <p className="text-sm text-amber-800 mt-0.5">
                    Supervisor note: {planWithPeriods.plan.revision_note}
                  </p>
                )}
                <p className="text-sm text-amber-700 mt-0.5">Make your changes, then resubmit for review.</p>
              </div>
            </div>
          )}

          <PlanConfigBar
            className={className}
            setClassName={setClassName}
            teacherClasses={teacherClasses}
            periodCount={periodCount}
            setPeriodCount={setPeriodCount}
            weekLabel={weekLabel}
            weekStartDate={weekStartDate}
            weekEndDate={weekEndDate}
            weekRangeLabel={weekRange}
            onPrevWeek={goPrevWeek}
            onNextWeek={goNextWeek}
          />
          {/* Editing controls are hidden entirely on a locked plan */}
          {!lockedForEditing && (
          <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2">
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
          </>
          )}

          {lockedForEditing ? (
            <PlanReadView
              periods={periods}
              periodCount={periodCount}
              subjects={subjects}
              planClassName={className}
              weekDates={weekDates}
            />
          ) : (
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
          )}

          <StepNav
            onBack={() => setTab('setup')}
            backLabel="Back to setup"
            onNext={() => setTab(lockedForEditing ? 'mine' : 'review')}
            nextLabel={lockedForEditing ? 'View submitted plans' : 'Next: Review & Submit'}
            nextDisabled={!lockedForEditing && !hasAnyTopic}
            nextHint={
              lockedForEditing
                ? 'This plan is read-only'
                : !hasAnyTopic
                  ? 'Add at least one topic to continue'
                  : emptyPeriodCount > 0
                    ? `${emptyPeriodCount} period(s) still empty`
                    : undefined
            }
          />
        </>
      )}

      {/* STEP 3: REVIEW & SUBMIT */}
      {tab === 'review' && planId && (
        <ReviewStep
          periods={periods}
          teacherClasses={teacherClasses}
          subjects={subjects}
          periodCount={periodCount}
          weekLabel={weekLabel}
          weekDates={weekDates}
          weekRange={weekRange}
          title={title}
          planClassName={className}
          onBack={() => setTab('plan')}
          onSubmit={handleSubmit}
          isSubmitting={submitMut.isPending}
          submitted={isSubmittedPlan}
          onViewSubmitted={() => setTab('mine')}
        />
      )}

      {/* STEP 4: MY LESSON PLANS */}
      {tab === 'mine' && (
        <SubmittedPlansView
          subjects={subjects}
          onEditPlan={handleSelectFromHistory}
          onBack={() => setTab(planId ? 'review' : 'setup')}
        />
      )}

      {/* Submission progress overlay */}
      {submitMut.isPending && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 shadow-xl flex flex-col items-center gap-4 max-w-sm text-center">
            <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
            <p className="text-lg font-semibold text-slate-900">Submitting&hellip;</p>
            <p className="text-sm text-slate-500">
              Saving plan &rarr; sending to supervisor. You will be redirected to your plans once it is done.
            </p>
          </div>
        </div>
      )}

      {/* AI review is handled entirely in the background — teacher never sees it */}
    </div>
  );
}
