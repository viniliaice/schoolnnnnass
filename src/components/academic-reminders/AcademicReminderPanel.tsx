import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  BellRing,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { MARKS_EXAM_SCOPES } from '../../lib/marksEntryTracking';
import {
  academicReminderApi,
  type AcademicReminderScheduleView,
  type AcademicReminderTaskView,
  type AcademicReminderTasksResponse,
} from '../../lib/academicRemindersApi';

const REMINDER_TYPES = ['lesson_plan_reminder', 'marks_entry_reminder'] as const;
type ReminderType = (typeof REMINDER_TYPES)[number];
const DAY_OPTIONS = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];
const SCOPE_LABELS: Record<string, string> = {
  monthly: 'Monthly coursework + Quiz',
  midterm: 'Midterm',
  final: 'Final',
  ca: 'CA',
  homework: 'Homework',
  classwork: 'Classwork',
  quiz: 'Quiz',
  attendance: 'Attendance',
  discipline: 'Discipline',
};

function typeTitle(type: ReminderType): string {
  return type === 'lesson_plan_reminder' ? 'Lesson plans' : 'Marks entry';
}

function typeDescription(type: ReminderType): string {
  return type === 'lesson_plan_reminder'
    ? 'Current-week lesson plans with incomplete required periods or a revision request.'
    : 'Incomplete class/subject entries returned by the existing marks monitor.';
}

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function deliveryLabel(task: AcademicReminderTaskView): string {
  const last = task.lastReminder;
  if (!last) return 'No reminder attempt for this period';
  if (last.status === 'sent' && (last.failedDevices > 0 || last.expiredDevices > 0)) return 'Partial device delivery';
  if (last.status === 'sent') return 'Accepted by push service';
  if (last.status === 'failed') return 'Delivery failed';
  if (last.status === 'expired') return 'All subscriptions expired';
  if (last.status === 'no_subscription') return 'No active real device';
  if (last.status === 'skipped') return 'Push preference disabled';
  if (last.status === 'already_reminded') return 'Duplicate event skipped';
  if (last.status === 'task_already_completed') return 'Work completed; no reminder sent';
  return last.status.replace(/_/g, ' ');
}

function taskState(task: AcademicReminderTaskView): { label: string; classes: string } {
  if (task.eligible) return { label: 'Needs attention', classes: 'bg-amber-100 text-amber-800' };
  if (task.completionStatus === 'complete') return { label: 'Complete', classes: 'bg-emerald-100 text-emerald-800' };
  if (task.completionStatus === 'no_task') return { label: 'No current task', classes: 'bg-slate-100 text-slate-600' };
  return { label: 'No reminder due', classes: 'bg-slate-100 text-slate-600' };
}

function TaskCard({
  task,
  canManage,
  selected,
  selectionDisabled,
  onToggle,
}: {
  task: AcademicReminderTaskView;
  canManage: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onToggle: (teacherId: string) => void;
}) {
  const state = taskState(task);
  const destination = task.reminderType === 'lesson_plan_reminder' ? '/teacher/lesson-plans' : '/teacher/results';

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={`academic-reminder-task-${task.reminderType}-${task.teacherId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {canManage && task.eligible && (
            <input
              aria-label={`Select ${task.teacherName} for ${typeTitle(task.reminderType)} reminder`}
              type="checkbox"
              checked={selected}
              disabled={selectionDisabled && !selected}
              onChange={() => onToggle(task.teacherId)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
          )}
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900">{canManage ? task.teacherName : 'My academic task'}</h3>
            <p className="mt-0.5 text-xs text-slate-500">{task.periodLabel}</p>
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${state.classes}`}>{state.label}</span>
      </div>

      <p className="mt-3 text-sm text-slate-700">{task.eligibilityReason || task.outstandingSummary}</p>
      {task.outstandingSummary && <p className="mt-1 text-xs text-slate-500">{task.outstandingSummary}</p>}
      {task.assignedClasses.length > 0 && (
        <p className="mt-1 text-xs text-slate-500">Classes: {task.assignedClasses.join(', ')}</p>
      )}
      {task.completionPercent != null && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
            <span>Completion</span><span>{Math.round(task.completionPercent)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${task.eligible ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, Math.max(0, task.completionPercent))}%` }} />
          </div>
        </div>
      )}

      {task.reminderType === 'lesson_plan_reminder' && (task.lessonPlanDetails?.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {task.lessonPlanDetails?.map((detail) => (
            <li key={`${detail.planId ?? 'plan'}-${detail.className}`} className="flex flex-wrap justify-between gap-2">
              <span>{detail.className} · {detail.status.replace(/_/g, ' ')}</span>
              <span>{detail.missingPeriods} required period(s) missing{detail.completionPercent != null ? ` · ${Math.round(detail.completionPercent)}%` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      {task.reminderType === 'marks_entry_reminder' && (task.outstandingAssignments?.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {task.outstandingAssignments?.map((assignment) => (
            <li key={assignment.assignmentId} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <span className="font-medium text-slate-700">{assignment.className} · {assignment.subjectName}</span>
              <span>{assignment.enteredStudents}/{assignment.expectedStudents} students · {assignment.missingCount} missing · {Math.round(assignment.completionPercent)}%</span>
            </li>
          ))}
        </ul>
      )}

      {task.lastReminder && (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-2 border-t border-slate-100 pt-3 text-xs">
          <span className={task.lastReminder.failedDevices > 0 || task.lastReminder.expiredDevices > 0 ? 'font-medium text-amber-700' : 'text-slate-600'}>
            {deliveryLabel(task)} · {task.lastReminder.deliveredDevices} accepted / {task.lastReminder.failedDevices} failed / {task.lastReminder.expiredDevices} expired
          </span>
          <time className="text-slate-400" dateTime={task.lastReminder.attemptedAt}>{formattedDate(task.lastReminder.attemptedAt)}</time>
          {task.lastReminder.lastError && <p className="w-full break-words text-rose-700">{task.lastReminder.lastError}</p>}
        </div>
      )}

      {canManage && task.subscription && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <Smartphone className="h-3.5 w-3.5" aria-hidden />
          {task.subscription.realActiveSubscriptions} real active device(s) · {task.subscription.activeSubscriptions} total active subscription(s)
        </p>
      )}
      {!canManage && task.eligible && (
        <a href={destination} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-900">
          Open {task.reminderType === 'lesson_plan_reminder' ? 'lesson planner' : 'marks entry'} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
    </article>
  );
}

export function AcademicReminderPanel() {
  const { session } = useRole();
  const queryClient = useQueryClient();
  const canManage = session?.role === 'admin' || session?.role === 'supervisor';
  const queryKey = ['academic-reminder-tasks', session?.role, session?.userId];
  const [reminderType, setReminderType] = useState<ReminderType>('lesson_plan_reminder');
  const [selectedByType, setSelectedByType] = useState<Partial<Record<ReminderType, string[]>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<ReminderType, AcademicReminderScheduleView>>>({});
  const [taskFilter, setTaskFilter] = useState<'needs_attention' | 'all'>('needs_attention');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [sendNotice, setSendNotice] = useState<{ reminderType: ReminderType; message: string; ok: boolean } | null>(null);
  const [sendRequestRef, setSendRequestRef] = useState<{ signature: string; requestId: string } | null>(null);

  const tasksQuery = useQuery({
    queryKey,
    queryFn: () => academicReminderApi<AcademicReminderTasksResponse>('/api/academic-reminders/tasks'),
    enabled: Boolean(session),
    staleTime: 30_000,
  });

  useEffect(() => {
    const schedules = tasksQuery.data?.schedules ?? [];
    if (schedules.length === 0) return;
    setDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const schedule of schedules) {
        if (!next[schedule.reminderType]) {
          next[schedule.reminderType] = schedule;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tasksQuery.data?.schedules]);

  const currentSnapshot = tasksQuery.data?.[reminderType];
  const tasks = currentSnapshot?.tasks ?? [];
  const eligibleTasks = tasks.filter((task) => task.eligible);
  const selectedIds = (selectedByType[reminderType] ?? []).filter((id) => eligibleTasks.some((task) => task.teacherId === id));
  const currentSchedule = drafts[reminderType]
    ?? tasksQuery.data?.schedules.find((schedule) => schedule.reminderType === reminderType)
    ?? null;

  const saveScheduleMutation = useMutation({
    mutationFn: async (draft: AcademicReminderScheduleView) => academicReminderApi<{ schedule: any }>('/api/academic-reminders/schedules', {
      method: 'PUT',
      body: JSON.stringify({
        reminderType: draft.reminderType,
        enabled: draft.enabled,
        timezone: draft.timezone,
        daysOfWeek: draft.daysOfWeek,
        sendTime: draft.sendTime,
        examScope: draft.examScope,
      }),
    }),
    onSuccess: (data, draft) => {
      if (data.schedule) {
        setDrafts((current) => ({ ...current, [draft.reminderType]: {
          reminderType: data.schedule.reminder_type,
          enabled: data.schedule.enabled,
          timezone: data.schedule.timezone,
          daysOfWeek: data.schedule.days_of_week,
          sendTime: String(data.schedule.send_time).slice(0, 5),
          examScope: data.schedule.exam_scope,
        } }));
      }
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (payload: { reminderType: ReminderType; teacherIds: string[]; requestId: string; examScope?: string }) =>
      academicReminderApi<any>('/api/academic-reminders/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async (result: any, variables) => {
      setSendRequestRef(null);
      setSendNotice({ reminderType: variables.reminderType, message: result.message || 'Reminder request processed.', ok: Boolean(result.deliveryOk) });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      setSendNotice({ reminderType, message: error instanceof Error ? error.message : 'Reminder send failed.', ok: false });
    },
  });

  const matchingTasks = useMemo(() => {
    const term = teacherSearch.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      if (canManage && taskFilter === 'needs_attention' && !task.eligible) return false;
      return !term
        || task.teacherName.toLocaleLowerCase().includes(term)
        || task.assignedClasses.some((className) => className.toLocaleLowerCase().includes(term));
    });
  }, [tasks, taskFilter, teacherSearch]);
  const visibleTasks = matchingTasks.slice(0, visibleLimit);

  function patchDraft(patch: Partial<AcademicReminderScheduleView>) {
    if (!currentSchedule) return;
    setDrafts((current) => ({ ...current, [reminderType]: { ...currentSchedule, ...patch } }));
  }

  function toggleTeacher(teacherId: string) {
    setSelectedByType((current) => {
      const selected = current[reminderType] ?? [];
      return {
        ...current,
        [reminderType]: selected.includes(teacherId)
          ? selected.filter((id) => id !== teacherId)
          : selected.length >= 500 ? selected : [...selected, teacherId],
      };
    });
  }

  function toggleAllEligible() {
    const allSelected = eligibleTasks.length > 0 && eligibleTasks.slice(0, 500).every((task) => selectedIds.includes(task.teacherId));
    setSelectedByType((current) => ({
      ...current,
      [reminderType]: allSelected ? [] : eligibleTasks.slice(0, 500).map((task) => task.teacherId),
    }));
  }

  function sendSelected() {
    if (selectedIds.length === 0 || selectedIds.length > 500) return;
    const examScope = reminderType === 'marks_entry_reminder' ? currentSchedule?.examScope ?? 'monthly' : undefined;
    const signature = JSON.stringify([reminderType, [...selectedIds].sort(), examScope]);
    const requestId = sendRequestRef?.signature === signature ? sendRequestRef.requestId : newRequestId();
    setSendRequestRef({ signature, requestId });
    setSendNotice(null);
    sendMutation.mutate({ reminderType, teacherIds: selectedIds, requestId, examScope });
  }

  const selectedAll = eligibleTasks.length > 0 && eligibleTasks.slice(0, 500).every((task) => selectedIds.includes(task.teacherId));
  const currentNotice = sendNotice?.reminderType === reminderType ? sendNotice : null;
  const mutationError = saveScheduleMutation.error instanceof Error ? saveScheduleMutation.error.message : '';
  const snapshotError = currentSnapshot?.error;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" data-testid="academic-reminder-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 via-white to-teal-50 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white"><BellRing className="h-5 w-5" aria-hidden /></div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Academic reminders</h2>
            <p className="text-xs text-slate-500">Academic tasks, delivery history, and schedule controls</p>
          </div>
        </div>
        <button type="button" onClick={() => void tasksQuery.refetch()} disabled={tasksQuery.isFetching} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          {tasksQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      <div className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Reminder type">
          {REMINDER_TYPES.map((type) => (
            <button key={type} type="button" role="tab" aria-selected={reminderType === type} onClick={() => {
              setReminderType(type);
              setVisibleLimit(50);
              setSendNotice(null);
            }} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${reminderType === type ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {typeTitle(type)}
            </button>
          ))}
          <p className="basis-full text-xs text-slate-500">{typeDescription(reminderType)}</p>
        </div>

        {tasksQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading current academic tasks…</div>
        ) : tasksQuery.error ? (
          <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{tasksQuery.error instanceof Error ? tasksQuery.error.message : 'Could not load reminder tasks.'}</div>
        ) : snapshotError ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />{snapshotError}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
              <span className="font-semibold text-slate-800">{currentSnapshot?.periodLabel || 'Current academic period'}</span>
              <span className="text-xs text-slate-500">{eligibleTasks.length} task(s) currently need attention · {tasks.length} teacher(s) in view</span>
            </div>

            {canManage && (
              <div className="space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-slate-900">Manual send · {typeTitle(reminderType)}</h3>
                    <p className="text-xs text-slate-600">Only eligible teachers can be selected. Maximum 500 per request.</p>
                  </div>
                  <button type="button" onClick={toggleAllEligible} disabled={eligibleTasks.length === 0 || sendMutation.isPending} className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-800 disabled:opacity-50">
                    {selectedAll ? 'Clear selection' : 'Select all eligible'}
                  </button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input value={teacherSearch} onChange={(event) => { setTeacherSearch(event.target.value); setVisibleLimit(50); }} placeholder="Filter teachers or classes" className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" />
                  <select value={taskFilter} onChange={(event) => { setTaskFilter(event.target.value as typeof taskFilter); setVisibleLimit(50); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                    <option value="needs_attention">Needs attention</option>
                    <option value="all">All task states</option>
                  </select>
                </div>
                {eligibleTasks.length > 500 && <p className="text-xs font-medium text-amber-800">Only the first 500 eligible teachers can be selected in one send.</p>}
                <button type="button" onClick={sendSelected} disabled={selectedIds.length === 0 || sendMutation.isPending} className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50">
                  {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sendMutation.isPending ? 'Sending…' : `Send to ${selectedIds.length} selected teacher(s)`}
                </button>
                {sendMutation.isError && sendMutation.variables?.reminderType === reminderType && <p className="text-sm text-rose-700">{sendMutation.error instanceof Error ? sendMutation.error.message : 'Reminder send failed.'}</p>}
                {currentNotice && (
                  <div className={`rounded-lg border px-3 py-2 text-sm ${currentNotice.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role="status">
                    {currentNotice.message}
                    {sendMutation.data?.reminderType === reminderType && sendMutation.data?.summary && (
                      <p className="mt-1 text-xs">{sendMutation.data.summary.sent} sent · {sendMutation.data.summary.failed} failed · {sendMutation.data.summary.noSubscription} without a real device · {sendMutation.data.summary.alreadyReminded} duplicate(s) skipped.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {tasks.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                <p className="font-semibold text-slate-800">No current academic task</p>
                <p className="mt-1">Reminders are based on current lesson-plan records and the marks monitor. Assigned classes alone do not trigger a reminder.</p>
              </div>
            ) : visibleTasks.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">No teachers match this view.</div>
            ) : (
              <div className="space-y-3">
                {visibleTasks.map((task) => (
                  <TaskCard
                    key={`${task.reminderType}:${task.teacherId}`}
                    task={task}
                    canManage={Boolean(canManage)}
                    selected={selectedIds.includes(task.teacherId)}
                    selectionDisabled={selectedIds.length >= 500}
                    onToggle={toggleTeacher}
                  />
                ))}
                {visibleTasks.length < matchingTasks.length && (
                  <button type="button" onClick={() => setVisibleLimit((limit) => limit + 50)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                    Show next 50 of {matchingTasks.length - visibleTasks.length} remaining
                  </button>
                )}
              </div>
            )}

            {canManage && currentSchedule && (
              <details className="group rounded-xl border border-slate-200 bg-white">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 font-semibold text-slate-800">
                  <span className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-indigo-600" />Schedule settings · {typeTitle(reminderType)}</span>
                  <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                </summary>
                <div className="space-y-4 border-t border-slate-100 px-4 py-4">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input type="checkbox" checked={currentSchedule.enabled} onChange={(event) => patchDraft({ enabled: event.target.checked })} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />
                    Scheduled sending enabled
                  </label>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="text-xs font-semibold text-slate-600">School timezone
                      <input value={currentSchedule.timezone} onChange={(event) => patchDraft({ timezone: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800" placeholder="Africa/Mogadishu" />
                    </label>
                    <label className="text-xs font-semibold text-slate-600">Local send time
                      <input type="time" value={currentSchedule.sendTime} onChange={(event) => patchDraft({ sendTime: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800" />
                    </label>
                  </div>
                  <fieldset>
                    <legend className="mb-2 text-xs font-semibold text-slate-600">Days of week</legend>
                    <div className="flex flex-wrap gap-2">
                      {DAY_OPTIONS.map((day) => {
                        const selected = currentSchedule.daysOfWeek.includes(day.value);
                        return (
                          <label key={day.value} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold ${selected ? 'border-indigo-300 bg-indigo-100 text-indigo-800' : 'border-slate-200 bg-white text-slate-500'}`}>
                            <input type="checkbox" checked={selected} onChange={() => patchDraft({ daysOfWeek: selected ? currentSchedule.daysOfWeek.filter((value) => value !== day.value) : [...currentSchedule.daysOfWeek, day.value].sort((a, b) => a - b) })} className="sr-only" />
                            {day.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  {reminderType === 'marks_entry_reminder' && (
                    <label className="block text-xs font-semibold text-slate-600">Marks scope
                      <select value={currentSchedule.examScope} onChange={(event) => patchDraft({ examScope: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800 sm:max-w-md">
                        {MARKS_EXAM_SCOPES.map((scope) => <option key={scope} value={scope}>{SCOPE_LABELS[scope] ?? scope}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="flex items-center gap-1.5 text-xs text-slate-500"><ShieldCheck className="h-3.5 w-3.5" />Vercel Cron checks schedules every five minutes; sends use this local timezone.</p>
                    <button type="button" onClick={() => saveScheduleMutation.mutate(currentSchedule)} disabled={saveScheduleMutation.isPending} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                      {saveScheduleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save schedule
                    </button>
                  </div>
                  {mutationError && <p className="text-sm text-rose-700">{mutationError}</p>}
                </div>
              </details>
            )}
            {canManage && !currentSchedule && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Reminder schedule rows are missing. Apply the academic-reminders database migration before configuring schedules.</p>}
          </>
        )}

        <p className="flex items-start gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
          Completed work stops qualifying automatically. Reminder types have separate schedules and delivery history; retries for the same event are deduplicated.
        </p>
        {canManage && <p className="flex items-center gap-2 text-xs text-slate-400"><Clock3 className="h-3.5 w-3.5" />Manual sends are logged alongside the existing notification history.</p>}
      </div>
    </section>
  );
}
