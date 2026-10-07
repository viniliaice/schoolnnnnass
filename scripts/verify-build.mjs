#!/usr/bin/env node
/**
 * Post-build verification gate for the hashed-asset architecture.
 *
 * Run after `vite build` (wired into `npm run validate`). Fails loudly if the
 * build regresses toward the old single-file output, if the service worker
 * was not stamped with real entry assets, or if server-only Web Push /
 * service-role code leaks into the browser bundle.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

if (!existsSync(dist)) {
  console.error('dist/ does not exist — run `npm run build` first.');
  process.exit(1);
}

/* ── 1. HTML shell ──────────────────────────────────────────────────────── */
console.log('HTML shell');
const indexPath = path.join(dist, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const htmlBytes = statSync(indexPath).size;

// The old single-file build was ~6 MB. The shell must stay small; 100 KB is
// a generous ceiling that still catches any accidental re-inlining.
if (htmlBytes > 100 * 1024) fail(`index.html is ${htmlBytes} bytes — looks single-file again (limit 100 KB).`);
else ok(`index.html is ${htmlBytes} bytes.`);

// No giant inline application script (the data:-URI favicon and tiny
// bootstrap snippets are fine; the app itself must not be inlined).
let biggestInline = 0;
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  biggestInline = Math.max(biggestInline, Buffer.byteLength(m[1]));
}
if (biggestInline > 20 * 1024) fail(`largest inline <script> is ${biggestInline} bytes — application code must live in /assets/.`);
else ok(`largest inline <script> is ${biggestInline} bytes.`);

// Root-absolute hashed asset references.
const assetRefs = [...new Set(
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
)];
const jsRefs = assetRefs.filter((u) => u.endsWith('.js'));
const cssRefs = assetRefs.filter((u) => u.endsWith('.css'));
if (jsRefs.length === 0) fail('index.html references no /assets/*.js entry script.');
else ok(`entry JS: ${jsRefs.join(', ')}`);
if (cssRefs.length === 0) fail('index.html references no /assets/*.css stylesheet.');
else ok(`entry CSS: ${cssRefs.join(', ')}`);

// No relative ("./assets", "../assets") or dev-server URLs may remain.
if (/(?:src|href)="\.\.?\//.test(html)) fail('index.html contains relative asset URLs — deep links would break.');
else ok('all asset URLs are root-absolute.');
if (/localhost|127\.0\.0\.1/.test(html)) fail('index.html references a local development URL.');
else ok('no development URLs in the shell.');

// PWA shell links must survive.
if (!html.includes('href="/manifest.webmanifest"')) fail('manifest link missing or not root-absolute.');
else ok('manifest link present and root-absolute.');

/* ── 2. Emitted assets ──────────────────────────────────────────────────── */
console.log('Emitted assets');
const assetsDir = path.join(dist, 'assets');
const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
if (assetFiles.length === 0) fail('dist/assets/ is empty — hashed asset output missing.');
else ok(`dist/assets/ contains ${assetFiles.length} files.`);

const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css|png|jpg|jpeg|svg|woff2?)$/;
for (const ref of assetRefs) {
  const file = path.join(dist, ref);
  if (!existsSync(file)) fail(`${ref} is referenced by index.html but was not emitted.`);
  if (!hashed.test(ref)) fail(`${ref} does not look content-hashed.`);
}
if (assetRefs.every((r) => existsSync(path.join(dist, r)) && hashed.test(r))) {
  ok('every referenced entry asset exists and is content-hashed.');
}

const maps = assetFiles.filter((f) => f.endsWith('.map'));
if (maps.length > 0) fail(`unexpected source maps emitted: ${maps.join(', ')}`);
else ok('no source maps emitted.');

/* ── 3. Service worker stamping ─────────────────────────────────────────── */
console.log('Service worker');
const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
if (sw.includes('__SW_BUILD_ID__')) fail('sw.js still contains the __SW_BUILD_ID__ placeholder.');
else ok('BUILD_ID is stamped (non-placeholder).');
if (sw.includes('__SW_PRECACHE_ASSETS__')) fail('sw.js still contains the __SW_PRECACHE_ASSETS__ placeholder.');
else ok('precache asset list is stamped.');
for (const ref of assetRefs) {
  if (!sw.includes(ref)) fail(`sw.js precache list is missing entry asset ${ref}.`);
}
if (assetRefs.length > 0 && assetRefs.every((r) => sw.includes(r))) {
  ok('sw.js precaches every entry asset referenced by index.html.');
}
// Guard against precaching the whole world (recreating the old problem).
const stamped = sw.match(/RAW_PRECACHE_ASSETS = '([^']*)'/);
const stampedList = stamped && !stamped[1].startsWith('__') ? stamped[1].split(',').filter(Boolean) : [];
if (stampedList.length > 10) fail(`sw.js precaches ${stampedList.length} assets — only entry JS/CSS should be precached.`);
else ok(`sw.js precaches ${stampedList.length} stamped entry asset(s).`);

/* ── 4. Security: server-only code must not reach the browser ───────────── */
console.log('Security scan (client bundles)');
const clientFiles = [indexPath, ...assetFiles.filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => path.join(assetsDir, f))];
const NEEDLES = [
  'VAPID_PRIVATE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SERVICE_ROLE',
  'sendWebPush',
  'node:crypto',
  'derivePublicKeyB64',
  'supabaseRest',
];
let leaked = false;
for (const file of clientFiles) {
  const content = readFileSync(file, 'utf8');
  for (const needle of NEEDLES) {
    if (content.includes(needle)) {
      leaked = true;
      fail(`"${needle}" found in ${path.relative(root, file)} — server-only code leaked into the client bundle.`);
    }
  }
}
if (!leaked) ok(`no server-only markers (${NEEDLES.length} checked) in ${clientFiles.length} client files.`);

/* ── Result ─────────────────────────────────────────────────────────────── */
if (failures > 0) {
  console.error(`\nverify-build: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nverify-build: all checks passed.');
