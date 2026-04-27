import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Listbox } from '@headlessui/react';
import { useRole } from '../../context/RoleContext';
import {
  getClasses,
  getExamStatusCounts,
  getExamSubjectsByClasses,
  getExamsPaginated,
  getStudentsByClasses,
  getUserById,
  getUsersByRole,
  updateExamStatus,
  updateExam,
  deleteExam,
  approveAllPendingExams,
  approvePendingExamsForClasses,
} from '../../lib/database';
import { Exam, ExamStatus, Student, User, EXAM_TYPES, MONTHS, CLASSES } from '../../types';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { CheckCircle, XCircle, Clock, FileText } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Skeleton } from '../../components/ui/Skeleton';

const DEFAULT_PAGE_SIZE = 150;
const STUDENT_FETCH_LIMIT = 1000;

export function ExamVerification() {
  const { session } = useRole();
  const { addToast } = useToast();
  const queryClient = useQueryClient();

  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [classFilterValue, setClassFilterValue] = useState<string[]>([]);
  const [subjectFilterValue, setSubjectFilterValue] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [studentSort, setStudentSort] = useState<'none' | 'asc' | 'desc'>('none');
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState<number | ''>('');
  const [editMonth, setEditMonth] = useState<string>('');
  const [editType, setEditType] = useState<string>('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const supervisorQuery = useQuery<User | null, Error>({
    queryKey: ['supervisorUser', session?.userId],
    queryFn: async () => {
      if (!session?.userId) return null;
      return getUserById(session.userId);
    },
    enabled: session?.role === 'supervisor' && !!session?.userId,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const classesQuery = useQuery<string[], Error>({
    queryKey: ['examVerification', 'classes'],
    queryFn: getClasses,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const sortedClassFilter = useMemo(() => [...classFilterValue].sort(), [classFilterValue]);

  const studentsQuery = useQuery<Student[], Error>({
    queryKey: ['examVerification', 'students', ...sortedClassFilter],
    queryFn: () => getStudentsByClasses(sortedClassFilter, undefined, STUDENT_FETCH_LIMIT),
    enabled: sortedClassFilter.length > 0,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const students = studentsQuery.data ?? [];
  const studentIds = useMemo(() => [...students.map(s => s.id)].sort(), [students]);

  const subjectsQuery = useQuery<string[], Error>({
    queryKey: ['examVerification', 'subjects', ...sortedClassFilter],
    queryFn: () => getExamSubjectsByClasses(sortedClassFilter),
    enabled: sortedClassFilter.length > 0,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    retry: false,
  });

const subjects = subjectsQuery.data || [];

const subjectOptions = ['All', ...subjects];

  const examsQuery = useQuery<{ exams: Exam[]; total: number }, Error>({
    queryKey: ['examVerification', 'exams', page, pageSize, statusFilter, subjectFilterValue, search, ...studentIds],
    queryFn: () => getExamsPaginated(page, pageSize, statusFilter, studentIds, subjectFilterValue, search),
    enabled: studentIds.length > 0 && subjectFilterValue !== '',
    staleTime: 1000 * 60 * 2,
    keepPreviousData: true,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const statusCountsQuery = useQuery<{
    all: number;
    pending: number;
    approved: number;
    rejected: number;
  }, Error>({
    queryKey: ['examVerification', 'statusCounts', subjectFilterValue, search, ...studentIds],
    queryFn: () => getExamStatusCounts(studentIds, undefined, subjectFilterValue, search),
    enabled: studentIds.length > 0 && subjectFilterValue !== '',
    staleTime: 1000 * 60 * 3,
    refetchOnWindowFocus: false,
    retry: false,
  });

const teachersQuery = useQuery<User[], Error>({
  queryKey: ['examVerification', 'teachers'],
  queryFn: () => getUsersByRole('teacher'),
  enabled: examsQuery.isSuccess && examsQuery.data?.exams.length > 0,

});

  const classes = classesQuery.data ?? [];
  const classOptions = supervisorQuery.data?.assignedClasses ?? (classes.length > 0 ? classes.slice().sort() : CLASSES.slice().sort());

  const exams = examsQuery.data?.exams ?? [];
  const totalItems = examsQuery.data?.total ?? 0;
  const statusCounts = statusCountsQuery.data ?? { all: 0, pending: 0, approved: 0, rejected: 0 };
  const teachers = teachersQuery.data ?? [];

  const isLoadingStudents = studentsQuery.isLoading && sortedClassFilter.length > 0;
  const isLoadingExams = examsQuery.isLoading;

  useEffect(() => {
    setSubjectFilterValue('');
    setPage(1);
  }, [sortedClassFilter.join('|')]);

  useEffect(() => {
    if (page !== 1) {
      setPage(1);
    }
  }, [statusFilter, pageSize, search, page]);

  useEffect(() => {
    if (Object.keys(selectedIds).length > 0) {
      setSelectedIds({});
    }
  }, [exams]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, pageSize, totalItems]);

  const getStudent = (studentId: string) => students.find(s => s.id === studentId);
  const getTeacher = (teacherId: string) => teachers.find(t => t.id === teacherId);

  const paged = useMemo(() => {
    const rows = [...exams];
    if (studentSort === 'none') return rows;
    rows.sort((a, b) => {
      const an = (getStudent(a.studentId)?.name || '').toLowerCase();
      const bn = (getStudent(b.studentId)?.name || '').toLowerCase();
      if (an === bn) return 0;
      return studentSort === 'asc' ? (an < bn ? -1 : 1) : (an > bn ? -1 : 1);
    });
    return rows;
  }, [exams, studentSort, students]);

  const tabs = useMemo(
    () => [
      { label: 'All', value: 'all', count: statusCounts.all },
      { label: 'Pending', value: 'pending', count: statusCounts.pending },
      { label: 'Approved', value: 'approved', count: statusCounts.approved },
      { label: 'Rejected', value: 'rejected', count: statusCounts.rejected },
    ],
    [statusCounts]
  );

  const handleAction = async (id: string, status: ExamStatus) => {
    try {
      await updateExamStatus(id, status);
      addToast({ type: 'success', title: `Exam ${status}` });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'exams'] });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'statusCounts'] });
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to update exam status' });
    }
  };

  const handleBulkAction = async (status: ExamStatus) => {
    const ids = Object.keys(selectedIds).filter(id => selectedIds[id]);
    if (ids.length === 0) {
      addToast({ type: 'error', title: 'No exams selected' });
      return;
    }
    try {
      await Promise.all(ids.map(id => updateExamStatus(id, status)));
      addToast({ type: 'success', title: `${status} ${ids.length} exams` });
      setSelectedIds({});
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'exams'] });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'statusCounts'] });
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to update selected exams' });
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const map: Record<string, boolean> = {};
      for (const e of paged) map[e.id] = true;
      setSelectedIds(map);
      return;
    }
    setSelectedIds({});
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this exam entry? This cannot be undone.')) return;
    try {
      const ok = await deleteExam(id);
      if (!ok) throw new Error('Delete failed');
      addToast({ type: 'success', title: 'Exam deleted' });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'exams'] });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'statusCounts'] });
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to delete exam' });
    }
  };

  const startEdit = (exam: Exam) => {
    setEditingExamId(exam.id);
    setEditScore(typeof exam.score === 'number' ? exam.score : Number(exam.score) || '');
    setEditMonth(exam.month || '');
    setEditType(exam.examType || '');
  };

  const cancelEdit = () => {
    setEditingExamId(null);
    setEditScore('');
    setEditMonth('');
    setEditType('');
  };

  const saveEdit = async (examId: string) => {
    if (editScore === '' || isNaN(Number(editScore))) {
      addToast({ type: 'error', title: 'Enter a valid score' });
      return;
    }
    setEditSubmitting(true);
    try {
      const payload: Partial<Exam> = {
        score: Number(editScore),
        month: editMonth,
        examType: editType as any,
      };
      const updated = await updateExam(examId, payload);
      if (!updated) throw new Error('Update failed');
      addToast({ type: 'success', title: 'Exam updated' });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'exams'] });
      queryClient.invalidateQueries({ queryKey: ['examVerification', 'statusCounts'] });
      cancelEdit();
    } catch (err) {
      console.error(err);
      addToast({ type: 'error', title: 'Failed to update exam' });
    }
    setEditSubmitting(false);
  };

  const skeletonRows = Array.from({ length: 6 });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exam Verification Center</h1>
        <p className="text-slate-500 mt-1">Review and approve/reject exam submissions</p>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative w-64">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            disabled={!subjectFilterValue}
            placeholder={subjectFilterValue ? 'Search exam subjects or students...' : 'Select a subject first'}
            className={cn(
              'w-full pl-3 pr-3 py-2 rounded-xl border text-sm outline-none',
              !subjectFilterValue ? 'bg-slate-50 text-slate-400 border-slate-200' : 'bg-white border-slate-200'
            )}
          />
        </div>

        <div>
          <Listbox
            value={classFilterValue}
            onChange={(v: any) => {
              if (Array.isArray(v)) setClassFilterValue(v as string[]);
              else setClassFilterValue(v ? [v] : []);
            }}
            multiple
          >
            <div className="relative">
              <Listbox.Button className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white w-48 text-left">
                {classFilterValue.length === 0 ? 'Select classes' : classFilterValue.join(', ')}
              </Listbox.Button>
              <Listbox.Options className="absolute z-20 mt-2 w-48 max-h-56 overflow-auto bg-white border border-slate-200 rounded-xl p-2 shadow">
                <Listbox.Option
                  value={[]}
                  key="__all"
                  className={({ active }) => `px-3 py-2 rounded-lg text-sm cursor-pointer ${active ? 'bg-slate-50' : ''}`}
                >
                  {() => (
                    <div className="flex items-center gap-3">
                      <input type="checkbox" readOnly checked={classFilterValue.length === 0} className="w-4 h-4" />
                      <span className={cn(classFilterValue.length === 0 ? 'font-semibold' : 'text-slate-700')}>All Classes</span>
                    </div>
                  )}
                </Listbox.Option>
                {(supervisorQuery.data?.assignedClasses ?? classOptions).map(cls => (
                  <Listbox.Option
                    key={cls}
                    value={cls}
                    className={({ active }) => `px-3 py-2 rounded-lg text-sm cursor-pointer ${active ? 'bg-slate-50' : ''}`}
                  >
                    {({ selected }) => (
                      <div className="flex items-center gap-3">
                        <input type="checkbox" readOnly checked={classFilterValue.includes(cls)} className="w-4 h-4" />
                        <span className={cn(selected ? 'font-semibold' : 'text-slate-700')}>{cls}</span>
                      </div>
                    )}
                  </Listbox.Option>
                ))}
              </Listbox.Options>
            </div>
          </Listbox>
        </div>

        <div>
          <Listbox
            value={subjectFilterValue}
            onChange={(v: any) => setSubjectFilterValue(v || '')}
            disabled={sortedClassFilter.length === 0 || subjectsQuery.isLoading || subjectOptions.length === 0}
          >
            <div className="relative">
              <Listbox.Button
                disabled={sortedClassFilter.length === 0 || subjectsQuery.isLoading || subjectOptions.length === 0}
                className={cn(
                  'px-3 py-2 rounded-xl border text-sm w-48 text-left',
                  sortedClassFilter.length === 0 || subjectsQuery.isLoading || subjectOptions.length === 0
                    ? 'bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed'
                    : 'bg-white border-slate-200'
                )}
              >
                {subjectFilterValue || (subjectsQuery.isLoading ? 'Loading subjects...' : 'Select a subject')}
              </Listbox.Button>
              <Listbox.Options className="absolute z-20 mt-2 w-48 max-h-56 overflow-auto bg-white border border-slate-200 rounded-xl p-2 shadow">
                {subjectOptions.length === 0 && !subjectsQuery.isLoading ? (
                  <div className="px-3 py-2 text-sm text-slate-500">No subjects found for selected classes</div>
                ) : (
                  subjectOptions.map(subject => (
                    <Listbox.Option
                      key={subject}
                      value={subject}
                      className={({ active }) => `px-3 py-2 rounded-lg text-sm cursor-pointer ${active ? 'bg-slate-50' : ''}`}
                    >
                      {({ selected }) => (
                        <span className={cn(selected ? 'font-semibold' : 'text-slate-700')}>{subject}</span>
                      )}
                    </Listbox.Option>
                  ))
                )}
              </Listbox.Options>
            </div>
          </Listbox>
        </div>

        <button
          onClick={async () => {
            try {
              let res = null;
              if (session?.role === 'supervisor') {
                const supervisor = await getUserById(session.userId);
                const assigned = supervisor?.assignedClasses || [];
                res = await approvePendingExamsForClasses(assigned);
              } else {
                res = await approveAllPendingExams();
              }
              addToast({ type: 'success', title: `Approved ${res?.length || 0} pending exams` });
              queryClient.invalidateQueries({ queryKey: ['examVerification', 'exams'] });
              queryClient.invalidateQueries({ queryKey: ['examVerification', 'statusCounts'] });
            } catch (err) {
              addToast({ type: 'error', title: 'Failed to approve all pending exams' });
            }
          }}
          className="ml-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
        >
          Approve All Pending
        </button>

        {Object.values(selectedIds).some(Boolean) && (
          <div className="flex gap-2">
            <button
              onClick={() => handleBulkAction('approved')}
              className="ml-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
            >
              Approve Selected
            </button>
            <button
              onClick={() => handleBulkAction('rejected')}
              className="ml-2 px-3 py-2 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700"
            >
              Reject Selected
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden min-h-[320px]">
        <div className="p-8">
          {sortedClassFilter.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-lg font-medium text-slate-900">Select a class to begin</p>
              <p className="mt-2 text-sm text-slate-500">Choose one or more classes to load students and unlock the exam selector.</p>
            </div>
          ) : !subjectFilterValue ? (
            <div className="space-y-4">
              {isLoadingStudents ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <Skeleton className="h-4 w-24 rounded" />
                      <Skeleton className="h-4 w-full rounded" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  {students.length > 0 ? (
                    <>
                      <p className="text-lg font-medium text-slate-900">{students.length} students loaded</p>
                      <p className="mt-2 text-sm text-slate-500">Select a subject to fetch exam submissions for these students.</p>
                    </>
                  ) : (
                    <>
                      <p className="text-lg font-medium text-slate-900">No students found</p>
                      <p className="mt-2 text-sm text-slate-500">Try a different class selection.</p>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex gap-2 flex-wrap items-center mb-6">
                <div className="flex gap-2 flex-wrap">
                  {tabs.map(tab => (
                    <button
                      key={tab.value}
                      onClick={() => setStatusFilter(tab.value as any)}
                      className={cn(
                        'px-4 py-2 rounded-xl text-sm font-medium transition-all',
                        statusFilter === tab.value
                          ? (tab.value === 'pending'
                              ? 'bg-amber-100 text-amber-700'
                              : tab.value === 'approved'
                              ? 'bg-emerald-100 text-emerald-700'
                              : tab.value === 'rejected'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-indigo-100 text-indigo-700') + ' ring-2 ring-offset-1 ring-slate-200'
                          : 'bg-white text-slate-500 border border-slate-200'
                      )}
                    >
                      {tab.label} ({tab.count})
                    </button>
                  ))}
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <label className="text-sm text-slate-500">Show</label>
                  <select
                    value={pageSize}
                    onChange={e => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-sm"
                  >
                    {[10, 20, 60, 100,150,200].map(o => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} className="p-1 rounded-md bg-slate-50">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <div className="text-sm text-slate-600">Page {page} / {Math.max(1, Math.ceil(totalItems / pageSize))}</div>
                    <button onClick={() => setPage(p => Math.min(Math.max(1, Math.ceil(totalItems / pageSize)), p + 1))} className="p-1 rounded-md bg-slate-50">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">
                        <input
                          type="checkbox"
                          checked={paged.length > 0 && paged.every(e => selectedIds[e.id])}
                          onChange={e => toggleSelectAll(e.target.checked)}
                        />
                      </th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">
                        <button
                          onClick={() => setStudentSort(s => (s === 'none' ? 'asc' : s === 'asc' ? 'desc' : 'none'))}
                          className="flex items-center gap-2"
                        >
                          <span>Student</span>
                          {studentSort === 'asc' ? <span className="text-xs">?</span> : studentSort === 'desc' ? <span className="text-xs">?</span> : null}
                        </button>
                      </th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Type</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Month</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Score</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Teacher</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                      <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(isLoadingExams || (subjectFilterValue !== '' && examsQuery.isFetching && !examsQuery.data)) ? (
                      skeletonRows.map((_, index) => (
                        <tr key={index} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-4"><Skeleton className="h-4 w-4 rounded" /></td>
                          <td className="px-5 py-4 space-y-2">
                            <Skeleton className="h-4 w-32 rounded" />
                            <Skeleton className="h-3 w-24 rounded" />
                          </td>
                          <td className="px-5 py-4"><Skeleton className="h-4 w-20 rounded" /></td>
                          <td className="px-5 py-4"><Skeleton className="h-4 w-24 rounded" /></td>
                          <td className="px-5 py-4"><Skeleton className="h-4 w-20 rounded" /></td>
                          <td className="px-5 py-4 text-center"><Skeleton className="h-4 w-16 rounded mx-auto" /></td>
                          <td className="px-5 py-4"><Skeleton className="h-4 w-28 rounded" /></td>
                          <td className="px-5 py-4 text-center"><Skeleton className="h-4 w-20 rounded mx-auto" /></td>
                          <td className="px-5 py-4 text-center"><Skeleton className="h-8 w-24 rounded mx-auto" /></td>
                        </tr>
                      ))
                    ) : paged.length > 0 ? (
                      paged.map(exam => {
                        const student = getStudent(exam.studentId);
                        const teacher = getTeacher(exam.teacherId);
                        console.log('exam.teacherId:', exam.teacherId);
  console.log('teacher IDs:', teachers.map(t => t.id)); 
  console.log('matched teacher:', teacher);
                        return (
                          <tr key={exam.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-5 py-3">
                              <input type="checkbox" checked={!!selectedIds[exam.id]} onChange={() => toggleSelect(exam.id)} />
                            </td>
                            <td className="px-5 py-3">
                              <div>
                                <p className="text-sm font-medium text-slate-800">{student?.name || '�'}</p>
                                <p className="text-xs text-slate-400">{student?.className}</p>
                              </div>
                            </td>
                            <td className="px-5 py-3 text-sm text-slate-600">{exam.subject}</td>
                            <td className="px-5 py-3">
                              {editingExamId === exam.id ? (
                                <select
                                  value={editType}
                                  onChange={e => setEditType(e.target.value)}
                                  className="px-2 py-1 rounded-md text-sm border border-slate-200 bg-white"
                                >
                                  {EXAM_TYPES.map(t => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">{exam.examType}</span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-sm text-slate-600">
                              {editingExamId === exam.id ? (
                                <select
                                  value={editMonth}
                                  onChange={e => setEditMonth(e.target.value)}
                                  className="px-2 py-1 rounded-md text-sm border border-slate-200 bg-white"
                                >
                                  {MONTHS.map(m => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                exam.month
                              )}
                            </td>
                            <td className="px-5 py-3 text-center font-bold text-sm text-slate-800">
                              {editingExamId === exam.id ? (
                                <input
                                  type="number"
                                  value={editScore as any}
                                  onChange={e => setEditScore(e.target.value === '' ? '' : Number(e.target.value))}
                                  className="w-20 text-center px-2 py-1 rounded-md border border-slate-200"
                                />
                              ) : (
                                `${exam.score}/${exam.total}`
                              )}
                            </td>
                            <td className="px-5 py-3 text-sm text-slate-600">{teacher?.name || '�'}</td>
                            <td className="px-5 py-3 text-center">
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold',
                                  exam.status === 'approved'
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : exam.status === 'rejected'
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-700'
                                )}
                              >
                                {exam.status === 'approved' ? (
                                  <CheckCircle className="w-3 h-3" />
                                ) : exam.status === 'rejected' ? (
                                  <XCircle className="w-3 h-3" />
                                ) : (
                                  <Clock className="w-3 h-3" />
                                )}
                                {exam.status}
                              </span>
                            </td>
                            <td className="px-5 py-3 text-center">
                              {editingExamId === exam.id ? (
                                <div className="flex items-center justify-center gap-2">
                                  <button
                                    onClick={() => saveEdit(exam.id)}
                                    disabled={editSubmitting}
                                    className="px-3 py-1 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={cancelEdit}
                                    disabled={editSubmitting}
                                    className="px-3 py-1 rounded-xl bg-slate-100 text-slate-700 text-sm font-medium hover:bg-slate-200"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center justify-center gap-1.5">
                                  {exam.status === 'pending' && (
                                    <>
                                      <button
                                        onClick={() => handleAction(exam.id, 'approved')}
                                        className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 transition-colors"
                                        title="Approve"
                                      >
                                        <CheckCircle className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => handleAction(exam.id, 'rejected')}
                                        className="p-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                                        title="Reject"
                                      >
                                        <XCircle className="w-4 h-4" />
                                      </button>
                                    </>
                                  )}
                                  {session?.role === 'admin' && (
                                    <button
                                      onClick={() => startEdit(exam)}
                                      className="px-2 py-1 text-xs rounded-lg bg-slate-50 text-slate-700 hover:bg-slate-100"
                                    >
                                      Edit
                                    </button>
                                  )}
                                  {session?.role === 'admin' && (
                                    <button
                                      onClick={() => handleDelete(exam.id)}
                                      className="px-2 py-1 text-xs rounded-lg bg-red-50 text-red-600 hover:bg-red-100"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={9} className="text-center py-12 text-slate-400">
                          <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
                          <p className="font-medium">No exams to review</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {totalItems > pageSize && (
                <div className="p-4 flex items-center justify-end gap-2">
                  <div className="text-sm text-slate-500">
                    Showing {(page - 1) * pageSize + 1}�{Math.min(page * pageSize, totalItems)} of {totalItems}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 py-1 rounded-md bg-slate-50">Prev</button>
                    <button onClick={() => setPage(p => Math.min(Math.max(1, Math.ceil(totalItems / pageSize)), p + 1))} className="px-3 py-1 rounded-md bg-slate-50">Next</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}