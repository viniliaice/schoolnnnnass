import { useState, useEffect, useCallback } from 'react';
import { Listbox } from '@headlessui/react';
import { getStudentsPaginated, getStudentsByClasses, createStudent, updateStudent, deleteStudent, getStudentById } from '../../lib/db/students';
import { getUserById, getUsersByRole } from '../../lib/db/profiles';
import { getExamsByStudent } from '../../lib/db/exams';
import { getCurrentTerm } from '../../lib/db/academic';
import { getReportCommentsForStudentTerm as getReportCommentsForStudentTermDirect } from '../../lib/db/reports';
import { Student, User, CLASSES, Exam } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { ExamReport } from '../reports/ExamReport';
import { DataTable } from '../../components/ui/DataTable';
import { Plus, Trash2, Edit, GraduationCap, Search, MessageCircle, Loader2, UserCheck } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ColumnDef } from '@tanstack/react-table';
import { buildParentCredentialWhatsAppLink } from '../../lib/whatsapp';

export function ManageStudents() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // ── Lazy parent loading ──
  // Parents are NOT loaded on page init. They load on-demand per student.
  const [parentMap, setParentMap] = useState<Map<string, User>>(new Map());
  const [loadingParentIds, setLoadingParentIds] = useState<Set<string>>(new Set());

  // ── Parent search (only loaded when create/edit form opens) ──
  const [searchParents, setSearchParents] = useState<User[]>([]);
  const [searchParentsLoaded, setSearchParentsLoaded] = useState(false);

  const [classFilter, setClassFilter] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<Student | null>(null);
  const [showExamDialog, setShowExamDialog] = useState(false);
  const [examStudentId, setExamStudentId] = useState<string | null>(null);
  const [examEntries, setExamEntries] = useState<Exam[]>([]);
  const [examLoading, setExamLoading] = useState(false);
  const [examReportComments, setExamReportComments] = useState<Record<string, string>>({});

  // ── Exam entries dialog ──
  useEffect(() => {
    if (!showExamDialog || !examStudentId) return;
    let mounted = true;
    const loadExams = async () => {
      setExamLoading(true);
      try {
        const exams = await getExamsByStudent(examStudentId);
        if (!mounted) return;
        setExamEntries(exams || []);
        const term = await getCurrentTerm();
        if (term) {
          const comments = await getReportCommentsForStudentTermDirect(examStudentId, term.id);
          const map: Record<string, string> = {};
          for (const c of comments) {
            if (c.examId && c.teacherComment) map[c.examId] = c.teacherComment;
          }
          if (!mounted) return;
          setExamReportComments(map);
        } else {
          setExamReportComments({});
        }
      } catch (err) {
        setExamEntries([]);
        setExamReportComments({});
      } finally {
        if (mounted) setExamLoading(false);
      }
    };
    loadExams();
    return () => { mounted = false; };
  }, [showExamDialog, examStudentId]);

  const [formName, setFormName] = useState('');
  const [formClass, setFormClass] = useState(CLASSES[0]);
  const [formParent, setFormParent] = useState('');
  const [parentSearch, setParentSearch] = useState('');
  const [parentFocused, setParentFocused] = useState(false);

  const STUDENTS_PER_PAGE = 50;

  // ── Load a single parent on demand ──
  const loadParent = useCallback(async (parentId: string) => {
    if (!parentId || parentMap.has(parentId) || loadingParentIds.has(parentId)) return;
    setLoadingParentIds(prev => { const next = new Set(prev); next.add(parentId); return next; });
    try {
      const parent = await getUserById(parentId);
      if (parent) {
        setParentMap(prev => { const next = new Map(prev); next.set(parentId, parent); return next; });
      }
    } catch (err) {
      console.warn('Failed to load parent:', err);
    } finally {
      setLoadingParentIds(prev => { const next = new Set(prev); next.delete(parentId); return next; });
    }
  }, [parentMap, loadingParentIds]);

  // ── Load all parents for search (only when form opens) ──
  const ensureParentsForSearch = useCallback(async () => {
    if (searchParentsLoaded) return;
    try {
      const parents = await getUsersByRole('parent');
      setSearchParents(parents || []);
      setSearchParentsLoaded(true);
    } catch (err) {
      console.warn('Failed to load parents for search:', err);
    }
  }, [searchParentsLoaded]);

  // ── Refresh students only (NO parent bulk fetch) ──
  const refresh = async (page: number = currentPage, searchTerm?: string) => {
    setLoading(true);
    setError(null);
    try {
      const term = searchTerm || search || '';
      if (classFilter.length > 0) {
        const studentsData = await getStudentsByClasses(classFilter, term);
        setStudents(studentsData);
        setTotalStudents(studentsData.length);
        // Clear old parent cache since students changed
        setParentMap(new Map());
        setLoadingParentIds(new Set());
        return;
      }

      const studentsData = await getStudentsPaginated(page, STUDENTS_PER_PAGE, term);
      setStudents(studentsData.students);
      setTotalStudents(studentsData.total);
      // Clear old parent cache since students changed
      setParentMap(new Map());
      setLoadingParentIds(new Set());
    } catch (err) {
      console.error('Failed to load students:', err);
      setError('Failed to load students. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [currentPage]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setCurrentPage(1); refresh(1, debouncedSearch); }, [debouncedSearch]);

  useEffect(() => { setCurrentPage(1); refresh(1, debouncedSearch); }, [classFilter]);

  const handlePageChange = (page: number) => { setCurrentPage(page); };

  const filteredParents = searchParents.filter(p =>
    p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
    p.email.toLowerCase().includes(parentSearch.toLowerCase())
  );

  const filtered = students.filter(s => classFilter.length === 0 || classFilter.includes(s.className));

  function handleSendWhatsApp(parent: User) {
    const phone = parent.phone1 || parent.phone2;
    if (!phone || !parent.email || !parent.password) {
      addToast({ type: 'error', title: 'Parent must have phone, email and password' });
      return;
    }
    const url = buildParentCredentialWhatsAppLink({ phone, email: parent.email, password: parent.password });
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const columns: ColumnDef<Student>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => {
        const student = row.original;
        return (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs">
              {student.name.split(' ').map(n => n[0]).join('')}
            </div>
            <span className="font-medium text-gray-900">{student.name}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'className',
      header: 'Class',
      cell: ({ row }) => {
        const className = row.getValue('className') as string;
        return (
          <span className="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-xs font-semibold">
            {className}
          </span>
        );
      },
    },
    {
      id: 'parent',
      header: 'Parent',
      cell: ({ row }) => {
        const student = row.original;
        const parent = student.parentId ? parentMap.get(student.parentId) : undefined;
        const isLoading = loadingParentIds.has(student.parentId || '');

        // Parent info already loaded — show it with WhatsApp button
        if (parent) {
          return (
            <div className="space-y-1">
              <span className="text-sm text-gray-900 font-medium">{parent.name} — {parent.phone1 || parent.phone2 || 'No phone'}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSendWhatsApp(parent)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  Send WhatsApp
                </button>
                {parent.email && <span className="text-xs text-gray-500">{parent.email}</span>}
              </div>
            </div>
          );
        }

        // No parent assigned
        if (!student.parentId) {
          return <span className="text-sm text-gray-400 italic">Unassigned</span>;
        }

        // Currently loading
        if (isLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading parent…
            </div>
          );
        }

        // Not yet loaded — show button to fetch
        return (
          <button
            onClick={() => loadParent(student.parentId!)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
          >
            <UserCheck className="w-3.5 h-3.5" />
            View Parent & WhatsApp
          </button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => {
        const student = row.original;
        return (
          <div className="flex items-center gap-2">
            <button onClick={() => { setExamStudentId(student.id); setShowExamDialog(true); }} title="View Exam Entry" className="p-1 text-slate-500 hover:text-slate-700">
              <Search className="w-4 h-4" />
            </button>
            <button onClick={() => openEdit(student)} className="p-1 text-blue-400 hover:text-blue-600">
              <Edit className="w-4 h-4" />
            </button>
            <button onClick={() => handleDelete(student)} className="p-1 text-red-400 hover:text-red-600">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      },
    },
  ];

  const resetForm = () => { setFormName(''); setFormClass(CLASSES[0]); setFormParent(''); setParentSearch(''); };

  const handleCreate = async () => {
    if (!formName.trim()) { addToast({ type: 'error', title: 'Student name is required' }); return; }
    try {
      await createStudent({ name: formName, className: formClass, parentId: formParent || null });
      addToast({ type: 'success', title: 'Student added successfully' });
      resetForm(); setShowCreate(false); await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to add student' });
    }
  };

  const openEdit = async (s: Student) => {
    setFormName(s.name);
    setFormClass(s.className);
    setFormParent(s.parentId || '');
    // Lazy-load parent name for display
    if (s.parentId && !parentMap.has(s.parentId)) {
      loadParent(s.parentId);
    }
    const parent = s.parentId ? parentMap.get(s.parentId) : undefined;
    setParentSearch(parent ? parent.name : '');
    // Load parents for search dropdown
    ensureParentsForSearch();
    setShowEdit(s);
  };

  const handleEdit = async () => {
    if (!showEdit) return;
    if (!formName.trim()) { addToast({ type: 'error', title: 'Student name is required' }); return; }
    try {
      await updateStudent(showEdit.id, { name: formName, className: formClass, parentId: formParent || null });
      addToast({ type: 'success', title: 'Student updated successfully' });
      setShowEdit(null); resetForm(); await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to update student' });
    }
  };

  const handleDelete = async (s: Student) => {
    if (!confirm(`Delete ${s.name}?`)) return;
    try {
      await deleteStudent(s.id);
      addToast({ type: 'success', title: `${s.name} deleted` });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to delete student' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manage Students</h1>
          <p className="text-slate-500 mt-1">Add students, assign classes and parents</p>
        </div>
        <button onClick={() => { resetForm(); ensureParentsForSearch(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all">
          <Plus className="w-4 h-4" /> Add Student
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative">
          <Listbox value={classFilter} onChange={(v: any) => {
            if (Array.isArray(v)) { setClassFilter(v); } else { setClassFilter(v ? [v] : []); }
          }} multiple>
            <Listbox.Button className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 min-w-[180px]">
              <span className="truncate">{classFilter.length === 0 ? 'All Classes' : `${classFilter.length} selected`}</span>
            </Listbox.Button>
            <Listbox.Options className="absolute z-30 mt-1 w-56 max-h-60 overflow-auto bg-white border border-slate-200 rounded-xl shadow-lg">
              <Listbox.Option value={[]} className="px-4 py-2 text-sm text-indigo-600 font-semibold cursor-pointer hover:bg-slate-50">
                Show all classes
              </Listbox.Option>
              {CLASSES.map(c => (
                <Listbox.Option key={c} value={c} className={({ active }) => cn('px-4 py-2 text-sm cursor-pointer', active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700')}>
                  {c}
                </Listbox.Option>
              ))}
            </Listbox.Options>
          </Listbox>
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search students…"
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
          <span className="ml-3 text-slate-500">Loading students…</span>
        </div>
      ) : (
        <DataTable columns={columns} data={filtered} />
      )}

      {/* Pagination */}
      {!loading && totalStudents > STUDENTS_PER_PAGE && classFilter.length === 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Page {currentPage} of {Math.ceil(totalStudents / STUDENTS_PER_PAGE)} ({totalStudents} students)
          </p>
          <div className="flex gap-2">
            <button disabled={currentPage <= 1} onClick={() => handlePageChange(currentPage - 1)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 disabled:opacity-50 hover:bg-slate-50">
              Previous
            </button>
            <button disabled={currentPage >= Math.ceil(totalStudents / STUDENTS_PER_PAGE)} onClick={() => handlePageChange(currentPage + 1)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 disabled:opacity-50 hover:bg-slate-50">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onClose={() => { setShowCreate(false); resetForm(); }} title="Add Student">
        <div className="space-y-4">
          <input placeholder="Student Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Class</label>
            <select value={formClass} onChange={e => setFormClass(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white">
              {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Assign Parent</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Search parents by name or email..."
                value={parentSearch}
                onChange={e => setParentSearch(e.target.value)}
                onFocus={() => { setParentFocused(true); ensureParentsForSearch(); }}
                onBlur={() => setTimeout(() => setParentFocused(false), 150)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
              />
              {parentSearch && parentFocused && (
                <div className="mt-2 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  <button onClick={() => { setFormParent(''); setParentSearch(''); }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-500 hover:bg-slate-50">
                    — No parent —
                  </button>
                  {filteredParents.map(p => (
                    <button key={p.id} onClick={() => { setFormParent(p.id); setParentSearch(p.name); }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50">
                      <div className="font-medium text-slate-800">{p.name}</div>
                      <div className="text-xs text-slate-500">{p.email}</div>
                    </button>
                  ))}
                  {filteredParents.length === 0 && parentSearch && (
                    <div className="px-4 py-2 text-sm text-slate-500">No parents found</div>
                  )}
                </div>
              )}
            </div>
          </div>
          <button onClick={handleCreate}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 transition-colors">
            Add Student
          </button>
        </div>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!showEdit} onClose={() => { setShowEdit(null); resetForm(); }} title="Edit Student">
        <div className="space-y-4">
          <input placeholder="Student Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Class</label>
            <select value={formClass} onChange={e => setFormClass(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white">
              {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Assign Parent</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Search parents by name or email..."
                value={parentSearch}
                onChange={e => setParentSearch(e.target.value)}
                onFocus={() => { setParentFocused(true); ensureParentsForSearch(); }}
                onBlur={() => setTimeout(() => setParentFocused(false), 150)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
              />
              {parentSearch && parentFocused && (
                <div className="mt-2 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  <button onClick={() => { setFormParent(''); setParentSearch(''); }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-500 hover:bg-slate-50">
                    — No parent —
                  </button>
                  {filteredParents.map(p => (
                    <button key={p.id} onClick={() => { setFormParent(p.id); setParentSearch(p.name); }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50">
                      <div className="font-medium text-slate-800">{p.name}</div>
                      <div className="text-xs text-slate-500">{p.email}</div>
                    </button>
                  ))}
                  {filteredParents.length === 0 && parentSearch && (
                    <div className="px-4 py-2 text-sm text-slate-500">No parents found</div>
                  )}
                </div>
              )}
            </div>
          </div>
          <button onClick={handleEdit}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 transition-colors">
            Save Changes
          </button>
        </div>
      </Dialog>

      {/* Exam Entry Dialog */}
      <Dialog open={showExamDialog} onClose={() => { setShowExamDialog(false); setExamStudentId(null); setExamEntries([]); setExamReportComments({}); }} title="Exam Entries">
        <div className="w-full h-[70vh] overflow-auto">
          <ExamEntriesDialogContent
            studentId={examStudentId}
            entries={examEntries}
            loading={examLoading}
            reportComments={examReportComments}
          />
        </div>
      </Dialog>
    </div>
  );
}

function ExamEntriesDialogContent({ studentId, entries, loading, reportComments }: { studentId: string | null; entries: Exam[]; loading: boolean; reportComments: Record<string, string> }) {
  const [studentName, setStudentName] = useState<string>('');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!studentId) return;
      try {
        const s = await getStudentById(studentId);
        if (!mounted) return;
        setStudentName(s?.name || 'Student');
      } catch (err) {
        // ignore
      }
    };
    load();
    return () => { mounted = false; };
  }, [studentId]);

  const rows = entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">{studentName} — Exam Entries</h3>
        <p className="text-sm text-slate-500">Showing individual exam records for the selected student</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200">
        {loading ? (
          <div className="p-6 text-center text-slate-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No exam entries found for this student</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Type</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Month</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Score</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">%</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Teacher Comment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(e => {
                  const pct = e.score != null && e.entryState !== 'absent' && e.entryState !== 'not_applicable' && e.total > 0 ? Math.round((e.score / e.total) * 100) : null;
                  return (
                    <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 text-sm text-slate-700">{e.subject}</td>
                      <td className="px-5 py-3 text-sm text-slate-600">{e.examType}</td>
                      <td className="px-5 py-3 text-sm text-slate-600">{e.month}</td>
                      <td className="px-5 py-3 text-center font-bold text-sm text-slate-800">{e.entryState === 'absent' ? 'Absent' : e.entryState === 'not_applicable' ? 'N/A' : `${e.score}/${e.total}`}</td>
                      <td className="px-5 py-3 text-center">{pct == null ? <span className="text-sm text-slate-400">Excluded</span> : <span className={cn('text-sm font-bold', pct >= 80 ? 'text-emerald-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600')}>{pct}%</span>}</td>
                      <td className="px-5 py-3 text-sm text-slate-600">{e.status}</td>
                      <td className="px-5 py-3 text-sm text-slate-600">{reportComments[e.id] || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
