import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, RefreshCw, X } from 'lucide-react';

export interface PhotoSelection {
  /** Already resized to a small JPEG; safe to upload from the gate. */
  blob: Blob;
  previewUrl: string;
}

const MAX_EDGE = 400;

/**
 * Resize a captured image in the browser before it leaves the device. A square
 * 400px canvas keeps the upload quick at dismissal time while preserving the
 * entire face (contain, not crop). This is the shared camera component for
 * the Office Dashboard pickup-photo feature and gate driver-photo capture;
 * keeping it separate prevents those flows from drifting apart.
 */
export async function resizePickupPhoto(file: File, maxEdge = MAX_EDGE): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    let width: number;
    let height: number;
    let draw: CanvasImageSource;

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      draw = bitmap;
    } else {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('The selected image could not be read.'));
        element.src = sourceUrl;
      });
      width = image.naturalWidth || image.width;
      height = image.naturalHeight || image.height;
      draw = image;
    }

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo capture is not available on this device.');
    context.drawImage(draw, 0, 0, canvas.width, canvas.height);

    // Start crisp, then lower JPEG quality only when needed. At 400px most
    // phone photos land in the requested 30–80KB band; the loop prevents a
    // particularly detailed image from slowing the gate upload.
    let blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => {
        if (result) resolve(result);
        else reject(new Error('The selected image could not be prepared.'));
      }, 'image/jpeg', 0.84);
    });
    for (const quality of [0.76, 0.68, 0.60, 0.52]) {
      if (blob.size <= 80 * 1024) break;
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(result => {
          if (result) resolve(result);
          else reject(new Error('The selected image could not be prepared.'));
        }, 'image/jpeg', quality);
      });
    }

    // ImageBitmap owns native resources in Chromium/Safari. Older browsers do
    // not expose close(), so the optional call is deliberately guarded.
    if ('close' in draw && typeof (draw as ImageBitmap).close === 'function') {
      (draw as ImageBitmap).close();
    }
    return blob;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

interface PhotoCaptureProps {
  selection: PhotoSelection | null;
  onChange: (selection: PhotoSelection | null) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function PhotoCapture({ selection, onChange, disabled = false, compact = false }: PhotoCaptureProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      if (selection?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(selection.previewUrl);
    };
  }, [selection?.previewUrl]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setPreparing(true);
    try {
      const blob = await resizePickupPhoto(file);
      const previewUrl = URL.createObjectURL(blob);
      if (selection?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(selection.previewUrl);
      onChange({ blob, previewUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Photo could not be prepared.');
    } finally {
      setPreparing(false);
      // Allow taking the same photo again after a failed attempt.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={event => { void handleFile(event.target.files?.[0]); }}
        disabled={disabled || preparing}
      />
      {selection ? (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5">
          <img src={selection.previewUrl} alt="Driver preview" className="h-16 w-16 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-emerald-900">Photo ready</p>
            <p className="text-xs text-emerald-800">Resized to about 400px · quick 30–80KB upload</p>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-label="Remove photo"
            className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || preparing}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:border-emerald-600 hover:text-emerald-800 disabled:opacity-50"
        >
          {preparing ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
          {preparing ? 'Preparing photo…' : 'Take Photo'}
          {!preparing && <ImagePlus className="h-4 w-4 opacity-50" />}
        </button>
      )}
      {selection && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || preparing}
          className="text-xs font-bold text-emerald-800 hover:underline disabled:opacity-50"
        >
          Retake photo
        </button>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}
