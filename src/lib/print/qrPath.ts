// QR as a pure SVG path — no canvas, no async, no data URLs.
//
// A QR code is just a grid of dark/light modules. `qrcode`'s create() gives
// that grid synchronously (pure math, no DOM), and @react-pdf/renderer draws
// SVG paths natively. So a card's QR is a single <Path d="..."> — it costs
// nothing to generate, needs no Image, and scales crisply at any print size.

import QRCode from 'qrcode';

export interface QrPath {
  /** SVG path data: one unit square per dark module, offset by the quiet zone. */
  d: string;
  /** Total grid size in modules (data + quiet zone on both sides). */
  size: number;
}

/** Build the SVG path for a QR encoding `text`. Deterministic per value. */
export function buildQrPath(text: string, quietZone = 4): QrPath {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const size = n + quietZone * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        d += `M${c + quietZone} ${r + quietZone}h1v1h-1z`;
      }
    }
  }
  return { d, size };
}
