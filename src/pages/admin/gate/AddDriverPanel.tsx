// "Add Driver" form at the dismissal gate.
//
// Staff scan a family card, see who is authorized to pick up its students, and
// tap "Add driver" when the arriving adult isn't listed. The form is
// deliberately fast: name, phone, relationship, which students they may pick
// up (staff must explicitly select — none is pre-selected), and a REQUIRED
// photo captured once at creation. There is no approval step and no
// photo-pending lifecycle — saving creates a record that is immediately
// usable for release in the same session.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { PhotoCapture } from '../../../components/photo/PhotoCapture';
import { useToast } from '../../../context/ToastContext';
import { supabase } from '../../../lib/supabase';
import { createAuthorizedPickup, PICKUP_BUCKET } from '../../../lib/db/authorizedPickups';
import { displayFamilyId } from '../../../lib/transport';
import type { GateLookupRow } from '../../../lib/db/gate';
import type { GateStrings } from '../../../lib/i18n/gateStrings';

export function AddDriverPanel({
  open,
  onClose,
  familyId,
  students,
  t,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  familyId: string;
  students: GateLookupRow[];
  t: GateStrings;
  onAdded: () => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed on open: NO student is pre-selected. Staff must explicitly choose
  // which student(s) this driver is taking, so a driver is never silently
  // authorized for siblings they aren't collecting.
  useEffect(() => {
    if (open) {
      setName('');
      setPhone('');
      setRelationship('');
      setSelected(new Set());
      setPhotoBlob(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const save = async () => {
    if (!name.trim() || !phone.trim()) {
      setError(t.driverFieldsRequired);
      return;
    }
    if (!photoBlob) {
      setError(t.photoRequired);
      return;
    }
    if (selected.size === 0) {
      setError(t.selectStudentError);
      return;
    }

    setSaving(true);
    setError(null);
    const id = `pickup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const path = `${id}.jpg`;
    try {
      // 1. Upload the photo (captured once at creation, permanent). The bucket
      // is private; we store the object PATH, and the gate signs it for display.
      const { error: uploadError } = await supabase.storage
        .from(PICKUP_BUCKET)
        .upload(path, photoBlob, { contentType: 'image/jpeg', upsert: true });
      if (uploadError) throw uploadError;

      // 2. Create the person + student links (role-checked in SQL).
      await createAuthorizedPickup({
        id,
        name: name.trim(),
        phoneNumber: phone.trim(),
        relationship: relationship.trim(),
        photoPath: path,
        studentIds: [...selected],
      });

      addToast({
        type: 'success',
        title: `${t.addDriver}: ${name.trim()}`,
        description: `${t.driverSavedFor} ${displayFamilyId(familyId)}`,
      });
      onClose();
      onAdded();
    } catch (err) {
      // Best-effort cleanup of the uploaded object so a failed save doesn't
      // leave an orphan in storage; the retry re-uploads with upsert anyway.
      try {
        await supabase.storage.from(PICKUP_BUCKET).remove([path]);
      } catch {
        /* non-critical */
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast({ type: 'error', title: t.saveDriverFailed, description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t.addDriver}
      description={`${displayFamilyId(familyId)} · ${t.studentsForDriver}`}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">{t.driverName}</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t.driverName}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">{t.driverPhone}</label>
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            inputMode="tel"
            placeholder={t.driverPhone}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">{t.relationship}</label>
          <input
            value={relationship}
            onChange={e => setRelationship(e.target.value)}
            placeholder={t.relationshipPlaceholder}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
        </div>

        {/* Which students this driver may pick up (staff must select each). */}
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">{t.studentsForDriver}</label>
          <div className="space-y-1 rounded-xl border border-slate-200 p-2">
            {students.map(s => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                  className="h-4 w-4 accent-emerald-700"
                />
                <span className="font-medium text-slate-700">{s.name}</span>
                <span className="text-xs text-slate-400">{s.className}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Required photo — captured once at creation. */}
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">{t.photoRequired}</label>
          <PhotoCapture onChange={setPhotoBlob} takeLabel={t.takePhoto} retakeLabel={t.retakePhoto} />
        </div>

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
            {t.cancel}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-5 py-2 text-sm font-black text-white transition hover:bg-emerald-900 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t.saving : `✓ ${t.saveDriver}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
