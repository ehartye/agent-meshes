// Real offline browser proof of the public bundled factory, independent of a mount or GLB.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { viewerScript } from '../src/preview-html.ts';
import { solveJansenLeg } from '../src/recipes/strandbeest.ts';

const output = resolve('.agent-meshes/check-planar-linkage');
const spec = { fixed: { O: [0, 0], P: [-38, -7.8] }, crank: { name: 'C', center: 'O', radius: 15 }, joints: [
  { name: 'A', a: 'P', b: 'C', ra: 41.5, rb: 50, branch: 1 },
  { name: 'B', a: 'P', b: 'C', ra: 39.3, rb: 61.9, branch: -1 },
  { name: 'D', a: 'P', b: 'A', ra: 40.1, rb: 55.8, branch: 1 },
  { name: 'E', a: 'D', b: 'B', ra: 39.4, rb: 36.7, branch: -1 },
  { name: 'F', a: 'B', b: 'E', ra: 49, rb: 65.7, branch: 1 },
] };
await mkdir(output, { recursive: true });
await writeFile(join(output, 'mesh-viewer.js'), await viewerScript());
await writeFile(join(output, 'harness.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Analytic linkage proof</title><style>body{margin:0;padding:16px;background:#eee9df;color:#283d36;font:16px system-ui}canvas{width:100%;max-width:800px}input{width:100%;max-width:800px;display:block}</style><h1>One crank, one closed mechanism</h1><p>The foot trace and every rod come from the same analytic sample.</p><canvas id="drawing" width="800" height="700"></canvas><label>Crank angle<input id="angle" type="range" min="0" max="360" value="0"></label><script src="mesh-viewer.js"></script><script>
const spec=${JSON.stringify(spec)}, driver=MeshViewer.createPlanarLinkage(spec), canvas=document.getElementById('drawing'), ctx=canvas.getContext('2d');
const rods=[['O','C'],...spec.joints.flatMap(j=>[[j.a,j.name],[j.b,j.name]])], trace=Array.from({length:1441},(_,i)=>driver.sample(i/1440*Math.PI*2).points.F);
const xy=p=>[(p[0]+120)*5,130-p[1]*5];
function draw(angle){const points=driver.sample(angle).points;ctx.clearRect(0,0,800,700);ctx.strokeStyle='#288c80';ctx.lineWidth=3;ctx.beginPath();trace.forEach((p,i)=>{const q=xy(p);i?ctx.lineTo(...q):ctx.moveTo(...q)});ctx.stroke();ctx.strokeStyle='#847147';ctx.lineWidth=9;for(const[a,b]of rods){ctx.beginPath();ctx.moveTo(...xy(points[a]));ctx.lineTo(...xy(points[b]));ctx.stroke()}ctx.font='18px system-ui';for(const[name,p]of Object.entries(points)){const[x,y]=xy(p);ctx.fillStyle=name==='F'?'#288c80':'#283d36';ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.fillText(name,x+11,y-9)}}
document.getElementById('angle').oninput=e=>draw(Number(e.target.value)/180*Math.PI);draw(0);window.proof={driver,trace,draw};
</script>`);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 940 } });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(join(output, 'harness.html')).href); await page.waitForFunction(() => window.proof);
  const result = await page.evaluate(() => {
    const { driver } = window.proof, saved = driver.sample(.37), frozen = Object.isFrozen(saved) && Object.isFrozen(saved.points) && Object.values(saved.points).every(Object.isFrozen);
    const samples = Array.from({ length: 721 }, (_, i) => driver.sample(i / 720 * Math.PI * 2));
    driver.sample(-4); driver.sample(3);
    return { samples, frozen, unchanged: JSON.stringify(saved) === JSON.stringify(driver.sample(.37)) };
  });
  let maxReferenceError = 0;
  for (const [i, sample] of result.samples.entries()) {
    const reference = solveJansenLeg(i / 720 * Math.PI * 2);
    for (const [name, p] of Object.entries(sample.points)) maxReferenceError = Math.max(maxReferenceError, Math.hypot(p[0] - reference[name][0], p[1] - reference[name][1]));
    assert.ok(sample.minimumBranchGap > 24);
  }
  assert.ok(maxReferenceError < 1e-10); assert.equal(result.frozen, true); assert.equal(result.unchanged, true);
  await page.screenshot({ path: join(output, 'full-turn-trace.png'), fullPage: true });
  await page.locator('#angle').fill('160'); await page.locator('#angle').dispatchEvent('input');
  await page.screenshot({ path: join(output, 'raised-return.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'phone.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const report = { samples: result.samples.length, maxReferenceError, frozen: result.frozen, unchanged: result.unchanged, errors, requests, output };
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await context.close();
} finally { await browser.close(); }
