// "New driver" dialog for the management screen — create a driver without a
// gate lookup first. This is the ONLY place a driver is created (the gate's
// AssignDriverPanel searches and assigns, never creates). Required fields:
// name, phone, and at least one student (students are picked with a
// school-wide search instead of a fixed family's checkbox list). The photo is
// OPTIONAL and can be added either by taking it with the device camera or by
// uploading an image — both feed the same single photoPath.
//
// De-dupe: when the phone matches an existing driver (normalized), staff are
// offered "attach to existing" instead of creating a duplicate. Attaching
// links the selected students to the existing driver (no new row, no photo).
// "Create separate driver" is the explicit override for two distinct people
// who share a number.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { DriverPhotoField } from '../../../components/photo/DriverPhotoField';
import { useToast } from '../../../context/ToastContext';
import { supabase } from '../../../lib/supabase';
import {
  attachStudentsToAuthorizedPickup, createAuthorizedPickup, findDriverByPhone, PICKUP_BUCKET,
  type ManagedDriver,
} from '../../../lib/db/authorizedPickups';
import { StudentSearchList } from './StudentSearchList';
import type { Student } from '../../../types';

export function NewDriverDialog({
  open,
  onClose,
  drivers,
  students,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  drivers: ManagedDriver[];
  students: Student[];
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [query, setQuery] = useState('');

  // Reset every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName('');
      setPhone('');
      setRelationship('');
      setSelected(new Set());
      setPhotoBlob(null);
      setSaving(false);
      setError(null);
      setOverride(false);
      setQuery('');
    }
  }, [open]);

  const duplicate = useMemo(
    () => (phone.trim() ? findDriverByPhone(drivers, phone) : undefined),
    [drivers, phone],
  );

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const close = () => {
    if (saving) return;
    onClose();
  };

  /** Link the selected students to the EXISTING driver (de-dupe path). */
  const attach = async () => {
    if (!duplicate) return;
    if (selected.size === 0) {
      setError('Select at least one student to attach to this driver.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await attachStudentsToAuthorizedPickup(duplicate.id, [...selected]);
      addToast({
        type: 'success',
        title: `Attached to ${duplicate.name}`,
        description: `${selected.size} student(s) linked to the existing driver`,
      });
      onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast({ type: 'error', title: 'Attach failed', description: message });
    } finally {
      setSaving(false);
    }
  };

  /** Create a brand-new driver (optionally overriding the duplicate guard). */
  const create = async () => {
    if (!name.trim() || !phone.trim()) {
      setError('Name and phone number are required.');
      return;
    }
    if (selected.size === 0) {
      setError('Select at least one student.');
      return;
    }

    setSaving(true);
    setError(null);
    const id = `pickup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // One photo path whether the photo came from the camera or a gallery
    // upload — null when the driver is saved without a photo.
    const path = photoBlob ? `${id}.jpg` : null;
    try {
      if (photoBlob && path) {
        const { error: uploadError } = await supabase.storage
          .from(PICKUP_BUCKET)
          .upload(path, photoBlob, { contentType: 'image/jpeg', upsert: true });
        if (uploadError) throw uploadError;
      }

      await createAuthorizedPickup({
        id,
        name: name.trim(),
        phoneNumber: phone.trim(),
        relationship: relationship.trim(),
        photoPath: path,
        studentIds: [...selected],
        allowDuplicatePhone: override,
      });

      addToast({ type: 'success', title: `Driver saved: ${name.trim()}` });
      onSaved();
      onClose();
    } catch (err) {
      if (path) {
        try {
          await supabase.storage.from(PICKUP_BUCKET).remove([path]);
        } catch {
          /* non-critical */
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast({ type: 'error', title: 'Could not save driver', description: message });
    } finally {
      setSaving(false);
    }
  };

  const selectedStudents = students.filter(s => selected.has(s.id));
  const showBanner = !!duplicate && !override;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New driver"
      description="Add an authorized pickup person and choose who they may pick up."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Driver name"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Phone number</label>
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="e.g. +252 61 2345678"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Relationship</label>
          <input
            value={relationship}
            onChange={e => setRelationship(e.target.value)}
            placeholder="e.g. Grandfather — takes to home"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        {showBanner && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-bold text-amber-900">
              This phone already belongs to {duplicate!.name}.
            </p>
            <p className="mt-0.5 text-xs text-amber-700">
              Attach the selected students to the existing driver instead of creating a duplicate.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => void attach()}
                disabled={saving}
                className="rounded-lg bg-emerald-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
              >
                Attach to {duplicate!.name}
              </button>
              <button
                onClick={() => setOverride(true)}
                disabled={saving}
                className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
              >
                Create separate driver
              </button>
            </div>
          </div>
        )}

        {/* Which students this driver may pick up (school-wide). */}
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">
            Students they may pick up <span className="text-slate-400">(required)</span>
          </label>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, family ID, class…"
            className="mb-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
          {selectedStudents.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {selectedStudents.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  {s.name}
                  <button onClick={() => toggle(s.id)} aria-label={`Remove ${s.name}`} className="text-emerald-700 hover:text-emerald-900">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <StudentSearchList
            students={students}
            query={query}
            excludeIds={selected}
            actionLabel="Add"
            onAction={s => toggle(s.id)}
            emptyHint="Start typing to find students"
          />
        </div>

        {/* Optional driver photo — camera capture or gallery upload (one shared field). */}
        {!showBanner && (
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Driver Photo</label>
            <DriverPhotoField onChange={setPhotoBlob} />
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={close}
            disabled={saving}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          {!showBanner && (
            <button
              onClick={() => void create()}
              disabled={saving}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-5 py-2 text-sm font-black text-white transition hover:bg-emerald-900 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? 'Saving…' : '✓ Save driver'}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
