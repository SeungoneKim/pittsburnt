/**
 * The demo sentence, driven through the real UI against the real model.
 *
 *   "Protect older adults on Forbes, don't let any corridor get nothing,
 *    cap Forbes at half the budget"
 *
 * Asserts the three things that make the claim honest: the sentence becomes a
 * readable typed program, the solver certifies the plan optimal, and every
 * stated constraint is reported including the ones that never bound.
 */
import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const SENTENCE = "Protect older adults on Forbes, don't let any corridor get "
  + "nothing, cap Forbes at half the budget";
// The second demo sentence exercises what the first does not: a corridor
// floor scoped to NAMED streets, an unambiguous short form the compiler has
// to resolve ("Craig Street" -> "South Craig Street"), and a requirement for
// an intervention type efficiency alone never buys.
const SENTENCE2 = "Use a $250,000 budget to protect older adults. Prioritize "
  + "Forbes Avenue, guarantee at least one intervention on Fifth Avenue and "
  + "Craig Street, cap spending on Forbes at 50% of the total budget, and use "
  + "both trees and shaded waiting shelters where they produce measurable "
  + "impact.";
const gates = []; const g = (n, ok, d = '') => gates.push([!!ok, n, String(d)]);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
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
// Two ways in, because three clicks deep is not discoverable on stage.
g('one-click entry sits on the map toolbar',
  await p.locator('button', { hasText: /^State a goal$/ }).count() === 1);
await p.locator('button[aria-label="ADJUST"]').click(); await p.waitForTimeout(400);
g('the Adjust panel leads with it, above budget',
  await p.locator('button', { hasText: 'State a goal in plain English' })
    .count() === 1);
await p.locator('button', { hasText: 'State a goal in plain English' }).click();
await p.waitForTimeout(1200);

const pre = await p.locator('aside').innerText();
g('panel names the model and the real corridor count',
  /Compiled by/.test(pre) && /\d+ real corridors/.test(pre),
  (pre.match(/Compiled by[^\n]*/) || [''])[0].slice(0, 90));
g('the demo sentence is prefilled',
  (await p.locator('textarea').inputValue()).includes('cap Forbes at half'));

const t0 = Date.now();
await p.locator('button', { hasText: /BUILD THE PROGRAM/i }).click();
await p.waitForFunction(() => /Solved —/.test(
  document.querySelector('aside')?.innerText ?? ''), null, { timeout: 120000 });
const took = ((Date.now() - t0) / 1000).toFixed(1);
const t = await p.locator('aside').innerText();

g(`compiled and solved end to end (${took}s)`, true, `${took}s`);
// The heading is CSS-uppercased, so innerText returns it in caps.
g('the typed program is shown before the plan', /the program it built/i.test(t));
g('objective is stated in words',
  /Minimise heat load/i.test(t), (t.match(/Minimise[^\n]*/) || [''])[0].slice(0, 60));
g('constraint: focus on Forbes',
  /Weight benefit on Forbes Avenue/i.test(t));
g('constraint: nobody left out',
  /Every walked corridor receives at least 1 unit/i.test(t));
g('constraint: Forbes spend cap',
  /At most 50% of the budget on Forbes Avenue/i.test(t));
g('solver certifies optimality', /optimum|optimality/i.test(t),
  (t.match(/proved within[^\n·]*/) || [''])[0]);
g('reports a constraint that never bound', /never bound/i.test(t),
  (t.match(/\$[\d,]+ of the \$[\d,]+ ceiling[^\n]*/) || [''])[0].slice(0, 80));
g('reports the corridor floor it applied', /corridors with demand/i.test(t),
  (t.match(/\d+ of \d+ corridors with demand/) || [''])[0]);
g('shows before -> after for heat load', /Heat load/.test(t) && /→/.test(t));
await p.screenshot({ path: `${OUT}/v27_1_program.png` });

// the plan must actually land on the map behind the panel
await p.locator('aside button', { hasText: 'Close' }).click();
await p.waitForTimeout(11000);
const ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('the solved plan is drawn on the map',
  ms && ms.dynamicSourceFeatureCount > 200, JSON.stringify(ms));
const body = await p.locator('body').innerText();
g('the result card shows the solved plan', /after adjust/i.test(body));
await p.screenshot({ path: `${OUT}/v27_2_program_map.png` });

// --- the second demo sentence, exactly as a planner would write it ------
// It says "Craig Street", which Oakland has two of. So this drives the whole
// live sequence: refuse -> offer the real candidates -> one click -> solve.
await p.locator('button', { hasText: /^State a goal$/ }).first().click();
await p.waitForTimeout(900);
await p.locator('textarea').fill(SENTENCE2);
await p.locator('button', { hasText: /BUILD THE PROGRAM/i }).click();
await p.waitForFunction(() => /will not guess/i.test(
  document.querySelector('aside')?.innerText ?? ''), null, { timeout: 150000 });
const t2 = await p.locator('aside').innerText();
g('2: an ambiguous street stops the plan instead of being guessed',
  /could mean/i.test(t2) && /will not guess/i.test(t2),
  (t2.match(/You wrote[^\n]*/) || [''])[0].slice(0, 96));
g('2: both real candidates are named',
  /North Craig Street/.test(t2) && /South Craig Street/.test(t2));
g('2: nothing was solved while the reference was unclear',
  !/Solved —/.test(t2));
await p.screenshot({ path: `${OUT}/v27_3_ambiguous.png` });

g('2: one-click fixes are offered',
  await p.locator('aside button', { hasText: 'South Craig Street' }).count() >= 1);
await p.locator('aside button', { hasText: 'South Craig Street' }).first().click();
await p.waitForTimeout(300);
g('2: clicking a candidate rewrites the sentence in place',
  (await p.locator('textarea').inputValue()).includes('South Craig Street')
  && !/on Craig Street/.test(await p.locator('textarea').inputValue()));

const t1 = Date.now();
await p.locator('button', { hasText: /BUILD THE PROGRAM/i }).click();
await p.waitForFunction(() => /Solved —/.test(
  document.querySelector('aside')?.innerText ?? ''), null, { timeout: 150000 });
const t3 = await p.locator('aside').innerText();
g(`2: solves once the street is named (${((Date.now() - t1) / 1000).toFixed(1)}s)`,
  true);
g('2: scopes the floor to the named streets only',
  /Fifth Avenue/.test(t3) && !/Every walked corridor/.test(t3),
  (t3.match(/[^\n]*each receive at least[^\n]*/) || [''])[0].slice(0, 70));
g('2: requires both intervention types',
  (t3.match(/at least 1 (tree|shaded shelter)/gi) || []).length === 2,
  (t3.match(/at least 1 [a-z ]+\(s\)/gi) || []).join(' | ').slice(0, 70));
g('2: buys a shelter pure efficiency never would',
  /Solved — \d+ trees, [1-9]/.test(t3), (t3.match(/Solved —[^\n]*/) || [''])[0]);
g('2: the Forbes cap binds here', /no further unit fits inside it/.test(t3),
  (t3.match(/\$[\d,]+ of the \$[\d,]+ ceiling/) || [''])[0]);
g('2: only the untestable phrase is unsupported', /measurable impact/.test(t3));
await p.screenshot({ path: `${OUT}/v27_4_sentence2.png` });

g('no page or console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const w = Math.max(...gates.map(x => x[1].length));
let fails = 0;
console.log('\nSTATED-PROGRAM GATES  (live model + HiGHS)');
console.log('-'.repeat(w + 42));
for (const [ok, n, d] of gates) {
  console.log(`${ok ? '  ok ' : 'FAIL'} ${n.padEnd(w)}  ${d}`); fails += !ok;
}
console.log('-'.repeat(w + 42));
console.log(`${gates.length - fails}/${gates.length} gates passed`);
await b.close();
process.exit(fails ? 1 : 0);
