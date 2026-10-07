// Guards the hashed-asset build architecture (migration away from
// vite-plugin-singlefile). These assertions read the tracked source/config
// files; the emitted dist/ output is verified separately by
// scripts/verify-build.mjs, which `npm run validate` runs after the build.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('build architecture: no single-file bundling', () => {
  it('vite.config.ts does not use vite-plugin-singlefile', () => {
    const config = read('vite.config.ts');
    expect(config).not.toContain('vite-plugin-singlefile');
    expect(config).not.toContain('viteSingleFile');
  });

  it('package.json does not depend on vite-plugin-singlefile', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies?.['vite-plugin-singlefile']).toBeUndefined();
    expect(pkg.devDependencies?.['vite-plugin-singlefile']).toBeUndefined();
  });

  it('the build stamps the service worker with build id and entry assets', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('__SW_BUILD_ID__');
    expect(config).toContain('__SW_PRECACHE_ASSETS__');
    // The build id must cover the emitted asset manifest, not only the HTML.
    expect(config).toMatch(/assetNames/);
  });

  it('validate runs the post-build verification gate', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify-build']).toContain('scripts/verify-build.mjs');
    expect(pkg.scripts.validate).toContain('verify-build');
  });
});

describe('service worker source contract', () => {
  const sw = read('public/sw.js');

  it('keeps both stamping placeholders for the build to replace', () => {
    expect(sw).toContain("'__SW_BUILD_ID__'");
    expect(sw).toContain("'__SW_PRECACHE_ASSETS__'");
  });

  it('precaches the stamped entry assets with the shell', () => {
    expect(sw).toMatch(/\.\.\.PRECACHE_ASSETS/);
    for (const url of ['/', '/manifest.webmanifest', '/logo.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
      expect(sw).toContain(`'${url}'`);
    }
  });

  it('handles hashed /assets/ requests (cache-first) and still never touches /api/', () => {
    expect(sw).toContain("url.pathname.startsWith('/assets/')");
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    // /api/ exclusion must appear before the /assets/ handler so server
    // endpoints can never be cached.
    expect(sw.indexOf("url.pathname.startsWith('/api/')")).toBeLessThan(
      sw.indexOf("url.pathname.startsWith('/assets/')"),
    );
  });
});

describe('vercel.json caching rules', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const headerFor = (source: string) =>
    vercel.headers.find((h: { source: string }) => h.source === source)?.headers ?? [];

  it('serves hashed assets as immutable for one year', () => {
    const cc = headerFor('/assets/(.*)').find((h: { key: string }) => h.key === 'Cache-Control');
    expect(cc?.value).toBe('public, max-age=31536000, immutable');
  });

  it('keeps the service worker non-cacheable', () => {
    const cc = headerFor('/sw.js').find((h: { key: string }) => h.key === 'Cache-Control');
    expect(cc?.value).toBe('no-cache, max-age=0');
  });

  it('keeps the existing manifest/icon caching and SPA rewrite', () => {
    const manifest = headerFor('/manifest.webmanifest').find((h: { key: string }) => h.key === 'Cache-Control');
    expect(manifest?.value).toBe('public, max-age=3600');
    const icons = headerFor('/icons/(.*)').find((h: { key: string }) => h.key === 'Cache-Control');
    expect(icons?.value).toBe('public, max-age=604800, immutable');
    expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });
});
