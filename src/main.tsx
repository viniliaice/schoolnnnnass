import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// @react-pdf's browser renderer can reach dependencies that expect Node's
// global Buffer. Browsers do not provide it, so install the npm polyfill once.
if (!(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
