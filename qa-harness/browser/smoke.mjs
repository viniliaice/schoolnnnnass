import puppeteer from 'puppeteer-core';
export const LAUNCH = {
  executablePath: '/tmp/chromium',
  headless: true,
  protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
         '--use-gl=swiftshader','--in-process-gpu','--disable-software-rasterizer',
         '--hide-scrollbars','--font-render-hinting=none','--force-device-scale-factor=1'],
  env: { ...process.env, LD_LIBRARY_PATH: '/tmp/clib:/tmp/clib/lib' },
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await puppeteer.launch(LAUNCH);
  const p = await b.newPage();
  await p.setViewport({ width: 900, height: 1000 });
  await p.goto('http://localhost:5199/?fam=100&drv=300', { waitUntil: 'load', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));
  console.log('HAS INPUT:', await p.$('#gate-family-id') !== null);
  console.log('TEXT:', (await p.evaluate(()=>document.body.innerText)).slice(0,200).replace(/\n/g,' | '));
  await b.close();
}
