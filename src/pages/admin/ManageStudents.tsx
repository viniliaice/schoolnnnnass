import { useState, useEffect } from 'react';
import { getStudentsPaginated, getUsersByRole, createStudent, updateStudent, deleteStudent } from '../../lib/database';
import { Student, User, CLASSES } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { DataTable } from '../../components/ui/DataTable';
import { Plus, Trash2, Edit, GraduationCap, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ColumnDef } from '@tanstack/react-table';

export function ManageStudents() {
  const { addToast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [parents, setParents] = useState<User[]>([]);
  const [classFilter, setClassFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<Student | null>(null);

  const [formName, setFormName] = useState('');
  const [formClass, setFormClass] = useState(CLASSES[0]);
  const [formParent, setFormParent] = useState('');
  const [parentSearch, setParentSearch] = useState('');

  const STUDENTS_PER_PAGE = 50;

  const refresh = async (page: number = currentPage, searchTerm?: string) => {
    const [studentsData, parentsData] = await Promise.all([
      getStudentsPaginated(page, STUDENTS_PER_PAGE, searchTerm || search),
      getUsersByRole('parent')
    ]);
    setStudents(studentsData.students);
    setTotalStudents(studentsData.total);
    setParents(parentsData);
  };

  useEffect(() => {
    refresh();
  }, [currentPage]);

  useEffect(() => {
    refresh(1); // Reset to first page when search changes
    setCurrentPage(1);
  }, [search]);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const filteredParents = parents.filter(p =>
    p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
    p.email.toLowerCase().includes(parentSearch.toLowerCase())
  );

  const filtered = students.filter(s => classFilter === 'all' || s.className === classFilter);

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
        const parent = parents.find(p => p.id === student.parentId);
        return parent ? (
          <div>
            <span className="text-sm text-gray-900 font-medium">{parent.name}</span>
            {parent.phone1 && <span className="text-xs text-gray-500 block">{parent.phone1}</span>}
          </div>
        ) : (
          <span className="text-sm text-gray-400 italic">Unassigned</span>
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
            <button
              onClick={() => openEdit(student)}
              className="p-1 text-blue-400 hover:text-blue-600"
            >
              <Edit className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDelete(student)}
              className="p-1 text-red-400 hover:text-red-600"
            >
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

  const handleEdit = async () => {
    if (!showEdit) return;
    try {
      await updateStudent(showEdit.id, { name: formName, className: formClass, parentId: formParent || null });
      addToast({ type: 'success', title: 'Student updated' });
      resetForm(); setShowEdit(null); await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to update student' });
    }
  };

  const handleDelete = async (s: Student) => {
    try {
      await deleteStudent(s.id);
      addToast({ type: 'success', title: `${s.name} deleted` });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to delete student' });
    }
  };

  const openEdit = (s: Student) => {
    const parent = parents.find(p => p.id === s.parentId);
    setFormName(s.name);
    setFormClass(s.className);
    setFormParent(s.parentId || '');
    setParentSearch(parent ? parent.name : '');
    setShowEdit(s);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manage Students</h1>
          <p className="text-slate-500 mt-1">Add students, assign classes and parents</p>
        </div>
        <button onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all">
          <Plus className="w-4 h-4" /> Add Student
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setClassFilter('all')}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              classFilter === 'all' ? 'bg-indigo-100 text-indigo-700 ring-2 ring-offset-1 ring-indigo-200' : 'bg-white text-slate-500 border border-slate-200'
            )}>All Classes</button>
          {CLASSES.map(cls => (
            <button key={cls} onClick={() => setClassFilter(cls)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                classFilter === cls ? 'bg-indigo-100 text-indigo-700 ring-2 ring-offset-1 ring-indigo-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{cls}</button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input type="text" placeholder="Search students..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
        </div>
      </div>



      {/* Students Table */}
      <DataTable
        data={filtered}
        columns={columns}
        searchPlaceholder="Search students..."
        searchValue={search}
        onSearchChange={setSearch}
      />

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No students found</p>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="Add New Student" description="Only admins can add students">
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
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
              />
              {parentSearch && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  <button
                    onClick={() => { setFormParent(''); setParentSearch(''); }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
                  >
                    — No parent —
                  </button>
                  {filteredParents.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setFormParent(p.id); setParentSearch(p.name); }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50"
                    >
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
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
              />
              {parentSearch && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  <button
                    onClick={() => { setFormParent(''); setParentSearch(''); }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
                  >
                    — No parent —
                  </button>
                  {filteredParents.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setFormParent(p.id); setParentSearch(p.name); }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50"
                    >
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
    </div>
  );
}
