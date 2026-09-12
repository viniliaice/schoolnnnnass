// Client-side photo resize for driver pickup photos.
//
// Driver photos come from EITHER the camera (a video frame or a `capture`
// file input) OR a gallery upload — both funnel through resizeImageToSquare(),
// which center-crops to a square and scales to a ~400×400 canvas before upload
// (JPEG ~30–80KB), keeping the stored file small and the driver list fast.
//
// Only computeSquareCrop() is pure (unit-testable). The DOM/Canvas helpers
// (loadImage / canvasToBlob / resizeImageToSquare / videoFrameToSquare) run in
// the browser.

export interface SquareCrop {
  sx: number;
  sy: number;
  size: number;
}

/**
 * Center-crop region for a source of `sourceWidth`×`sourceHeight` into a
 * square. Returns the top-left source point and the square side length.
 */
export function computeSquareCrop(sourceWidth: number, sourceHeight: number): SquareCrop {
  const size = Math.min(sourceWidth, sourceHeight);
  const sx = (sourceWidth - size) / 2;
  const sy = (sourceHeight - size) / 2;
  return { sx, sy, size };
}

export interface ResizedPhoto {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
}

function loadImage(source: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image.'));
    };
    image.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      type,
      quality,
    );
  });
}

/** Resize a photo (file, blob, or camera frame) to a square JPEG (default 400×400) for upload. */
export async function resizeImageToSquare(source: Blob, targetSize = 400): Promise<ResizedPhoto> {
  const image = await loadImage(source);
  const { sx, sy, size } = computeSquareCrop(image.naturalWidth, image.naturalHeight);

  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser.');
  ctx.drawImage(image, sx, sy, size, size, 0, 0, targetSize, targetSize);

  // Prefer JPEG at 0.85; if the result is still chunky, re-encode harder.
  let quality = 0.85;
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (blob.size > 120 * 1024) {
    quality = 0.6;
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { blob, dataUrl, width: targetSize, height: targetSize };
}

/**
 * Snapshot a <video> camera frame and normalize it exactly like an uploaded
 * photo (center-crop + resize to a square JPEG). Browser-only (canvas).
 */
export async function videoFrameToSquare(video: HTMLVideoElement, targetSize = 400): Promise<ResizedPhoto> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('The camera did not produce a frame.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser.');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  return resizeImageToSquare(frame, targetSize);
}
