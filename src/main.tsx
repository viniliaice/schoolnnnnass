import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { applyPrivacyPolicyMetadata } from "./legal/privacyPolicy";

// Keeps the tab title/description correct when the app shell serves
// /privacy-policy (the standalone file has them in its own <head>).
applyPrivacyPolicyMetadata();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
