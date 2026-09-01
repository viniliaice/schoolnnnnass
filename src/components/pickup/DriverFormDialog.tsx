import { FormEvent, useState } from 'react';
import { UserRound, Phone, HeartHandshake, ShieldCheck, Loader2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { useToast } from '../../context/ToastContext';
import { createAuthorizedPickup, deleteAuthorizedPickupPhoto, uploadAuthorizedPickupPhoto, type AuthorizedPickup } from '../../lib/db/authorizedPickups';
import { PhotoCapture, type PhotoSelection } from './PhotoCapture';

interface DriverFormDialogProps {
  open: boolean;
  familyId: string;
  onClose: () => void;
  onSaved: (pickup: AuthorizedPickup) => void;
}

function newPersonId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // UUID v4 fallback for older WebViews used at the gate.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function DriverFormDialog({ open, familyId, onClose, onSaved }: DriverFormDialogProps) {
  const { addToast } = useToast();
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [relationship, setRelationship] = useState('');
  const [photo, setPhoto] = useState<PhotoSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState('');

  const resetForm = () => {
    setName('');
    setPhoneNumber('');
    setRelationship('');
    setPhoto(null);
    setPhotoError('');
  };

  const close = () => {
    if (!saving) {
      resetForm();
      onClose();
    }
  };

  const saveDriver = async (event: FormEvent) => {
    event.preventDefault();
    setPhotoError('');
    if (!name.trim() || !phoneNumber.trim()) return;
    if (!photo) {
      setPhotoError('Take a photo before saving this driver.');
      return;
    }

    const personId = newPersonId();
    setSaving(true);
    let uploadedPhoto = false;
    try {
      const photoUrl = await uploadAuthorizedPickupPhoto(familyId, personId, photo.blob);
      uploadedPhoto = true;
      const pickup = await createAuthorizedPickup({
        personId,
        familyId,
        name,
        phoneNumber,
        relationship,
        photoUrl,
      });
      onSaved(pickup);
      addToast({ type: 'success', title: 'Driver saved', description: `${pickup.name} can be used for release now.` });
      resetForm();
      onClose();
    } catch (error) {
      // If the DB insert failed after Storage succeeded, avoid leaving a photo
      // with no driver record behind. Cleanup is best-effort and never hides
      // the useful original error.
      if (uploadedPhoto) void deleteAuthorizedPickupPhoto(familyId, personId);
      addToast({
        type: 'error',
        title: 'Driver could not be saved',
        description: error instanceof Error ? error.message : 'Check the connection and try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add Driver"
      description={`Add an authorized pickup person for family ${familyId}. A photo is required.`}
      className="max-w-xl"
    >
      <form onSubmit={saveDriver} className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <div className="flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4" /> Fast gate entry</div>
          <p className="mt-1 text-xs text-emerald-800">Only the name, phone, relationship, and photo are needed. This person is available for release as soon as you save.</p>
        </div>

        <label className="block">
          <span className="mb-1.5 flex items-center gap-2 text-sm font-bold text-slate-700"><UserRound className="h-4 w-4 text-emerald-700" /> Name <span className="text-red-600">*</span></span>
          <input
            autoFocus
            required
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Full name"
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-emerald-700"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-center gap-2 text-sm font-bold text-slate-700"><Phone className="h-4 w-4 text-emerald-700" /> Phone number <span className="text-red-600">*</span></span>
          <input
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phoneNumber}
            onChange={event => setPhoneNumber(event.target.value)}
            placeholder="e.g. 063 000 0000"
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-emerald-700"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-center gap-2 text-sm font-bold text-slate-700"><HeartHandshake className="h-4 w-4 text-emerald-700" /> Relationship / where they take the child</span>
          <input
            value={relationship}
            onChange={event => setRelationship(event.target.value)}
            placeholder="e.g. Grandfather — takes to home"
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none focus:border-emerald-700"
          />
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-sm font-bold text-slate-700">Photo <span className="text-red-600">*</span></span>
            <span className="text-xs text-slate-500">Required to save</span>
          </div>
          <PhotoCapture selection={photo} onChange={selection => { setPhoto(selection); setPhotoError(''); }} disabled={saving} />
          {photoError && <p role="alert" className="mt-1 text-xs font-semibold text-red-700">{photoError}</p>}
        </div>

        <div className="flex gap-3 border-t border-slate-200 pt-4">
          <button type="button" onClick={close} disabled={saving} className="min-h-[50px] flex-1 rounded-xl border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button
            type="submit"
            disabled={saving || !name.trim() || !phoneNumber.trim() || !photo}
            className="min-h-[50px] flex-[1.5] rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <span className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Saving…</span> : 'Save Driver'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
