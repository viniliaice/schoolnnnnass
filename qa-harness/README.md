# School Gate — visual QA harness

QA-only. Not part of the app build, not shipped, not imported by `src/`.

It runs the **real** gate components against a fake Supabase with tunable
latency, so layout shift can be measured in a real browser without a backend.

## Run the preview

```bash
npx vite --config qa-harness/vite.config.ts     # http://localhost:5199/qa-harness/index.html
```

Query params:

| param      | meaning                          | default |
|------------|----------------------------------|---------|
| `fam`      | `lookup_family` latency (ms)     | 250     |
| `drv`      | `get_family_pickups` latency (ms)| 1200    |
| `drvfail`  | make the driver lookup fail      | off     |

Family IDs: `0050` (driver + bus + walker), `0077` (6 students, shared driver),
`0001` (single walking student), `9999` (not found).

A live CLS meter is pinned bottom-right.

## Run the automated visual QA

Requires a Chromium binary. Google's CDN is blocked in this sandbox, so it was
obtained through the npm registry instead:

```bash
cd /tmp
npm pack @sparticuz/chromium@131.0.1
tar xzf sparticuz-chromium-131.0.1.tgz -C spc
node -e "const f=require('fs'),z=require('zlib');f.writeFileSync('/tmp/chromium',z.brotliDecompressSync(f.readFileSync('spc/package/bin/chromium.br')))"
chmod +x /tmp/chromium
mkdir -p /tmp/clib && tar xf <(node -e "...al2023.tar.br...") -C /tmp/clib   # bundled libnss3 etc.
```

Then, with the preview running:

```bash
node qa-harness/browser/gate-visual-qa.mjs   # 12 scenarios, exits non-zero on any shift
node qa-harness/browser/perf.mjs             # proves the two RPCs run in parallel
node qa-harness/browser/attrib.mjs           # prints CLS entries with attribution
```

## What the visual QA asserts

Two independent measurements per scenario:

1. **CLS** via `PerformanceObserver('layout-shift')` with source attribution —
   Chrome's own metric, so a failure names the offending node.
2. **Per-element geometry.** Every element the spec names (student name, grade,
   transport, driver field, Assign/Change/Remove/Release/Release-All buttons,
   family header, results divider) is sampled each frame; the max movement
   after the element has **settled** must be 0.

"Settled" excludes the deliberate 200ms entry animation: that is an intended
reveal of content that was not previously on screen, not layout shift (Chrome
agrees — transform animations don't accrue CLS). The baseline for each element
is its first post-animation sample, and it must never move again. Skeleton
`<li>`s are keyed separately from real card `<li>`s so a placeholder is never
compared against the card that replaces it.
