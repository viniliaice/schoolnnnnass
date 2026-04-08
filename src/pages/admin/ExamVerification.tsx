import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getExams, updateExamStatus, updateExam, getStudentById, getUserById, getStudents, getStudentsByClasses, getUsersByRole, approveAllPendingExams, approvePendingExamsForClasses } from '../../lib/database';
import { Exam, ExamStatus, Student, User, EXAM_TYPES, MONTHS } from '../../types';
import { useToast } from '../../context/ToastContext';
import { CheckCircle, XCircle, Clock, FileText } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ExamVerification() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<User[]>([]);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [classFilterValue, setClassFilterValue] = useState<string>('All');
  const [subjectFilterValue, setSubjectFilterValue] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  // Editing state for admins
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState<number | ''>('');
  const [editMonth, setEditMonth] = useState<string>('');
  const [editType, setEditType] = useState<string>('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const refresh = async () => {
    const [allExams, studentsData, teachersData] = await Promise.all([
      getExams(),
      getStudents(),
      getUsersByRole('teacher')
    ]);

    let examsData = allExams;

    if (session?.role === 'supervisor') {
      const supervisor = await getUserById(session.userId);
      const assignedClasses = supervisor?.assignedClasses || [];
      if (assignedClasses.length > 0) {
        const supervisedStudents = await getStudentsByClasses(assignedClasses);
        const supervisedIds = new Set(supervisedStudents.map(s => s.id));
        examsData = allExams.filter(exam => supervisedIds.has(exam.studentId));
      } else {
        examsData = [];
      }
    }

    setExams(examsData);
    setStudents(studentsData);
    setTeachers(teachersData);
    setSelectedIds({});
  };

  useEffect(() => { refresh(); }, []);

  const getStudent = (studentId: string) => students.find(s => s.id === studentId);
  const getTeacher = (teacherId: string) => teachers.find(t => t.id === teacherId);

  const filtered = exams
    .filter(e => statusFilter === 'all' || e.status === statusFilter)
    .filter(e => classFilterValue === 'All' || getStudent(e.studentId)?.className === classFilterValue)
    .filter(e => subjectFilterValue === 'All' || e.subject === subjectFilterValue)
    .filter(e => {
      if (!search.trim()) return true;
      const s = search.toLowerCase();
      const student = getStudent(e.studentId);
      const teacher = getTeacher(e.teacherId);
      return (
        (student?.name || '').toLowerCase().includes(s) ||
        (e.subject || '').toLowerCase().includes(s) ||
        (teacher?.name || '').toLowerCase().includes(s)
      );
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const classes = Array.from(new Set(students.map(s => s.className))).filter(Boolean).sort();
  const subjects = Array.from(new Set(exams.map(e => e.subject))).filter(Boolean).sort();

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
      for (const e of filtered) map[e.id] = true;
      setSelectedIds(map);
    } else {
      setSelectedIds({});
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
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

  const tabs: { label: string; value: ExamStatus | 'all'; count: number }[] = [
    { label: 'All', value: 'all', count: exams.length },
    { label: 'Pending', value: 'pending', count: exams.filter(e => e.status === 'pending').length },
    { label: 'Approved', value: 'approved', count: exams.filter(e => e.status === 'approved').length },
    { label: 'Rejected', value: 'rejected', count: exams.filter(e => e.status === 'rejected').length },
  ];

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
          <select value={classFilterValue} onChange={e => setClassFilterValue(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
            <option value="All">All classes</option>
            {classes.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <select value={subjectFilterValue} onChange={e => setSubjectFilterValue(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
            <option value="All">All subjects</option>
            {subjects.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
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

      <div className="flex gap-2 flex-wrap">
        {tabs.map(tab => (
          <button key={tab.value} onClick={() => setStatusFilter(tab.value)}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              statusFilter === tab.value
                ? (tab.value === 'pending' ? 'bg-amber-100 text-amber-700' : tab.value === 'approved' ? 'bg-emerald-100 text-emerald-700' : tab.value === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700') + ' ring-2 ring-offset-1 ring-slate-200'
                : 'bg-white text-slate-500 border border-slate-200'
            )}>
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">
                    <input type="checkbox" checked={filtered.length > 0 && filtered.every(e => selectedIds[e.id])} onChange={e => toggleSelectAll(e.target.checked)} />
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
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
              {filtered.map(exam => {
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
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No exams to review</p>
          </div>
        )}
      </div>
    </div>
  );
}
