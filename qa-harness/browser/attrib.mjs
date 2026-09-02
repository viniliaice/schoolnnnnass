import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b = await puppeteer.launch(LAUNCH);
const p = await b.newPage();
await p.evaluateOnNewDocument(() => {
  window.__s = [];
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__s.push({
    v: e.value, t: Math.round(e.startTime),
    src: (e.sources||[]).map(s => ({ tag: s.node?.tagName, cls: String(s.node?.className||'').slice(0,60),
      prev: JSON.stringify(s.previousRect), cur: JSON.stringify(s.currentRect) })) });
  }).observe({type:'layout-shift', buffered:true});
});
await p.setViewport({width:1100,height:1100});
await p.goto('http://localhost:5199/qa-harness/index.html?fam=150&drv=1200',{waitUntil:'load'});
await new Promise(r=>setTimeout(r,400));
await p.click('#gate-family-id',{clickCount:3}); await p.type('#gate-family-id','0050');
await p.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,3000));
console.log(JSON.stringify(await p.evaluate(()=>window.__s), null, 1));
await b.close();
