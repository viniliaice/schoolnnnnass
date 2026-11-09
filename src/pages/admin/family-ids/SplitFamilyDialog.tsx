// Split a merged family — the "separate these two households" action.
//
// A Family ID is frozen at generation time. When two households end up on one
// MBK number (shared phone at Generate, or a parent account corrected later),
// correcting `parentId` cannot undo it: assign_student_parent() never touches
// familyId. This dialog is the deliberate repair path.
//
// It is admin + office in the UI *and* in SQL (split_family_members re-checks
// the role). Students are grouped by parent account because that is the one
// exact signal in the data — names are spelled inconsistently ("salebaan" /
// "suleban"), so grouping by surname would mislead.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Split } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { displayFamilyId, formatGradeLabel, transportLabel } from '../../../lib/transport';
import { familyParentIds } from '../../../lib/db/familyIds';
import { cn } from '../../../utils/cn';
import type { Student } from '../../../types';

interface Props {
  open: boolean;
  /** Canonical 4-digit id of the family being split ('0305'). */
  familyId: string;
  /** Active members of that family. */
  students: Student[];
  /** parentId → name, when the caller could load it (admin only). */
  parentNames?: Map<string, string>;
  onClose: () => void;
  /** Persist the split. Must reject on failure so the error shows inline. */
  onSplit: (familyId: string, studentIds: string[]) => Promise<void>;
}

export function SplitFamilyDialog({
  open, familyId, students, parentNames, onClose, onSplit,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens for a (possibly different) family.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setError(null);
      setSaving(false);
    }
  }, [open, familyId]);

  /** Members grouped by parent account; the null group is "no parent account". */
  const groups = useMemo(() => {
    const byParent = new Map<string, Student[]>();
    for (const s of students) {
      const key = s.parentId ?? '';
      const list = byParent.get(key);
      if (list) list.push(s);
      else byParent.set(key, [s]);
    }
    const sorted = [...byParent.entries()]
      .map(([parentId, kids]) => ({
        parentId,
        name: parentId ? (parentNames?.get(parentId) || '') : '',
        students: [...kids].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.students.length - a.students.length || a.name.localeCompare(b.name));

    // Office cannot read `profiles`, so a parent name is often unavailable.
    // Number the unnamed groups instead of printing "Parent account" twice —
    // the students listed under each group are what identifies the household
    // (names are spelled inconsistently, so a surname label would mislead).
    let unnamed = 0;
    return sorted.map((group, index) => ({
      parentId: group.parentId,
      students: group.students,
      hasName: !!group.name,
      label: !group.parentId
        ? 'No parent account'
        : group.name || `Parent account ${++unnamed}`,
      ordinal: index + 1,
    }));
  }, [students, parentNames]);

  const parentCount = familyParentIds(students).length;
  const unnamedParents = groups.some(group => group.parentId && !group.hasName);
  const total = students.length;
  const movingCount = selected.size;
  const remaining = total - movingCount;
  const allSelected = total > 0 && movingCount === total;

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const toggleGroup = (ids: string[]) => {
    const everySelected = ids.every(id => selected.has(id));
    setSelected(prev => {
      const next = new Set(prev);
      ids.forEach(id => { if (everySelected) next.delete(id); else next.add(id); });
      return next;
    });
  };

  const disabled = saving || movingCount === 0 || allSelected;

  const handleSplit = async () => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSplit(familyId, [...selected]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not split the family.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Separate ${displayFamilyId(familyId)}`}
      description="Choose the students that belong to a DIFFERENT household. They move onto a new Family ID; everyone else keeps this one."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {parentCount > 1 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <b>This family holds {parentCount} parent accounts.</b> That is either two households
            merged onto one ID, or one household with two logins. Check before splitting.
            {unnamedParents && (
              <p className="mt-1 text-amber-800">
                Parent names are not available for your role — identify each household by the
                students listed under it.
              </p>
            )}
          </div>
        )}

        <div className="max-h-[45vh] space-y-3 overflow-y-auto pr-1">
          {groups.map(group => {
            const ids = group.students.map(s => s.id);
            const everySelected = ids.every(id => selected.has(id));
            return (
              <div key={group.parentId || 'none'} className="overflow-hidden rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-2">
                  <div className="text-xs">
                    <span className="font-bold text-slate-800">{group.label}</span>
                    <span className="ml-2 text-slate-500">
                      {group.students.length} student{group.students.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleGroup(ids)}
                    disabled={saving}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 transition hover:border-emerald-600 hover:text-emerald-800 disabled:opacity-50"
                  >
                    {everySelected ? 'Clear group' : 'Select group'}
                  </button>
                </div>
                <ul className="divide-y divide-slate-100">
                  {group.students.map(s => {
                    const checked = selected.has(s.id);
                    return (
                      <li key={s.id}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-3 px-3 py-2 text-xs transition',
                            checked ? 'bg-emerald-50/70' : 'bg-white hover:bg-slate-50',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(s.id)}
                            disabled={saving}
                            className="h-4 w-4 accent-emerald-700"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-slate-800">{s.name}</span>
                            <span className="ml-2 rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500">
                              {formatGradeLabel(s.className)}
                            </span>
                          </span>
                          <span className="shrink-0 text-slate-500">{transportLabel(s.transport)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div
          className={cn(
            'rounded-xl border p-3 text-xs',
            allSelected
              ? 'border-red-200 bg-red-50 text-red-800'
              : movingCount === 0
                ? 'border-slate-200 bg-slate-50 text-slate-600'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900',
          )}
        >
          {movingCount === 0 ? (
            <>Select at least one student to move onto a new Family ID.</>
          ) : allSelected ? (
            <>Leave at least one student in {displayFamilyId(familyId)} — a family cannot be split
              away entirely. Use Assign for a whole-family move.</>
          ) : (
            <>
              <b>{movingCount}</b> student{movingCount === 1 ? '' : 's'} move to a <b>new</b> Family
              ID · <b>{remaining}</b> stay on {displayFamilyId(familyId)}. Parent accounts and
              transport do not change.
            </>
          )}
        </div>

        {error && (
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSplit}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-800 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />}
            {saving ? 'Splitting…' : movingCount > 0 ? `Split ${movingCount} to a new ID` : 'Split'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
