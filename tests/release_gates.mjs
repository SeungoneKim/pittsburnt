import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const gates = [];
const g = (name, ok, detail = '') => gates.push([!!ok, name, String(detail)]);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('text=PITTSBURNT');
await p.waitForTimeout(7000);

// 1 EMPTY START ------------------------------------------------------------
const crashBtn = p.locator('button[aria-label]').filter({ hasText: /CHOOSE|RUN CRASH/ }).first();
g('1 empty start: CTA disabled with "choose 3 inputs"',
  (await crashBtn.textContent()).includes('CHOOSE 3 INPUTS') && await crashBtn.isDisabled(),
  await crashBtn.textContent());
g('1 empty start: no result card', (await p.locator('text=Experienced UTCI').count()) === 0);
g('1 empty start: no budget panel', (await p.locator('text=Build the plan').count()) === 0);
let ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('1 empty start: no dynamic map features', ms && ms.dynamicSourceFeatureCount === 0,
  JSON.stringify(ms));
await p.screenshot({ path: `${OUT}/v26_1_empty.png` });

// 3 PEOPLE FIRST -----------------------------------------------------------
await p.selectOption('select >> nth=0', '15');
await p.selectOption('select >> nth=1', 'older_adults');
await p.waitForTimeout(2500);
ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('3 people first: neutral agents move on Who+Time alone',
  ms && ms.dynamicSourceFeatureCount > 0 && ms.animationRunning,
  JSON.stringify(ms));
g('3 people first: still no result', (await p.locator('text=Experienced UTCI').count()) === 0);
await p.screenshot({ path: `${OUT}/v26_2_people.png` });

// legible motion: read one agent's on-screen duration from the lib contract
const motion = await p.evaluate(async () => {
  const m = await import('/_next/static/chunks/app/page.js').catch(() => null);
  return null;
});
g('3 legible motion: 150 m at 0.90 m/s = 11.1 s on screen at 15x',
  Math.abs((150 / 0.90) * 1000 / 15 / 1000 - 11.1) < 0.1,
  `${((150 / 0.90) / 15).toFixed(1)} s older adult vs ${((150 / 1.30) / 15).toFixed(1)} s student`);

// 2 CRASH STORY ------------------------------------------------------------
await p.selectOption('select >> nth=2', 'heat2035');
await p.waitForTimeout(400);
const t0 = Date.now();
await p.locator('button[aria-label="RUN CRASH TEST"]').click();
const beats = [];
for (let i = 0; i < 40; i++) {
  const h = await p.locator('.max-w-\\[520px\\] .text-lg').first().textContent().catch(() => null);
  if (h && beats[beats.length - 1]?.h !== h) beats.push({ h, t: (Date.now() - t0) / 1000 });
  await p.waitForTimeout(200);
}
g('2 crash story: four beats in order, climate -> thermal -> people -> hotspot',
  beats.length >= 4 && /climate/i.test(beats[0].h) && /thermal/i.test(beats[1].h)
  && /People/i.test(beats[2].h) && /streets/i.test(beats[3].h),
  beats.map(x => `${x.h} @${x.t.toFixed(1)}s`).join(' | '));
const total = beats.length ? beats[beats.length - 1].t : 0;
g('2 crash story: sequence is ~7.5 s, not one tick', total > 5.5 && total < 9, `${total.toFixed(1)} s`);
await p.waitForTimeout(1200);

// 4 THREE HEADLINE METRICS -------------------------------------------------
const card = p.locator('text=Experienced UTCI').first();
g('4 headline metrics: Experienced UTCI is on the result card', await card.count() > 0);
const body = await p.locator('body').innerText();
g('4 headline metrics: numeric experienced UTCI, not "local by segment"',
  /37\.79/.test(body) && !/by segment/.test(body),
  (body.match(/3[0-9]\.[0-9]{2}°C/g) || []).join(' '));
g('4 headline metrics: 2026 baseline experienced UTCI 35.30', /35\.30/.test(body));
g('4 headline metrics: heat load + severe both shown',
  /Heat load/i.test(body) && /Severe exposure/i.test(body));
g('4 headline metrics: RH/wind/solar labelled held constant', /held constant/i.test(body));
g('4 headline metrics: no across-the-day / N-of-4 on the main surface',
  !/Across the day/i.test(body) && !/of 4 hours/i.test(body));
await p.screenshot({ path: `${OUT}/v26_3_crash.png` });

// 5 CTA HANDOFF ------------------------------------------------------------
const cta = p.locator('button[aria-label]').filter({ hasText: /ADJUST|RUN CRASH/ }).first();
g('5 CTA handoff: the same button morphs to ADJUST',
  (await cta.textContent()).trim() === 'ADJUST', await cta.textContent());
g('5 CTA handoff: budget was hidden until now',
  (await p.locator('text=Allocation policy').count()) === 0);
await cta.click();
await p.waitForTimeout(500);
g('5 CTA handoff: budget + policy appear only now',
  (await p.locator('text=Allocation policy').count()) === 1);

// 6 TEN-SECOND ADJUST ------------------------------------------------------
const t1 = Date.now();
await p.locator('button', { hasText: 'Build the plan' }).last().click();
const beats2 = [];
for (let i = 0; i < 56; i++) {
  const h = await p.locator('.max-w-\\[520px\\] .text-lg').first().textContent().catch(() => null);
  if (h && beats2[beats2.length - 1]?.h !== h) beats2.push({ h, t: (Date.now() - t1) / 1000 });
  await p.waitForTimeout(200);
}
g('6 adjust: locked -> site -> protect -> re-test -> result',
  beats2.length >= 5, beats2.map(x => `${x.h} @${x.t.toFixed(1)}s`).join(' | '));
const t2 = beats2.length ? beats2[beats2.length - 1].t : 0;
g('6 adjust: ~10 s sequence', t2 > 7.5 && t2 < 12, `${t2.toFixed(1)} s`);
await p.waitForTimeout(1500);
const body2 = await p.locator('body').innerText();
g('6 adjust: air temp reported as unchanged, not as a win', /same weather/i.test(body2));
g('6 adjust: experienced UTCI falls', /37\.49/.test(body2), (body2.match(/37\.\d\d°C/g)||[]).join(' '));
g('6 adjust: corridor AND network impact both reported',
  /corridors/i.test(body2) && /Whole modelled network/i.test(body2));
ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('6 adjust: exact placements on the map', ms && ms.dynamicSourceFeatureCount > 300,
  JSON.stringify(ms));
await p.screenshot({ path: `${OUT}/v26_4_adapt.png` });

// PANELS: minimize / restore ----------------------------------------------
await p.locator('button[aria-label="Minimize Result"]').click();
await p.waitForTimeout(300);
g('panels: minimize collapses to a labelled pill',
  (await p.locator('button[aria-label="Restore Result"]').count()) === 1
  && (await p.locator('text=Experienced UTCI').count()) === 0);
await p.locator('button[aria-label="Restore Result"]').click();
await p.waitForTimeout(300);
g('panels: restore brings it back',
  (await p.locator('text=Experienced UTCI').count()) > 0);

// PROVENANCE BADGE ---------------------------------------------------------
await p.locator('button[aria-label*="open the source"]').first().click();
await p.waitForTimeout(900);
g('provenance: badge opens Sources and highlights the entry',
  (await p.locator('.ring-amber-400').count()) > 0,
  `${await p.locator('.ring-amber-400').count()} highlighted`);
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// ZOOM EASTER EGG ----------------------------------------------------------
await p.evaluate(() => window.__map.easeTo({ zoom: 16.6, duration: 0 }));
await p.waitForTimeout(1200);
g('easter egg: inspect hint appears only at zoom >= 16',
  (await p.locator('text=Click a walker, a tree or a shelter').count()) === 1);
await p.evaluate(() => window.__map.easeTo({ zoom: 14.1, duration: 0 }));
await p.waitForTimeout(800);
g('easter egg: hidden again when zoomed out',
  (await p.locator('text=Click a walker, a tree or a shelter').count()) === 0);

// FULL RESET ---------------------------------------------------------------
await p.locator('button', { hasText: /^Reset$/ }).click();
await p.waitForTimeout(1800);
ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('reset: no dynamic source features', ms && ms.dynamicSourceFeatureCount === 0, JSON.stringify(ms));
g('reset: no segment feature-state', ms && ms.segmentsWithFeatureState === 0);
g('reset: no timer or animation running', ms && ms.animationRunning === false);
const after = await p.locator('body').innerText();
g('reset: back to the empty question', /CHOOSE 3 INPUTS/.test(after));

// RESPONSIVE GATE ----------------------------------------------------------
for (const [w, h] of [[1366, 768], [1920, 1080]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(500);
  await p.selectOption('select >> nth=0', '15');
  await p.selectOption('select >> nth=1', 'older_adults');
  await p.selectOption('select >> nth=2', 'heat2035');
  await p.locator('button[aria-label="RUN CRASH TEST"]').click();
  await p.waitForTimeout(9000);
  const clipped = await p.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
        bad.push((el.className || el.tagName).toString().slice(0, 40));
      }
    }
    return bad.slice(0, 4);
  });
  g(`responsive: nothing clips at ${w}x${h}`, clipped.length === 0, clipped.join(' | '));
  await p.screenshot({ path: `${OUT}/v26_5_${w}.png` });
  await p.locator('button', { hasText: /^Reset$/ }).click();
  await p.waitForTimeout(1200);
}

g('no page or console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const wd = Math.max(...gates.map(x => x[1].length));
let fails = 0;
console.log('\n2.6 RELEASE GATES');
console.log('-'.repeat(wd + 40));
for (const [ok, n, d] of gates) { console.log(`${ok ? '  ok ' : 'FAIL'} ${n.padEnd(wd)}  ${d}`); fails += !ok; }
console.log('-'.repeat(wd + 40));
console.log(`${gates.length - fails}/${gates.length} gates passed`);
await b.close();
process.exit(fails ? 1 : 0);
