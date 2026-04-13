import { useEffect, useState } from 'react';
import { getClassSubjects, createClassSubject, updateClassSubject, deleteClassSubject, getUsers, getSubjects } from '../../lib/database';
import { Dialog } from '../../components/ui/Dialog';
import { Listbox } from '@headlessui/react';
import { useToast } from '../../context/ToastContext';
import { CLASSES } from '../../types';
import { Plus, Trash2, Edit } from 'lucide-react';
import { cn } from '../../utils/cn';

export function ManageClassSubjects() {
  const { addToast } = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const [formClass, setFormClass] = useState('');
  const [formSubjectIds, setFormSubjectIds] = useState<string[]>([]);
  const [formTeacherId, setFormTeacherId] = useState('');
  const [filteredClasses, setFilteredClasses] = useState<string[]>(CLASSES);

  const refresh = async () => {
    const [rows, users, subs] = await Promise.all([getClassSubjects(), getUsers(), getSubjects()]);
    setItems(rows);
    setTeachers(users.filter((u:any) => u.role === 'teacher'));
    setSubjects(subs);
  };

  useEffect(() => { refresh(); }, []);

  const openCreate = () => { setFormClass(''); setFormSubjectIds([]); setFormTeacherId(''); setFilteredClasses(CLASSES); setEditing(null); setShowCreate(true); };

  const handleSave = async () => {
    try {
      if (editing) {
        // Only allow editing a single subject mapping at a time
        await updateClassSubject(editing.id, { className: formClass, subjectId: formSubjectIds[0], teacherId: formTeacherId });
        addToast({ type: 'success', title: 'Updated mapping' });
      } else {
        // Filter out invalid/empty subjectIds
        const validSubjectIds = formSubjectIds.filter(sid => typeof sid === 'string' && sid.trim() !== '');
        if (validSubjectIds.length === 0) {
          addToast({ type: 'error', title: 'Please select at least one valid subject.' });
          return;
        }
        await Promise.all(
          validSubjectIds.map(subjectId => {
            const payload = { className: formClass, subjectId, teacherId: formTeacherId };
            if (import.meta.env && import.meta.env.MODE !== 'production') {
              console.debug('Creating class_subjects row:', payload);
            }
            return createClassSubject(payload);
          })
        );
        addToast({ type: 'success', title: 'Created mapping(s)' });
      }
      setShowCreate(false);
      await refresh();
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to save mapping' });
      console.error('Error saving class_subjects:', err);
    }
  };

  const handleEdit = (row: any) => {
    setEditing(row);
    setFormClass(row.className || '');
    setFormSubjectIds(row.subjectId ? [row.subjectId] : []);
    setFormTeacherId(row.teacherId || '');
    // Filter classes for the teacher being edited
    const teacher = teachers.find((t: any) => t.id === row.teacherId);
    setFilteredClasses(Array.isArray(teacher?.assignedClasses) ? teacher.assignedClasses : CLASSES);
    setShowCreate(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this mapping?')) return;
    try {
      await deleteClassSubject(id);
      addToast({ type: 'success', title: 'Deleted' });
      await refresh();
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to delete' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Class Subjects</h1>
          <p className="text-slate-500">Map subjects to classes and assign teachers</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl">
          <Plus className="w-4 h-4" /> New Mapping
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500">Class</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500">Subject</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500">Teacher</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3">{it.className}</td>
                  <td className="px-4 py-3">{it.subjects?.name || it.subjectId}</td>
                  <td className="px-4 py-3">{it.users?.name || it.teacherId || '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleEdit(it)} className="px-2 py-1 text-xs rounded-lg bg-slate-50 mr-2"><Edit className="w-3.5 h-3.5" /></button>
                    <button onClick={() => handleDelete(it.id)} className="px-2 py-1 text-xs rounded-lg bg-red-50 text-red-700"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title={editing ? 'Edit Mapping' : 'New Mapping'} description="Assign a subject to a class and teacher">
        <form
          className="flex flex-col gap-3 bg-blue-50 rounded-xl p-4 border border-blue-200 shadow"
          onSubmit={e => { e.preventDefault(); handleSave(); }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-blue-700">Teacher</label>
            <select
              value={formTeacherId}
              onChange={e => {
                setFormTeacherId(e.target.value);
                const teacher = teachers.find((t: any) => t.id === e.target.value);
                setFilteredClasses(Array.isArray(teacher?.assignedClasses) ? teacher.assignedClasses : CLASSES);
                setFormClass('');
              }}
              className="border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              required
            >
              <option value="">Select teacher</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-blue-700">Class</label>
            <select
              value={formClass}
              onChange={e => setFormClass(e.target.value)}
              className="border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              required
              disabled={!formTeacherId}
            >
              <option value="">Select class</option>
              {filteredClasses.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-blue-700">Subjects</label>
            <Listbox value={formSubjectIds} onChange={setFormSubjectIds} multiple>
              <div className="relative">
                <Listbox.Button className="border border-blue-300 rounded px-2 py-1 text-sm w-full text-left focus:outline-none focus:ring-2 focus:ring-blue-400 min-h-12 bg-white">
                  {formSubjectIds.length === 0
                    ? <span className="text-blue-300">Select subjects</span>
                    : <span className="text-blue-800">{subjects.filter(s => formSubjectIds.includes(s.id)).map(s => s.name).join(', ')}</span>}
                </Listbox.Button>
                <Listbox.Options className="absolute z-10 mt-1 w-full bg-white border border-blue-200 rounded shadow-lg max-h-48 overflow-auto">
                  {subjects.map(s => (
                    <Listbox.Option
                      key={s.id}
                      value={s.id}
                      className={({ active, selected }) =>
                        `cursor-pointer select-none px-3 py-2 text-sm ${active ? 'bg-blue-50' : ''} ${selected ? 'font-semibold text-blue-700' : ''}`
                      }
                    >
                      {({ selected }) => (
                        <span className="flex items-center">
                          <span className="flex-1">{s.name}</span>
                          {selected && <span className="ml-2 text-blue-600">✓</span>}
                        </span>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
            <span className="text-xs text-blue-400">Click to select multiple</span>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded bg-blue-100 text-blue-700 text-sm">Cancel</button>
            <button type="submit" className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-700">Save</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
