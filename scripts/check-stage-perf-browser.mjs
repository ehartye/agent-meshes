// Performance floor (talking-heads E8) for a face-driving stage at 1280x720: three skinned,
// morph-heavy heads (one 12.5k-vertex glTF face mesh with six primitives that share 25 ARKit morphs,
// a 3-bone skin, eyes on eye bones) driven every frame with 25 morph weights and two eye poses each.
//   (a) In Chromium with GPU acceleration (headless, ANGLE on the real driver) at default quality:
//       frame median <= 33 ms and p95 <= 50 ms over 10 s; a software backend fails the check.
//   (b) In headless Chromium with software GL: the per-frame driving work alone (all writes plus
//       the sync that applies them, rendering excluded) has median <= 8 ms and p95 <= 12 ms. The
//       `fast` quality preset also holds the frame floor there.
// Usage: node scripts/check-stage-perf-browser.mjs [--baseline] [--seconds N]
//   --baseline measures software GL at the default quality and asserts nothing.
// Writes evidence under artifacts/stage-perf.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import * as T from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { viewerScript } from '../src/preview-html.ts';

const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const seconds = Number(args[args.indexOf('--seconds') + 1]) || 10;
const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(repository, 'artifacts/stage-perf');
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, 'mesh-viewer.js'), await viewerScript());

const ARKIT = ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'noseSneerLeft', 'noseSneerRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower'];
const PRIMITIVES = ['skin', 'lid', 'teeth_upper', 'teeth_lower', 'tongue', 'cavity'];

/**
 * A skinned head in the talking-heads layout: one glTF mesh `face` with six primitives (skin, lids,
 * upper and lower teeth, tongue, mouth cavity) that all carry the same 25 ARKit morphs, 12.5k
 * vertices skinned to neck, head and jaw; eyeballs and irises on eye bones.
 */
async function headGLB() {
  const root = new T.Group(); root.name = 'headroot';
  const rootBone = new T.Bone(); rootBone.name = 'root';
  const neck = new T.Bone(); neck.name = 'neck'; neck.position.set(0, 0.18, 0); rootBone.add(neck);
  const head = new T.Bone(); head.name = 'head'; head.position.set(0, 0.12, 0); neck.add(head);
  const jaw = new T.Bone(); jaw.name = 'jaw'; jaw.position.set(0, -0.03, 0.02); head.add(jaw);
  const eyeL = new T.Bone(); eyeL.name = 'eye_L'; eyeL.position.set(-0.045, 0.03, 0.1); head.add(eyeL);
  const eyeR = new T.Bone(); eyeR.name = 'eye_R'; eyeR.position.set(0.045, 0.03, 0.1); head.add(eyeR);
  root.add(rootBone); root.updateMatrixWorld(true);
  const g = new T.SphereGeometry(0.12, 128, 96); g.translate(0, 0.3, 0);
  const pos = g.getAttribute('position'), n = pos.count;
  const si = [], sw = [];
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i), low = y < 0.29, neckWeight = y < 0.22 ? 0.3 : 0;
    si.push(2, 3, 1, 0);
    sw.push((low ? 0.4 : 1) - neckWeight, low ? 0.6 : 0, neckWeight, 0);
  }
  g.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new T.Float32BufferAttribute(sw, 4));
  // Each morph moves a band of the face (not a sparse sprinkle), so the GPU pays for real deltas.
  g.morphAttributes.position = ARKIT.map((name, k) => {
    const a = new T.Float32BufferAttribute(new Float32Array(n * 3), 3); a.name = name;
    const lo = 0.18 + (k / ARKIT.length) * 0.22, hi = lo + 0.05;
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      if (name === 'jawOpen' ? y < 0.27 : y >= lo && y < hi) a.setXYZ(i, 0.001 * Math.sin(i), name === 'jawOpen' ? -0.03 : 0.003, 0.002);
    }
    return a;
  });
  g.morphTargetsRelative = true;
  // One material slot per primitive; GLTFExporter writes each slot as a primitive of the one mesh.
  const triangles = g.index.count / 3, per = Math.floor(triangles / PRIMITIVES.length);
  g.clearGroups();
  PRIMITIVES.forEach((_, k) => g.addGroup(k * per * 3, (k === PRIMITIVES.length - 1 ? triangles - k * per : per) * 3, k));
  const colors = ['#e0b090', '#c08070', '#fffff0', '#fffff0', '#c05060', '#401010'];
  const face = new T.SkinnedMesh(g, PRIMITIVES.map((name, k) => new T.MeshStandardMaterial({ name, color: colors[k] })));
  face.name = 'face'; root.add(face);
  face.bind(new T.Skeleton([rootBone, neck, head, jaw, eyeL, eyeR]));
  face.updateMorphTargets();
  for (const [bone, side] of [[eyeL, 'L'], [eyeR, 'R']]) {
    const ball = new T.Mesh(new T.SphereGeometry(0.025, 24, 16), new T.MeshStandardMaterial({ name: 'sclera', color: '#ffffff' })); ball.name = `eyeball_${side}`; bone.add(ball);
    const iris = new T.Mesh(new T.CircleGeometry(0.012, 24), new T.MeshStandardMaterial({ name: 'iris', color: '#2050a0' })); iris.name = `iris_${side}`; iris.position.z = 0.0255; bone.add(iris);
  }
  ensureFileReader();
  return Buffer.from(await new GLTFExporter().parseAsync(root, { binary: true }));
}
const glb = await headGLB();
const harness = join(evidence, 'harness.html');
await writeFile(harness, `<!doctype html><html lang="en"><meta charset="utf-8"><style>html,body{margin:0}#stage{width:1280px;height:720px}</style>
<div id="stage"></div><script id="head" type="text/plain">${glb.toString('base64')}</script>
<script src="mesh-viewer.js"></script></html>`);

/**
 * Mount the three heads in a fresh Chromium, drive them every frame for `seconds`, and measure the
 * frame time (rAF to rAF: driving plus rendering) and the driving cost alone (every morph and eye
 * write plus the stage sync that applies them; rendering excluded).
 */
async function run({ label, launchArgs, quality }) {
  const browser = await chromium.launch({ args: launchArgs });
  try {
    const page = await (await browser.newContext({ offline: true, viewport: { width: 1280, height: 720 } })).newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(pathToFileURL(harness).href, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ quality, seconds }) => {
      const g = document.getElementById('head').textContent;
      const options = {
        autoplay: false, background: '#e8dccb',
        models: { pip: { glb: g, position: [-0.35, 0, 0], rotation: [0, 15, 0] }, moss: { glb: g }, bolt: { glb: g, position: [0.35, 0, 0], rotation: [0, -15, 0] } },
      };
      if (quality) options.quality = quality;
      const s = await MeshViewer.mountStage(document.getElementById('stage'), options);
      s.frame();
      const faceMorphs = s.model('pip').morphTargets('face');
      const primitives = s.model('pip').root.getObjectByName('face').children.filter(child => child.isMesh);
      const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; };
      const summary = values => (values.length ? { samples: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) } : null);
      const measure = async (secs, drive) => {
        const frames = [], driving = []; let t = 0, last = performance.now();
        const stop = last + secs * 1000;
        const off = s.onFrame(() => {
          if (!drive) return;
          const start = performance.now();
          t += 1 / 60;
          // Pip speaks: one setMorph per curve for 25 face morphs (each reaching all six primitives) and
          // two eye poses. Moss and Bolt listen: a batch of 25 morphs, eyes aimed at Pip's mouth.
          const speaker = s.model('pip'), mouth = speaker.worldPoint('jaw', [0, 0, 0.1]);
          for (let k = 0; k < faceMorphs.length; k++) speaker.setMorph('face', faceMorphs[k], 0.5 + 0.5 * Math.sin(t * 7 + k));
          speaker.setPose('eye_L', { rotation: [5 * Math.cos(t), 10 * Math.sin(t), 0] });
          speaker.setPose('eye_R', { rotation: [5 * Math.cos(t), 10 * Math.sin(t), 0] });
          for (const name of ['moss', 'bolt']) {
            const h = s.model(name), weights = {};
            for (let k = 0; k < faceMorphs.length; k++) weights[faceMorphs[k]] = 0.3 + 0.3 * Math.sin(t * 2 + k);
            h.setMorphs({ face: weights });
            h.aimBone('eye_L', mouth, { maxYaw: 30, maxPitch: 20 });
            h.aimBone('eye_R', mouth, { maxYaw: 30, maxPitch: 20 });
          }
          // Apply everything now (the render loop would do it next) so the timing includes it.
          s.sync();
          driving.push(performance.now() - start);
        });
        await new Promise(done => { const tick = now => { frames.push(now - last); last = now; if (now < stop) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
        off();
        frames.shift();
        return { frame: summary(frames), driving: summary(driving) };
      };
      await measure(1, true); // warm up shader compilation
      const idle = (await measure(Math.min(5, seconds), false)).frame;
      const driven = await measure(seconds, true);
      s.model('pip').setMorph('face', 'jawOpen', 0.95); s.sync();
      const reached = primitives.every(p => p.morphTargetInfluences[p.morphTargetDictionary.jawOpen] === 0.95);
      const gl = s.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
      const settings = { pixelRatio: s.renderer.getPixelRatio(), shadows: s.renderer.shadowMap.enabled, antialias: gl.getContextAttributes().antialias, environment: !!s.scene.environment, backend: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      const faceVertices = primitives[0].geometry.getAttribute('position').count;
      const screenshot = s.screenshot();
      s.dispose();
      return { idle, frame: driven.frame, driving: driven.driving, faceVertices, facePrimitives: primitives.length, faceMorphs: faceMorphs.length, morphsReachEveryPrimitive: reached, settings, screenshot };
    }, { quality, seconds });
    await writeFile(join(evidence, `stage-${label}.png`), Buffer.from(result.screenshot.split(',')[1], 'base64'));
    delete result.screenshot;
    assert.deepEqual(errors, [], `${label}: console errors`);
    assert.ok(result.faceVertices >= 10000 && result.faceMorphs === 25 && result.facePrimitives === 6, 'the synthetic head carries realistic cost');
    assert.equal(result.morphsReachEveryPrimitive, true, 'a morph written to the glTF mesh reaches all six primitives');
    return { label, quality: quality ?? 'high (default)', launchArgs, ...result };
  } finally {
    await browser.close();
  }
}

if (baseline) {
  const report = await run({ label: 'software-high', launchArgs: [], quality: undefined });
  await writeFile(join(evidence, 'perf-baseline.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} else {
  // (a) Real frame time on the GPU (ANGLE on the machine's graphics driver), default quality.
  const gpuArgs = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])];
  const gpu = await run({ label: 'gpu-high', launchArgs: gpuArgs, quality: undefined });
  // (b) Driving cost with rendering excluded, plus the fast preset's frame time, under software GL.
  const software = await run({ label: 'software-fast', launchArgs: [], quality: 'fast' });
  const report = { viewport: '1280x720', seconds, glbBytes: glb.length, gpu, software };
  await writeFile(join(evidence, 'perf.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  assert.ok(!/SwiftShader|llvmpipe|software/i.test(gpu.settings.backend), `(a) needs a hardware GPU backend, got ${gpu.settings.backend}`);
  assert.ok(gpu.frame.median <= 33 && gpu.frame.p95 <= 50, `(a) GPU frame median ${gpu.frame.median} ms <= 33 and p95 ${gpu.frame.p95} ms <= 50`);
  assert.ok(software.driving.median <= 8 && software.driving.p95 <= 12, `(b) driving median ${software.driving.median} ms <= 8 and p95 ${software.driving.p95} ms <= 12`);
  assert.ok(software.frame.median <= 33 && software.frame.p95 <= 50, `quality 'fast' software-GL frame median ${software.frame.median} ms <= 33 and p95 ${software.frame.p95} ms <= 50`);
  console.log(`E8 (a) GPU frame median ${gpu.frame.median} ms, p95 ${gpu.frame.p95} ms on ${gpu.settings.backend}; (b) driving median ${software.driving.median} ms, p95 ${software.driving.p95} ms; software-GL fast frame median ${software.frame.median} ms, p95 ${software.frame.p95} ms.`);
}
