import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b = await puppeteer.launch(LAUNCH);
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 1000 });
await p.goto('http://localhost:5200/qa-harness/review.html?n=20&lat=300', { waitUntil:'load' });
await new Promise(r=>setTimeout(r,2200));
await p.evaluate(()=>[...document.querySelectorAll('ul li button')][3].click());
await new Promise(r=>setTimeout(r,1600));
// The panel is sticky; screenshot its own element rather than a page clip.
const el = await p.$('[aria-labelledby="decision-heading"]');
await el.screenshot({ path: '/tmp/panel.png' });
console.log(await p.evaluate(()=>document.querySelector('[aria-labelledby="decision-heading"]').innerText));
await b.close();
