import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b = await puppeteer.launch(LAUNCH);
// Real laptop viewport heights (browser chrome already subtracted).
for (const [name, vp] of [
  ['MacBook Air 13"  1440x900  -> ~760', {width:1440,height:760}],
  ['1366x768 laptop            -> ~630', {width:1366,height:630}],
  ['1920x1080                  -> ~940', {width:1920,height:940}],
]) {
  const p = await b.newPage();
  await p.setViewport(vp);
  await p.goto('http://localhost:5200/qa-harness/review.html?n=20&lat=300',{waitUntil:'load'});
  await new Promise(r=>setTimeout(r,2200));
  await p.evaluate(()=>[...document.querySelectorAll('ul li button')][3].click());
  await new Promise(r=>setTimeout(r,1600));
  const m = await p.evaluate(()=>{
    const panel=document.querySelector('[aria-labelledby="decision-heading"]');
    const r=panel.getBoundingClientRect();
    const vh=window.innerHeight;
    return {
      panelH:+r.height.toFixed(0),
      vh,
      pctOfViewport:+(r.height/vh*100).toFixed(1),
      // How much vertical room is left for the lesson plan itself.
      planVisible:+(vh-r.height).toFixed(0),
      sticky:getComputedStyle(panel).position,
    };
  });
  console.log(name.padEnd(38), JSON.stringify(m));
  await p.close();
}
await b.close();
