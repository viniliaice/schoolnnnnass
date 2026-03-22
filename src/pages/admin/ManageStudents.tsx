import { useState, useEffect } from 'react';
import { getStudents, getUsersByRole, createStudent, updateStudent, deleteStudent } from '../../lib/database';
import { Student, User, CLASSES } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import { Plus, Trash2, Edit, GraduationCap, Search } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ManageStudents() {
  const { addToast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [parents, setParents] = useState<User[]>([]);
  const [classFilter, setClassFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<Student | null>(null);

  const [formName, setFormName] = useState('');
  const [formClass, setFormClass] = useState(CLASSES[0]);
  const [formParent, setFormParent] = useState('');

  const refresh = () => {
    setStudents(getStudents());
    setParents(getUsersByRole('parent'));
  };
  useEffect(() => { refresh(); }, []);

  const allClasses = [...new Set(students.map(s => s.className))].sort();
  const filtered = students
    .filter(s => classFilter === 'all' || s.className === classFilter)
    .filter(s => s.name.toLowerCase().includes(search.toLowerCase()));

  const resetForm = () => { setFormName(''); setFormClass(CLASSES[0]); setFormParent(''); };

  const handleCreate = () => {
    if (!formName.trim()) { addToast({ type: 'error', title: 'Student name is required' }); return; }
    createStudent({ name: formName, className: formClass, parentId: formParent || null });
    addToast({ type: 'success', title: 'Student added successfully' });
    resetForm(); setShowCreate(false); refresh();
  };

  const handleEdit = () => {
    if (!showEdit) return;
    updateStudent(showEdit.id, { name: formName, className: formClass, parentId: formParent || null });
    addToast({ type: 'success', title: 'Student updated' });
    resetForm(); setShowEdit(null); refresh();
  };

  const handleDelete = (s: Student) => {
    deleteStudent(s.id);
    addToast({ type: 'success', title: `${s.name} deleted` });
    refresh();
  };

  const openEdit = (s: Student) => {
    setFormName(s.name); setFormClass(s.className); setFormParent(s.parentId || '');
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
          {allClasses.map(cls => (
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

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Class</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Parent</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(s => {
                const parent = parents.find(p => p.id === s.parentId);
                return (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs">
                          {s.name.split(' ').map(n => n[0]).join('')}
                        </div>
                        <span className="font-semibold text-slate-800 text-sm">{s.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-xs font-semibold">{s.className}</span>
                    </td>
                    <td className="px-6 py-4">
                      {parent ? (
                        <div>
                          <span className="text-sm text-slate-800 font-medium">{parent.name}</span>
                          {parent.phone1 && <span className="text-xs text-slate-400 block">{parent.phone1}</span>}
                        </div>
                      ) : (
                        <span className="text-sm text-slate-400 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => openEdit(s)} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                          <Edit className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(s)} className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No students found</p>
          </div>
        )}
      </div>

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
            <select value={formParent} onChange={e => setFormParent(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white">
              <option value="">— No parent —</option>
              {parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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
            <select value={formParent} onChange={e => setFormParent(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white">
              <option value="">— No parent —</option>
              {parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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
