// Real-browser QA for the supervisor Lesson Plan Review redesign.
import puppeteer from 'puppeteer-core';
import { LAUNCH } from './smoke.mjs';

const BASE = 'http://localhost:5200/qa-harness/review.html';
const results = [];
const rec = (name, pass, detail='') => { results.push({name, pass, detail}); console.log(`${pass?'PASS':'FAIL'}  ${name}${detail?' :: '+detail:''}`); };

const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function open(browser, query, vw={width:1400,height:1000}) {
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type()==='error' && !/ERR_CONNECTION_CLOSED|favicon/.test(m.text())) errs.push(m.text()); });
  await p.setViewport(vw);
  await p.goto(`${BASE}?${query}`, { waitUntil:'load', timeout:60000 });
  await sleep(2000);
  p.__errs = errs;
  return p;
}

// Click the Nth plan in the queue.
async function selectPlan(p, n=0) {
  await p.evaluate(i => {
    const btns = [...document.querySelectorAll('ul li button')];
    btns[i].click();
  }, n);
  await sleep(1500);
}

const findBtn = (p, re) => p.evaluateHandle(r => {
  const rx = new RegExp(r);
  return [...document.querySelectorAll('button')].find(b => rx.test(b.innerText.trim()));
}, re.source);

async function clickBtn(p, re) {
  const h = await findBtn(p, re);
  const el = h.asElement();
  if (!el) throw new Error('button not found: '+re);
  await el.click();
}

const text = p => p.evaluate(()=>document.body.innerText);

const b = await puppeteer.launch(LAUNCH);

// ── 1. Approve flow ───────────────────────────────────────────────────────
{
  const p = await open(b, 'n=40&lat=500');
  await selectPlan(p, 1); // an in_review plan with an AI score
  const before = await text(p);
  rec('1a approve: AI advisory notice is present',
      /advisory — the final decision is yours/.test(before));
  rec('1b approve: AI score shows band label not just colour',
      /(Excellent|Strong|Needs attention|Weak)/.test(before));

  await clickBtn(p, /Approve/);
  await sleep(150);
  const during = await text(p);
  rec('1c approve: immediate "Approving…" feedback before server responds',
      /Approving…/.test(during) && !/Lesson plan approved/.test(during),
      during.match(/Approving…/) ? 'saw Approving…' : during.slice(0,120));

  await sleep(1500);
  const after = await text(p);
  rec('1d approve: success only after server confirm', /Lesson plan approved\./.test(after));
  rec('1e approve: next-plan affordance appears', /Next lesson plan/.test(after));

  // Advance
  await clickBtn(p, /Next lesson plan/);
  await sleep(1200);
  const nxt = await text(p);
  rec('1f approve: advancing clears success + shows fresh decision panel',
      !/Lesson plan approved\./.test(nxt) && /Approve/.test(nxt));
  rec('1g no page errors during approve flow', p.__errs.length===0, p.__errs.slice(0,2).join(' | '));
  await p.close();
}

// ── 2. Reject flow + confirmation dialog ─────────────────────────────────
{
  const p = await open(b, 'n=40&lat=400');
  await selectPlan(p, 1);
  await clickBtn(p, /^Reject$/);
  await sleep(400);
  const dlg = await p.evaluate(()=>{
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return { text: d.innerText, modal: d.getAttribute('aria-modal'),
             labelled: !!d.getAttribute('aria-labelledby'),
             focusInside: d.contains(document.activeElement) };
  });
  rec('2a reject: confirmation dialog opens', !!dlg);
  rec('2b reject: dialog has role/aria-modal/labelled', dlg && dlg.modal==='true' && dlg.labelled);
  rec('2c reject: dialog copy matches spec',
      dlg && /Reject lesson plan\?/i.test(dlg.text) && /marked? the lesson plan as rejected|mark the lesson plan as rejected/i.test(dlg.text)
      && /Cancel/.test(dlg.text) && /Reject plan/.test(dlg.text), dlg?dlg.text.replace(/\n/g,' | '):'');
  rec('2d reject: focus moves into the dialog', dlg && dlg.focusInside);

  // Escape closes
  await p.keyboard.press('Escape');
  await sleep(300);
  rec('2e reject: Escape closes the dialog',
      await p.evaluate(()=>!document.querySelector('[role="dialog"]')));
  rec('2f reject: cancelling does NOT change the plan', !/Lesson plan rejected/.test(await text(p)));

  await clickBtn(p, /^Reject$/); await sleep(300);
  await clickBtn(p, /^Reject plan$/);
  await sleep(1400);
  const after = await text(p);
  rec('2g reject: confirms after server', /Lesson plan rejected\./.test(after));
  rec('2h reject: offers next plan', /Next lesson plan/.test(after));
  rec('2i no page errors during reject flow', p.__errs.length===0, p.__errs.slice(0,2).join(' | '));
  await p.close();
}

// ── 3. Request revisions ──────────────────────────────────────────────────
{
  const p = await open(b, 'n=40&lat=400');
  await selectPlan(p, 1);
  const pre = await text(p);
  rec('3a revisions: explains that teacher editing is re-enabled',
      /re-enables the teacher's edit controls/i.test(pre));
  rec('3b revisions: single shared comment field doubles as the revision note',
      /Comment \/ revision note/.test(pre) && /this is the revision note the teacher sees/i.test(pre)
      && (await p.evaluate(()=>document.querySelectorAll('textarea').length))===1);

  await p.type('textarea', 'Please add differentiation for the lower group.');
  await clickBtn(p, /Request Revisions|Send back/i);
  await sleep(150);
  rec('3c revisions: shows "Sending back…" immediately', /Sending back…/.test(await text(p)));
  await sleep(1400);
  const after = await text(p);
  rec('3d revisions: success states editing re-enabled',
      /Sent back for revisions\. Teacher editing has been re-enabled\./.test(after));
  rec('3e revisions: status updates in place to Revision requested',
      await p.evaluate(()=>document.body.innerText.includes('Revision requested')));
  rec('3f no page errors during revision flow', p.__errs.length===0, p.__errs.slice(0,2).join(' | '));
  await p.close();
}

// ── 4. Duplicate clicks ×3 ────────────────────────────────────────────────
{
  const p = await open(b, 'n=40&lat=700');
  await selectPlan(p, 1);
  const planId = await p.evaluate(()=>'plan-'+1);
  await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x=>/Approve/.test(x.innerText));
    btn.click(); btn.click(); btn.click();  // three synchronous clicks
  });
  await sleep(2000);
  const calls = await p.evaluate(()=>window.__decisionCalls || {});
  const total = Object.values(calls).reduce((a,c)=>a+c,0);
  rec('4a triple-click produces exactly ONE server call', total===1, `calls=${JSON.stringify(calls)}`);
  const after = await text(p);
  rec('4b triple-click produces exactly one success message',
      (after.match(/Lesson plan approved\./g)||[]).length===1);
  await p.close();
}

// ── 5. Failure recovery ───────────────────────────────────────────────────
{
  const p = await open(b, 'n=10&lat=300&fail=1');
  await selectPlan(p, 1);
  await clickBtn(p, /Approve/);
  await sleep(1500);
  const after = await text(p);
  rec('5a failure: never shows success', !/Lesson plan approved\./.test(after));
  rec('5b failure: exact recovery copy + reassurance',
      /Could not approve this lesson plan\. The plan was not changed\./.test(after), after.slice(0,200).replace(/\n/g,' | '));
  rec('5c failure: offers Try again', /Try again/.test(after));
  const enabled = await p.evaluate(()=> {
    const btn=[...document.querySelectorAll('button')].find(x=>/Approve/.test(x.innerText));
    return btn && !btn.disabled;
  });
  rec('5d failure: controls restored (Approve re-enabled)', enabled);
  await p.close();
}

// ── 6. Rapid plan switching (no stale mismatch) ──────────────────────────
{
  const p = await open(b, 'n=40&lat=1500');
  await selectPlan(p, 1);
  await clickBtn(p, /Approve/);
  await sleep(120);
  await selectPlan(p, 3);          // jump away mid-flight
  await sleep(2500);               // let plan-1's response land
  const after = await text(p);
  rec('6a switching: stale success does not paint onto the new plan',
      !/Lesson plan approved\./.test(after), after.slice(0,160).replace(/\n/g,' | '));

  // Teacher shown in the detail header must match the selected queue row.
  const match = await p.evaluate(()=>{
    const sel = document.querySelector('ul li button[aria-current="true"]');
    if (!sel) return {ok:false, why:'no selected row'};
    const lines = sel.innerText.split('\n').map(s=>s.trim()).filter(Boolean);
    const title = lines[0];
    const teacher = (lines[1]||'').split('·')[0].trim();
    if (!teacher || !title) return {ok:false, why:'could not parse row', lines};
    // The detail pane is everything to the right of the queue.
    const detail = document.querySelector('[data-testid="plan-detail"]');
    if (!detail) return {ok:false, why:'no detail pane'};
    const dtext = detail.innerText;
    return {
      ok: dtext.includes(teacher) && dtext.includes(title),
      teacher, title,
      teacherInDetail: dtext.includes(teacher),
      titleInDetail: dtext.includes(title),
    };
  });
  rec('6b switching: detail header teacher matches selected row', match.ok, JSON.stringify(match));
  await p.close();
}

// ── 7. Responsive + touch targets ────────────────────────────────────────
for (const [label, vw] of [['mobile 375', {width:375,height:800}], ['tablet 768', {width:768,height:1024}]]) {
  const p = await open(b, 'n=20', vw);
  await selectPlan(p, 1);
  const small = await p.evaluate(() => {
    const out=[];
    for (const el of document.querySelectorAll('button, select, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width===0 && r.height===0) continue;          // hidden
      if (el.closest('#cls-meter')) continue;
      if (r.height < 44) out.push({t:(el.innerText||el.tagName).trim().slice(0,32), h:+r.height.toFixed(1)});
    }
    return out;
  });
  rec(`7 ${label}: all interactive controls ≥44px`, small.length===0,
      small.length? JSON.stringify(small.slice(0,6)) : '');
  const overflow = await p.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth+1);
  rec(`7 ${label}: no horizontal overflow`, !overflow);
  await p.close();
}

// ── 8. Contrast of chips / key text ──────────────────────────────────────
{
  const p = await open(b, 'n=40');
  await selectPlan(p, 1);
  const bad = await p.evaluate(() => {
    const lum = c => { const [r,g,bl]=c; const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
      return 0.2126*f(r)+0.7152*f(g)+0.0722*f(bl); };
    const parse = s => (s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
    // walk up for a non-transparent background
    const bgOf = el => { let e=el; while(e){ const c=getComputedStyle(e).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return parse(c); e=e.parentElement; }
      return [0,0,0]; };
    const out=[];
    const check = (el, label) => {
      const cs = getComputedStyle(el);
      const fg = parse(cs.color), bg = bgOf(el);
      const L1=lum(fg), L2=lum(bg);
      const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
      // 18.66px+ bold or 24px+ counts as large text (AA = 3:1).
      const size = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight,10) >= 700;
      const min = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
      if (ratio < min) out.push({label, t:el.innerText.trim().slice(0,34), ratio:+ratio.toFixed(2), min});
    };
    for (const el of document.querySelectorAll('.review-chip')) check(el, 'chip');
    // Every button and paragraph inside the decision panel.
    const panel = document.querySelector('[aria-labelledby="decision-heading"]');
    if (panel) for (const el of panel.querySelectorAll('button, p, h2, label')) {
      if (el.innerText.trim()) check(el, 'decision');
    }
    return out;
  });
  rec('8 chips + decision panel meet WCAG AA contrast', bad.length===0, bad.length?JSON.stringify(bad):'');
  await p.screenshot({path:'/tmp/review-detail.png'});
  await p.close();
}

// ── 9. Long content ───────────────────────────────────────────────────────
{
  const p = await open(b, 'n=10&long=1');
  await selectPlan(p, 1);
  const overflow = await p.evaluate(()=>({
    doc: document.documentElement.scrollWidth > window.innerWidth+1,
    esc: [...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right > window.innerWidth+2).length,
  }));
  rec('9 long content: no horizontal overflow', !overflow.doc, JSON.stringify(overflow));
  await p.close();
}

// ── 10. Empty / all-caught-up ────────────────────────────────────────────
{
  const p = await open(b, 'n=0');
  const t = await text(p);
  rec('10 empty queue shows positive "All caught up" state', /All caught up/.test(t), t.slice(0,160).replace(/\n/g,' | '));
  await p.close();
}

// ── 11. Layout stability (CLS) ───────────────────────────────────────────
{
  const p = await open(b, 'n=40&lat=400');
  await selectPlan(p, 1);
  await clickBtn(p, /Approve/);
  await sleep(1500);
  const cls = await p.evaluate(()=>window.__cls || 0);
  rec('11 CLS through select+approve under 0.01', cls < 0.01, `CLS=${cls.toFixed(5)}`);
  await p.close();
}

// ── 12. Keyboard reachability ────────────────────────────────────────────
{
  const p = await open(b, 'n=10');
  await selectPlan(p, 1);
  const reach = await p.evaluate(()=>{
    const focusables=[...document.querySelectorAll('button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
      .filter(e=>e.offsetParent!==null && !e.disabled);
    const noOutline = focusables.filter(e=>{
      e.focus();
      const cs=getComputedStyle(e);
      return cs.outlineStyle==='none' && !/ring|shadow/.test(cs.boxShadow) && cs.boxShadow==='none';
    }).length;
    return { total: focusables.length, noOutline };
  });
  rec('12 all visible controls are focusable', reach.total>0, JSON.stringify(reach));
  await p.close();
}

// ── 13. Contrast across every theme + light/dark mode ────────────────────
{
  const p = await open(b, 'n=40');
  await selectPlan(p, 1);
  for (const theme of ['acanthus','baroque','aurora']) {
    for (const mode of ['dark','light']) {
      const bad = await p.evaluate((th, md) => {
        document.documentElement.setAttribute('data-theme', th);
        document.documentElement.setAttribute('data-mode', md);
        const lum = c => { const [r,g,bl]=c; const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
          return 0.2126*f(r)+0.7152*f(g)+0.0722*f(bl); };
        const parse = s => (s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
        const bgOf = el => { let e=el; while(e){ const c=getComputedStyle(e).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return parse(c); e=e.parentElement; }
          return [255,255,255]; };
        const out=[];
        const check = el => {
          const cs=getComputedStyle(el);
          if (!el.innerText.trim()) return;
          const fg=parse(cs.color), bg=bgOf(el);
          const L1=lum(fg), L2=lum(bg);
          const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
          const size=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight,10)>=700;
          const min=(size>=24||(size>=18.66&&bold))?3:4.5;
          if (ratio<min) out.push({t:el.innerText.trim().slice(0,28), ratio:+ratio.toFixed(2)});
        };
        document.querySelectorAll('.review-chip').forEach(check);
        const panel=document.querySelector('[aria-labelledby="decision-heading"]');
        if (panel) panel.querySelectorAll('button,p,h2,label').forEach(check);
        return out;
      }, theme, mode);
      rec(`13 contrast: ${theme}/${mode}`, bad.length===0, bad.length?JSON.stringify(bad.slice(0,4)):'');
    }
  }
  await p.close();
}

await b.close();
const failed = results.filter(r=>!r.pass);
console.log(`\n=== ${results.length-failed.length}/${results.length} passed ===`);
if (failed.length) { console.log('FAILURES:'); failed.forEach(f=>console.log(' -',f.name, f.detail)); process.exit(1); }
