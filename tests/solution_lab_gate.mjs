/**
 * Add a solution (Beta), end to end.
 *
 * The default example is reflective cool pavement, and the point of it is
 * that the honest answer is the unwelcome one: the engine recomputes UTCI
 * from mean radiant temperature, and a reflective surface raises the radiant
 * load on a pedestrian even while the ground under them cools. A demo that
 * quietly showed it helping would be the exact failure this whole gate exists
 * to prevent, so these assert the sign.
 */
import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const gates = []; const g = (n, ok, d = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL'} ${n}${d ? '  ' + d : ''}`);
  gates.push([!!ok, n, String(d)]);
};

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1050 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 140)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('text=PITTSBURNT'); await p.waitForTimeout(6000);
await p.selectOption('select >> nth=0', '15');
await p.selectOption('select >> nth=1', 'older_adults');
await p.selectOption('select >> nth=2', 'heat2035');
await p.locator('button[aria-label="RUN CRASH TEST"]').click();
await p.waitForTimeout(9500);
await p.locator('button[aria-label="ADJUST"]').click(); await p.waitForTimeout(400);
await p.locator('button', { hasText: 'Describe a measure, let a language model' }).click();
await p.waitForTimeout(1500);

const t = (await p.locator('aside').innerText()).toUpperCase();
g('cool pavement is the default example',
  (await p.locator('aside h3').first().textContent()) === 'Reflective cool pavement');
g('the gate still refuses what it cannot model',
  ['NO ADAPTER IN THIS BUILD', 'ACCESS BENEFIT, NOT THERMAL']
    .every(s => t.includes(s)));
g('a surface treatment is now simulatable, not blanket-refused',
  t.includes('CAN SIMULATE'));

await p.locator('button', { hasText: 'Confirm these numbers and simulate' })
  .first().click();
await p.waitForSelector('text=Same budget, three measures', { timeout: 90000 });
await p.waitForTimeout(600);
const m = await p.locator('text=Same budget, three measures')
  .locator('xpath=ancestor::div[2]').innerText();

g('the comparison names all three measures',
  /Reflective cool pavement/i.test(m) && /Street tree/i.test(m)
  && /Shaded waiting shelter/i.test(m));
g('it says plainly that the proposal makes things worse',
  /leaves people hotter/i.test(m),
  (m.match(/[^\n]*leaves people hotter[^\n]*/) || [''])[0].slice(0, 74));
g('cool pavement ADDS heat load, and is shown adding it',
  /\+\s?\d/.test(m) && /adds heat/i.test(m));
g('its experienced UTCI change is positive (worse)',
  /\+0\.0\d °C/.test(m), (m.match(/\+0\.\d+ °C/) || [''])[0]);
g('trees avoid far more than either alternative',
  /−394|-394/.test(m), (m.match(/[−-]39\d/) || [''])[0]);
g('the optimiser buys none of it when they compete',
  /and\s+0\s+of/i.test(m.replace(/\s+/g, ' ')),
  (m.replace(/\s+/g, ' ').match(/The optimiser buys[^.]*\./) || [''])[0].slice(0, 96));
g('the per-$10K efficiency is shown for every measure',
  (m.match(/AVOIDED PER \$10K/gi) || []).length === 3);
g('provenance of the numbers is stated',
  /computed by the deterministic engine/i.test(m));
await p.screenshot({ path: `${OUT}/v31_benchmark.png` });

// It must close cleanly and leave the plan on the map behind it.
await p.locator('div', { hasText: /^Same budget, three measures/ })
  .locator('button', { hasText: 'Close' }).first().click();
await p.waitForTimeout(400);
g('the comparison closes', await p.locator('text=Same budget, three measures').count() === 0);
await p.locator('aside button', { hasText: 'Close' }).first().click();
await p.waitForTimeout(11000);
const ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('the deployment is drawn on the map', ms && ms.dynamicSourceFeatureCount > 10,
  JSON.stringify(ms));
const sprites = await p.evaluate(() => {
  const d = window.__map.getSource('placed')?._data;
  return [...new Set((d?.features ?? []).map(f => f.properties.sprite))];
});
g('drawn with its own mark, not a tree', sprites.includes('pb-custom'),
  String(sprites));

g('no page or console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

let fails = 0;
for (const [ok] of gates) fails += !ok;
console.log(`\n${gates.length - fails}/${gates.length} gates passed`);
await b.close();
process.exit(fails ? 1 : 0);
