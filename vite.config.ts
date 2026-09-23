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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), privacyPolicyStaticPage()],
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
