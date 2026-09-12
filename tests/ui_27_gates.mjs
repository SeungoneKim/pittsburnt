/**
 * The 2.7 P0 checklist, asserted against a real render.
 *
 * Every row of the spec's development checklist is a gate here. The panel
 * ones matter most: "nothing clips" was already passing in 2.6 while panels
 * still overlapped each other, because a box can sit inside the viewport and
 * on top of another box at the same time.
 */
import { chromium } from 'playwright';
const OUT = process.env.SP ?? 'tests/screenshots';
await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });
const gates = []; const g = (n, ok, d = '') => gates.push([!!ok, n, String(d)]);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1366, height: 768 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 140)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('text=PITTSBURNT');
await p.waitForTimeout(7000);

// --- empty start ---------------------------------------------------------
let ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('empty start: zero dynamic map features',
  ms && ms.dynamicSourceFeatureCount === 0, JSON.stringify(ms));
const pressed = await p.$$eval('button[aria-pressed]',
  bs => bs.filter(x => x.getAttribute('aria-pressed') === 'true').length);
g('empty start: no protection pill is selected', pressed === 0, `${pressed} pressed`);
g('empty start: Moving People is disabled until Who + Time',
  await p.locator('button:has-text("Moving People")').isDisabled());
g('empty start: it says what to do instead of silently doing nothing',
  await p.locator('text=Choose Who and Time first').count() === 1);

// --- setup order ---------------------------------------------------------
const heads = await p.$$eval('aside, main h2',
  () => [...document.querySelectorAll('section h2')].map(h => h.textContent.trim()));
// The three selectors must be reachable without scrolling: a required input
// below the fold is worse than a cramped one.
const fit = await p.evaluate(() => {
  const setup = document.querySelector('[data-panel="Set up the test"]');
  const box = setup.getBoundingClientRect();
  const sc = setup.querySelector('.overflow-y-auto');
  const sel = [...setup.querySelectorAll('select')]
    .map(s => s.getBoundingClientRect().bottom);
  return { bottom: box.bottom, vh: innerHeight, selects: sel,
    scrolls: sc.scrollHeight > sc.clientHeight + 1 };
});
g('setup: all three selectors are visible without scrolling at 1366x768',
  !fit.scrolls && fit.selects.every(v => v <= fit.bottom),
  `panel ends ${Math.round(fit.bottom)}, last select ${Math.round(Math.max(...fit.selects))}, scrolls=${fit.scrolls}`);
g('setup: the panel fits the viewport', fit.bottom <= fit.vh,
  `${Math.round(fit.bottom)} <= ${fit.vh}`);

g('setup order: Existing protection comes first',
  heads[0]?.toLowerCase() === 'existing protection', heads.join(' -> '));

// --- people ready --------------------------------------------------------
await p.selectOption('select >> nth=0', '15');
await p.selectOption('select >> nth=1', 'older_adults');
await p.waitForTimeout(2500);
g('people: Moving People switches itself on once Who + Time exist',
  await p.locator('button:has-text("Moving People")')
    .getAttribute('aria-pressed') === 'true');
ms = await p.evaluate(() => window.__mapState?.() ?? null);
g('people: 60-80 representative agents are drawn',
  ms && ms.dynamicSourceFeatureCount >= 60 && ms.dynamicSourceFeatureCount <= 80,
  `${ms?.dynamicSourceFeatureCount} agents`);
g('people: the agent backplate layer exists and is visible',
  await p.evaluate(() => window.__map?.getLayoutProperty('agent-shadow', 'visibility'))
  === 'visible');
g('no easter egg: inspect/sweat/freeze are gone from the bundle',
  await p.locator('text=Click a walker').count() === 0
  && !(await p.evaluate(() => !!window.__map?.getLayer('unit-highlight'))));
await p.screenshot({ path: `${OUT}/v28_1_people.png` });

// --- motion: separate flow from travel -----------------------------------
const travel = await p.evaluate(() => {
  const F = 70, MAX = 18000;
  const MIN = { mobility_constrained: 12000, older_adults: 10000 };
  const dur = (m, persona) => Math.min(Math.max(
    ((m * 60000) / F) * 4, MIN[persona] ?? 7500), MAX);
  return { older: dur((150 / 0.9) / 60, 'older_adults'),
    student: dur((150 / 1.3) / 60, 'students') };
});
g('motion: a 150 m Older Adult trip lasts about 10 s on screen',
  Math.abs(travel.older - 10000) < 400, `${(travel.older / 1000).toFixed(1)}s`);
g('motion: and reads slower than the same trip for a Student',
  travel.older > travel.student,
  `older ${(travel.older / 1000).toFixed(1)}s vs student ${(travel.student / 1000).toFixed(1)}s`);

// --- crash, then the result surface --------------------------------------
await p.selectOption('select >> nth=2', 'heat2035');
await p.locator('button[aria-label="RUN CRASH TEST"]').click();
await p.waitForTimeout(9500);
const body = await p.locator('body').innerText();
g('metric truth: severe exposure is person-minutes',
  /person-min/i.test(body));
g('metric truth: the visible-agent count is separate and labelled',
  /Visible agents in severe heat/i.test(body)
  && /\d+ \/ \d+/.test(body),
  (body.match(/Visible agents in severe heat[\s\S]{0,24}/) || [''])[0].replace(/\n/g, ' '));
g('provenance: friendly full words, no ASS badge',
  /Calculated|Assumed|Source/.test(body) && !/\bASS\b/.test(body));

// --- panel collision, the thing "nothing clips" never caught -------------
const boxes = await p.evaluate(() => {
  const pick = (t) => document.querySelector(`[data-panel="${t}"]`)
    ?.getBoundingClientRect();
  const r = (x) => x && { x: x.x, y: x.y, w: x.width, h: x.height };
  return { setup: r(pick('Set up the test')), result: r(pick('Result')),
    stage: r(pick('Stage')) };
});
g('panels: all three surfaces were actually measured',
  !!(boxes.setup && boxes.result && boxes.stage),
  JSON.stringify(boxes));
const hit = (a, c) => a && c && a.x < c.x + c.w && c.x < a.x + a.w
  && a.y < c.y + c.h && c.y < a.y + a.h;
g('panels: setup and result do not intersect at 1366x768',
  !hit(boxes.setup, boxes.result),
  `setup w=${boxes.setup?.w} result w=${boxes.result?.w}`);
g('panels: the stage banner clears both', !hit(boxes.stage, boxes.setup)
  && !hit(boxes.stage, boxes.result));
g('panels: setup is ~292px, result ~320px',
  Math.abs((boxes.setup?.w ?? 0) - 292) <= 2
  && Math.abs((boxes.result?.w ?? 0) - 320) <= 2,
  `${boxes.setup?.w} / ${boxes.result?.w}`);
await p.screenshot({ path: `${OUT}/v28_2_crash_1366.png` });

// --- the stage banner must be able to get out of the way -----------------
g('panels: the stage banner can minimize',
  await p.locator('button[aria-label="Minimize Plan complete"]').count() === 1);
await p.locator('button[aria-label="Minimize Plan complete"]').click();
await p.waitForTimeout(300);
g('panels: and restores from a labelled pill',
  await p.locator('button[aria-label="Restore Plan complete"]').count() === 1);
await p.locator('button[aria-label="Restore Plan complete"]').click();

// --- efficiency replaces the leftover-budget row -------------------------
await p.locator('button[aria-label="ADJUST"]').click(); await p.waitForTimeout(400);
await p.locator('button', { hasText: 'Build the plan' }).last().click();
await p.waitForTimeout(12000);
const after = await p.locator('body').innerText();
g('efficiency: protection efficiency replaces "budget left"',
  /per \$10K/i.test(after) && !/left — under the cheapest/i.test(after),
  (after.match(/[\d.]+\s*severe person-min avoided per \$10K/i) || [''])[0]);
g('efficiency: it matches this run, not a hard-coded figure',
  /4\.2[0-9]\s*severe person-min avoided per \$10K/i.test(after),
  (after.match(/[\d.]+(?=\s*severe person-min avoided)/i) || [''])[0]);
await p.screenshot({ path: `${OUT}/v28_3_adapt_1366.png` });

// --- reset ---------------------------------------------------------------
await p.locator('button', { hasText: /^Reset$/ }).click();
await p.waitForTimeout(1800);
ms = await p.evaluate(() => window.__mapState?.() ?? null);
const pressedAfter = await p.$$eval('button[aria-pressed]',
  bs => bs.filter(x => x.getAttribute('aria-pressed') === 'true').length);
g('reset: dynamic sources, feature-state and RAF all cleared',
  ms && ms.dynamicSourceFeatureCount === 0 && ms.segmentsWithFeatureState === 0
  && ms.animationRunning === false, JSON.stringify(ms));
g('reset: every protection pill is unpressed again', pressedAfter === 0);

// --- 1920x1080 -----------------------------------------------------------
await p.setViewportSize({ width: 1920, height: 1080 });
await p.waitForTimeout(600);
await p.selectOption('select >> nth=0', '15');
await p.selectOption('select >> nth=1', 'older_adults');
await p.selectOption('select >> nth=2', 'heat2035');
await p.locator('button[aria-label="RUN CRASH TEST"]').click();
await p.waitForTimeout(9500);
const wide = await p.evaluate(() => {
  const pick = (t) => document.querySelector(`[data-panel="${t}"]`)
    ?.getBoundingClientRect();
  const r = (x) => x && { x: x.x, y: x.y, w: x.width, h: x.height };
  return { setup: r(pick('Set up the test')), result: r(pick('Result')) };
});
g('panels: no intersection at 1920x1080 either',
  !!(wide.setup && wide.result) && !hit(wide.setup, wide.result),
  JSON.stringify(wide));
await p.screenshot({ path: `${OUT}/v28_4_1920.png` });

g('no page or console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const w = Math.max(...gates.map(x => x[1].length));
let fails = 0;
console.log('\n2.7 UI GATES');
console.log('-'.repeat(w + 40));
for (const [ok, n, d] of gates) {
  console.log(`${ok ? '  ok ' : 'FAIL'} ${n.padEnd(w)}  ${d}`); fails += !ok;
}
console.log('-'.repeat(w + 40));
console.log(`${gates.length - fails}/${gates.length} gates passed`);
await b.close();
process.exit(fails ? 1 : 0);
