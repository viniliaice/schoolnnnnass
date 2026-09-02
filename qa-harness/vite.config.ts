import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// QA-only config: real gate code, faked Supabase with tunable latency.
export default defineConfig({
  // Root MUST be the repo root: @tailwindcss/vite auto-detects source files
  // relative to the Vite root, so rooting at qa-harness/ meant it never
  // scanned ../src and generated ZERO utilities — the page rendered unstyled
  // and every geometry measurement was meaningless. Caught by screenshot.
  root: path.resolve(__dirname, '..'),
  plugins: [
    // Redirect EVERY import that resolves to src/lib/supabase.ts (at any
    // relative depth) to the QA mock. An alias regex on the import specifier
    // missed '../supabase' from src/lib/db/*, which let the real client load
    // and throw on missing env vars.
    {
      name: 'qa-mock-supabase',
      enforce: 'pre',
      resolveId(source: string, importer?: string) {
        if (!importer) return null;
        if (!/(^|\/)(\.\.\/)*supabase$/.test(source) && !source.endsWith('/lib/supabase')) return null;
        const resolved = path.resolve(path.dirname(importer), source);
        if (resolved === path.resolve(__dirname, '../src/lib/supabase')) {
          // Two harnesses share this config; pick the mock matching the entry.
          const mock = process.env.QA_MOCK === 'review' ? 'mockReviewSupabase.ts' : 'mockSupabase.ts';
          return path.resolve(__dirname, mock);
        }
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, '../src') }],
  },
  // Only the harness entry — don't let the scanner crawl the app's index.html.
  optimizeDeps: { entries: ['qa-harness/index.html', 'qa-harness/review.html'] },
  server: { host: '0.0.0.0', port: 5199, allowedHosts: true, open: false },
});
