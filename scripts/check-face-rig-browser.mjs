// Optional real Blender -> arkit-face/1 test head -> contract verifier -> offline viewer renders.
// Needs Blender and Chromium. Writes renders and a contact sheet under .agent-meshes/face-rig-proof/<fixture>/.
// Usage: node scripts/check-face-rig-browser.mjs [test_head|test_robot]
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorGLB } from '../src/author.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { viewerScript } from '../src/preview-html.ts';

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
await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0}#stage{width:420px;height:420px}</style><div id="stage"></div><script src="mesh-viewer.js"></script><script>window.ready=MeshViewer.mount(document.getElementById('stage'),{glb:'${bytes.toString('base64')}',autoplay:false,floor:false,orbit:false,background:'#e8e4dc',view:{position:[0.07,0.16,0.42],target:[0,0.13,0]}}).then(v=>window.viewer=v);</script>`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 420 }, offline: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(join(output, 'index.html')).href);
  await page.evaluate(() => window.ready);
  const tiles = [];
  for (const [label, weights] of states) {
    const image = await page.evaluate(w => {
      // A multi-material face is one glTF mesh but several three.js meshes: set each target on every one.
      const meshes = []; viewer.root.traverse(o => { if (o.isMesh && o.morphTargetDictionary) meshes.push(o); });
      viewer.resetMorph();
      for (const mesh of meshes) for (const [target, weight] of Object.entries(w)) if (target in mesh.morphTargetDictionary) viewer.setMorph(mesh.name, target, weight);
      return viewer.screenshot();
    }, weights);
    const file = `${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
    await writeFile(join(output, file), Buffer.from(image.split(',')[1], 'base64'));
    tiles.push({ label, file });
  }
  await writeFile(join(output, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px sans-serif;display:grid;grid-template-columns:repeat(4,260px);gap:6px;padding:6px;background:#fff}figure{margin:0}img{width:260px;height:260px}figcaption{text-align:center}</style>${tiles.map(t => `<figure><img src="${t.file}"><figcaption>${t.label}</figcaption></figure>`).join('')}`);
  const sheet = await browser.newPage({ viewport: { width: 1070, height: 1200 } });
  await sheet.goto(pathToFileURL(join(output, 'sheet.html')).href);
  await sheet.screenshot({ path: join(output, 'contact-sheet.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS face rig: contract ok, ${tiles.length} states rendered to ${join(output, 'contact-sheet.png')}`);
} finally { await browser.close(); }
