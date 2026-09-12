import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0,140)));
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('text=PITTSBURNT'); await p.waitForTimeout(6000);
await p.selectOption('select >> nth=0','15'); await p.selectOption('select >> nth=1','older_adults'); await p.selectOption('select >> nth=2','heat2035');
await p.locator('button[aria-label="RUN CRASH TEST"]').click(); await p.waitForTimeout(9500);
await p.locator('button[aria-label="ADJUST"]').click(); await p.waitForTimeout(400);
await p.locator('button', { hasText: 'Add a solution' }).click(); await p.waitForTimeout(1500);
const head = await p.locator('aside').innerText();
console.log('provider line:', /Drafting with/.test(head) ? head.match(/Drafting with[^\n]*/)[0] : 'MISSING');

// The cached examples already contain a misting node, so waiting for that
// text would pass before the model had answered at all. The real signal is
// that the four cached cards are REPLACED by the single live draft.
const cached = 'Shade sail over the kerb';
console.log('cached examples on screen first:',
  (await p.locator('aside').innerText()).includes(cached));
await p.locator('textarea').fill('Install misting fans at the busiest bus stops.');
const t0 = Date.now();
await p.locator('button', { hasText: /DRAFT IT/i }).click();
await p.waitForFunction((c) => {
  const a = document.querySelector('aside');
  return a && !a.innerText.includes(c) && /MECHANISM|MICROCLIMATE/i.test(a.innerText);
}, cached, { timeout: 90000 });
console.log(`live draft replaced the examples in ${((Date.now()-t0)/1000).toFixed(1)}s`);
const t1 = await p.locator('aside').innerText();
console.log('mechanism refused:', /NO ADAPTER IN THIS BUILD/.test(t1.toUpperCase()));
console.log('only one card:', (t1.match(/microclimate node/gi) || []).length === 1);
console.log('no JSON blob shown:', !/\{"questions"/.test(t1));
await p.screenshot({ path: `${OUT}/v26_8_live_refused.png` });
// give the separate clarify call time to land
// The clarify call is the slow half and lands after the card is already up.
const tq = Date.now();
let qs = [];
// The gate writes its own questions immediately, and they name raw field
// paths ("effect.air_temp_delta_c"). The model's replacements never do, so
// the absence of that token is the signal that clarify actually landed -
// matching on wording alone passed against the gate's text.
await p.waitForFunction(
  () => {
    const li = [...document.querySelectorAll('aside li')].map(x => x.innerText);
    return li.length > 0 && !li.some(t => t.includes('effect.'));
  },
  null, { timeout: 90000 })
  .then(async () => { qs = await p.locator('aside li').allInnerTexts(); })
  .catch(() => console.log('  (clarify did not land in 90s)'));
console.log(`model questions arrived: ${qs.length > 0} `
  + `(${qs.length} of them, +${((Date.now()-tq)/1000).toFixed(1)}s)`);
const t2 = await p.locator('aside').innerText();
console.log('still no JSON blob:', !/\{"questions"/.test(t2));
if (!qs.length || /\{"questions"/.test(t2)) process.exitCode = 1;
await p.screenshot({ path: `${OUT}/v26_9_live_clarified.png` });
console.log('errors:', errs.length ? errs.slice(0,2) : 'none');
if (errs.length) process.exitCode = 1;
await b.close();
