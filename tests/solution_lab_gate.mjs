import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0,140)));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('text=PITTSBURNT'); await p.waitForTimeout(6000);
await p.selectOption('select >> nth=0','15'); await p.selectOption('select >> nth=1','older_adults'); await p.selectOption('select >> nth=2','heat2035');
await p.locator('button[aria-label="RUN CRASH TEST"]').click();
await p.waitForTimeout(9500);
await p.locator('button[aria-label="ADJUST"]').click(); await p.waitForTimeout(500);
await p.locator('button', { hasText: 'Add a solution' }).click();
await p.waitForTimeout(1500);
// innerText returns CSS-transformed text, and the badges are `uppercase`.
const t = (await p.locator('aside').innerText()).toUpperCase();
const want = ['CAN SIMULATE', 'NEEDS MEASURED TMRT', 'NO ADAPTER IN THIS BUILD',
  'ACCESS BENEFIT, NOT THERMAL'];
console.log('gate verdicts:', want.map(s => `${s}:${t.includes(s)}`).join('  '));
if (want.some(s => !t.includes(s))) { console.error('FAIL: a verdict is missing'); process.exitCode = 1; }
await p.screenshot({ path: `${OUT}/v26_6_lab.png` });
await p.locator('button', { hasText: 'Confirm these numbers and simulate' }).click();
await p.waitForFunction(() => /simulated two ways/i.test(
  document.querySelector('aside')?.innerText ?? ''), null, { timeout: 60000 });
const t2 = await p.locator('aside').innerText();
console.log('simulated two ways:', /simulated two ways/i.test(t2));

// The measure works on its own AND loses to a cheaper tree. Both halves are
// the point: a custom solution that is never bought is a finding.
const solo = /On its own[\s\S]{0,120}?(\d+) units built/i.exec(t2);
console.log('built on its own:', solo ? `${solo[1]} units` : 'MISSING');
if (!solo || Number(solo[1]) < 1) process.exitCode = 1;
console.log('reports why it loses to a tree:',
  /removed more severe minutes per dollar|costs \$/i.test(t2));

// And the plan reaches the map with its own mark, not a tree's.
await p.locator('aside button', { hasText: 'Close' }).click();
await p.waitForTimeout(11000);
const ms = await p.evaluate(() => window.__mapState?.() ?? null);
console.log('drawn on the map:', ms && ms.dynamicSourceFeatureCount > 100,
  JSON.stringify(ms));
if (!ms || ms.dynamicSourceFeatureCount <= 100) process.exitCode = 1;
const sprites = await p.evaluate(() => {
  const src = window.__map.getSource('placed');
  const d = src && src._data;
  return [...new Set((d?.features ?? []).map(f => f.properties.sprite))];
});
console.log('unit sprite:', sprites);
if (!sprites.includes('pb-custom')) process.exitCode = 1;
const body = await p.locator('body').innerText();
console.log('result card names the custom solution:',
  /shade sail/i.test(body));
await p.screenshot({ path: `${OUT}/v26_7_lab_sim.png` });
console.log('errors:', errs.length ? errs.slice(0,2) : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
