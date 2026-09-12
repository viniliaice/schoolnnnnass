// Edit Driver Photo dialog — replace or remove an existing driver's photo
// from the management screen's driver detail view.
//
// Uses the SAME DriverPhotoField as the New Driver form, so the two capture
// methods (camera / upload) and the preview behave identically. The existing
// photo (a signed URL the caller already resolved) is shown first; the staff
// member can replace it via Take Photo / Upload Photo, or remove it entirely
// (photos are optional). Only a CHANGED photo is written back — opening and
// closing without touching the photo is a no-op.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog } from '../../../components/ui/Dialog';
import { DriverPhotoField } from '../../../components/photo/DriverPhotoField';
import { useToast } from '../../../context/ToastContext';
import { supabase } from '../../../lib/supabase';
import {
  PICKUP_BUCKET, updateAuthorizedPickupPhoto, type ManagedDriver,
} from '../../../lib/db/authorizedPickups';

export function EditDriverPhotoDialog({
  driver,
  initialPhotoUrl,
  open,
  onClose,
  onSaved,
}: {
  driver: ManagedDriver;
  initialPhotoUrl: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track whether the photo actually changed vs the existing one.
  const handleChange = (blob: Blob | null) => {
    setPhotoBlob(blob);
    setDirty(true);
  };

  const close = () => {
    if (saving) return;
    onClose();
  };

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    // Reuse the same object path as creation ({id}.jpg) so a driver keeps ONE
    // object — replaced with upsert, or removed entirely.
    const path = photoBlob ? `${driver.id}.jpg` : null;
    try {
      if (photoBlob && path) {
        const { error: uploadError } = await supabase.storage
          .from(PICKUP_BUCKET)
          .upload(path, photoBlob, { contentType: 'image/jpeg', upsert: true });
        if (uploadError) throw uploadError;
      }

      await updateAuthorizedPickupPhoto(driver.id, path);

      // Best-effort cleanup of the old object when the photo was removed.
      if (!path && driver.photoPath) {
        try {
          await supabase.storage.from(PICKUP_BUCKET).remove([driver.photoPath]);
        } catch {
          /* non-critical */
        }
      }

      addToast({
        type: 'success',
        title: path ? 'Driver photo updated' : 'Driver photo removed',
        description: driver.name,
      });
      onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast({ type: 'error', title: 'Could not update photo', description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Edit driver photo"
      description={`Replace or remove the photo for ${driver.name}.`}
    >
      <div className="space-y-4">
        <DriverPhotoField
          onChange={handleChange}
          initialPhotoUrl={initialPhotoUrl}
        />

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
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-5 py-2 text-sm font-black text-white transition hover:bg-emerald-900 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Saving…' : 'Save photo'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
