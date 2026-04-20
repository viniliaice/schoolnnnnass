import { useState, useEffect, useCallback, useMemo } from 'react';
import { Listbox } from '@headlessui/react';
import { useRole } from '../../context/RoleContext';
import { getClasses, getExamCount, getExamsPaginated, getStudentsByClasses, getStudentsByIds, getUserById, getUsersByRole, updateExamStatus, updateExam, deleteExam, approveAllPendingExams, approvePendingExamsForClasses } from '../../lib/database';
import { Exam, ExamStatus, Student, User, EXAM_TYPES, MONTHS, CLASSES } from '../../types';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { CheckCircle, XCircle, Clock, FileText } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ExamVerification() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<User[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [statusCounts, setStatusCounts] = useState({ all: 0, pending: 0, approved: 0, rejected: 0 });
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [classFilterValue, setClassFilterValue] = useState<string[]>([]); // empty = All
  const [supervisorClasses, setSupervisorClasses] = useState<string[] | null>(null);
  const [subjectFilterValue, setSubjectFilterValue] = useState<string>('All');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(60);
  const pageOptions = [10, 20, 60, 100];
  const [studentSort, setStudentSort] = useState<'none' | 'asc' | 'desc'>('none');
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  // Editing state for admins
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState<number | ''>('');
  const [editMonth, setEditMonth] = useState<string>('');
  const [editType, setEditType] = useState<string>('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const [teachersData, classData] = await Promise.all([
      getUsersByRole('teacher'),
      getClasses(),
    ]);
    setTeachers(teachersData);
    setClasses(classData);

    let effectiveClasses = classFilterValue.length === 0 ? classData : classFilterValue;
    if (session?.role === 'supervisor') {
      const supervisor = await getUserById(session.userId);
      const assignedClasses = supervisor?.assignedClasses || [];
      setSupervisorClasses(assignedClasses.length > 0 ? assignedClasses : []);
      if (assignedClasses.length > 0) {
        effectiveClasses = assignedClasses;
      } else {
        setExams([]);
        setStudents([]);
        setTotalItems(0);
        setStatusCounts({ all: 0, pending: 0, approved: 0, rejected: 0 });
        setSelectedIds({});
        return;
      }
    } else {
      setSupervisorClasses(null);
    }

    const selectedStudentIds = (classFilterValue.length > 0 || session?.role === 'supervisor')
      ? (await getStudentsByClasses(effectiveClasses, undefined, 1000)).map(s => s.id)
      : [];

    const examPage = await getExamsPaginated(
      page,
      pageSize,
      statusFilter,
      selectedStudentIds.length > 0 ? selectedStudentIds : undefined,
      subjectFilterValue,
      search
    );

    const studentIds = examPage.exams.map(e => e.studentId);
    const currentStudents = studentIds.length > 0 ? await getStudentsByIds(studentIds) : [];

    const [allCount, pendingCount, approvedCount, rejectedCount] = await Promise.all([
      getExamCount('all', selectedStudentIds.length > 0 ? selectedStudentIds : undefined, subjectFilterValue, search),
      getExamCount('pending', selectedStudentIds.length > 0 ? selectedStudentIds : undefined, subjectFilterValue, search),
      getExamCount('approved', selectedStudentIds.length > 0 ? selectedStudentIds : undefined, subjectFilterValue, search),
      getExamCount('rejected', selectedStudentIds.length > 0 ? selectedStudentIds : undefined, subjectFilterValue, search),
    ]);

    setExams(examPage.exams);
    setStudents(currentStudents);
    setTotalItems(examPage.total);
    setStatusCounts({ all: allCount, pending: pendingCount, approved: approvedCount, rejected: rejectedCount });
    setSelectedIds({});
  }, [session, classFilterValue, page, pageSize, statusFilter, subjectFilterValue, search]);

  useEffect(() => { refresh(); }, [refresh]);
  // Reset page when filters or pageSize change
  useEffect(() => { setPage(1); }, [statusFilter, classFilterValue, subjectFilterValue, pageSize, search]);

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

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  // Clamp page
  if (page > totalPages) setPage(1);

  // Use the canonical class list so classes without students still appear
  const classOptions = classes.length > 0 ? classes.slice().sort() : CLASSES.slice().sort();
  const subjects = useMemo(() => Array.from(new Set(exams.map(e => e.subject))).filter(Boolean).sort(), [exams]);

  const tabs = useMemo(() => [
    { label: 'All', value: 'all', count: statusCounts.all },
    { label: 'Pending', value: 'pending', count: statusCounts.pending },
    { label: 'Approved', value: 'approved', count: statusCounts.approved },
    { label: 'Rejected', value: 'rejected', count: statusCounts.rejected },
  ], [statusCounts]);

  const handleAction = async (id: string, status: ExamStatus) => {
    try {
      await updateExamStatus(id, status);
      addToast({ type: 'success', title: `Exam ${status}` });
      await refresh();
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
      await refresh();
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to update selected exams' });
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const map: Record<string, boolean> = {};
      for (const e of paged) map[e.id] = true;
      setSelectedIds(map);
    } else {
      setSelectedIds({});
    }
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
      await refresh();
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
      await refresh();
      cancelEdit();
    } catch (err) {
      console.error(err);
      addToast({ type: 'error', title: 'Failed to update exam' });
    }
    setEditSubmitting(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exam Verification Center</h1>
        <p className="text-slate-500 mt-1">Review and approve/reject exam submissions</p>
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative w-64">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search student, subject, teacher..."
            className="w-full pl-3 pr-3 py-2 rounded-xl border border-slate-200 text-sm outline-none" />
        </div>
        <div>
          <Listbox value={classFilterValue} onChange={(v:any)=>{
            if (Array.isArray(v)) setClassFilterValue(v as string[]);
            else setClassFilterValue(v ? [v] : []);
          }} multiple>
            <div className="relative">
              <Listbox.Button className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white w-48 text-left">
                {classFilterValue.length === 0 ? 'All classes' : classFilterValue.join(', ')}
              </Listbox.Button>
              <Listbox.Options className="absolute z-20 mt-2 w-48 max-h-56 overflow-auto bg-white border border-slate-200 rounded-xl p-2 shadow">
                <Listbox.Option value={[]} key="__all" className={({active})=>`px-3 py-2 rounded-lg text-sm cursor-pointer ${active?'bg-slate-50':''}`}>
                  {() => (
                    <div className="flex items-center gap-3">
                      <input type="checkbox" readOnly checked={classFilterValue.length===0} className="w-4 h-4" />
                      <span className={cn(classFilterValue.length===0 ? 'font-semibold' : 'text-slate-700')}>All Classes</span>
                    </div>
                  )}
                </Listbox.Option>
                {(supervisorClasses ?? classOptions).map(cls => (
                  <Listbox.Option key={cls} value={cls} className={({ active }) => `px-3 py-2 rounded-lg text-sm cursor-pointer ${active ? 'bg-slate-50' : ''}`}>
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
          <Listbox value={subjectFilterValue} onChange={(v:any)=> setSubjectFilterValue(v || 'All')}>
            <div className="relative">
              <Listbox.Button className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white w-48 text-left">
                {subjectFilterValue === 'All' ? 'All subjects' : subjectFilterValue}
              </Listbox.Button>
              <Listbox.Options className="absolute z-20 mt-2 w-48 max-h-56 overflow-auto bg-white border border-slate-200 rounded-xl p-2 shadow">
                <Listbox.Option value={'All'} key="__all_sub" className={({active})=>`px-3 py-2 rounded-lg text-sm cursor-pointer ${active?'bg-slate-50':''}`}>
                  {() => <div className="text-slate-700">All subjects</div>}
                </Listbox.Option>
                {subjects.map(s => (
                  <Listbox.Option key={s} value={s} className={({ active }) => `px-3 py-2 rounded-lg text-sm cursor-pointer ${active ? 'bg-slate-50' : ''}`}>
                    {({ selected }) => (
                      <div className={cn(selected ? 'font-semibold' : 'text-slate-700')}>{s}</div>
                    )}
                  </Listbox.Option>
                ))}
              </Listbox.Options>
            </div>
          </Listbox>
        </div>
        <button onClick={async () => {
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
            await refresh();
          } catch (err) {
            addToast({ type: 'error', title: 'Failed to approve all pending exams' });
          }
        }}
          className="ml-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
          Approve All Pending
        </button>
        {Object.values(selectedIds).some(Boolean) && (
          <div className="flex gap-2">
            <button onClick={() => handleBulkAction('approved')}
              className="ml-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
              Approve Selected
            </button>
            <button onClick={() => handleBulkAction('rejected')}
              className="ml-2 px-3 py-2 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700">
              Reject Selected
            </button>
          </div>
        )}

      </div>

        <div className="flex gap-2 flex-wrap items-center">
        {tabs.map(tab => (
          <button key={tab.value} onClick={() => setStatusFilter(tab.value as any)}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              statusFilter === tab.value
                ? (tab.value === 'pending' ? 'bg-amber-100 text-amber-700' : tab.value === 'approved' ? 'bg-emerald-100 text-emerald-700' : tab.value === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700') + ' ring-2 ring-offset-1 ring-slate-200'
                : 'bg-white text-slate-500 border border-slate-200'
            )}>
            {tab.label} ({tab.count})
          </button>
        ))}
          <div className="ml-auto flex items-center gap-2">
            <label className="text-sm text-slate-500">Show</label>
            <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-sm">
              {pageOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} className="p-1 rounded-md bg-slate-50"><ChevronLeft className="w-4 h-4" /></button>
              <div className="text-sm text-slate-600">Page {page} / {totalPages}</div>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="p-1 rounded-md bg-slate-50"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">
                      <input type="checkbox" checked={paged.length > 0 && paged.every(e => selectedIds[e.id])} onChange={e => toggleSelectAll(e.target.checked)} />
                    </th>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">
                      <button onClick={() => setStudentSort(s => s === 'none' ? 'asc' : s === 'asc' ? 'desc' : 'none')} className="flex items-center gap-2">
                        <span>Student</span>
                        {studentSort === 'asc' ? <span className="text-xs">▲</span> : studentSort === 'desc' ? <span className="text-xs">▼</span> : null}
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
              {paged.map(exam => {
                const student = getStudent(exam.studentId);
                const teacher = getTeacher(exam.teacherId);
                return (
                  <tr key={exam.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3">
                      <input type="checkbox" checked={!!selectedIds[exam.id]} onChange={() => toggleSelect(exam.id)} />
                    </td>
                    <td className="px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{student?.name || '—'}</p>
                        <p className="text-xs text-slate-400">{student?.className}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{exam.subject}</td>
                    <td className="px-5 py-3">
                      {editingExamId === exam.id ? (
                        <select value={editType} onChange={e => setEditType(e.target.value)}
                          className="px-2 py-1 rounded-md text-sm border border-slate-200 bg-white">
                          {EXAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium">{exam.examType}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">
                      {editingExamId === exam.id ? (
                        <select value={editMonth} onChange={e => setEditMonth(e.target.value)}
                          className="px-2 py-1 rounded-md text-sm border border-slate-200 bg-white">
                          {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : (
                        exam.month
                      )}
                    </td>
                    <td className="px-5 py-3 text-center font-bold text-sm text-slate-800">
                      {editingExamId === exam.id ? (
                        <input type="number" value={editScore as any} onChange={e => setEditScore(e.target.value === '' ? '' : Number(e.target.value))}
                          className="w-20 text-center px-2 py-1 rounded-md border border-slate-200" />
                      ) : (
                        `${exam.score}/${exam.total}`
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{teacher?.name || '—'}</td>
                    <td className="px-5 py-3 text-center">
                      <span className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold",
                        exam.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                        exam.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      )}>
                        {exam.status === 'approved' ? <CheckCircle className="w-3 h-3" /> : exam.status === 'rejected' ? <XCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                        {exam.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {editingExamId === exam.id ? (
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => saveEdit(exam.id)} disabled={editSubmitting}
                            className="px-3 py-1 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
                            Save
                          </button>
                          <button onClick={cancelEdit} disabled={editSubmitting}
                            className="px-3 py-1 rounded-xl bg-slate-100 text-slate-700 text-sm font-medium hover:bg-slate-200">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1.5">
                          {exam.status === 'pending' && (
                            <>
                              <button onClick={() => handleAction(exam.id, 'approved')}
                                className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 transition-colors" title="Approve">
                                <CheckCircle className="w-4 h-4" />
                              </button>
                              <button onClick={() => handleAction(exam.id, 'rejected')}
                                className="p-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors" title="Reject">
                                <XCircle className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {session?.role === 'admin' && (
                            <button onClick={() => startEdit(exam)}
                              className="px-2 py-1 text-xs rounded-lg bg-slate-50 text-slate-700 hover:bg-slate-100">
                              Edit
                            </button>
                          )}
                          {session?.role === 'admin' && (
                            <button onClick={() => handleDelete(exam.id)}
                              className="px-2 py-1 text-xs rounded-lg bg-red-50 text-red-600 hover:bg-red-100">
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {paged.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No exams to review</p>
          </div>
        )}
        {totalItems > pageSize && (
          <div className="p-4 flex items-center justify-end gap-2">
            <div className="text-sm text-slate-500">Showing {(page-1)*pageSize+1}–{Math.min(page*pageSize, totalItems)} of {totalItems}</div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 py-1 rounded-md bg-slate-50">Prev</button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="px-3 py-1 rounded-md bg-slate-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
