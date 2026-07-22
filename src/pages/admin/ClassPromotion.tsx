import { useState, useEffect } from 'react';
import { CLASSES, getNextClass } from '../../types';
import { supabase } from '../../lib/supabase';
import { promoteStudents, undoPromotion, usePromotionHistory } from '../../lib/db/promotions';
import { getStudentsByClass } from '../../lib/db/students';
import { getAcademicYears } from '../../lib/db/academic';
import { useToast } from '../../context/ToastContext';
import type { Student, AcademicYear, StudentPromotion } from '../../types';

export function ClassPromotion() {
  const { addToast } = useToast();
  const [fromClass, setFromClass] = useState('');
  const [toClass, setToClass] = useState('');
  const [suggestedClass, setSuggestedClass] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [academicYears, setAcademicYears] = useState<AcademicYear[]>([]);
  const [selectedYear, setSelectedYear] = useState<string>('');
  const [promoting, setPromoting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const { history, loading: histLoading, refetch } = usePromotionHistory(selectedYear || undefined);
  const [undoSelection, setUndoSelection] = useState<Set<string>>(new Set());

  useEffect(() => {
    getAcademicYears()
      .then(ys => {
        setAcademicYears(ys);
        const current = ys.find(y => y.isCurrent);
        if (current) setSelectedYear(current.id);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!fromClass) {
      setStudents([]);
      setSuggestedClass(null);
      setToClass('');
      return;
    }
    setLoading(true);
    getStudentsByClass(fromClass)
      .then(setStudents)
      .catch(() => setStudents([]))
      .finally(() => setLoading(false));

    const next = getNextClass(fromClass);
    setSuggestedClass(next);
    if (next && !overriding) {
      setToClass(next);
    }
  }, [fromClass, overriding]);

  const handlePromote = async () => {
    if (!fromClass || !toClass || students.length === 0) return;
    setPromoting(true);
    try {
      const result = await promoteStudents(fromClass, toClass, selectedYear || undefined);
      addToast({ type: 'success', title: 'Promotion Complete', description: `${result.length} student(s) promoted from ${fromClass} to ${toClass}` });
      setFromClass('');
      setToClass('');
      setStudents([]);
      setOverriding(false);
      await refetch();
    } catch (err: any) {
      addToast({ type: 'error', title: 'Promotion Failed', description: err.message });
    } finally {
      setPromoting(false);
    }
  };

  const handleUndo = async () => {
    if (undoSelection.size === 0) return;
    setUndoing(true);
    try {
      const count = await undoPromotion(Array.from(undoSelection));
      addToast({ type: 'success', title: 'Undo Complete', description: `Reverted ${count} student(s) to their previous class` });
      setUndoSelection(new Set());
      await refetch();
    } catch (err: any) {
      addToast({ type: 'error', title: 'Undo Failed', description: err.message });
    } finally {
      setUndoing(false);
    }
  };

  const toggleUndoSelection = (id: string) => {
    setUndoSelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Class Promotion</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-1">Promote students to the next grade level</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">From Class</label>
          <select
            value={fromClass}
            onChange={e => setFromClass(e.target.value)}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
          >
            <option value="">Select class...</option>
            {CLASSES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">To Class</label>
          <div className="flex gap-2">
            <select
              value={toClass}
              onChange={e => { setToClass(e.target.value); setOverriding(true); }}
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="">Select class...</option>
              {CLASSES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          {suggestedClass && !overriding && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">Auto-suggested: {suggestedClass}</p>
          )}
          {suggestedClass && overriding && (
            <button
              onClick={() => { setToClass(suggestedClass); setOverriding(false); }}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-1"
            >
              Reset to suggested ({suggestedClass})
            </button>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Academic Year (optional)</label>
        <select
          value={selectedYear}
          onChange={e => setSelectedYear(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
        >
          <option value="">All years</option>
          {academicYears.map(y => (
            <option key={y.id} value={y.id}>{y.name}{y.isCurrent ? ' (Current)' : ''}</option>
          ))}
        </select>
      </div>

      {fromClass && (
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">
            Students in {fromClass} ({loading ? '...' : students.length})
          </h3>
          {loading ? (
            <div className="text-sm text-slate-400">Loading...</div>
          ) : students.length === 0 ? (
            <div className="text-sm text-slate-400">No students found</div>
          ) : (
            <div className="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-700">
              {students.map(s => (
                <div key={s.id} className="px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300">{s.name}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {students.length > 0 && toClass && (
        <button
          onClick={handlePromote}
          disabled={promoting}
          className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium"
        >
          {promoting ? 'Promoting...' : `Promote ${students.length} student(s) to ${toClass}`}
        </button>
      )}

      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Promotion History</h2>
        {histLoading ? (
          <div className="text-sm text-slate-400">Loading...</div>
        ) : history.length === 0 ? (
          <div className="text-sm text-slate-400">No promotions yet</div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                onClick={handleUndo}
                disabled={undoSelection.size === 0 || undoing}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm font-medium"
              >
                {undoing ? 'Reverting...' : `Undo Selected (${undoSelection.size})`}
              </button>
            </div>
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800">
                  <tr>
                    <th className="px-3 py-2 text-left w-8"><input type="checkbox" disabled /></th>
                    <th className="px-3 py-2 text-left text-slate-600 dark:text-slate-400 font-medium">Student</th>
                    <th className="px-3 py-2 text-left text-slate-600 dark:text-slate-400 font-medium">From</th>
                    <th className="px-3 py-2 text-left text-slate-600 dark:text-slate-400 font-medium">To</th>
                    <th className="px-3 py-2 text-left text-slate-600 dark:text-slate-400 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {history.map((h: StudentPromotion) => (
                    <tr key={h.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={undoSelection.has(h.id)}
                          onChange={() => toggleUndoSelection(h.id)}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{h.studentId}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{h.fromClass}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{h.toClass}</td>
                      <td className="px-3 py-2 text-slate-500">{new Date(h.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
