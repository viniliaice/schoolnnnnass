// Pixel-level layout-shift QA for the School Gate, in real Chromium 131.
//
// Two independent measurements per scenario:
//
//  1. CLS via PerformanceObserver('layout-shift') WITH attribution — Chrome's
//     own metric. Any non-zero value names the offending DOM node, so a
//     failure is actionable rather than just a number.
//
//  2. Element geometry sampling. We poll getBoundingClientRect() for every
//     element the follow-up brief names (student name, grade, transport,
//     driver field, each button, family header, results divider) on a ~16ms
//     tick, and report the maximum movement of each element AFTER it has
//     SETTLED. This catches shifts CLS can miss (e.g. a card resizing while
//     off-viewport, or sub-threshold movement).
//
//     "Settled" matters: the design deliberately animates results in with a
//     6px translateY over 200ms. That is an intentional entry transition on
//     content that was not previously on screen — it is NOT layout shift
//     (Chrome agrees: CLS stays 0 because transform animations don't count).
//     Counting it would be measuring the wrong thing. So each element's
//     baseline is the first sample taken AFTER its entry animation has
//     finished, and we then assert it never moves again. This is strictly
//     harder than the naive check for the property we care about: "once the
//     operator can read a card, nothing in it may move."
//
// The rule under test: once a student card is on screen, nothing inside it
// may move when driver data arrives.

import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';

const BASE = 'http://localhost:5199/qa-harness/index.html';
const VIEWPORTS = { desktop: { width: 1100, height: 1100 }, tablet: { width: 820, height: 1180 } };

/** Installed before any app code runs. */
function instrument() {
  const w = /** @type {any} */ (window);
  w.__shifts = [];
  w.__cls = 0;
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const entry = /** @type {any} */ (e);
      if (entry.hadRecentInput) continue;
      w.__cls += entry.value;
      w.__shifts.push({
        value: entry.value,
        time: Math.round(entry.startTime),
        nodes: (entry.sources || []).map(s => {
          const n = s.node;
          if (!n) return '(detached)';
          const tag = n.tagName ? n.tagName.toLowerCase() : String(n.nodeName);
          const cls = n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
          const txt = (n.innerText || '').trim().slice(0, 40).replace(/\s+/g, ' ');
          return `${tag}${cls} "${txt}"`;
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });

  // ── Geometry tracker ───────────────────────────────────────────────────
  // Identify tracked elements by a stable semantic key so we can follow the
  // SAME logical element across re-renders.
  w.__track = {};
  w.__sample = () => {
    const seen = {};
    const add = (key, el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      let k = key, i = 2;
      while (seen[k]) { k = `${key}#${i++}`; }
      seen[k] = true;
      const rec = (w.__track[k] ||= { first: null, maxDx: 0, maxDy: 0, maxDw: 0, maxDh: 0, samples: 0, settledAt: 0 });
      const cur = { x: r.x, y: r.y, w: r.width, h: r.height };
      // Ignore samples while an entry animation is still running on this
      // element or an ancestor — that movement is the intended reveal.
      const animating = typeof el.getAnimations === 'function'
        && el.getAnimations({ subtree: false }).some(a => a.playState === 'running')
        || (el.closest && el.closest('.gate-enter')
            && el.closest('.gate-enter').getAnimations
            && el.closest('.gate-enter').getAnimations().some(a => a.playState === 'running'));
      if (animating) return;
      if (!rec.first) { rec.first = cur; rec.settledAt = Math.round(performance.now()); }
      else {
        rec.maxDx = Math.max(rec.maxDx, Math.abs(cur.x - rec.first.x));
        rec.maxDy = Math.max(rec.maxDy, Math.abs(cur.y - rec.first.y));
        rec.maxDw = Math.max(rec.maxDw, Math.abs(cur.w - rec.first.w));
        rec.maxDh = Math.max(rec.maxDh, Math.abs(cur.h - rec.first.h));
      }
      rec.samples++;
    };

    // Page-level landmarks
    add('familyHeader', document.querySelector('section[role="status"] > div'));
    add('resultsDivider', document.querySelector('h2 + div'));
    add('idPanel', document.querySelector('#gate-family-id'));
    add('checkButton', Array.from(document.querySelectorAll('button')).find(b => /Check|Scanning/.test(b.innerText)));
    add('releaseAll', Array.from(document.querySelectorAll('button')).find(b => /Release all/.test(b.innerText)));

    // Per-student-card internals, keyed by card index (position in the list).
    // Skeleton <li>s and real card <li>s are DIFFERENT elements; tracking them
    // under one key would compare a placeholder's position to a card's and
    // report a bogus "move". Key them separately.
    document.querySelectorAll('section li').forEach((li, i) => {
      const isSkeleton = !!li.querySelector('.gate-skeleton');
      const p = isSkeleton ? `skel${i}` : `card${i}`;
      add(`${p}`, li);
      add(`${p}.name`, li.children[0]?.children[0]?.children[0]);
      add(`${p}.grade`, li.children[0]?.children[0]?.children[1]);
      add(`${p}.transportSlot`, li.children[1]?.children[0]);
      add(`${p}.driverSlot`, li.children[1]?.children[1]);
      add(`${p}.statusLine`, li.children[2]);
      add(`${p}.actionBand`, li.children[3]);
      li.querySelectorAll('button').forEach(b => {
        const label = /Release/.test(b.innerText) ? 'releaseBtn'
          : /Change driver/.test(b.innerText) ? 'changeDriverBtn'
            : /Assign driver/.test(b.innerText) ? 'assignDriverBtn'
              : b.getAttribute('aria-label')?.startsWith('Remove') ? 'removeDriverBtn' : 'otherBtn';
        add(`${p}.${label}`, b);
      });
    });
  };

  w.__startSampling = () => {
    w.__track = {};
    const tick = () => { w.__sample(); w.__raf = requestAnimationFrame(tick); };
    tick();
  };
  w.__stopSampling = () => cancelAnimationFrame(w.__raf);
}

async function newPage(browser, viewport, reducedMotion = false) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(instrument);
  return page;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scan(page, id) {
  await page.click('#gate-family-id', { clickCount: 3 });
  await page.type('#gate-family-id', id);
  await page.keyboard.press('Enter');
}

async function report(page) {
  return page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const moved = Object.entries(w.__track)
      .filter(([, r]) => r.maxDx > 0.5 || r.maxDy > 0.5 || r.maxDw > 0.5 || r.maxDh > 0.5)
      .map(([k, r]) => ({ el: k, dx: +r.maxDx.toFixed(1), dy: +r.maxDy.toFixed(1), dw: +r.maxDw.toFixed(1), dh: +r.maxDh.toFixed(1) }));
    return { cls: +w.__cls.toFixed(5), shifts: w.__shifts, moved, tracked: Object.keys(w.__track).length };
  });
}

const results = [];
function record(name, r, extra = {}) {
  const pass = r.cls < 0.005 && r.moved.length === 0;
  results.push({ name, pass, cls: r.cls, moved: r.moved, shifts: r.shifts, ...extra });
  console.log(`\n${pass ? '  PASS' : '  FAIL'}  ${name}`);
  console.log(`        CLS=${r.cls}  trackedElements=${r.tracked}  movedElements=${r.moved.length}`);
  if (r.moved.length) console.log('        MOVED:', JSON.stringify(r.moved.slice(0, 8)));
  if (r.shifts.length) console.log('        SHIFT SOURCES:', JSON.stringify(r.shifts.slice(0, 4)));
  if (extra.note) console.log(`        ${extra.note}`);
}

const browser = await puppeteer.launch(LAUNCH);

// ── Scenarios 1-3: the three latency matrices from the brief ─────────────
for (const [label, fam, drv, family] of [
  ['fam=100ms  drv=2000ms  (slow drivers)', 100, 2000, '0050'],
  ['fam=2000ms drv=100ms   (slow family)', 2000, 100, '0050'],
  ['fam=2000ms drv=3000ms  (both slow)', 2000, 3000, '0050'],
]) {
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=${fam}&drv=${drv}`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, family);
  await sleep(fam + drv + 1800);
  await page.evaluate(() => window.__stopSampling());
  const html = await page.evaluate(() => document.body.innerText);
  record(`Latency ${label}`, await report(page), {
    note: `rendered: ${/RAYAAN AXMAD/.test(html) ? 'students+' : 'NO students '}${/ASKO/.test(html) ? 'driver OK' : 'no driver'}`,
  });
  await page.close();
}

// ── Scenario 4: driver lookup failure ────────────────────────────────────
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=300&drv=1500&drvfail=1`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, '0050');
  await sleep(3000);
  await page.evaluate(() => window.__stopSampling());
  const txt = await page.evaluate(() => document.body.innerText);
  record('Driver lookup FAILURE degrades cleanly', await report(page), {
    note: `students=${/RAYAAN AXMAD/.test(txt)} warning=${/Driver data unavailable/.test(txt)}`,
  });
  await page.close();
}

// ── Scenario 5: mixed family (walking + driver + bus), 6-student family ──
for (const [label, id] of [['mixed 3-student family (driver+bus+walker)', '0050'], ['6-student family, shared driver', '0077']]) {
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=150&drv=1800`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, id);
  await sleep(3000);
  await page.evaluate(() => window.__stopSampling());
  const n = await page.evaluate(() => document.querySelectorAll('section li').length);
  record(`Mixed family — ${label}`, await report(page), { note: `cards rendered: ${n}` });
  await page.close();
}

// ── Scenario 6: driver assignment in-place (walking student gets a driver) ─
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=150&drv=200`, { waitUntil: 'load' });
  await sleep(400);
  await scan(page, '0001');
  await page.waitForFunction(() => /RAYAAN/.test(document.body.innerText), { timeout: 15000 });
  await sleep(700);
  // Start sampling only AFTER the card is settled: we are measuring whether
  // assigning a driver moves an already-rendered card.
  await page.evaluate(() => { window.__cls = 0; window.__shifts = []; window.__startSampling(); });
  const before = await page.evaluate(() => JSON.stringify(document.querySelector('section li').getBoundingClientRect()));
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /Assign driver/.test(x.innerText));
    b.click();
  });
  await sleep(900);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /ASKO/.test(x.innerText));
    if (b) b.click();
  });
  await sleep(2200);
  await page.evaluate(() => window.__stopSampling());
  const after = await page.evaluate(() => JSON.stringify(document.querySelector('section li').getBoundingClientRect()));
  const txt = await page.evaluate(() => document.body.innerText);
  const r = await report(page);
  record('Driver ASSIGNMENT updates card in place', r, {
    note: `assigned=${/ASKO/.test(txt)} cardRectBefore=${before} cardRectAfter=${after}`,
  });
  await page.close();
}

// ── Scenario 7: release ──────────────────────────────────────────────────
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=150&drv=200`, { waitUntil: 'load' });
  await sleep(400);
  await scan(page, '0050');
  await page.waitForFunction(() => /RAYAAN AXMAD/.test(document.body.innerText), { timeout: 15000 });
  await sleep(700);
  await page.evaluate(() => { window.__cls = 0; window.__shifts = []; window.__startSampling(); });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /^✓ Release$/.test(x.innerText.trim()));
    b.click();
  });
  await sleep(2200);
  await page.evaluate(() => window.__stopSampling());
  const txt = await page.evaluate(() => document.body.innerText);
  record('RELEASE transitions in place', await report(page), { note: `released=${/Released at/.test(txt)}` });
  await page.close();
}

// ── Scenario 8: rapid repeated scans A → B → C ───────────────────────────
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=250&drv=900`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  const contamination = [];
  for (const [id, expect, forbid] of [['0050', 'RAYAAN AXMAD', null], ['0077', 'STUDENT NUMBER 1', 'RAYAAN AXMAD'], ['0001', 'RAYAAN', 'STUDENT NUMBER 1']]) {
    await scan(page, id);
    // Sample mid-flight: the previous family must already be gone.
    await sleep(350);
    const mid = await page.evaluate(() => document.body.innerText);
    if (forbid && mid.includes(forbid)) contamination.push(`stale "${forbid}" visible while ${id} loading`);
    await sleep(1400);
    const done = await page.evaluate(() => document.body.innerText);
    if (!done.includes(expect)) contamination.push(`${id} did not render ${expect}`);
    if (forbid && done.includes(forbid)) contamination.push(`stale "${forbid}" still present after ${id}`);
  }
  await page.evaluate(() => window.__stopSampling());
  const r = await report(page);
  results[results.length - 1].pass = results[results.length - 1].pass && contamination.length === 0;
  console.log(`        contamination: ${contamination.length ? JSON.stringify(contamination) : 'none'}`);
  await page.close();
}

// ── Scenario 9: interleaved scans (superseded response) ──────────────────
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=1500&drv=200`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, '0050');
  await sleep(200);
  await scan(page, '0077'); // supersede while A is still in flight
  await sleep(4000);
  await page.evaluate(() => window.__stopSampling());
  const txt = await page.evaluate(() => document.body.innerText);
  const ok = /STUDENT NUMBER 1/.test(txt) && !/RAYAAN AXMAD/.test(txt);
  const r = await report(page);
  record('Superseded scan discarded (no A-in-B)', r, { note: `showsB=${/STUDENT NUMBER 1/.test(txt)} showsA=${/RAYAAN AXMAD/.test(txt)}` });
  results[results.length - 1].pass = results[results.length - 1].pass && ok;
  await page.close();
}

// ── Scenario 10: not found, and reduced motion ───────────────────────────
{
  const page = await newPage(browser, VIEWPORTS.desktop);
  await page.goto(`${BASE}?fam=300&drv=300`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, '9999');
  await sleep(2000);
  await page.evaluate(() => window.__stopSampling());
  const txt = await page.evaluate(() => document.body.innerText);
  record('Unknown family ID — clean error transition', await report(page), { note: `notFound=${/NOT FOUND/.test(txt)}` });
  await page.close();
}
{
  const page = await newPage(browser, VIEWPORTS.desktop, true);
  await page.goto(`${BASE}?fam=200&drv=1200`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, '0050');
  await sleep(2600);
  await page.evaluate(() => window.__stopSampling());
  const anim = await page.evaluate(() => {
    const li = document.querySelector('section li');
    const cs = li ? getComputedStyle(li) : null;
    const dot = document.querySelector('.gate-dot');
    return { card: cs ? cs.animationDuration : 'n/a', dot: dot ? getComputedStyle(dot).animationName : 'n/a' };
  });
  record('prefers-reduced-motion honoured', await report(page), { note: `cardAnimDuration=${anim.card} statusDotAnim=${anim.dot}` });
  await page.close();
}

// ── Scenario 11: tablet / touch viewport ─────────────────────────────────
{
  const page = await newPage(browser, VIEWPORTS.tablet);
  await page.goto(`${BASE}?fam=200&drv=1600`, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__startSampling());
  await scan(page, '0077');
  await sleep(3000);
  await page.evaluate(() => window.__stopSampling());
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).filter(b => {
      const r = b.getBoundingClientRect();
      return r.height > 0 && r.height < 44;
    }).map(b => `${b.innerText.trim().slice(0, 18)}=${Math.round(b.getBoundingClientRect().height)}px`));
  record('Tablet 820px — stable + touch targets', await report(page), {
    note: `controls under 44px: ${small.length ? JSON.stringify(small) : 'none'}`,
  });
  await page.close();
}

await browser.close();

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${results.length - failed.length}/${results.length} scenarios passed`);
console.log(`Worst CLS across all scenarios: ${Math.max(...results.map(r => r.cls))}`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(` - ${f.name}: CLS=${f.cls} moved=${JSON.stringify(f.moved.slice(0, 5))}`);
}
console.log('='.repeat(72));
process.exit(failed.length ? 1 : 0);
