import { chromium } from 'playwright';
const OUT='/private/tmp/claude-501/-Users-seungonekim-Documents-vscode-pittsburnt/c4565d4b-3096-4bb4-bc6f-f4028fafa723/scratchpad';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1500,height:1050}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,140)));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,140));});
await p.goto('http://localhost:3000',{waitUntil:'domcontentloaded'});
await p.waitForSelector('text=PITTSBURNT'); await p.waitForTimeout(9000);

const t0=Date.now();
await p.click('text=RUN CRASH TEST');
const seen=[];
for (let i=0;i<32;i++){
  const h=await p.locator('.w-\\[520px\\] .text-lg').textContent().catch(()=>null);
  if(h && seen[seen.length-1]!==h) seen.push(`${h} @${((Date.now()-t0)/1000).toFixed(1)}s`);
  await p.waitForTimeout(220);
}
console.log('CRASH TEST beats:'); seen.forEach(x=>console.log('  '+x));
await p.waitForTimeout(800);
const panelUp = await p.locator('text=Thermal stress (UTCI)').count();
console.log('  result panel after sequence:', panelUp?'shown':'MISSING');
await p.screenshot({path:`${OUT}/60_stage.png`});

const t1=Date.now();
await p.click('text=ADAPT PITTSBURGH');
const seen2=[];
for (let i=0;i<44;i++){
  const h=await p.locator('.w-\\[520px\\] .text-lg').textContent().catch(()=>null);
  if(h && seen2[seen2.length-1]!==h) seen2.push(`${h} @${((Date.now()-t1)/1000).toFixed(1)}s`);
  await p.waitForTimeout(220);
}
console.log('ADAPT beats:'); seen2.forEach(x=>console.log('  '+x));
await p.waitForTimeout(600);
console.log('  before/after landed:', await p.locator('text=Before').count()?'yes':'no');
await p.screenshot({path:`${OUT}/61_adapt_stage.png`});
console.log('errors:', errs.length?errs.slice(0,2):'none');
await b.close();
