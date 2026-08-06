import { Buffer } from "buffer";

// @react-pdf and some of its transitive dependencies still reference the
// Node.js Buffer global while generating PDFs in the browser. Vite does not
// provide Node globals automatically, so expose the browser-compatible Buffer
// implementation from the `buffer` package before the app is loaded.
const browserGlobal = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (!browserGlobal.Buffer) {
  browserGlobal.Buffer = Buffer;
}

if (!browserGlobal.global) {
  browserGlobal.global = globalThis;
}
