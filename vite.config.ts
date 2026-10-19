import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { renderPrivacyPolicyHtml } from "./src/legal/privacyPolicy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ships the public privacy policy as standalone HTML files built from the same
 * content the in-app page renders (src/legal/privacyPolicy.ts). It is written
 * twice — dist/privacy-policy.html and dist/privacy-policy/index.html — so that
 * /privacy-policy, /privacy-policy.html and /privacy-policy/ all resolve to the
 * real page on the hosts this project could be served from.
 *
 * WHY: this build folds the whole app into one index.html, and the dev/preview
 * servers answer unknown paths with that SPA shell. The privacy-policy URL is
 * registered in Google Play, so it must resolve to a real, self-contained page
 * that still reads correctly with JavaScript disabled — which means a static
 * file that exists next to the app bundle, not only a React route.
 *
 * The file is written in closeBundle (after Vite copies public/), so nothing
 * else in the build can overwrite it.
 */
function privacyPolicyStaticPage(): Plugin {
  let outDir = "dist";

  return {
    name: "mbk-privacy-policy-static-page",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      // Vitest runs the Vite build pipeline too, with build.outDir pointed at a
      // throw-away folder ("dummy-non-existing-folder"). Writing the page there
      // would litter the repo on every test run, so only real builds write it.
      if (process.env.VITEST) return;

      const page = renderPrivacyPolicyHtml();
      for (const relative of ["privacy-policy.html", "privacy-policy/index.html"]) {
        const target = path.resolve(__dirname, outDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, page, "utf8");
      }
    },
  };
}

/**
 * Stamps the built service worker (dist/sw.js, copied verbatim from public/)
 * with a deterministic content hash of the built index.html. The whole app is
 * inlined into index.html, so hashing it is equivalent to hashing the app
 * bundle: any code change produces a new sw.js byte sequence, which is what
 * browsers use to detect that a new service worker version exists. Without
 * this the static public/sw.js would never change and installed PWAs would
 * stay pinned to old app code forever.
 *
 * The source file keeps the literal placeholder __SW_BUILD_ID__ so that dev
 * servers still register a working (version 'dev') worker.
 */
function serviceWorkerBuildId(): Plugin {
  let outDir = "dist";

  return {
    name: "mbk-sw-build-id",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      // Don't litter the repo during vitest's throw-away builds.
      if (process.env.VITEST) return;

      const swPath = path.resolve(__dirname, outDir, "sw.js");
      if (!fs.existsSync(swPath)) return;

      const indexPath = path.resolve(__dirname, outDir, "index.html");

      // viteSingleFile builds with a relative base, which rewrites the
      // absolute PWA link tags to "./manifest.webmanifest" / "./icons/…".
      // Relative URLs resolve against the *current path*, so a cold load of a
      // deep link (/teacher/lesson-plans) would look for the manifest under
      // /teacher/. PWA URLs must stay root-absolute.
      if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, "utf8");
        const before = html;
        html = html
          .replace(/href="\.\.\/manifest\.webmanifest"/g, 'href="/manifest.webmanifest"')
          .replace(/href="\.\/manifest\.webmanifest"/g, 'href="/manifest.webmanifest"')
          .replace(/href="\.\.\/icons\//g, 'href="/icons/')
          .replace(/href="\.\/icons\//g, 'href="/icons/');
        if (html !== before) fs.writeFileSync(indexPath, html, "utf8");
      }

      const source = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : Buffer.from("");
      const buildId = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);

      const sw = fs.readFileSync(swPath, "utf8");
      if (sw.includes("__SW_BUILD_ID__")) {
        fs.writeFileSync(swPath, sw.replace(/__SW_BUILD_ID__/g, buildId), "utf8");
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), privacyPolicyStaticPage(), serviceWorkerBuildId()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: process.env.FINGERPRINT_API_PROXY_TARGET
      ? {
          "/api/fingerprint-attendance": {
            target: process.env.FINGERPRINT_API_PROXY_TARGET,
            changeOrigin: true,
            secure: true,
            headers: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
              ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
              : undefined,
          },
        }
      : undefined,
  },
});
