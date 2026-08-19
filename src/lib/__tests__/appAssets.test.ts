// Guards the shipped HTML shell against missing-asset regressions.
//
// REPORTED: the live site always showed no logo. index.html asked for
// "/logo.png", but that file existed only in the repo-root assets/ folder --
// which Vite does NOT copy to the output. There was no public/ entry for it,
// so the favicon 404'd on every deploy. The in-app logos were fine (imported
// through the bundler, and inlined by vite-plugin-singlefile); only the HTML
// shell referenced a path that never shipped.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

describe('index.html favicon', () => {
  it('declares a favicon', () => {
    expect(html).toMatch(/<link[^>]+rel="icon"/);
  });

  it('does not reference a bare /logo.png that is not in public/', () => {
    const external = html.match(/<link[^>]+rel="icon"[^>]+href="(?!data:)([^"]+)"/);
    if (external) {
      // If someone switches back to a file reference, it MUST exist in public/.
      const href = external[1].replace(/^\.?\//, '');
      expect(
        existsSync(resolve(root, 'public', href)),
        `index.html references "${external[1]}" but public/${href} does not exist — ` +
        'it will 404 on the deployed site. Put the file in public/ or inline it.',
      ).toBe(true);
    }
  });

  it('inlines the favicon so it survives a single-file deploy', () => {
    // This build uses vite-plugin-singlefile: everything is folded into one
    // index.html. A data: URI cannot 404 regardless of how the host serves it.
    expect(html).toMatch(/rel="icon"[^>]+href="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  });

  it('keeps the favicon small enough to inline sensibly', () => {
    const m = html.match(/rel="icon"[^>]+href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    expect(m).toBeTruthy();
    const bytes = Buffer.from(m![1], 'base64');
    // Valid PNG signature.
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // The source logo is 1024x1024 / 480KB; inlining that would bloat the
    // shell. Keep the favicon under 32KB.
    expect(bytes.length).toBeLessThan(32 * 1024);
  });
});

describe('logo assets used by the app', () => {
  it('the imported logos exist and are tracked', () => {
    for (const p of ['assets/logo.png', 'assets/MBK Internatinal Logo.png']) {
      expect(existsSync(resolve(root, p)), `${p} is missing`).toBe(true);
    }
  });

  it('public/logo.png exists as a fallback for non-inlined deploys', () => {
    expect(existsSync(resolve(root, 'public/logo.png'))).toBe(true);
  });
});
