import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// QA-only config: real gate code, faked Supabase with tunable latency.
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^.*\/lib\/supabase$/, replacement: path.resolve(__dirname, 'mockSupabase.ts') },
      { find: '@', replacement: path.resolve(__dirname, '../src') },
    ],
  },
  server: { host: '0.0.0.0', port: 5199, allowedHosts: true, open: false, fs: { allow: [path.resolve(__dirname, '..')] } },
});
