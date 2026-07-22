import { useState, useEffect, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById } from '../../lib/db/profiles';
import { getClasses, getClassSubjectsForTeacher } from '../../lib/db/classes';
import { getStudentsByClass } from '../../lib/db/students';
import { getSubjects } from '../../lib/db/subjects';
import { createHomeworkBatch, getHomeworkByClass, updateHomework, deleteHomework, deleteHomeworkByTitle, homeworkExists } from '../../lib/db/homework';
import { Student, Subject } from '../../types';
import { useToast } from '../../context/ToastContext';
import { BookOpen, CheckCircle, ChevronRight, Users, Trash2, Pencil, X, Plus } from 'lucide-react';
import { cn } from '../../utils/cn';

type Tab = 'view' | 'new';
type Step = 'config' | 'students';

interface StudentRow {
  studentId: string;
  studentName: string;
  dueDate: string;
  note: string;
  included: boolean;
}

interface ExistingHomework {
  id: string;
  title: string;
  subject: string;
  dueDate: string;
  studentName: string;
}

export function AssignHomework() {
  const { session } = useRole();
  const { addToast } = useToast();

  const [tab, setTab] = useState<Tab>('new');
  const [step, setStep] = useState<Step>('config');

  // Config
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [individualDates, setIndividualDates] = useState(false);

  // Students
  const [students, setStudents] = useState<StudentRow[]>([]);

  // View tab
  const [existingHomework, setExistingHomework] = useState<ExistingHomework[]>([]);
  const [viewClass, setViewClass] = useState('');

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    const loadClasses = async () => {
      if (session.role === 'teacher' || session.role === 'supervisor') {
        const me = await getUserById(session.userId);
        const cls = (me?.assignedClasses || []) as string[];
        setClasses(cls);
        if (cls.length > 0) { setSelectedClass(cls[0]); setViewClass(cls[0]); }
      } else {
        const all = await getClasses();
        setClasses(all);
        if (all.length > 0) { setSelectedClass(all[0]); setViewClass(all[0]); }
      }
    };
    loadClasses();
  }, [session]);

  useEffect(() => {
    if (!session || !selectedClass) return;
    const loadSubjects = async () => {
      if (session.role === 'admin') {
        const all = await getSubjects();
        setSubjects(all);
        if (all.length > 0) setSelectedSubject(all[0].id);
      } else {
        const subs = await getClassSubjectsForTeacher(session.userId, selectedClass);
        setSubjects(subs);
        if (subs.length > 0) setSelectedSubject(subs[0].id);
      }
    };
    loadSubjects();
  }, [session, selectedClass]);

  const loadStudentsForClass = useCallback(async () => {
    if (!selectedClass) return;
    const list = await getStudentsByClass(selectedClass);
    setStudents(
      list.map((s: Student) => ({
        studentId: s.id,
        studentName: s.name,
        dueDate,
        note: '',
        included: true,
      }))
    );
  }, [selectedClass, dueDate]);

  const goToStudents = async () => {
    if (!title.trim()) {
      addToast({ type: 'error', title: 'Title is required' });
      return;
    }
    if (!dueDate) {
      addToast({ type: 'error', title: 'Due date is required' });
      return;
    }
    const exists = await homeworkExists(selectedClass, title, subjects.find(s => s.id === selectedSubject)?.name || '');
    if (exists) {
      addToast({ type: 'error', title: 'A homework with this title already exists for this class and subject' });
      return;
    }
    await loadStudentsForClass();
    setStep('students');
  };

  const toggleIncluded = (studentId: string) => {
    setStudents(prev => prev.map(s => s.studentId === studentId ? { ...s, included: !s.included } : s));
  };

  const updateStudentDueDate = (studentId: string, date: string) => {
    setStudents(prev => prev.map(s => s.studentId === studentId ? { ...s, dueDate: date } : s));
  };

  const updateStudentNote = (studentId: string, note: string) => {
    setStudents(prev => prev.map(s => s.studentId === studentId ? { ...s, note } : s));
  };

  const setAllDueDates = (date: string) => {
    setStudents(prev => prev.map(s => ({ ...s, dueDate: date })));
  };

  const handleAssign = async () => {
    if (!session) return;
    const included = students.filter(s => s.included);
    if (included.length === 0) {
      addToast({ type: 'error', title: 'No students selected' });
      return;
    }
    setSaving(true);
    try {
      await createHomeworkBatch(
        included.map(s => ({
          studentId: s.studentId,
          className: selectedClass,
          subject: subjects.find(x => x.id === selectedSubject)?.name || '',
          title: title.trim(),
          description: description.trim() || undefined,
          dueDate: s.dueDate,
          teacherId: session.userId,
        }))
      );
      addToast({ type: 'success', title: `Homework assigned to ${included.length} student(s)` });
      setTitle('');
      setDescription('');
      setStep('config');
    } catch {
      addToast({ type: 'error', title: 'Failed to assign homework' });
    } finally {
      setSaving(false);
    }
  };

  // View tab
  const loadExistingHomework = useCallback(async () => {
    if (!viewClass) return;
    const records = await getHomeworkByClass(viewClass);
    // Deduplicate by title+subject for display
    const seen = new Set<string>();
    const uniq: ExistingHomework[] = [];
    for (const r of records) {
      const key = `${r.title}|${r.subject}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push({ id: r.id, title: r.title, subject: r.subject, dueDate: r.dueDate, studentName: r.studentId });
      }
    }
    setExistingHomework(uniq);
  }, [viewClass]);

  useEffect(() => {
    if (tab === 'view' && viewClass) loadExistingHomework();
  }, [tab, viewClass, loadExistingHomework]);

  const handleDelete = async (title: string) => {
    try {
      await deleteHomework(title);
      addToast({ type: 'success', title: 'Homework deleted' });
      loadExistingHomework();
    } catch {
      addToast({ type: 'error', title: 'Failed to delete homework' });
    }
  };

  const handleDeleteByTitle = async (title: string) => {
    try {
      await deleteHomeworkByTitle(viewClass, title);
      addToast({ type: 'success', title: 'Homework deleted' });
      loadExistingHomework();
    } catch {
      addToast({ type: 'error', title: 'Failed to delete homework' });
    }
  };

  const subjectName = subjects.find(s => s.id === selectedSubject)?.name || '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Assign Homework</h1>
        <p className="text-slate-500 mt-1">Create and manage homework assignments for your classes</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setTab('new')}
          className={cn("px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
            tab === 'new' ? 'bg-white text-indigo-600 border border-b-0 border-slate-200 -mb-[3px]' : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <Plus className="w-4 h-4 inline mr-1" />
          New Assignment
        </button>
        <button
          onClick={() => setTab('view')}
          className={cn("px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
            tab === 'view' ? 'bg-white text-indigo-600 border border-b-0 border-slate-200 -mb-[3px]' : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <BookOpen className="w-4 h-4 inline mr-1" />
          View Assignments
        </button>
      </div>

      {tab === 'new' && (
        <>
          {/* Step indicator */}
          <div className="flex items-center gap-2">
            {[
              { key: 'config' as Step, label: 'Configure', icon: BookOpen },
              { key: 'students' as Step, label: 'Students', icon: Users },
            ].map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
                <button
                  onClick={() => s.key === 'config' && setStep('config')}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                    step === s.key
                      ? 'bg-indigo-100 text-indigo-700 ring-2 ring-offset-1 ring-indigo-200'
                      : 'bg-white text-slate-400 border border-slate-200'
                  )}
                >
                  <s.icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{s.label}</span>
                </button>
              </div>
            ))}
          </div>

          {step === 'config' && (
            <div className="max-w-3xl">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
                <h2 className="text-lg font-bold text-slate-800">Assignment Details</h2>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Class</label>
                  <select
                    value={selectedClass}
                    onChange={e => setSelectedClass(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {classes.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Subject</label>
                  <select
                    value={selectedSubject}
                    onChange={e => setSelectedSubject(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Title *</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g., Chapter 5 Exercises"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Optional details about the assignment..."
                    rows={3}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none"
                  />
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Due Date *</label>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={e => setDueDate(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      id="individualDates"
                      checked={individualDates}
                      onChange={e => setIndividualDates(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    <label htmlFor="individualDates" className="text-sm text-slate-600">Individual dates per student</label>
                  </div>
                </div>

                <button
                  onClick={goToStudents}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'students' && (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-slate-800">
                    {title} — {subjectName}
                  </h2>
                  {individualDates && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">Set all due dates:</span>
                      <input
                        type="date"
                        onChange={e => e.target.value && setAllDueDates(e.target.value)}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                      />
                    </div>
                  )}
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-4 py-3 font-medium text-slate-600 w-8">
                        <input
                          type="checkbox"
                          checked={students.every(s => s.included)}
                          onChange={e => setStudents(prev => prev.map(s => ({ ...s, included: e.target.checked })))}
                          className="rounded border-slate-300"
                        />
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Student</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">
                        Due Date {!individualDates && <span className="text-xs text-slate-400">(class default)</span>}
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-slate-600">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map(row => (
                      <tr key={row.studentId} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={() => toggleIncluded(row.studentId)}
                            className="rounded border-slate-300"
                          />
                        </td>
                        <td className={cn("px-4 py-2.5", row.included ? 'text-slate-900' : 'text-slate-400 line-through')}>
                          {row.studentName}
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="date"
                            value={row.included ? row.dueDate : ''}
                            onChange={e => updateStudentDueDate(row.studentId, e.target.value)}
                            disabled={!row.included}
                            className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="text"
                            value={row.included ? row.note : ''}
                            onChange={e => updateStudentNote(row.studentId, e.target.value)}
                            disabled={!row.included}
                            placeholder="Optional..."
                            className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep('config')}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50"
                >
                  Back
                </button>
                <button
                  onClick={handleAssign}
                  disabled={saving}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                >
                  <CheckCircle className="w-4 h-4" />
                  {saving ? 'Assigning...' : `Assign to ${students.filter(s => s.included).length} student(s)`}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'view' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <label className="text-sm font-semibold text-slate-700 mb-2 block">Select Class</label>
            <select
              value={viewClass}
              onChange={e => setViewClass(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {classes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {existingHomework.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
              <BookOpen className="w-8 h-8 mx-auto text-slate-300 mb-2" />
              <p className="text-slate-500">No homework assigned yet for this class.</p>
            </div>
          )}

          {existingHomework.map(hw => (
            <div key={hw.title + hw.subject} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-slate-900">{hw.title}</h3>
                <p className="text-xs text-slate-500">{hw.subject} • Due {hw.dueDate}</p>
              </div>
              <button
                onClick={() => handleDeleteByTitle(hw.title)}
                className="p-2 rounded-lg text-red-500 hover:bg-red-50 transition-colors"
                title="Delete assignment"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
