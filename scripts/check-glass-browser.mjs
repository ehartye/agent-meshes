// Exercises glass (alphaMode BLEND and KHR_materials_transmission) end to end in Chromium: a face inside a clear
// bubble is visible through it in the MeshViewer, a multi-model stage, a plain three.js page and the workbench's
// fixed-view renders; the ID render counts the face through unnamed glass and the glass itself when named; glass
// gets no outline hull and casts no shadow. Pass a GLB path to also check a built model (for example a suited
// character) whose glass is named "*glass*". Writes evidence under artifacts/glass-check.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { viewerScript } from '../src/preview-html.ts';
import { captureProject } from '../src/capture.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(repository, 'artifacts/glass-check');
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, 'mesh-viewer.js'), await viewerScript());

function helmet() {
  let p = createProject('glass-helmet');
  p = applyOperation(p, { op: 'add', part: { name: 'head', geometry: { type: 'sphere', size: [0.3, 0.36, 0.3], segments: 32 }, position: [0, 1.6, 0], color: '#c08060' } });
  p = applyOperation(p, { op: 'add', part: { name: 'eyes', geometry: { type: 'box', size: [0.18, 0.04, 0.04] }, position: [0, 1.65, 0.135], color: '#1a2230' } });
  p = applyOperation(p, { op: 'add', part: { name: 'body', geometry: { type: 'capsule', size: [0.4, 1.2, 0.3] }, position: [0, 0.8, 0], color: '#e8dcc0' } });
  p = applyOperation(p, { op: 'add', part: { name: 'bubble', geometry: { type: 'sphere', size: [0.46, 0.5, 0.46], segments: 48 }, position: [0, 1.62, 0], color: '#e8f6ff', material: { metalness: 0, roughness: 0.05, opacity: 0.18, ior: 1.5, doubleSided: true } } });
  return p;
}
const project = helmet();
const bytes = await exportGLB(project);
const verification = await verifyGLB(bytes);
assert.equal(verification.errors, 0, 'helmet GLB has no validator errors');
assert.equal(verification.warnings, 0, 'helmet GLB has no validator warnings');
const glbs = { helmet: Buffer.from(bytes).toString('base64') };
const extra = process.argv[2] ? resolve(process.argv[2]) : null;
if (extra) glbs.model = (await readFile(extra)).toString('base64');

const page_ = join(evidence, 'harness.html');
await writeFile(page_, `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#one,#stage{width:640px;height:640px}</style>
<div id="one"></div><div id="stage"></div><script>window.GLBS = ${JSON.stringify(glbs)};</script><script src="mesh-viewer.js"></script>
<script>window.ready = Promise.all([
  MeshViewer.mount(document.getElementById('one'), { glb: GLBS.helmet, background: '#dce7eb', autoplay: false, outline: 0.004 }),
  MeshViewer.mountStage(document.getElementById('stage'), { models: { a: { glb: GLBS.helmet, position: [-0.4, 0, 0] }, b: { glb: GLBS.helmet, position: [0.4, 0, 0] } }, background: '#dce7eb', autoplay: false }),
]).then(([v, s]) => { window.viewer = v; window.stage = s; });</script></html>`);

const browser = await chromium.launch();
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 1300 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(page_).href, { waitUntil: 'load' });
  await page.evaluate(() => window.ready);
  const result = await page.evaluate(() => {
    const out = {};
    const count = (image, hex) => MeshViewer.countColors(image)[hex] ?? 0;
    const bubble = viewer.object('bubble'), material = bubble.material;
    out.material = { transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite, side: material.side, castShadow: bubble.castShadow, glass: bubble.userData.glass };
    out.hulls = viewer.scene.getObjectsByProperty('name', 'bubble_outline').length + viewer.scene.getObjectsByProperty('name', 'head_outline').length;
    out.hullNames = []; viewer.scene.traverse(o => { if (o.userData.outline) out.hullNames.push(o.name); });
    out.views = {};
    for (const view of ['front', 'right', 'perspective']) {
      viewer.view(view); viewer.frame(1.1);
      const through = viewer.idRender({ parts: { head: '#ff0000', eyes: '#00ff00' }, width: 256, height: 256 });
      const named = viewer.idRender({ parts: { head: '#ff0000', eyes: '#00ff00', bubble: '#0000ff' }, width: 256, height: 256 });
      out.views[view] = { head: count(through, '#ff0000'), eyes: count(through, '#00ff00'), headBehindNamedGlass: count(named, '#ff0000'), glass: count(named, '#0000ff') };
      out.views[view].shot = viewer.screenshot();
    }
    stage.view('front');
    const staged = stage.idRender({ parts: { 'a/head': '#ff0000', 'b/head': '#00ff00' }, width: 320, height: 160 });
    out.stage = { a: count(staged, '#ff0000'), b: count(staged, '#00ff00'), glassA: stage.model('a').object('bubble').castShadow, shot: stage.screenshot() };
    return out;
  });
  for (const [view, value] of Object.entries(result.views)) await writeFile(join(evidence, `viewer-${view}.png`), Buffer.from(value.shot.split(',')[1], 'base64'));
  await writeFile(join(evidence, 'stage.png'), Buffer.from(result.stage.shot.split(',')[1], 'base64'));
  const check = (ok, message) => { if (!ok) failures.push(message); };
  check(result.material.transparent && result.material.opacity < 0.5 && !result.material.depthWrite, `viewer glass is blended without depth writes: ${JSON.stringify(result.material)}`);
  check(result.material.side === 2, 'viewer glass is double-sided');
  check(result.material.castShadow === false && result.material.glass === true, 'viewer glass casts no shadow and is tagged');
  check(!result.hullNames.includes('bubble_outline') && result.hullNames.includes('head_outline'), `outline hulls skip glass: ${result.hullNames}`);
  for (const [view, v] of Object.entries(result.views)) {
    check(v.head > 500, `${view}: the head is counted through unnamed glass (${v.head} px)`);
    check(view === 'right' || v.eyes > 20, `${view}: the eyes are counted through the glass (${v.eyes} px)`);
    check(v.glass > v.head && v.headBehindNamedGlass < v.head / 4, `${view}: named glass occludes the head it covers (${JSON.stringify({ ...v, shot: undefined })})`);
  }
  check(result.stage.a > 200 && result.stage.b > 200 && result.stage.glassA === false, `stage: both heads are counted through their glass: ${JSON.stringify({ ...result.stage, shot: undefined })}`);
  check(errors.length === 0, `no page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ material: result.material, hulls: result.hullNames, views: Object.fromEntries(Object.entries(result.views).map(([k, v]) => [k, { ...v, shot: undefined }])), stage: { ...result.stage, shot: undefined } }));

  // A plain three.js page (no agent-meshes runtime) loads the same GLB as blended glass.
  // Modules cannot load from file://, so a routed origin serves node_modules/three and the page.
  const origin = 'http://plain-three.test';
  const plain = join(evidence, 'plain.html');
  await writeFile(plain, `<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"three":"${origin}/three/build/three.module.js","three/addons/":"${origin}/three/examples/jsm/"}}</script>
<script type="module">import * as THREE from 'three'; import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const bytes = Uint8Array.from(atob(${JSON.stringify(extra ? glbs.model : glbs.helmet)}), c => c.charCodeAt(0));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
const glass = []; gltf.scene.traverse(o => { if (o.isMesh && o.material.transparent && o.material.opacity < 1) glass.push({ name: o.name, opacity: o.material.opacity, depthWrite: o.material.depthWrite, side: o.material.side }); });
const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true }); renderer.setSize(400, 400); document.body.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#dce7eb'); scene.add(gltf.scene, new THREE.HemisphereLight('#fff', '#789', 2)); const sun = new THREE.DirectionalLight('#fff', 2); sun.position.set(2, 4, 5); scene.add(sun);
const box = new THREE.Box3().setFromObject(gltf.scene), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
const top = new THREE.Vector3(center.x, box.max.y - size.y * 0.13, center.z);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50); camera.position.set(top.x, top.y, top.z + size.y * 0.9); camera.lookAt(top);
renderer.render(scene, camera); window.result = { glass, shot: renderer.domElement.toDataURL() };</script>`);
  const plainPage = await browser.newPage();
  const plainErrors = []; plainPage.on('pageerror', error => plainErrors.push(error.message));
  await plainPage.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/plain.html' ? plain : resolve(repository, 'node_modules', `.${path}`);
    await route.fulfill({ body: await readFile(file), contentType: /\.html$/.test(file) ? 'text/html' : 'text/javascript' });
  });
  await plainPage.goto(`${origin}/plain.html`); await plainPage.waitForFunction(() => window.result, undefined, { timeout: 20000 });
  const plainResult = await plainPage.evaluate(() => window.result);
  await writeFile(join(evidence, 'plain-three.png'), Buffer.from(plainResult.shot.split(',')[1], 'base64'));
  check(plainResult.glass.length > 0 && plainResult.glass.every(g => g.depthWrite === false && g.side === 2), `plain three.js loads blended double-sided glass: ${JSON.stringify(plainResult.glass)}`);
  check(plainErrors.length === 0, `plain three.js page errors: ${plainErrors.join('; ')}`);

  if (extra) {
    const model = await browser.newPage({ viewport: { width: 700, height: 700 } });
    await model.goto(pathToFileURL(page_).href, { waitUntil: 'load' }); await model.evaluate(() => window.ready);
    const suited = await model.evaluate(async () => {
      const v = await MeshViewer.mount(document.body.appendChild(Object.assign(document.createElement('div'), { style: 'width:600px;height:600px' })), { glb: GLBS.model, background: '#dce7eb', autoplay: false });
      const glass = v.parts.filter(name => v.object(name).userData.glass);
      const face = v.parts.filter(name => /face|eye|iris|pupil|lid|lip|mouth|hair|brow/.test(name));
      const parts = Object.fromEntries(face.map((name, i) => [name, `#${(0x100000 + i * 0x010203).toString(16).slice(-6)}`]));
      const out = { glass, face: face.length, views: {} };
      for (const view of ['front', 'right', 'perspective']) {
        v.view(view); v.seek(0);
        const image = v.idRender({ parts, width: 300, height: 600 });
        const counts = MeshViewer.countColors(image);
        out.views[view] = Object.values(parts).reduce((sum, hex) => sum + (counts[hex] ?? 0), 0);
      }
      v.view('front'); out.shot = v.screenshot();
      return out;
    });
    await writeFile(join(evidence, 'model-front.png'), Buffer.from(suited.shot.split(',')[1], 'base64'));
    check(suited.glass.length > 0, `the model has glass parts: ${suited.glass}`);
    for (const [view, pixels] of Object.entries(suited.views)) check(pixels > 100, `model ${view}: face and hair pixels are counted through the glass (${pixels})`);
    console.log(JSON.stringify({ model: extra, glass: suited.glass, facePixels: suited.views }));
  }
} finally { await browser.close(); }

// The workbench's fixed-view renders draw the same glass from the operation model.
const files = await captureProject(project, join(evidence, 'workbench'));
if (!files.includes('front.png')) failures.push(`workbench renders: ${files}`);

if (failures.length) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exitCode = 1; }
else console.log(`glass check passed; evidence in ${evidence}`);
