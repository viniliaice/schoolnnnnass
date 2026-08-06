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
import { BookOpen, Plus, Pencil, Trash2, Loader2, Eye, X, CalendarRange, Target, Layers } from 'lucide-react';
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
  const [viewingUnit, setViewingUnit] = useState<UnitPlan | null>(null);
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
  const subjectName = (subjectId: string) => subjects?.find(s => s.id === subjectId)?.name || subjectId;
  const termName = (termId: string) => terms.find(t => t.id === termId)?.name || termId;

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

      {viewingUnit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
          <div className="max-h-[92vh] w-full max-w-3xl overflow-auto rounded-t-3xl border border-slate-200 bg-white shadow-2xl sm:rounded-3xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white/95 p-5 backdrop-blur">
              <div className="min-w-0">
                <p className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">
                  <Layers className="h-3.5 w-3.5" /> Unit Plan
                </p>
                <h2 className="break-words text-xl font-bold text-slate-900">{viewingUnit.name}</h2>
                <p className="mt-1 text-sm text-slate-500">{viewingUnit.class_name} · {subjectName(viewingUnit.subject_id)}</p>
              </div>
              <button
                type="button"
                onClick={() => setViewingUnit(null)}
                className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close unit plan details"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Class</p>
                  <p className="mt-1 font-semibold text-slate-900">{viewingUnit.class_name}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Subject</p>
                  <p className="mt-1 font-semibold text-slate-900">{subjectName(viewingUnit.subject_id)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Term</p>
                  <p className="mt-1 font-semibold text-slate-900">{termName(viewingUnit.term_id)}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-bold text-indigo-900">
                  <CalendarRange className="h-4 w-4" /> Teaching window
                </div>
                <p className="text-sm text-indigo-800">Week {viewingUnit.week_number_start} to Week {viewingUnit.week_number_end}</p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900">
                  <Target className="h-4 w-4 text-indigo-600" /> Learning objectives
                </div>
                <div className="whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-7 text-slate-700">
                  {viewingUnit.objectives}
                </div>
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setViewingUnit(null)}
                  className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => { openEdit(viewingUnit); setViewingUnit(null); }}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
                >
                  <Pencil className="h-4 w-4" /> Edit Unit Plan
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isLoading && !error && units && units.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
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
                    {subjectName(unit.subject_id)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">Week {unit.week_number_start} - Week {unit.week_number_end}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setViewingUnit(unit)}
                        className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="View unit plan"
                        aria-label={`View ${unit.name}`}>
                        <Eye className="w-4 h-4" />
                      </button>
                      <button onClick={() => openEdit(unit)}
                        className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="Edit unit plan"
                        aria-label={`Edit ${unit.name}`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(unit.id)}
                        className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete unit plan"
                        aria-label={`Delete ${unit.name}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
