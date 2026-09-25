// Optional real Blender -> arkit-face/1 test head -> contract verifier -> offline viewer renders.
// Needs Blender and Chromium. Writes renders, a contact sheet and a jaw sheet (neutral, jawOpen .5 and 1 from the
// front, three-quarter and close up, with the measured chin drop) under .agent-meshes/face-rig-proof/<fixture>/.
// Usage: node scripts/check-face-rig-browser.mjs [test_head|test_robot|test_frog|test_kid]
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorGLB } from '../src/author.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { previewHTML, viewerScript } from '../src/preview-html.ts';

const fixture = process.argv[2] ?? 'test_head';
if (!/^test_[a-z]+$/.test(fixture)) throw new Error(`Unknown fixture ${fixture}`);
const output = resolve('.agent-meshes/face-rig-proof', fixture);
await mkdir(output, { recursive: true });
const result = await authorGLB(resolve(`tests/fixtures/face-rig/${fixture}.py`), join(output, 'model.glb'));
const bytes = await readFile(result.output);
const report = await verifyFaceContract(bytes);
await writeFile(join(output, 'contract.json'), JSON.stringify(report, null, 2));
assert.equal(report.ok, true, report.failures.join('\n'));

const presets = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + bytes.readUInt32LE(12)))).nodes.find(n => n.extras?.arkitFace).extras.arkitFace.emotions;
const states = [
  ['neutral', {}], ['blink .25', { eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25 }], ['blink .5', { eyeBlinkLeft: 0.5, eyeBlinkRight: 0.5 }],
  ['blink .75', { eyeBlinkLeft: 0.75, eyeBlinkRight: 0.75 }], ['blink 1', { eyeBlinkLeft: 1, eyeBlinkRight: 1 }],
  ['wink left', { eyeBlinkLeft: 1 }], ['squint', { eyeSquintLeft: 1, eyeSquintRight: 1 }], ['blink .5 + squint', { eyeBlinkLeft: 0.5, eyeBlinkRight: 0.5, eyeSquintLeft: 1, eyeSquintRight: 1 }],
  ['wide', { eyeWideLeft: 1, eyeWideRight: 1 }], ['jaw .5', { jawOpen: 0.5 }], ['jaw 1', { jawOpen: 1 }],
  ...['happy', 'sad', 'angry', 'surprised', 'scared'].map(name => [name, Object.fromEntries(Object.entries(presets[name]).filter(([k]) => !k.startsWith('eyeLook')))]),
];
await writeFile(join(output, 'mesh-viewer.js'), await viewerScript());
await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0}#stage{width:420px;height:420px}</style><div id="stage"></div><script src="mesh-viewer.js"></script><script>window.ready=MeshViewer.mount(document.getElementById('stage'),{glb:'${bytes.toString('base64')}',autoplay:false,floor:false,orbit:false,background:'#e8e4dc',view:{position:[0.07,0.14,0.46],target:[0,0.11,0]}}).then(v=>window.viewer=v);</script>`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 420 }, offline: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(join(output, 'index.html')).href);
  await page.evaluate(() => window.ready);
  const tiles = [];
  const shoot = (weights, view) => page.evaluate(([w, v]) => {
    // A multi-material face is one glTF mesh loaded as several three.js meshes; its node name (a morph group)
    // drives the target on every primitive at once.
    viewer.resetMorph();
    for (const group of viewer.morphGroups) for (const [target, weight] of Object.entries(w)) if (viewer.morphTargets(group).includes(target)) viewer.setMorph(group, target, weight);
    if (v) viewer.view(v);
    return viewer.screenshot();
  }, [weights, view]);
  for (const [label, weights] of states) {
    const image = await shoot(weights);
    const file = `${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
    await writeFile(join(output, file), Buffer.from(image.split(',')[1], 'base64'));
    tiles.push({ label, file });
  }
  await writeFile(join(output, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px sans-serif;display:grid;grid-template-columns:repeat(4,260px);gap:6px;padding:6px;background:#fff}figure{margin:0}img{width:260px;height:260px}figcaption{text-align:center}</style>${tiles.map(t => `<figure><img src="${t.file}"><figcaption>${t.label}</figcaption></figure>`).join('')}`);
  const sheet = await browser.newPage({ viewport: { width: 1070, height: 1200 } });
  await sheet.goto(pathToFileURL(join(output, 'sheet.html')).href);
  await sheet.screenshot({ path: join(output, 'contact-sheet.png'), fullPage: true });
  // The puppet jaw: neutral, jawOpen .5 and 1 from the front, three-quarter and close to the mouth.
  const views = [['front', { position: [0, 0.11, 0.5], target: [0, 0.11, 0] }], ['three-quarter', { position: [0.34, 0.13, 0.36], target: [0, 0.11, 0] }],
    ['mouth close-up', { position: [0.05, 0.09, 0.26], target: [0, 0.085, 0] }]];
  const jawTiles = [];
  for (const [view, spec] of views) for (const weight of [0, 0.5, 1]) {
    const file = `jaw-${weight}-${view.replace(/[^a-z]+/g, '-')}.png`;
    await writeFile(join(output, file), Buffer.from((await shoot({ jawOpen: weight }, spec)).split(',')[1], 'base64'));
    jawTiles.push({ label: `jawOpen ${weight}, ${view}`, file });
  }
  const m = report.measurements;
  // E3 in pixels: an exact ID render (512 px tall, front view) of the silhouette, the upper and the lower teeth.
  const pixels = weight => page.evaluate(w => {
    viewer.resetMorph();
    for (const group of viewer.morphGroups) if (viewer.morphTargets(group).includes('jawOpen')) viewer.setMorph(group, 'jawOpen', w);
    viewer.view({ position: [0, 0.11, 0.6], target: [0, 0.11, 0] });
    // The silhouette with everything drawn; the teeth alone (other: null hides the rest) so lips never occlude them.
    const shape = viewer.idRender({ materials: {}, other: '#ff0000', background: '#000000', width: 512, height: 512 });
    const image = viewer.idRender({ materials: { teeth_upper: '#0000ff', teeth_lower: '#00ff00' }, other: null, background: '#000000', width: 512, height: 512 });
    const stats = { top: Infinity, bottom: -1, upper: [0, 0, 0, Infinity, -Infinity], lower: [0, 0, 0] };
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4, r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (shape.data[i]) { stats.top = Math.min(stats.top, y); stats.bottom = Math.max(stats.bottom, y); }
      if (b > 128) { stats.upper[0]++; stats.upper[1] += x; stats.upper[2] += y; stats.upper[3] = Math.min(stats.upper[3], x); stats.upper[4] = Math.max(stats.upper[4], x); }
      if (g > 128) { stats.lower[0]++; stats.lower[1] += x; stats.lower[2] += y; }
    }
    return stats;
  }, weight);
  const [shut, open] = [await pixels(0), await pixels(1)];
  const lowerShift = open.lower[2] / open.lower[0] - (shut.lower[0] ? shut.lower[2] / shut.lower[0] : NaN);
  const upperShift = open.upper[2] / open.upper[0] - shut.upper[2] / shut.upper[0];
  const width = shut.upper[4] - shut.upper[3] + 1;
  const e3 = `ID render 512 px: silhouette bottom drops ${open.bottom - shut.bottom} px = ${(100 * (open.bottom - shut.bottom) / (shut.bottom - shut.top)).toFixed(1)}% of the ${shut.bottom - shut.top} px chin-to-crown silhouette; lower teeth centroid drops ${lowerShift.toFixed(1)} px = ${(100 * lowerShift / width).toFixed(0)}% of the ${width} px upper-teeth (mouth) width; upper teeth move ${upperShift.toFixed(2)} px (teeth drawn alone, unoccluded)`;
  const caption = `${fixture}: jawOpen=1 drops the chin ${(m.chinDrop * 1000).toFixed(1)} mm = ${(m.chinDropRatio * 100).toFixed(1)}% of the ${(m.faceHeight * 1000).toFixed(0)} mm face; lower teeth drop ${(m.teeth.lowerDrop * 1000).toFixed(1)} mm; upper lip moves ${(m.upperLipMove * 1000).toFixed(2)} mm; between the teeth rows the front view sees ${m.mouthOpen.hits.join(', ')}. ${e3}`;
  await writeFile(join(output, 'jaw.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px sans-serif;background:#fff;padding:6px}p{margin:4px 0 8px}div{display:grid;grid-template-columns:repeat(3,300px);gap:6px}figure{margin:0}img{width:300px;height:300px}figcaption{text-align:center}</style><p>${caption}</p><div>${jawTiles.map(t => `<figure><img src="${t.file}"><figcaption>${t.label}</figcaption></figure>`).join('')}</div>`);
  const jawPage = await browser.newPage({ viewport: { width: 930, height: 1040 } });
  await jawPage.goto(pathToFileURL(join(output, 'jaw.html')).href);
  await jawPage.screenshot({ path: join(output, 'jaw-sheet.png'), fullPage: true });
  // The build's preview.html for a morph-only head: no clip controls, a slider per morph and the emotion presets.
  await writeFile(join(output, 'preview.html'), await previewHTML(fixture, bytes));
  const preview = await browser.newPage({ viewport: { width: 1100, height: 760 }, offline: true });
  preview.on('pageerror', e => errors.push(e.message));
  await preview.goto(pathToFileURL(join(output, 'preview.html')).href);
  await preview.waitForFunction(() => /morphs/.test(document.getElementById('status').textContent));
  const page2 = await preview.evaluate(() => ({
    clipHidden: document.getElementById('clip').hidden, sliders: [...document.querySelectorAll('input[data-morph]')].map(i => i.dataset.morph),
    presets: [...document.querySelectorAll('button[data-preset]')].map(b => b.dataset.preset),
  }));
  assert.equal(page2.clipHidden, true);
  assert.ok(page2.sliders.includes('jawOpen') && page2.sliders.length >= 21, `morph sliders: ${page2.sliders.length}`);
  assert.deepEqual(page2.presets, ['neutral', 'happy', 'sad', 'angry', 'surprised', 'scared']);
  await preview.click('button[data-preset="surprised"]');
  const surprised = await preview.evaluate(() => ({ jaw: document.querySelector('input[data-morph="jawOpen"]').value, weight: window.meshPreview.viewer.getMorph('face', 'jawOpen') }));
  assert.ok(Number(surprised.jaw) > 0.3 && surprised.weight === Number(surprised.jaw), JSON.stringify(surprised));
  await preview.screenshot({ path: join(output, 'preview.png') });
  console.log(caption);
  assert.deepEqual(errors, []);
  console.log(`PASS face rig: contract ok, ${tiles.length} states rendered to ${join(output, 'contact-sheet.png')}`);
} finally { await browser.close(); }
