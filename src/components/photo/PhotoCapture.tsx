// Reusable camera-capture component for pickup-person photos.
//
// Opens the phone camera via <input type="file" accept="image/*"
// capture="environment">, center-crops + resizes to ~400×400 (see
// src/lib/photoResize.ts), then hands the caller a Blob ready for upload.
// Shows a live preview with a "Retake" action before the caller saves.
//
// The photo is captured ONCE at creation and is permanent — this component is
// intentionally a single-shot capture + review + retake, not an edit surface.

import { useRef, useState } from 'react';
import { Camera, RefreshCw } from 'lucide-react';
import { resizeImageToSquare } from '../../lib/photoResize';

export interface PhotoCaptureProps {
  /** Called with the resized blob (or null when capture failed/cleared). */
  onChange: (blob: Blob | null) => void;
  takeLabel: string;
  retakeLabel: string;
}

export function PhotoCapture({ onChange, takeLabel, retakeLabel }: PhotoCaptureProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openCamera = () => {
    setError(null);
    inputRef.current?.click();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const { blob, dataUrl } = await resizeImageToSquare(file, 400);
      setPreview(dataUrl);
      onChange(blob);
    } catch {
      setError('Could not read the photo. Try again.');
      onChange(null);
    } finally {
      setProcessing(false);
    }
  };

  const retake = () => {
    setPreview(null);
    onChange(null);
    openCamera();
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={e => {
          void handleFile(e.target.files?.[0]);
          // Reset so re-selecting the same file still fires onChange.
          e.target.value = '';
        }}
      />

      {preview ? (
        <div className="flex items-center gap-3">
          <img
            src={preview}
            alt="Driver photo"
            className="h-28 w-28 rounded-2xl border border-slate-200 object-cover"
          />
          <button
            type="button"
            onClick={retake}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            {retakeLabel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openCamera}
          disabled={processing}
          className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-5 py-3 text-sm font-bold text-slate-700 transition hover:border-emerald-500 hover:bg-emerald-50 disabled:opacity-50"
        >
          <Camera className="h-5 w-5" />
          {processing ? '…' : takeLabel}
        </button>
      )}

      {error && <p className="mt-1 text-xs font-semibold text-red-600">{error}</p>}
    </div>
  );
}
