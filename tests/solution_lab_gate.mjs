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
await p.waitForTimeout(2500);
const t2 = await p.locator('aside').innerText();
console.log('simulated:', /priced against the built-ins/.test(t2));
if (!/priced against the built-ins/.test(t2)) process.exitCode = 1;
console.log('engine owns the numbers:', /Experienced UTCI/.test(t2) && /37\.79/.test(t2));
await p.screenshot({ path: `${OUT}/v26_7_lab_sim.png` });
console.log('errors:', errs.length ? errs.slice(0,2) : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
