// Shared "Driver Photo" field for the New Driver form and the Edit Driver
// photo dialog. One photo section with TWO ways to add it — the device camera
// or a gallery upload — that both feed the SAME photo field:
//
//   Driver Photo
//   [ preview ]
//   Take Photo  |  Upload Photo
//
// Capture paths:
//   • Take Photo → getUserMedia (rear camera) with an in-app live preview +
//     shutter. If camera permission is DENIED a clear message is shown and
//     "Upload Photo" stays available. If no camera exists (or getUserMedia is
//     unsupported, e.g. insecure context / desktop), it falls back to the
//     native `capture="environment"` input — the same mechanism the previous
//     PhotoCapture used, which launches the OS camera on Android/iOS.
//   • Upload Photo → a plain file input (JPG/JPEG/PNG, plus any image/*).
//
// Both routes run through resizeImageToSquare() so the stored file is a small
// square JPEG regardless of the source. The user can replace or remove the
// photo before the caller saves.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Camera, ImagePlus, X, XCircle } from 'lucide-react';
import { resizeImageToSquare, videoFrameToSquare } from '../../lib/photoResize';

export interface DriverPhotoFieldProps {
  /** Called whenever the selected photo changes (pick, replace, or remove). */
  onChange: (blob: Blob | null) => void;
  /** Existing photo URL to preview first (e.g. when editing an existing driver). */
  initialPhotoUrl?: string | null;
}

export function DriverPhotoField({ onChange, initialPhotoUrl }: DriverPhotoFieldProps) {
  const [preview, setPreview] = useState<string | null>(initialPhotoUrl ?? null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const galleryRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // Attach the live camera stream to the <video> once the modal opens.
  useEffect(() => {
    if (!cameraOpen) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      setError('Could not start the camera preview.');
    });
    return () => {
      if (video) video.srcObject = null;
    };
  }, [cameraOpen]);

  // Always release the camera when the field unmounts.
  useEffect(() => stopStream, [stopStream]);

  const acceptFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      // Reject files that clearly aren't images; empty types (some Android
      // pickers) are passed through and fail gracefully inside the resizer.
      if (file.type && !file.type.startsWith('image/')) {
        setError('That file is not a supported image. Choose a JPG, JPEG, or PNG.');
        return;
      }
      setProcessing(true);
      setError(null);
      try {
        const { blob, dataUrl } = await resizeImageToSquare(file, 400);
        setPreview(dataUrl);
        onChange(blob);
      } catch {
        setError('Could not read that image. Try a different photo.');
        // Keep whatever was selected before — the form is never left broken.
      } finally {
        setProcessing(false);
      }
    },
    [onChange],
  );

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file still fires onChange.
    e.target.value = '';
    void acceptFile(file);
  };

  /** Fallback native camera/file chooser — the pre-existing capture mechanism. */
  const openCaptureInput = useCallback(() => {
    setError(null);
    captureRef.current?.click();
  }, []);

  const openGallery = useCallback(() => {
    setError(null);
    galleryRef.current?.click();
  }, []);

  const takePhoto = useCallback(async () => {
    setError(null);
    // Non-secure contexts (or old WebViews) have no getUserMedia — use the
    // native capture input, which still opens the OS camera on mobile.
    if (!navigator.mediaDevices?.getUserMedia) {
      openCaptureInput();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        // Permission denied — do NOT break the form. Upload Photo stays usable.
        setError('Camera permission was denied. Allow camera access in your browser, or upload a photo instead.');
      } else {
        // No camera (or it is busy/blocked) — fall back to the native capture
        // input, which on a phone opens the camera and on desktop the picker.
        openCaptureInput();
      }
    }
  }, [openCaptureInput]);

  const shutter = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setProcessing(true);
    setError(null);
    try {
      const { blob, dataUrl } = await videoFrameToSquare(video, 400);
      setPreview(dataUrl);
      onChange(blob);
      stopStream();
      setCameraOpen(false);
    } catch {
      setError('Could not capture the photo. Try again, or upload a photo.');
    } finally {
      setProcessing(false);
    }
  }, [onChange, stopStream]);

  const closeCamera = useCallback(() => {
    stopStream();
    setCameraOpen(false);
  }, [stopStream]);

  const removePhoto = useCallback(() => {
    setPreview(null);
    onChange(null);
  }, [onChange]);

  const hasPhoto = !!preview;

  return (
    <div>
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleInput}
        data-testid="driver-photo-upload"
      />
      <input
        ref={captureRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleInput}
        data-testid="driver-photo-capture"
      />

      {/* Preview / placeholder */}
      <div
        className={`flex min-h-[112px] items-center justify-center overflow-hidden rounded-2xl border ${
          hasPhoto ? 'border-slate-200 bg-slate-50' : 'border-2 border-dashed border-slate-300 bg-slate-50'
        }`}
      >
        {hasPhoto ? (
          <div className="relative">
            <img
              src={preview!}
              alt="Driver photo preview"
              className="h-44 w-full max-w-xs object-contain"
            />
            <button
              type="button"
              onClick={removePhoto}
              aria-label="Remove photo"
              title="Remove photo"
              className="absolute right-1 top-1 rounded-full bg-slate-900/70 p-1 text-white hover:bg-slate-900"
            >
              <XCircle className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <div className="px-4 py-8 text-center">
            <Camera className="mx-auto mb-1 h-6 w-6 text-slate-300" />
            <p className="text-sm font-semibold text-slate-400">No driver photo</p>
            <p className="mt-0.5 text-xs text-slate-400">Take a photo or upload one</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void takePhoto()}
          disabled={processing}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <Camera className="h-4 w-4" />
          Take Photo
        </button>
        <button
          type="button"
          onClick={openGallery}
          disabled={processing}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <ImagePlus className="h-4 w-4" />
          Upload Photo
        </button>
        {hasPhoto && (
          <button
            type="button"
            onClick={removePhoto}
            disabled={processing}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-bold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            Remove
          </button>
        )}
      </div>

      {processing && (
        <p className="mt-1 text-xs font-semibold text-slate-500">Processing photo…</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs font-semibold text-red-600">
          {error}
        </p>
      )}

      {/* Live camera modal */}
      {cameraOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="relative aspect-square w-full bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={closeCamera}
                aria-label="Close camera"
                className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 p-4">
              <p className="text-xs font-semibold text-slate-500">Position the driver's face in the square</p>
              <button
                type="button"
                onClick={() => void shutter()}
                disabled={processing}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-5 py-2 text-sm font-black text-white transition hover:bg-emerald-900 disabled:opacity-50"
              >
                <Camera className="h-4 w-4" />
                {processing ? '…' : 'Capture'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
