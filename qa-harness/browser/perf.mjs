import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b = await puppeteer.launch(LAUNCH);
const p = await b.newPage();
await p.evaluateOnNewDocument(() => {
  window.__rpc = [];
  window.__t0 = performance.now();
});
await p.setViewport({width:1100,height:1100});
// Instrument the mock at module level via a fetch-free hook: patch after load.
await p.goto('http://localhost:5199/qa-harness/index.html?fam=400&drv=400',{waitUntil:'load'});
await p.evaluate(async () => {
  const mod = await import('/qa-harness/mockSupabase.ts');
  const orig = mod.supabase.rpc.bind(mod.supabase);
  mod.supabase.rpc = async (fn, args) => {
    const start = performance.now();
    window.__rpc.push({ fn, start: Math.round(start), args: JSON.stringify(args).slice(0,60) });
    const r = await orig(fn, args);
    const rec = window.__rpc.find(x => x.fn===fn && x.start===Math.round(start));
    if (rec) rec.end = Math.round(performance.now());
    return r;
  };
});
await new Promise(r=>setTimeout(r,300));
await p.click('#gate-family-id',{clickCount:3}); await p.type('#gate-family-id','0050');
await p.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,2500));
const rpc = await p.evaluate(()=>window.__rpc);
console.log('RPC CALLS:', JSON.stringify(rpc, null, 1));
const lf = rpc.filter(r=>r.fn==='lookup_family'), gp = rpc.filter(r=>r.fn==='get_family_pickups');
console.log(`\nlookup_family calls: ${lf.length}  get_family_pickups calls: ${gp.length}`);
if (lf[0] && gp[0]) {
  const overlap = Math.min(lf[0].end, gp[0].end) - Math.max(lf[0].start, gp[0].start);
  console.log(`PARALLEL? start delta = ${Math.abs(lf[0].start-gp[0].start)}ms, overlap = ${overlap}ms`);
  console.log(`Sequential would take ${(lf[0].end-lf[0].start)+(gp[0].end-gp[0].start)}ms; actual wall = ${Math.max(lf[0].end,gp[0].end)-Math.min(lf[0].start,gp[0].start)}ms`);
}
// Animation audit: any animation on a layout-affecting property?
const anims = await p.evaluate(()=>document.getAnimations().map(a=>({
  name: a.animationName || (a.effect?.getKeyframes?.()||[]).map(k=>Object.keys(k).join('/')).join('|'),
  target: a.effect?.target?.className?.toString().slice(0,40), state: a.playState })));
console.log('\nRUNNING ANIMATIONS AFTER SETTLE:', JSON.stringify(anims));
await b.close();
