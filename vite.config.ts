import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
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
 * WHY: the dev/preview servers (and the Vercel SPA rewrite) answer unknown
 * paths with the SPA shell. The privacy-policy URL is registered in Google
 * Play, so it must resolve to a real, self-contained page that still reads
 * correctly with JavaScript disabled — which means a static file that exists
 * next to the app bundle, not only a React route.
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
 * with:
 *
 *  1. __SW_BUILD_ID__ — a deterministic content hash of the built app shell
 *     (index.html bytes + the sorted list of emitted hashed asset filenames).
 *     Hashed filenames are content-addressed, so ANY change to any chunk or
 *     asset changes this ID, which changes sw.js's bytes — that is what
 *     browsers use to detect that a new service worker version exists.
 *     Without this the static public/sw.js would never change and installed
 *     PWAs would stay pinned to old app code forever.
 *
 *  2. __SW_PRECACHE_ASSETS__ — the root-absolute URLs of the entry JS/CSS
 *     that index.html actually references. The app shell is no longer a
 *     single inlined HTML file, so the service worker must precache these
 *     entry assets alongside '/' for the offline shell to keep working.
 *     Only entry assets referenced by the HTML are stamped — lazy/optional
 *     chunks (none today) are runtime-cached on demand instead, so a deploy
 *     never re-downloads the whole application.
 *
 * The source file keeps the literal placeholders so that dev servers still
 * register a working (version 'dev', empty precache) worker.
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
      const html = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";

      // Entry assets = every root-absolute /assets/* JS/CSS URL the shell
      // references (script src, stylesheet href, modulepreload href).
      const entryAssets = Array.from(
        new Set(
          Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)).map((m) => m[1])
        )
      ).sort();

      // Build ID covers the shell AND the full emitted asset manifest, so a
      // change in any content-hashed file (even one not referenced from the
      // HTML) produces a new worker version.
      const assetsDir = path.resolve(__dirname, outDir, "assets");
      const assetNames = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).sort() : [];
      const buildId = crypto
        .createHash("sha256")
        .update(html)
        .update("\n")
        .update(assetNames.join("\n"))
        .digest("hex")
        .slice(0, 16);

      let sw = fs.readFileSync(swPath, "utf8");
      sw = sw.replace(/__SW_BUILD_ID__/g, buildId);
      sw = sw.replace(/__SW_PRECACHE_ASSETS__/g, entryAssets.join(","));
      fs.writeFileSync(swPath, sw, "utf8");
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), privacyPolicyStaticPage(), serviceWorkerBuildId()],
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
  },
});
