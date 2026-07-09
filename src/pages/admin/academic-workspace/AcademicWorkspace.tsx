import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Copy,
  Grid3X3,
  Layers3,
  ListChecks,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '../../../context/ToastContext';
import { CLASSES, type AcademicYear, type ClassSubject, type Subject, type Term, type User } from '../../../types';
import {
  createAcademicYear,
  createTerm,
  deleteAcademicYear,
  deleteTerm,
  updateAcademicYear,
  updateTerm,
} from '../../../lib/db/academic';
import {
  createClassSubject,
  deleteClassSubject,
  updateClassSubject,
} from '../../../lib/db/classes';
import { createSubject, deleteSubject, updateSubject } from '../../../lib/db/subjects';
import { cn } from '../../../utils/cn';
import { calculateTeacherWorkload, DEFAULT_WEEKLY_LESSONS, TEACHER_WEEKLY_LIMIT, type SubjectMeta } from './utils/workload';
import { buildAcademicWarnings } from './utils/warnings';
import { useAcademicWorkspaceData } from './hooks/useAcademicWorkspaceData';
import { InfoPill, SummaryCard } from './components/Summary';

type WorkspaceView = 'cards' | 'matrix';
type SlideOverMode = 'subject' | 'year' | 'term' | 'bulk' | null;
const SUBJECT_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0f766e', '#be123c'];

function getSubjectName(row: any, subjectsById: Map<string, Subject>) {
  return row.subjects?.name || subjectsById.get(row.subjectId)?.name || row.subjectId;
}

function getTeacherName(row: any, teachersById: Map<string, User>) {
  return row.users?.name || teachersById.get(row.teacherId)?.name || '';
}

function normalizeRole(user: User) {
  return String(user.role || '').toLowerCase().trim();
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items));
}

export function AcademicWorkspace() {
  const { addToast } = useToast();

  const handleLoadError = useCallback((error: unknown) => {
    console.error('Academic workspace refresh failed:', error);
    addToast({ type: 'error', title: 'Failed to load academic workspace' });
  }, [addToast]);

  const {
    loading,
    refreshing,
    refresh,
    subjects,
    years,
    terms,
    mappings,
    setMappings,
    teachers,
    currentTerm,
  } = useAcademicWorkspaceData(handleLoadError);
  const [selectedClass, setSelectedClass] = useState(CLASSES[0] || '');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<WorkspaceView>('cards');
  const [slideOver, setSlideOver] = useState<SlideOverMode>(null);
  const subjectMeta = useMemo<SubjectMeta>(() => Object.fromEntries(subjects.map((subject, index) => [
    subject.id,
    {
      color: subject.color || SUBJECT_COLORS[index % SUBJECT_COLORS.length],
      weeklyLessons: subject.weeklyLessons || DEFAULT_WEEKLY_LESSONS,
    },
  ])), [subjects]);

  const [subjectForm, setSubjectForm] = useState({ id: '', name: '', shortName: '', color: SUBJECT_COLORS[0], weeklyLessons: DEFAULT_WEEKLY_LESSONS });
  const [yearForm, setYearForm] = useState({ id: '', name: '', startDate: '', endDate: '', isCurrent: false });
  const [termForm, setTermForm] = useState({ id: '', name: '', academicYearId: '', startDate: '', endDate: '', isCurrent: false });
  const [addSubjectId, setAddSubjectId] = useState('');

  const [copyFromClass, setCopyFromClass] = useState('');
  const [copyToClasses, setCopyToClasses] = useState<string[]>([]);
  const [bulkSubjectId, setBulkSubjectId] = useState('');
  const [bulkTeacherId, setBulkTeacherId] = useState('');
  const [replaceFromTeacherId, setReplaceFromTeacherId] = useState('');
  const [replaceToTeacherId, setReplaceToTeacherId] = useState('');
  const [bulkTargetClasses, setBulkTargetClasses] = useState<string[]>([]);

  const subjectsById = useMemo(() => new Map(subjects.map(subject => [subject.id, subject])), [subjects]);
  const teachersById = useMemo(() => new Map(teachers.map(teacher => [teacher.id, teacher])), [teachers]);

  const currentYear = useMemo(
    () => years.find(year => year.isCurrent) || years.find(year => year.id === currentTerm?.academicYearId) || years[0],
    [years, currentTerm],
  );

  const filteredSubjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return subjects;
    return subjects.filter(subject =>
      subject.name.toLowerCase().includes(needle)
      || String(subject.shortName || '').toLowerCase().includes(needle),
    );
  }, [subjects, query]);

  const filteredClasses = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return CLASSES;
    return CLASSES.filter(className => className.toLowerCase().includes(needle));
  }, [query]);

  const selectedClassMappings = useMemo(
    () => mappings.filter(row => row.className === selectedClass),
    [mappings, selectedClass],
  );

  const workloadByTeacher = useMemo(
    () => calculateTeacherWorkload(mappings, subjectMeta),
    [mappings, subjectMeta],
  );

  const summary = useMemo(() => {
    const configuredClasses = CLASSES.filter(className => mappings.some(row => row.className === className)).length;
    const missingTeachers = mappings.filter(row => !row.teacherId).length;
    const teacherAssigned = mappings.length - missingTeachers;
    const completion = mappings.length > 0 ? Math.round((teacherAssigned / mappings.length) * 100) : 0;
    return {
      configuredClasses,
      subjects: subjects.length,
      teacherAssigned,
      missingTeachers,
      completion,
    };
  }, [mappings, subjects]);

  const warnings = useMemo(
    () => buildAcademicWarnings({
      classes: CLASSES,
      mappings,
      subjects,
      subjectsById,
      teachersById,
      workloadByTeacher,
      teacherWeeklyLimit: TEACHER_WEEKLY_LIMIT,
    }).slice(0, 8),
    [mappings, subjects, subjectsById, teachersById, workloadByTeacher],
  );

  useEffect(() => {
    if (!addSubjectId && subjects[0]?.id) setAddSubjectId(subjects[0].id);
    if (!bulkSubjectId && subjects[0]?.id) setBulkSubjectId(subjects[0].id);
    if (!bulkTeacherId && teachers[0]?.id) setBulkTeacherId(teachers[0].id);
    if (!replaceFromTeacherId && teachers[0]?.id) setReplaceFromTeacherId(teachers[0].id);
    if (!replaceToTeacherId && (teachers[1]?.id || teachers[0]?.id)) setReplaceToTeacherId(teachers[1]?.id || teachers[0].id);
  }, [addSubjectId, bulkSubjectId, bulkTeacherId, replaceFromTeacherId, replaceToTeacherId, subjects, teachers]);

  const openSubject = (subject?: Subject) => {
    const meta = subject ? subjectMeta[subject.id] : undefined;
    setSubjectForm({
      id: subject?.id || '',
      name: subject?.name || '',
      shortName: subject?.shortName || '',
      color: meta?.color || SUBJECT_COLORS[subjects.length % SUBJECT_COLORS.length],
      weeklyLessons: meta?.weeklyLessons || DEFAULT_WEEKLY_LESSONS,
    });
    setSlideOver('subject');
  };

  const openYear = (year?: AcademicYear) => {
    setYearForm({
      id: year?.id || '',
      name: year?.name || '',
      startDate: year?.startDate || '',
      endDate: year?.endDate || '',
      isCurrent: Boolean(year?.isCurrent),
    });
    setSlideOver('year');
  };

  const openTerm = (term?: Term) => {
    setTermForm({
      id: term?.id || '',
      name: term?.name || '',
      academicYearId: term?.academicYearId || currentYear?.id || '',
      startDate: term?.startDate || '',
      endDate: term?.endDate || '',
      isCurrent: Boolean(term?.isCurrent),
    });
    setSlideOver('term');
  };

  const saveSubject = async () => {
    if (!subjectForm.name.trim()) {
      addToast({ type: 'error', title: 'Subject name required' });
      return;
    }

    try {
      const payload = {
        name: subjectForm.name.trim(),
        shortName: subjectForm.shortName.trim() || undefined,
        color: subjectForm.color,
        weeklyLessons: Number(subjectForm.weeklyLessons) || DEFAULT_WEEKLY_LESSONS,
      };
      const saved = subjectForm.id
        ? await updateSubject(subjectForm.id, payload)
        : await createSubject(payload);
      addToast({ type: 'success', title: subjectForm.id ? 'Subject updated' : 'Subject created' });
      setSlideOver(null);
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to save subject' });
    }
  };

  const saveYear = async () => {
    if (!yearForm.name.trim() || !yearForm.startDate || !yearForm.endDate) {
      addToast({ type: 'error', title: 'Year name, start date and end date required' });
      return;
    }
    try {
      const payload = {
        name: yearForm.name.trim(),
        startDate: yearForm.startDate,
        endDate: yearForm.endDate,
        isCurrent: yearForm.isCurrent,
      };
      if (yearForm.isCurrent) {
        await Promise.all(years.filter(year => year.id !== yearForm.id && year.isCurrent).map(year => updateAcademicYear(year.id, { isCurrent: false })));
      }
      yearForm.id ? await updateAcademicYear(yearForm.id, payload) : await createAcademicYear(payload);
      addToast({ type: 'success', title: yearForm.id ? 'Academic year updated' : 'Academic year created' });
      setSlideOver(null);
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to save academic year' });
    }
  };

  const saveTerm = async () => {
    if (!termForm.name.trim() || !termForm.academicYearId || !termForm.startDate || !termForm.endDate) {
      addToast({ type: 'error', title: 'Term name, year, start date and end date required' });
      return;
    }
    try {
      const payload = {
        name: termForm.name.trim(),
        academicYearId: termForm.academicYearId,
        startDate: termForm.startDate,
        endDate: termForm.endDate,
        isCurrent: termForm.isCurrent,
        months: [],
      };
      if (termForm.isCurrent) {
        await Promise.all(terms.filter(term => term.id !== termForm.id && term.isCurrent).map(term => updateTerm(term.id, { isCurrent: false })));
      }
      termForm.id ? await updateTerm(termForm.id, payload) : await createTerm(payload);
      addToast({ type: 'success', title: termForm.id ? 'Term updated' : 'Term created' });
      setSlideOver(null);
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to save term' });
    }
  };

  const addSubjectToSelectedClass = async () => {
    if (!selectedClass || !addSubjectId) return;
    const exists = mappings.some(row => row.className === selectedClass && row.subjectId === addSubjectId);
    if (exists) {
      addToast({ type: 'info', title: 'Subject already assigned to this class' });
      return;
    }
    try {
      await createClassSubject({ className: selectedClass, subjectId: addSubjectId, teacherId: undefined } as any);
      addToast({ type: 'success', title: 'Subject added to class' });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to add subject' });
    }
  };

  const updateMappingTeacher = async (row: any, teacherId: string) => {
    try {
      await updateClassSubject(row.id, { teacherId: teacherId || undefined } as any);
      setMappings(prev => prev.map(item => item.id === row.id ? { ...item, teacherId: teacherId || undefined, users: teacherId ? { name: teachersById.get(teacherId)?.name || '' } : undefined } : item));
      addToast({ type: 'success', title: 'Teacher assignment updated' });
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to update teacher' });
    }
  };

  const removeMapping = async (row: any) => {
    if (!confirm(`Remove ${getSubjectName(row, subjectsById)} from ${row.className}?`)) return;
    try {
      await deleteClassSubject(row.id);
      addToast({ type: 'success', title: 'Subject removed from class' });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to remove subject' });
    }
  };

  const deleteSubjectInline = async (subject: Subject) => {
    if (!confirm(`Archive/delete ${subject.name}? Existing class mappings for this subject will also be removed.`)) return;
    try {
      await deleteSubject(subject.id);
      addToast({ type: 'success', title: 'Subject archived' });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to archive subject' });
    }
  };

  const copyCurriculum = async () => {
    if (!copyFromClass || copyToClasses.length === 0) {
      addToast({ type: 'error', title: 'Select source and target classes' });
      return;
    }
    const sourceRows = mappings.filter(row => row.className === copyFromClass);
    if (sourceRows.length === 0) {
      addToast({ type: 'error', title: 'Source class has no curriculum to copy' });
      return;
    }
    try {
      const tasks: Promise<unknown>[] = [];
      for (const targetClass of copyToClasses) {
        for (const source of sourceRows) {
          const exists = mappings.some(row => row.className === targetClass && row.subjectId === source.subjectId);
          if (!exists) {
            tasks.push(createClassSubject({ className: targetClass, subjectId: source.subjectId, teacherId: source.teacherId || undefined } as any));
          }
        }
      }
      await Promise.all(tasks);
      addToast({ type: 'success', title: `Copied ${sourceRows.length} subjects to ${copyToClasses.length} class(es)` });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to copy curriculum' });
    }
  };

  const assignSubjectToMultipleClasses = async () => {
    if (!bulkSubjectId || bulkTargetClasses.length === 0) {
      addToast({ type: 'error', title: 'Choose a subject and target classes' });
      return;
    }
    try {
      const tasks = bulkTargetClasses
        .filter(className => !mappings.some(row => row.className === className && row.subjectId === bulkSubjectId))
        .map(className => createClassSubject({ className, subjectId: bulkSubjectId, teacherId: bulkTeacherId || undefined } as any));
      await Promise.all(tasks);
      addToast({ type: 'success', title: `Assigned subject to ${tasks.length} class(es)` });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Bulk subject assignment failed' });
    }
  };

  const replaceTeacherEverywhere = async () => {
    if (!replaceFromTeacherId || !replaceToTeacherId || replaceFromTeacherId === replaceToTeacherId) {
      addToast({ type: 'error', title: 'Choose different teachers' });
      return;
    }
    try {
      const affected = mappings.filter(row => row.teacherId === replaceFromTeacherId);
      await Promise.all(affected.map(row => updateClassSubject(row.id, { teacherId: replaceToTeacherId } as any)));
      addToast({ type: 'success', title: `Replaced teacher in ${affected.length} assignment(s)` });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Teacher replacement failed' });
    }
  };

  const removeSubjectFromMultipleClasses = async () => {
    if (!bulkSubjectId || bulkTargetClasses.length === 0) return;
    if (!confirm('Remove selected subject from all selected classes?')) return;
    try {
      const affected = mappings.filter(row => row.subjectId === bulkSubjectId && bulkTargetClasses.includes(row.className));
      await Promise.all(affected.map(row => deleteClassSubject(row.id)));
      addToast({ type: 'success', title: `Removed ${affected.length} assignment(s)` });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Bulk removal failed' });
    }
  };

  const createMatrixMapping = async (className: string, subjectId: string) => {
    try {
      const created = await createClassSubject({ className, subjectId, teacherId: undefined } as any);
      setMappings(prev => [...prev, created as any]);
      setSelectedClass(className);
      addToast({ type: 'success', title: 'Subject added to class' });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to add subject to class' });
    }
  };

  const workloadBadge = (teacherId?: string) => {
    if (!teacherId) return <span className="text-xs text-slate-400">No workload</span>;
    const workload = workloadByTeacher.get(teacherId) || 0;
    const color = workload > TEACHER_WEEKLY_LIMIT ? 'bg-red-100 text-red-700' : workload >= 22 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';
    return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', color)}>{workload} / {TEACHER_WEEKLY_LIMIT} lessons</span>;
  };

  const renderSlideOver = () => {
    if (!slideOver) return null;
    return (
      <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={() => setSlideOver(null)}>
        <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-500">Academic Workspace</p>
              <h2 className="text-xl font-bold text-slate-900">
                {slideOver === 'subject' && (subjectForm.id ? 'Edit Subject' : 'Create Subject')}
                {slideOver === 'year' && (yearForm.id ? 'Edit Academic Year' : 'Create Academic Year')}
                {slideOver === 'term' && (termForm.id ? 'Edit Term' : 'Create Term')}
                {slideOver === 'bulk' && 'Bulk Operations'}
              </h2>
            </div>
            <button onClick={() => setSlideOver(null)} className="rounded-full bg-slate-100 p-2 text-slate-500 hover:bg-slate-200"><X size={18} /></button>
          </div>

          {slideOver === 'subject' && (
            <div className="space-y-4">
              <label className="block text-sm font-medium text-slate-700">Name
                <input value={subjectForm.name} onChange={event => setSubjectForm(prev => ({ ...prev, name: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" placeholder="Mathematics" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Code
                <input value={subjectForm.shortName} onChange={event => setSubjectForm(prev => ({ ...prev, shortName: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" placeholder="MATH" />
              </label>
              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">Color</p>
                <div className="flex flex-wrap gap-2">
                  {SUBJECT_COLORS.map(color => (
                    <button key={color} onClick={() => setSubjectForm(prev => ({ ...prev, color }))} className={cn('h-9 w-9 rounded-full border-4', subjectForm.color === color ? 'border-slate-900' : 'border-white')} style={{ backgroundColor: color }} />
                  ))}
                </div>
              </div>
              <label className="block text-sm font-medium text-slate-700">Weekly Lessons
                <input type="number" min={1} max={40} value={subjectForm.weeklyLessons} onChange={event => setSubjectForm(prev => ({ ...prev, weeklyLessons: Number(event.target.value) }))} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" />
              </label>
              <button onClick={saveSubject} className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700">Save Subject</button>
            </div>
          )}

          {slideOver === 'year' && (
            <div className="space-y-4">
              <input value={yearForm.name} onChange={event => setYearForm(prev => ({ ...prev, name: event.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2" placeholder="2026-2027" />
              <div className="grid grid-cols-2 gap-3">
                <input type="date" value={yearForm.startDate} onChange={event => setYearForm(prev => ({ ...prev, startDate: event.target.value }))} className="rounded-xl border border-slate-200 px-3 py-2" />
                <input type="date" value={yearForm.endDate} onChange={event => setYearForm(prev => ({ ...prev, endDate: event.target.value }))} className="rounded-xl border border-slate-200 px-3 py-2" />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={yearForm.isCurrent} onChange={event => setYearForm(prev => ({ ...prev, isCurrent: event.target.checked }))} /> Set as current academic year</label>
              <button onClick={saveYear} className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700">Save Academic Year</button>
            </div>
          )}

          {slideOver === 'term' && (
            <div className="space-y-4">
              <input value={termForm.name} onChange={event => setTermForm(prev => ({ ...prev, name: event.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2" placeholder="Term 1" />
              <select value={termForm.academicYearId} onChange={event => setTermForm(prev => ({ ...prev, academicYearId: event.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2">
                <option value="">Select academic year</option>
                {years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <input type="date" value={termForm.startDate} onChange={event => setTermForm(prev => ({ ...prev, startDate: event.target.value }))} className="rounded-xl border border-slate-200 px-3 py-2" />
                <input type="date" value={termForm.endDate} onChange={event => setTermForm(prev => ({ ...prev, endDate: event.target.value }))} className="rounded-xl border border-slate-200 px-3 py-2" />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={termForm.isCurrent} onChange={event => setTermForm(prev => ({ ...prev, isCurrent: event.target.checked }))} /> Set as current term</label>
              <button onClick={saveTerm} className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700">Save Term</button>
            </div>
          )}

          {slideOver === 'bulk' && (
            <div className="space-y-8">
              <section className="rounded-2xl border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">Copy Curriculum</h3>
                <p className="mt-1 text-sm text-slate-500">Copy subjects and teachers from one class to many.</p>
                <select value={copyFromClass} onChange={event => setCopyFromClass(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2">
                  <option value="">Copy from</option>
                  {CLASSES.map(className => <option key={className} value={className}>{className}</option>)}
                </select>
                <ClassMultiSelect value={copyToClasses} onChange={setCopyToClasses} classes={CLASSES.filter(className => className !== copyFromClass)} />
                <button onClick={copyCurriculum} className="mt-3 w-full rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white">Copy Curriculum</button>
              </section>

              <section className="rounded-2xl border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">Assign / Remove Subject</h3>
                <select value={bulkSubjectId} onChange={event => setBulkSubjectId(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2">
                  {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
                </select>
                <select value={bulkTeacherId} onChange={event => setBulkTeacherId(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2">
                  <option value="">Unassigned</option>
                  {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                </select>
                <ClassMultiSelect value={bulkTargetClasses} onChange={setBulkTargetClasses} classes={CLASSES} />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button onClick={assignSubjectToMultipleClasses} className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Assign</button>
                  <button onClick={removeSubjectFromMultipleClasses} className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">Remove</button>
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">Replace Teacher Everywhere</h3>
                <select value={replaceFromTeacherId} onChange={event => setReplaceFromTeacherId(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2">
                  {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                </select>
                <select value={replaceToTeacherId} onChange={event => setReplaceToTeacherId(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2">
                  {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                </select>
                <button onClick={replaceTeacherEverywhere} className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">Replace Teacher</button>
              </section>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center text-slate-500">Loading Academic Workspace…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-500">Unified setup</p>
            <h1 className="text-3xl font-bold text-slate-900">Academic Workspace</h1>
            <p className="mt-1 text-sm text-slate-500">Manage years, terms, subjects, classes and teachers without switching pages.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <InfoPill label="Current Year" value={currentYear?.name || 'Not set'} />
            <InfoPill label="Current Term" value={currentTerm?.name || 'Not set'} />
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search classes, subjects…" className="w-64 rounded-2xl border border-slate-200 py-2 pl-9 pr-3 text-sm" />
            </div>
            <button onClick={() => openSubject()} className="rounded-2xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"><Plus className="mr-1 inline h-4 w-4" />New Subject</button>
            <button onClick={() => openYear()} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">New Year</button>
            <button onClick={() => openTerm()} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">New Term</button>
            <button onClick={refresh} className="rounded-2xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"><RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /></button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <SummaryCard icon={Layers3} label="Classes Configured" value={`${summary.configuredClasses}/${CLASSES.length}`} />
        <SummaryCard icon={BookOpen} label="Subjects" value={summary.subjects} />
        <SummaryCard icon={UserCheck} label="Teachers Assigned" value={summary.teacherAssigned} />
        <SummaryCard icon={AlertTriangle} label="Missing Teachers" value={summary.missingTeachers} tone={summary.missingTeachers ? 'warn' : 'ok'} />
        <SummaryCard icon={CheckCircle2} label="Completion" value={`${summary.completion}%`} tone={summary.completion === 100 ? 'ok' : 'neutral'} />
        <button onClick={() => setSlideOver('bulk')} className="rounded-3xl border border-indigo-200 bg-indigo-50 p-4 text-left text-indigo-700 hover:bg-indigo-100">
          <Settings2 className="mb-2 h-5 w-5" />
          <p className="text-sm font-semibold">Bulk Actions</p>
          <p className="text-xs">Copy, assign, replace</p>
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4">
          <div className="mb-3 flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="h-5 w-5" />Smart Warnings</div>
          <div className="grid gap-2 lg:grid-cols-2">
            {warnings.map(warning => (
              <div key={warning.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
                <span>{warning.message}</span>
                <button onClick={() => { if (warning.className) setSelectedClass(warning.className); }} className="rounded-xl bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">Fix Now</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(260px,20%)_1fr]">
        <aside className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <SideSection icon={CalendarDays} title="Academic Years" onAdd={() => openYear()}>
            {years.map(year => (
              <StructureRow key={year.id} active={year.isCurrent} label={year.name} sub={`${year.startDate} – ${year.endDate}`} onEdit={() => openYear(year)} onDelete={() => deleteAcademicYear(year.id).then(refresh)} />
            ))}
          </SideSection>
          <SideSection icon={ListChecks} title="Terms" onAdd={() => openTerm()}>
            {terms.map(term => (
              <StructureRow key={term.id} active={term.isCurrent} label={term.name} sub={years.find(year => year.id === term.academicYearId)?.name || term.academicYearId} onEdit={() => openTerm(term)} onDelete={() => deleteTerm(term.id).then(refresh)} />
            ))}
          </SideSection>
          <SideSection icon={BookOpen} title="Subjects" onAdd={() => openSubject()}>
            {filteredSubjects.map(subject => {
              const meta = subjectMeta[subject.id] || {};
              return (
                <div key={subject.id} className="group flex items-center justify-between rounded-2xl px-2 py-2 hover:bg-slate-50">
                  <button onClick={() => { setAddSubjectId(subject.id); }} className="flex min-w-0 items-center gap-2 text-left">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: meta.color || SUBJECT_COLORS[0] }} />
                    <span className="truncate text-sm font-medium text-slate-700">{subject.name}</span>
                  </button>
                  <div className="flex opacity-0 group-hover:opacity-100">
                    <button onClick={() => openSubject(subject)} className="rounded-lg p-1 text-slate-400 hover:text-indigo-600">Edit</button>
                    <button onClick={() => deleteSubjectInline(subject)} className="rounded-lg p-1 text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                </div>
              );
            })}
          </SideSection>
        </aside>

        <main className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Classes & Assignments</h2>
              <p className="text-sm text-slate-500">Select a class, add subjects and assign teachers inline.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setView('cards')} className={cn('rounded-xl px-3 py-2 text-sm font-semibold', view === 'cards' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600')}><Layers3 className="mr-1 inline h-4 w-4" />Cards</button>
              <button onClick={() => setView('matrix')} className={cn('rounded-xl px-3 py-2 text-sm font-semibold', view === 'matrix' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600')}><Grid3X3 className="mr-1 inline h-4 w-4" />Matrix</button>
              <select value={addSubjectId} onChange={event => setAddSubjectId(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
                {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </select>
              <button onClick={addSubjectToSelectedClass} className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white">Add Subject</button>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2">
            {filteredClasses.map(className => (
              <button key={className} onClick={() => setSelectedClass(className)} className={cn('shrink-0 rounded-2xl border px-4 py-2 text-sm font-semibold', selectedClass === className ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                {className}
              </button>
            ))}
          </div>

          {view === 'cards' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900">{selectedClass}</h3>
                <button onClick={() => { setCopyFromClass(selectedClass); setSlideOver('bulk'); }} className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"><Copy className="mr-1 inline h-4 w-4" />Copy Curriculum</button>
              </div>
              {selectedClassMappings.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No subjects assigned to {selectedClass}. Use “Add Subject” or copy a curriculum.</div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                  {selectedClassMappings.map(row => {
                    const subject = subjectsById.get(row.subjectId);
                    const meta = subjectMeta[row.subjectId] || {};
                    return (
                      <article key={row.id} className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="mb-2 h-1.5 w-16 rounded-full" style={{ backgroundColor: meta.color || SUBJECT_COLORS[0] }} />
                            <h4 className="truncate text-lg font-bold text-slate-900">{subject?.name || getSubjectName(row, subjectsById)}</h4>
                            <p className="text-xs text-slate-500">{subject?.shortName || 'No code'} · {meta.weeklyLessons || DEFAULT_WEEKLY_LESSONS} lessons/week</p>
                          </div>
                          <button onClick={() => removeMapping(row)} className="rounded-xl bg-red-50 p-2 text-red-600 hover:bg-red-100"><Trash2 size={16} /></button>
                        </div>
                        <div className="mt-4 space-y-2">
                          <label className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Assigned Teacher</label>
                          <select value={row.teacherId || ''} onChange={event => updateMappingTeacher(row, event.target.value)} className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                            <option value="">Unassigned</option>
                            {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                          </select>
                          <div>{workloadBadge(row.teacherId)}</div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <MatrixView classes={filteredClasses} subjects={subjects} mappings={mappings} teachers={teachers} teachersById={teachersById} onTeacherChange={updateMappingTeacher} onCreateMapping={createMatrixMapping} onFocusClass={setSelectedClass} />
          )}
        </main>
      </div>

      {renderSlideOver()}
    </div>
  );
}

function SideSection({ icon: Icon, title, onAdd, children }: { icon: typeof BookOpen; title: string; onAdd: () => void; children: ReactNode }) {
  return <section><div className="mb-2 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-bold text-slate-900"><Icon className="h-4 w-4 text-indigo-500" />{title}</h3><button onClick={onAdd} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"><Plus size={16} /></button></div><div className="max-h-56 space-y-1 overflow-auto pr-1">{children}</div></section>;
}

function StructureRow({ active, label, sub, onEdit, onDelete }: { active?: boolean; label: string; sub?: string; onEdit: () => void; onDelete: () => void }) {
  return <div className={cn('group rounded-2xl px-2 py-2', active ? 'bg-indigo-50' : 'hover:bg-slate-50')}><div className="flex items-center justify-between gap-2"><button onClick={onEdit} className="min-w-0 text-left"><p className={cn('truncate text-sm font-semibold', active ? 'text-indigo-700' : 'text-slate-700')}>{label}</p>{sub && <p className="truncate text-xs text-slate-400">{sub}</p>}</button><button onClick={onDelete} className="opacity-0 text-slate-400 hover:text-red-600 group-hover:opacity-100"><Trash2 size={14} /></button></div></div>;
}

function ClassMultiSelect({ value, onChange, classes }: { value: string[]; onChange: (value: string[]) => void; classes: string[] }) {
  return (
    <div className="mt-3 rounded-2xl border border-slate-200 p-2">
      <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">Target classes</span><button onClick={() => onChange(classes)} className="text-xs font-semibold text-indigo-600">Select all</button></div>
      <div className="max-h-40 space-y-1 overflow-auto">
        {classes.map(className => (
          <label key={className} className="flex items-center gap-2 rounded-xl px-2 py-1 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={value.includes(className)} onChange={event => onChange(event.target.checked ? [...value, className] : value.filter(item => item !== className))} />
            {className}
          </label>
        ))}
      </div>
    </div>
  );
}

function MatrixView({ classes, subjects, mappings, teachers, teachersById, onTeacherChange, onCreateMapping, onFocusClass }: {
  classes: string[];
  subjects: Subject[];
  mappings: any[];
  teachers: User[];
  teachersById: Map<string, User>;
  onTeacherChange: (row: any, teacherId: string) => void;
  onCreateMapping: (className: string, subjectId: string) => void;
  onFocusClass: (className: string) => void;
}) {
  return (
    <div className="overflow-auto rounded-3xl border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="sticky left-0 z-10 bg-slate-50 px-4 py-3 text-left font-semibold text-slate-600">Subject</th>
            {classes.map(className => <th key={className} className="min-w-40 px-3 py-3 text-left font-semibold text-slate-600"><button onClick={() => onFocusClass(className)}>{className}</button></th>)}
          </tr>
        </thead>
        <tbody>
          {subjects.map(subject => (
            <tr key={subject.id} className="border-t border-slate-100">
              <td className="sticky left-0 z-10 bg-white px-4 py-3 font-semibold text-slate-900">{subject.name}</td>
              {classes.map(className => {
                const row = mappings.find(item => item.className === className && item.subjectId === subject.id);
                return (
                  <td key={`${className}-${subject.id}`} className="px-3 py-2">
                    {row ? (
                      <select value={row.teacherId || ''} onChange={event => onTeacherChange(row, event.target.value)} className="w-full rounded-xl border border-slate-200 px-2 py-1 text-xs">
                        <option value="">—</option>
                        {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
                      </select>
                    ) : (
                      <button onClick={() => onCreateMapping(className, subject.id)} className="rounded-lg border border-dashed border-slate-300 px-2 py-1 text-xs font-semibold text-slate-400 hover:border-indigo-300 hover:text-indigo-600">+ Add</button>
                    )}
                    {row?.teacherId && <p className="mt-1 truncate text-[11px] text-slate-400">{teachersById.get(row.teacherId)?.name}</p>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
