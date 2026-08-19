// Edit one student's transport, from the Family IDs table.
//
// Scope is deliberately ONE STUDENT: transport is a student-level column
// (students.transport), and a family may legitimately mix modes — Ahmed on
// bus 9, Amina walking, Yasmin by car. Saving here writes exactly one row via
// set_student_transport(), so a sibling can never be changed by accident.
//
// There is no 'BUS' value in the database. The CHECK constraint is
//   transport IS NULL OR transport IN ('WALKER','CAR','LEFT') OR transport ~ '^\d+$'
// so choosing Bus means storing the route number ('9'). That is why the route
// field appears only for Bus and is required before Save enables.

import { useEffect, useState } from 'react';
import { Bus, Car, Footprints, Loader2 } from 'lucide-react';
import {
  busNumberOf, toStoredTransport, transportChoiceOf, transportLabel,
  type TransportChoice,
} from '../../../lib/transport';
import { formatGradeLabel } from '../../../lib/transport';
import { cn } from '../../../utils/cn';
import type { Student } from '../../../types';

const CHOICES: Array<{ value: TransportChoice; label: string; Icon: typeof Bus }> = [
  { value: 'WALKER', label: 'Walker', Icon: Footprints },
  { value: 'CAR', label: 'Car', Icon: Car },
  { value: 'BUS', label: 'Bus', Icon: Bus },
];

export function EditTransportDialog({
  student,
  open,
  onClose,
  onSave,
}: {
  student: Student | null;
  open: boolean;
  onClose: () => void;
  /** Persist the canonical stored value ('WALKER' | 'CAR' | bus digits). */
  onSave: (studentId: string, transport: string) => Promise<void>;
}) {
  // Seed DURING RENDER from the student, keyed on which student is open.
  // An effect would leave the first paint (and any server render) showing the
  // wrong mode before correcting itself; this is right immediately.
  const seed = open && student ? `${student.id}:${student.transport ?? ''}` : '';
  const [draft, setDraft] = useState<{ seed: string; choice: TransportChoice; busNumber: string }>(
    () => ({
      seed,
      choice: transportChoiceOf(student?.transport),
      busNumber: busNumberOf(student?.transport),
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = draft.seed === seed
    ? draft
    : { seed, choice: transportChoiceOf(student?.transport), busNumber: busNumberOf(student?.transport) };
  const { choice, busNumber } = current;

  const setChoice = (value: TransportChoice) => setDraft({ ...current, choice: value });
  const setBusNumber = (value: string) => setDraft({ ...current, busNumber: value });

  // Clear a stale error when the dialog is re-seeded for a different student.
  useEffect(() => { setError(null); setSaving(false); }, [seed]);

  if (!open || !student) return null;

  const stored = toStoredTransport(choice, busNumber);
  const needsRoute = choice === 'BUS' && stored === null;
  const unchanged = stored !== null && stored === (student.transport ?? 'WALKER');

  const save = async () => {
    if (stored === null) {
      setError('Enter the bus route number.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(student.id, stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save transport.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit transport for ${student.name}`}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
      >
        <h2 className="text-base font-bold text-slate-800">Edit transport</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          {student.name}
          <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500">
            {formatGradeLabel(student.className)}
          </span>
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Currently {transportLabel(student.transport)}. This changes only this student —
          siblings keep their own transport.
        </p>

        <div className="mt-4 space-y-1.5">
          {CHOICES.map(({ value, label, Icon }) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 transition',
                choice === value
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300',
              )}
            >
              <input
                type="radio"
                name="transport"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="h-4 w-4 accent-emerald-700"
              />
              <Icon className="h-4 w-4" />
              <span className="text-sm font-semibold">{label}</span>
            </label>
          ))}
        </div>

        {choice === 'BUS' && (
          <div className="mt-3">
            <label htmlFor="bus-route" className="text-xs font-bold text-slate-500">
              Bus / route number
            </label>
            <input
              id="bus-route"
              inputMode="numeric"
              value={busNumber}
              onChange={e => setBusNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 9"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-600 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || needsRoute || unchanged}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-1.5 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
