import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';
const b = await puppeteer.launch(LAUNCH);
const p = await b.newPage();
await p.setViewport({width:1000,height:1200});
await p.goto('http://localhost:5199/qa-harness/index.html?fam=100&drv=300', { waitUntil:'load' });
await new Promise(r=>setTimeout(r,600));
await p.click('#gate-family-id',{clickCount:3}); await p.type('#gate-family-id','0050');
await p.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,2000));
console.log(await p.evaluate(()=>{
  const btn=[...document.querySelectorAll('button')].find(x=>/Release$/.test(x.innerText.trim()));
  const cs=btn?getComputedStyle(btn):null;
  return JSON.stringify({relH:btn?btn.getBoundingClientRect().height:null, minH:cs?cs.minHeight:null, bg:cs?cs.backgroundColor:null});
}));
await p.screenshot({path:'/tmp/gate.png'});
await b.close();
