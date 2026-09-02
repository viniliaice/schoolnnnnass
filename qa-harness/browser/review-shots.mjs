import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b=await puppeteer.launch(LAUNCH);
async function shot(name, q, vw, fn) {
  const p=await b.newPage(); await p.setViewport(vw);
  await p.goto(`http://localhost:5200/qa-harness/review.html?${q}`,{waitUntil:'load'});
  await new Promise(r=>setTimeout(r,2000));
  await p.evaluate(()=>[...document.querySelectorAll('ul li button')][1]?.click());
  await new Promise(r=>setTimeout(r,1600));
  if (fn) await fn(p);
  await p.screenshot({path:`/tmp/rv-${name}.png`});
  await p.close();
}
await shot('light','n=20',{width:1400,height:1050}, async p=>{
  await p.evaluate(()=>{document.documentElement.setAttribute('data-mode','light');
    document.documentElement.setAttribute('data-theme','aurora');});
  await new Promise(r=>setTimeout(r,400));
});
await shot('mobile','n=20',{width:375,height:900});
await shot('success','n=20&lat=200',{width:1400,height:1050}, async p=>{
  await p.evaluate(()=>[...document.querySelectorAll('button')].find(x=>/Approve/.test(x.innerText)).click());
  await new Promise(r=>setTimeout(r,1200));
});
await b.close(); console.log('ok');
