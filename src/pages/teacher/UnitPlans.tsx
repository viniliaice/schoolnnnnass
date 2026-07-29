import { useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { useQuery } from '@tanstack/react-query';
import { useUnitPlans, useCreateUnitPlan, useUpdateUnitPlan, useDeleteUnitPlan } from '../../lib/hooks/useUnitPlans';
import { getSubjects } from '../../lib/db/subjects';
import { getClasses, getClassSubjectsForTeacher } from '../../lib/db/classes';
import { getUserById } from '../../lib/db/profiles';
import { getTerms } from '../../lib/db/academic';
import type { UnitPlan, UnitPlanInput, Term, Subject } from '../../types';
import { BookOpen, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useEffect } from 'react';

export function UnitPlans() {
  const { session } = useRole();
  const { addToast } = useToast();
  const { data: units, isLoading, error } = useUnitPlans();
  const createMutation = useCreateUnitPlan();
  const updateMutation = useUpdateUnitPlan();
  const deleteMutation = useDeleteUnitPlan();

  const [form, setForm] = useState<UnitPlanInput>({
    name: '',
    subject_id: '',
    class_name: '',
    term_id: '',
    week_number_start: 1,
    week_number_end: 1,
    objectives: '',
  });

  const [classes, setClasses] = useState<string[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: getSubjects,
    staleTime: 1000 * 60 * 10,
  });
  const { data: teacherSubjects } = useQuery({
    queryKey: ['teacher-subjects', session?.userId, form.class_name],
    queryFn: () => getClassSubjectsForTeacher(session!.userId, form.class_name || undefined),
    enabled: !!session && (session.role === 'teacher' || session.role === 'supervisor'),
    staleTime: 1000 * 60 * 10,
  });

  const [editingUnit, setEditingUnit] = useState<UnitPlan | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (!session) return;
    const init = async () => {
      const allTerms = await getTerms();
      setTerms(allTerms);
      if (session.role === 'teacher' || session.role === 'supervisor') {
        const me = await getUserById(session.userId);
        setClasses((me?.assignedClasses || []) as string[]);
      } else {
        setClasses(await getClasses());
      }
    };
    init();
  }, [session]);

  function openCreate() {
    setEditingUnit(null);
    setForm({ name: '', subject_id: '', class_name: '', term_id: '', week_number_start: 1, week_number_end: 1, objectives: '' });
    setShowForm(true);
  }

  function openEdit(unit: UnitPlan) {
    setEditingUnit(unit);
    setForm({
      name: unit.name,
      subject_id: unit.subject_id,
      class_name: unit.class_name,
      term_id: unit.term_id,
      week_number_start: unit.week_number_start,
      week_number_end: unit.week_number_end,
      objectives: unit.objectives,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.subject_id || !form.class_name || !form.term_id || !form.objectives) {
      addToast({ type: 'error', title: 'Please fill in all required fields' });
      return;
    }
    if (form.week_number_end < form.week_number_start) {
      addToast({ type: 'error', title: 'End week must be after start week' });
      return;
    }

    try {
      if (editingUnit) {
        await updateMutation.mutateAsync({ id: editingUnit.id, data: form });
        addToast({ type: 'success', title: 'Unit plan updated' });
      } else {
        await createMutation.mutateAsync(form);
        addToast({ type: 'success', title: 'Unit plan created' });
      }
      setShowForm(false);
      setEditingUnit(null);
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || 'Failed to save unit plan' });
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this unit plan? Lesson plans linked to it will retain their data but no longer belong to a unit.')) return;
    try {
      await deleteMutation.mutateAsync(id);
      addToast({ type: 'success', title: 'Unit plan deleted' });
    } catch (err: any) {
      addToast({ type: 'error', title: err.message || 'Failed to delete unit plan' });
    }
  }

  const selectedTerm = terms.find(t => t.id === form.term_id);

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Unit Plans</h1>
          <p className="text-slate-600 mt-1">Group your lesson plans into curriculum units</p>
        </div>
        {!showForm && (
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
            <Plus className="w-4 h-4" />
            New Unit Plan
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 mb-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            {editingUnit ? 'Edit Unit Plan' : 'New Unit Plan'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Unit Name *</label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Class *</label>
              <select value={form.class_name} onChange={e => setForm({ ...form, class_name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
                <option value="">Select class...</option>
                {classes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Subject *</label>
              <select value={form.subject_id} onChange={e => setForm({ ...form, subject_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
                <option value="">Select subject...</option>
                {(session?.role === 'teacher' || session?.role === 'supervisor' ? teacherSubjects : subjects)?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Term *</label>
              <select value={form.term_id} onChange={e => setForm({ ...form, term_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
                <option value="">Select term...</option>
                {terms.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-slate-700 mb-1">Start Week</label>
                <input type="number" min={1} value={form.week_number_start}
                  onChange={e => setForm({ ...form, week_number_start: parseInt(e.target.value) || 1 })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-slate-700 mb-1">End Week</label>
                <input type="number" min={form.week_number_start} value={form.week_number_end}
                  onChange={e => setForm({ ...form, week_number_end: parseInt(e.target.value) || form.week_number_start })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Learning Objectives *</label>
              <textarea value={form.objectives} onChange={e => setForm({ ...form, objectives: e.target.value })} rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
            </div>
          </div>
          {selectedTerm && (
            <p className="text-sm text-slate-500 mb-4">
              Term: {selectedTerm.name} ({selectedTerm.startDate} - {selectedTerm.endDate})
            </p>
          )}
          <div className="flex gap-3">
            <button type="submit" disabled={isSaving}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editingUnit ? 'Update' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditingUnit(null); }}
              className="px-4 py-2 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load unit plans. Please try again.
        </div>
      )}

      {!isLoading && !error && units && units.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-12 text-center">
          <BookOpen className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-900 mb-2">No unit plans yet</h3>
          <p className="text-slate-600 mb-4">Create your first unit to start grouping your lesson plans.</p>
          <button onClick={openCreate} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
            Create Unit Plan
          </button>
        </div>
      )}

      {!isLoading && !error && units && units.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-4 py-3 text-sm font-semibold text-slate-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-slate-700">Class</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-slate-700">Subject</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-slate-700">Weeks</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-slate-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {units.map(unit => (
                <tr key={unit.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{unit.name}</div>
                    <div className="text-sm text-slate-500 truncate max-w-xs">{unit.objectives}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{unit.class_name}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {subjects?.find(s => s.id === unit.subject_id)?.name || unit.subject_id}
                  </td>
                  <td className="px-4 py-3 text-slate-700">Week {unit.week_number_start} - Week {unit.week_number_end}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openEdit(unit)}
                        className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(unit.id)}
                        className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
