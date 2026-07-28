import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Copy,
  Download,
  FileDown,
  FileText,
  Grid3X3,
  Layers3,
  ListChecks,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '../../../context/ToastContext';
import { CLASSES, DEPARTMENTS, type AcademicYear, type ClassSubject, type Subject, type Term, type User } from '../../../types';
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
import { createAuditLog } from '../../../lib/db/audit';
import { bulkCreateTeachersWithAssignments } from '../../../lib/db/bulk';
import { cn } from '../../../utils/cn';
import { calculateTeacherWorkload, DEFAULT_WEEKLY_LESSONS, TEACHER_WEEKLY_LIMIT, type SubjectMeta } from './utils/workload';
import { buildAcademicWarnings } from './utils/warnings';
import { useAcademicWorkspaceData } from './hooks/useAcademicWorkspaceData';
import { InfoPill, SummaryCard } from './components/Summary';
import { PDFDownloadLink } from '@react-pdf/renderer';
import { CurriculumPdfDocument } from './components/CurriculumPdf';
import { WorkloadAnalytics } from './components/WorkloadAnalytics';

type WorkspaceView = 'cards' | 'matrix';
type SlideOverMode = 'subject' | 'year' | 'term' | 'bulk' | 'analytics' | 'teachers' | null;
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

/** CSV example for teacher upload */
const TEACHER_UPLOAD_CSV = `Name,Email,Password,Classes (semicolon-separated),Subjects (semicolon-separated names),Weekly Periods
Mr. Abdirahman Ali,abdirahman@school.edu,TempPass123!,Grade 7-A;Grade 7-B,Mathematics;Science,25
Ms. Nasra Ibrahim,nasra@school.edu,TempPass123!,Grade 9-A;Grade 10-A,English;Somali,20
Mr. Yusuf Hassan,yusuf@school.edu,TempPass123!,Grade 8-A;Grade 8-B,Islamic Studies;Arabic,22`;

/** Parse teacher CSV text into entries */
interface ParsedTeacherEntry {
  name: string;
  email: string;
  password: string;
  assignedClasses: string[];
  subjectNames: string[];
  weeklyPeriods: number;
}

function parseTeacherCsv(text: string): ParsedTeacherEntry[] {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const entries: ParsedTeacherEntry[] = [];
  for (const line of lines) {
    // Skip header row
    if (line.toLowerCase().includes('email') && line.toLowerCase().includes('name')) continue;
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    entries.push({
      name: parts[0] || '',
      email: parts[1] || '',
      password: parts[2] || 'TempPass123!',
      assignedClasses: (parts[3] || '').split(';').map(s => s.trim()).filter(Boolean),
      subjectNames: (parts[4] || '').split(';').map(s => s.trim()).filter(Boolean),
      weeklyPeriods: parseInt(parts[5] || '0', 10) || 0,
    });
  }
  return entries;
}

export function AcademicWorkspace() {
  const { addToast } = useToast();
  const [loadError, setLoadError] = useState<unknown>(null);

  const handleLoadError = useCallback((error: unknown) => {
    console.error('Academic workspace refresh failed:', error);
    setLoadError(error);
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

  const [subjectForm, setSubjectForm] = useState({ id: '', name: '', shortName: '', color: SUBJECT_COLORS[0], weeklyLessons: DEFAULT_WEEKLY_LESSONS, department: '' });
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
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [filterClassList, setFilterClassList] = useState<string[]>([]);
  const [showClassFilter, setShowClassFilter] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const classFilterRef = useRef<HTMLButtonElement>(null);
  const classFilterDropdownRef = useRef<HTMLDivElement>(null);

  // ── Teacher upload state ──────────────────────────────────────────
  const [teacherCsv, setTeacherCsv] = useState('');
  const [teacherCsvMode, setTeacherCsvMode] = useState(false);
  const [uploadingTeachers, setUploadingTeachers] = useState(false);
  const [teacherUploadResult, setTeacherUploadResult] = useState<{
    created: number;
    assignments: number;
    skipped: string[];
    failedAssignments: string[];
  } | null>(null);
  // Inline add-teacher form
  const [showInlineTeacherForm, setShowInlineTeacherForm] = useState(false);
  const [inlineTeacherForm, setInlineTeacherForm] = useState({
    name: '',
    email: '',
    password: 'TempPass123!',
    classes: [] as string[],
    subjects: [] as string[],
    weeklyPeriods: 25,
  });

  // ── P0 #1: Lazy-load PDF export ──
  const [showPdfExport, setShowPdfExport] = useState(false);

  const subjectsById = useMemo(() => new Map(subjects.map(subject => [subject.id, subject])), [subjects]);
  const teachersById = useMemo(() => new Map(teachers.map(teacher => [teacher.id, teacher])), [teachers]);

  const currentYear = useMemo(
    () => years.find(year => year.isCurrent) || years.find(year => year.id === currentTerm?.academicYearId) || years[0],
    [years, currentTerm],
  );

  const filteredSubjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return subjects.filter(subject => {
      if (needle && !subject.name.toLowerCase().includes(needle) && !String(subject.shortName || '').toLowerCase().includes(needle)) return false;
      if (departmentFilter && subject.department !== departmentFilter) return false;
      return true;
    });
  }, [subjects, query, departmentFilter]);

  const filteredClasses = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (filterClassList.length === 0 && !needle) return [];
    let list = CLASSES;
    if (needle) list = list.filter(className => className.toLowerCase().includes(needle));
    if (filterClassList.length > 0) list = list.filter(className => filterClassList.includes(className));
    return list;
  }, [query, filterClassList]);

  const selectedClassMappings = useMemo(
    () => mappings.filter(row => row.className === selectedClass),
    [mappings, selectedClass],
  );

  // ── P0 #3: Pre-computed O(1) lookup map for matrix/heatmap ──
  // Key = "className::subjectId" → mapping row. Eliminates O(S×C×M) .find() scans.
  const mappingLookup = useMemo(() => {
    const map = new Map<string, (typeof mappings)[number]>();
    for (const m of mappings) {
      map.set(`${m.className}::${m.subjectId}`, m);
    }
    return map;
  }, [mappings]);

  // ── P0 #3b: Pre-computed set of configured class names ──
  const configuredClassSet = useMemo(() => {
    const set = new Set<string>();
    for (const m of mappings) set.add(m.className);
    return set;
  }, [mappings]);

  const workloadByTeacher = useMemo(
    () => calculateTeacherWorkload(mappings, subjectMeta),
    [mappings, subjectMeta],
  );

  // ── P0 #5: summary now uses O(M) single-pass instead of O(C×M) ──
  const summary = useMemo(() => {
    const configuredClasses = configuredClassSet.size;
    let missingTeachers = 0;
    for (const row of mappings) {
      if (!row.teacherId) missingTeachers++;
    }
    const teacherAssigned = mappings.length - missingTeachers;
    const completion = mappings.length > 0 ? Math.round((teacherAssigned / mappings.length) * 100) : 0;
    return {
      configuredClasses,
      subjects: subjects.length,
      teacherAssigned,
      missingTeachers,
      completion,
    };
  }, [mappings, subjects, configuredClassSet]);

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
      department: subject?.department || '',
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
        department: subjectForm.department || undefined,
      };
      const saved = subjectForm.id
        ? await updateSubject(subjectForm.id, payload)
        : await createSubject(payload);
      addToast({ type: 'success', title: subjectForm.id ? 'Subject updated' : 'Subject created' });
      setSlideOver(null);
      createAuditLog(subjectForm.id ? 'subject.updated' : 'subject.created', { id: saved.id, name: saved.name, department: saved.department });
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
        for (const year of years) {
          if (year.id !== yearForm.id && year.isCurrent) {
            await updateAcademicYear(year.id, { isCurrent: false });
          }
        }
      }
      yearForm.id ? await updateAcademicYear(yearForm.id, payload) : await createAcademicYear(payload);
      addToast({ type: 'success', title: yearForm.id ? 'Academic year updated' : 'Academic year created' });
      setSlideOver(null);
      createAuditLog(yearForm.id ? 'academic-year.updated' : 'academic-year.created', { name: yearForm.name, isCurrent: yearForm.isCurrent });
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
      createAuditLog(termForm.id ? 'term.updated' : 'term.created', { name: termForm.name, academicYearId: termForm.academicYearId, isCurrent: termForm.isCurrent });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to save term' });
    }
  };

  const addSubjectToSelectedClass = async (subjectId?: string) => {
    const id = subjectId || addSubjectId;
    if (!selectedClass || !id) return;
    const exists = mappings.some(row => row.className === selectedClass && row.subjectId === id);
    if (exists) return;
    try {
      await createClassSubject({ className: selectedClass, subjectId: id, teacherId: undefined } as any);
      addToast({ type: 'success', title: 'Subject added to class' });
      createAuditLog('class-subject.created', { className: selectedClass, subjectId: id });
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
      createAuditLog('class-subject.updated', { mappingId: row.id, className: row.className, subjectId: row.subjectId, teacherId });
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
      createAuditLog('class-subject.deleted', { mappingId: row.id, className: row.className, subjectId: row.subjectId });
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
      createAuditLog('subject.deleted', { id: subject.id, name: subject.name });
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
      const tasks = copyToClasses.flatMap(targetClass =>
        sourceRows
          .filter(source => !mappings.some(row => row.className === targetClass && row.subjectId === source.subjectId))
          .map(source => createClassSubject({ className: targetClass, subjectId: source.subjectId, teacherId: source.teacherId || undefined } as any)),
      );
      const results = await Promise.allSettled(tasks);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) {
        addToast({ type: 'success', title: `Copied ${succeeded} subject(s) to ${copyToClasses.length} class(es)` });
      } else if (succeeded === 0) {
        addToast({ type: 'error', title: 'Failed to copy curriculum' });
      } else {
        addToast({ type: 'info', title: `Copied ${succeeded} subject(s), ${failed} failed` });
      }
      createAuditLog('curriculum.copied', { fromClass: copyFromClass, toClasses: copyToClasses, succeeded, failed });
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
      const results = await Promise.allSettled(tasks);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) {
        addToast({ type: 'success', title: `Assigned subject to ${succeeded} class(es)` });
      } else if (succeeded === 0) {
        addToast({ type: 'error', title: 'Bulk subject assignment failed' });
      } else {
        addToast({ type: 'info', title: `Assigned to ${succeeded} class(es), ${failed} failed` });
      }
      createAuditLog('bulk.assign', { subjectId: bulkSubjectId, teacherId: bulkTeacherId, targets: bulkTargetClasses, succeeded, failed });
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
      const results = await Promise.allSettled(affected.map(row => updateClassSubject(row.id, { teacherId: replaceToTeacherId } as any)));
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) {
        addToast({ type: 'success', title: `Replaced teacher in ${succeeded} assignment(s)` });
      } else if (succeeded === 0) {
        addToast({ type: 'error', title: 'Teacher replacement failed' });
      } else {
        addToast({ type: 'info', title: `Replaced teacher in ${succeeded} assignment(s), ${failed} failed` });
      }
      createAuditLog('teacher.replaced', { fromTeacherId: replaceFromTeacherId, toTeacherId: replaceToTeacherId, affected: affected.length, succeeded, failed });
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
      const results = await Promise.allSettled(affected.map(row => deleteClassSubject(row.id)));
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) {
        addToast({ type: 'success', title: `Removed ${succeeded} assignment(s)` });
      } else if (succeeded === 0) {
        addToast({ type: 'error', title: 'Bulk removal failed' });
      } else {
        addToast({ type: 'info', title: `Removed ${succeeded} assignment(s), ${failed} failed` });
      }
      createAuditLog('bulk.remove', { subjectId: bulkSubjectId, targets: bulkTargetClasses, succeeded, failed });
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
      createAuditLog('class-subject.created', { className, subjectId });
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to add subject to class' });
    }
  };

  // ── Teacher Upload / Import handlers ──────────────────────────────
  const importTeachersFromCsv = async () => {
    const parsed = parseTeacherCsv(teacherCsv);
    if (parsed.length === 0) {
      addToast({ type: 'error', title: 'No valid rows found in CSV' });
      return;
    }

    // Resolve subject names → IDs
    const subjectNameToId = new Map<string, string>();
    for (const subject of subjects) {
      subjectNameToId.set(subject.name.toLowerCase(), subject.id);
      if (subject.shortName) subjectNameToId.set(subject.shortName.toLowerCase(), subject.id);
    }

    const entries = parsed.map(entry => {
      const resolvedSubjectIds = entry.subjectNames
        .map(name => subjectNameToId.get(name.toLowerCase()))
        .filter((id): id is string => Boolean(id));

      return {
        name: entry.name,
        email: entry.email,
        password: entry.password,
        assignedClasses: entry.assignedClasses,
        assignedSubjects: resolvedSubjectIds,
        weeklyPeriods: entry.weeklyPeriods,
      };
    }).filter(entry => entry.assignedSubjects.length > 0 && entry.assignedClasses.length > 0);

    if (entries.length === 0) {
      addToast({ type: 'error', title: 'No valid entries — check subject names match existing subjects' });
      return;
    }

    setUploadingTeachers(true);
    try {
      const result = await bulkCreateTeachersWithAssignments(entries);
      setTeacherUploadResult({
        created: result.teachers.length,
        assignments: result.assignments.length,
        skipped: result.skippedTeachers,
        failedAssignments: result.skippedAssignments,
      });
      createAuditLog('bulk.assign', {
        action: 'teacher-bulk-upload',
        created: result.teachers.length,
        assignments: result.assignments.length,
      });
      addToast({
        type: result.teachers.length > 0 ? 'success' : 'info',
        title: `${result.teachers.length} teacher(s) created, ${result.assignments.length} assignment(s) made`,
      });
      setTeacherCsv('');
      setTeacherCsvMode(false);
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Teacher upload failed' });
    } finally {
      setUploadingTeachers(false);
    }
  };

  const addSingleTeacher = async () => {
    if (!inlineTeacherForm.name.trim() || !inlineTeacherForm.email.trim()) {
      addToast({ type: 'error', title: 'Name and email required' });
      return;
    }
    if (inlineTeacherForm.classes.length === 0 || inlineTeacherForm.subjects.length === 0) {
      addToast({ type: 'error', title: 'Select at least one class and subject' });
      return;
    }

    setUploadingTeachers(true);
    try {
      const result = await bulkCreateTeachersWithAssignments([{
        name: inlineTeacherForm.name.trim(),
        email: inlineTeacherForm.email.trim(),
        password: inlineTeacherForm.password || 'TempPass123!',
        assignedClasses: inlineTeacherForm.classes,
        assignedSubjects: inlineTeacherForm.subjects,
        weeklyPeriods: inlineTeacherForm.weeklyPeriods,
      }]);

      if (result.teachers.length > 0) {
        addToast({
          type: 'success',
          title: `${inlineTeacherForm.name} added with ${result.assignments.length} assignment(s)`,
        });
        setTeacherUploadResult({
          created: result.teachers.length,
          assignments: result.assignments.length,
          skipped: result.skippedTeachers,
          failedAssignments: result.skippedAssignments,
        });
        setShowInlineTeacherForm(false);
        setInlineTeacherForm({
          name: '',
          email: '',
          password: 'TempPass123!',
          classes: [],
          subjects: [],
          weeklyPeriods: 25,
        });
      } else if (result.skippedTeachers.length > 0) {
        addToast({ type: 'info', title: `Teacher already exists: ${result.skippedTeachers[0]}` });
      } else {
        addToast({ type: 'error', title: 'Failed to add teacher' });
      }
      await refresh();
    } catch (error) {
      console.error(error);
      addToast({ type: 'error', title: 'Failed to add teacher' });
    } finally {
      setUploadingTeachers(false);
    }
  };

  const downloadTeacherTemplate = () => {
    const blob = new Blob([TEACHER_UPLOAD_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'teachers_template.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
                {slideOver === 'analytics' && 'Workload Analytics'}
                {slideOver === 'teachers' && 'Upload & Manage Teachers'}
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
              <label className="block text-sm font-medium text-slate-700">Department
                <select value={subjectForm.department} onChange={event => setSubjectForm(prev => ({ ...prev, department: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2">
                  <option value="">No department</option>
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
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
          {slideOver === 'analytics' && (
            <div className="space-y-4">
              <WorkloadAnalytics subjects={subjects} mappings={mappings} teachers={teachers} />
            </div>
          )}

          {slideOver === 'teachers' && (
            <div className="space-y-6">
              {/* ── Result banner ── */}
              {teacherUploadResult && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-800">
                    ✅ {teacherUploadResult.created} teacher(s) created · {teacherUploadResult.assignments} assignment(s) made
                  </p>
                  {teacherUploadResult.skipped.length > 0 && (
                    <p className="mt-1 text-xs text-amber-700">Skipped: {teacherUploadResult.skipped.join(', ')}</p>
                  )}
                  {teacherUploadResult.failedAssignments.length > 0 && (
                    <p className="mt-1 text-xs text-red-600">Failed assignments: {teacherUploadResult.failedAssignments.join(', ')}</p>
                  )}
                  <button onClick={() => setTeacherUploadResult(null)} className="mt-2 text-xs font-semibold text-emerald-700 hover:underline">Dismiss</button>
                </div>
              )}

              {/* ── Action buttons ── */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => { setTeacherCsvMode(prev => !prev); setShowInlineTeacherForm(false); }}
                  className={cn('flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all', teacherCsvMode ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100')}
                >
                  <Upload size={16} /> CSV Upload
                </button>
                <button
                  onClick={() => { setShowInlineTeacherForm(prev => !prev); setTeacherCsvMode(false); }}
                  className={cn('flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all', showInlineTeacherForm ? 'bg-teal-600 text-white' : 'bg-teal-50 text-teal-700 hover:bg-teal-100')}
                >
                  <Plus size={16} /> Add Teacher
                </button>
              </div>

              <button
                onClick={downloadTeacherTemplate}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm font-semibold text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
              >
                <FileDown size={16} /> Download CSV Template
              </button>

              {/* ── CSV upload area ── */}
              {teacherCsvMode && (
                <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">
                    <strong>Format:</strong> Name, Email, Password, Classes (semicolon), Subjects (semicolon names), Weekly Periods
                  </p>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Example</p>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-600">{
`Mr. Abdirahman,abdirahman@school.edu,TempPass123!,Grade 7-A;Grade 7-B,Mathematics;Science,25
Ms. Nasra,nasra@school.edu,TempPass123!,Grade 9-A;Grade 10-A,English;Somali,20`
                    }</pre>
                  </div>
                  <textarea
                    value={teacherCsv}
                    onChange={event => setTeacherCsv(event.target.value)}
                    rows={8}
                    placeholder="Paste your teacher CSV data here…"
                    className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
                  />
                  <button
                    onClick={importTeachersFromCsv}
                    disabled={uploadingTeachers || !teacherCsv.trim()}
                    className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {uploadingTeachers ? 'Uploading…' : 'Upload Teachers & Assignments'}
                  </button>
                </div>
              )}

              {/* ── Inline single teacher form ── */}
              {showInlineTeacherForm && (
                <div className="space-y-3 rounded-2xl border border-slate-200 p-4">
                  <label className="block text-sm font-medium text-slate-700">Name
                    <input
                      value={inlineTeacherForm.name}
                      onChange={event => setInlineTeacherForm(prev => ({ ...prev, name: event.target.value }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                      placeholder="Mr. Abdirahman Ali"
                    />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">Email
                    <input
                      value={inlineTeacherForm.email}
                      onChange={event => setInlineTeacherForm(prev => ({ ...prev, email: event.target.value }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                      placeholder="teacher@school.edu"
                    />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">Password
                    <input
                      value={inlineTeacherForm.password}
                      onChange={event => setInlineTeacherForm(prev => ({ ...prev, password: event.target.value }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                      placeholder="TempPass123!"
                    />
                  </label>
                  <label className="block text-sm font-medium text-slate-700">Weekly Periods
                    <input
                      type="number"
                      min={1}
                      max={40}
                      value={inlineTeacherForm.weeklyPeriods}
                      onChange={event => setInlineTeacherForm(prev => ({ ...prev, weeklyPeriods: Number(event.target.value) }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                    />
                  </label>

                  {/* Classes multi-select */}
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-700">Classes</p>
                    <div className="max-h-32 overflow-auto rounded-xl border border-slate-200 p-2">
                      {CLASSES.map(className => (
                        <label key={className} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={inlineTeacherForm.classes.includes(className)}
                            onChange={event => {
                              const val = event.target.checked
                                ? [...inlineTeacherForm.classes, className]
                                : inlineTeacherForm.classes.filter(c => c !== className);
                              setInlineTeacherForm(prev => ({ ...prev, classes: val }));
                            }}
                          />
                          {className}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Subjects multi-select */}
                  <div>
                    <p className="mb-1 text-sm font-medium text-slate-700">Subjects</p>
                    <div className="max-h-32 overflow-auto rounded-xl border border-slate-200 p-2">
                      {subjects.map(subject => (
                        <label key={subject.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={inlineTeacherForm.subjects.includes(subject.id)}
                            onChange={event => {
                              const val = event.target.checked
                                ? [...inlineTeacherForm.subjects, subject.id]
                                : inlineTeacherForm.subjects.filter(id => id !== subject.id);
                              setInlineTeacherForm(prev => ({ ...prev, subjects: val }));
                            }}
                          />
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: subjectMeta[subject.id]?.color || '#94a3b8' }} />
                          {subject.name}
                        </label>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={addSingleTeacher}
                    disabled={uploadingTeachers}
                    className="w-full rounded-xl bg-teal-600 px-4 py-2.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {uploadingTeachers ? 'Creating…' : 'Add Teacher & Assign'}
                  </button>
                </div>
              )}

              {/* ── Teacher Overview Table ── */}
              <div>
                <h3 className="mb-3 text-sm font-bold text-slate-900">All Teachers & Workload</h3>
                {teachers.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    No teachers yet. Upload teachers above to get started.
                  </div>
                ) : (
                  <div className="overflow-auto rounded-2xl border border-slate-200">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Teacher</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Email</th>
                          <th className="px-3 py-2 text-center font-semibold text-slate-600">Classes</th>
                          <th className="px-3 py-2 text-center font-semibold text-slate-600">Subjects</th>
                          <th className="px-3 py-2 text-center font-semibold text-slate-600">Workload</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teachers.map(teacher => {
                          const workload = workloadByTeacher.get(teacher.id) || 0;
                          const assignedClasses = Array.from(new Set(
                            mappings.filter(m => m.teacherId === teacher.id).map(m => m.className),
                          ));
                          const assignedSubjectIds = Array.from(new Set(
                            mappings.filter(m => m.teacherId === teacher.id).map(m => m.subjectId),
                          ));
                          return (
                            <tr key={teacher.id} className="border-t border-slate-100">
                              <td className="px-3 py-2 font-medium text-slate-900">{teacher.name}</td>
                              <td className="px-3 py-2 text-slate-500">{teacher.email}</td>
                              <td className="px-3 py-2 text-center">
                                <div className="flex flex-wrap justify-center gap-1">
                                  {assignedClasses.slice(0, 3).map(cn => (
                                    <span key={cn} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">{cn}</span>
                                  ))}
                                  {assignedClasses.length > 3 && (
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">+{assignedClasses.length - 3}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <div className="flex flex-wrap justify-center gap-1">
                                  {assignedSubjectIds.slice(0, 3).map(sid => {
                                    const sub = subjectsById.get(sid);
                                    return sub ? (
                                      <span key={sid} className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: (subjectMeta[sid]?.color || '#94a3b8') + '20', color: subjectMeta[sid]?.color || '#475569' }}>{sub.shortName || sub.name}</span>
                                    ) : null;
                                  })}
                                  {assignedSubjectIds.length > 3 && (
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">+{assignedSubjectIds.length - 3}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className={cn(
                                  'rounded-full px-2 py-0.5 text-xs font-semibold',
                                  workload > TEACHER_WEEKLY_LIMIT ? 'bg-red-100 text-red-700' :
                                  workload >= 22 ? 'bg-amber-100 text-amber-700' :
                                  'bg-emerald-100 text-emerald-700'
                                )}>
                                  {workload}/{TEACHER_WEEKLY_LIMIT}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!showMoreMenu) return;
    const handler = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMoreMenu]);

  useEffect(() => {
    if (!showClassFilter) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && classFilterRef.current?.contains(target)) return;
      if (target && classFilterDropdownRef.current?.contains(target)) return;
      setShowClassFilter(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showClassFilter]);

  if (loading || (refreshing && !subjects.length)) {
    return (
      <div className="space-y-5">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="animate-pulse space-y-3">
            <div className="h-3 w-24 rounded-full bg-slate-200" />
            <div className="h-6 w-64 rounded-full bg-slate-200" />
            <div className="h-4 w-96 rounded-full bg-slate-200" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 h-10 w-10 rounded-2xl bg-slate-200" />
              <div className="mb-2 h-8 w-16 rounded-full bg-slate-200" />
              <div className="h-4 w-24 rounded-full bg-slate-200" />
            </div>
          ))}
        </div>
        <div className="grid animate-pulse gap-5 xl:grid-cols-[minmax(260px,20%)_1fr]">
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2"><div className="h-4 w-20 rounded-full bg-slate-200" /><div className="h-8 rounded-2xl bg-slate-100" /></div>
            ))}
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="h-6 w-48 rounded-full bg-slate-200" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError && !subjects.length) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 p-12 text-center">
        <p className="text-lg font-semibold text-red-800">Failed to load Academic Workspace</p>
        <p className="mt-1 text-sm text-red-600">Check your connection and try again.</p>
        <button onClick={() => { setLoadError(null); refresh(); }} className="mt-4 rounded-xl bg-red-600 px-5 py-2 font-semibold text-white hover:bg-red-700">Try Again</button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
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
            <div ref={moreMenuRef} className="relative xl:hidden">
              <button onClick={() => setShowMoreMenu(prev => !prev)} className="rounded-2xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"><MoreHorizontal className="h-4 w-4" /></button>
              {showMoreMenu && (
                <div className="absolute right-0 z-40 mt-2 w-48 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
                  <button onClick={() => { openYear(); setShowMoreMenu(false); }} className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50">New Year</button>
                  <button onClick={() => { openTerm(); setShowMoreMenu(false); }} className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50">New Term</button>
                  <button onClick={() => { setSlideOver('analytics'); setShowMoreMenu(false); }} className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><BarChart3 className="mr-2 inline h-4 w-4" />Analytics</button>
                  <button onClick={() => { setSlideOver('teachers'); setShowMoreMenu(false); }} className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-teal-700 hover:bg-teal-50"><Users className="mr-2 inline h-4 w-4" />Upload Teachers</button>
                  <button onClick={() => { refresh(); setShowMoreMenu(false); }} className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className={cn('mr-2 inline h-4 w-4', refreshing && 'animate-spin')} />Refresh</button>
                </div>
              )}
            </div>
            <div className="hidden xl:flex xl:items-center xl:gap-2">
              <button onClick={() => openYear()} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">New Year</button>
              <button onClick={() => openTerm()} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">New Term</button>
              <button onClick={() => setSlideOver('analytics')} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"><BarChart3 className="mr-1 inline h-4 w-4" />Analytics</button>
              <button onClick={() => setSlideOver('teachers')} className="rounded-2xl bg-teal-50 px-3 py-2 text-sm font-semibold text-teal-700 hover:bg-teal-100"><Users className="mr-1 inline h-4 w-4" />Teachers</button>
              <button onClick={refresh} className="rounded-2xl border border-slate-200 p-2 text-slate-500 hover:bg-slate-50"><RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <SummaryCard icon={Layers3} label="Classes Configured" value={`${summary.configuredClasses}/${CLASSES.length}`} />
        <SummaryCard icon={BookOpen} label="Subjects" value={summary.subjects} />
        <SummaryCard icon={UserCheck} label="Teachers Assigned" value={summary.teacherAssigned} />
        <SummaryCard icon={AlertTriangle} label="Missing Teachers" value={summary.missingTeachers} tone={summary.missingTeachers ? 'warn' : 'ok'} />
        <SummaryCard icon={CheckCircle2} label="Completion" value={`${summary.completion}%`} tone={summary.completion === 100 ? 'ok' : 'neutral'} />
        <div className="rounded-3xl border border-teal-200 bg-teal-50 p-4 text-teal-700">
          <button onClick={() => setSlideOver('teachers')} className="w-full text-left hover:opacity-80">
            <Upload className="mb-2 h-5 w-5" />
            <p className="text-sm font-semibold">Upload Teachers</p>
            <p className="text-xs">CSV bulk + periods</p>
          </button>
          <div className="mt-3 border-t border-teal-200 pt-3">
            <p className="text-xs text-teal-600">{teachers.length} teacher{teachers.length !== 1 ? 's' : ''} registered</p>
          </div>
        </div>
        <div className="rounded-3xl border border-indigo-200 bg-indigo-50 p-4 text-indigo-700">
          <button onClick={() => setSlideOver('bulk')} className="w-full text-left hover:opacity-80">
            <Settings2 className="mb-2 h-5 w-5" />
            <p className="text-sm font-semibold">Bulk Actions</p>
            <p className="text-xs">Copy, assign, replace</p>
          </button>
          <div className="mt-3 border-t border-indigo-200 pt-3">
            {!showPdfExport ? (
              <button
                onClick={() => setShowPdfExport(true)}
                className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
              >
                <FileText size={14} />
                Export PDF
              </button>
            ) : (
              <PDFDownloadLink document={<CurriculumPdfDocument subjects={subjects} mappings={mappings} teachers={teachers} currentTerm={currentTerm} currentYear={currentYear} />} fileName="curriculum-plan.pdf" className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50">
                <FileText size={14} />
                Export PDF
              </PDFDownloadLink>
            )}
          </div>
        </div>
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
            <div className="mb-2 flex flex-wrap gap-1">
              <button onClick={() => setDepartmentFilter('')} className={cn('rounded-lg px-2 py-0.5 text-[11px] font-semibold', departmentFilter === '' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:text-slate-600')}>All</button>
              {DEPARTMENTS.map(d => (
                <button key={d} onClick={() => setDepartmentFilter(d)} className={cn('rounded-lg px-2 py-0.5 text-[11px] font-semibold', departmentFilter === d ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:text-slate-600')}>{d}</button>
              ))}
            </div>
            {filteredSubjects.map(subject => {
              const meta = subjectMeta[subject.id] || {};
              return (
                <div key={subject.id} className="group flex items-center justify-between rounded-2xl px-2 py-2 hover:bg-slate-50">
                  <button onClick={() => { if (selectedClass) addSubjectToSelectedClass(subject.id); }} className="flex min-w-0 items-center gap-2 text-left">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: meta.color || SUBJECT_COLORS[0] }} />
                    <span className="truncate text-sm font-medium text-slate-700">{subject.name}</span>
                    {subject.department && <span className="truncate text-[10px] text-slate-400">{subject.department}</span>}
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
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pb-2">
            <div ref={classFilterDropdownRef} className="relative inline-block">
              <button ref={classFilterRef} onClick={() => setShowClassFilter(prev => !prev)} className="flex w-32 items-center gap-1 rounded-2xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                <CheckSquare className="h-4 w-4 shrink-0" />
                <span className="truncate">{filterClassList.length > 0 ? `${filterClassList.length} classes` : 'Classes'}</span>
              </button>
              {showClassFilter && (
                <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
                  <button onClick={() => { setFilterClassList([]); setShowClassFilter(false); }} className="w-full rounded-xl px-3 py-1.5 text-left text-sm font-semibold text-indigo-600 hover:bg-slate-50">Show all</button>
                  <div className="max-h-56 space-y-0.5 overflow-auto">
                    {CLASSES.map(className => (
                      <label key={className} className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-sm hover:bg-slate-50">
                        <input type="checkbox" checked={filterClassList.includes(className)} onChange={event => setFilterClassList(prev => event.target.checked ? [...prev, className] : prev.filter(c => c !== className))} className="rounded" />
                        {className}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2 overflow-x-auto">
            {filteredClasses.map(className => (
              <button key={className} onClick={() => setSelectedClass(className)} className={cn('shrink-0 rounded-2xl border px-4 py-2 text-sm font-semibold', selectedClass === className ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}>
                {className}
              </button>
            ))}
            </div>
          </div>

          {view === 'cards' && (
            <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-3">
              {subjects.map(subject => {
                const assigned = selectedClassMappings.some(row => row.subjectId === subject.id);
                const meta = subjectMeta[subject.id] || {};
                return (
                  <button key={subject.id} onClick={() => {
                    if (!assigned && selectedClass) addSubjectToSelectedClass(subject.id);
                  }} disabled={assigned} className={cn('flex items-center gap-1 rounded-xl border px-2.5 py-1 text-xs font-semibold', assigned ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600')}>
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.color || SUBJECT_COLORS[0] }} />
                    {assigned ? 'Added' : '+ Add'}
                    <span>{subject.shortName || subject.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          {view === 'cards' ? (
            <div className="space-y-6">
              {(filterClassList.length > 0 ? filteredClasses : selectedClass ? [selectedClass] : []).map(className => {
                const classMappings = mappings.filter(row => row.className === className);
                return (
                  <div key={className}>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-lg font-bold text-slate-900">{className}</h3>
                      <button onClick={() => { setCopyFromClass(className); setSlideOver('bulk'); }} className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"><Copy className="mr-1 inline h-4 w-4" />Copy Curriculum</button>
                    </div>
                    {classMappings.length === 0 ? (
                      <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500">No subjects assigned to {className}.</div>
                    ) : (
                      <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                        {classMappings.map(row => {
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
                );
              })}
            </div>
          ) : (
            <MatrixView classes={filteredClasses} subjects={subjects} mappingLookup={mappingLookup} teachers={teachers} teachersById={teachersById} onTeacherChange={updateMappingTeacher} onCreateMapping={createMatrixMapping} onFocusClass={setSelectedClass} />
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

function MatrixView({ classes, subjects, mappingLookup, teachers, teachersById, onTeacherChange, onCreateMapping, onFocusClass }: {
  classes: string[];
  subjects: Subject[];
  mappingLookup: Map<string, any>;
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
                const row = mappingLookup.get(`${className}::${subject.id}`);
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
