// Exercises the multi-model stage and the ID-render mode of the standalone viewer in Chromium:
// three GLBs in one renderer, independent puppets, world anchors, whole-stage and per-model framing,
// exact ID colors that follow a morph and a pose, and full restoration of the normal render.
// Writes evidence under artifacts/stage-check.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createCreature } from '../src/recipes/index.ts';
import { exportGLB } from '../src/export.ts';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { viewerScript } from '../src/preview-html.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(repository, 'artifacts/stage-check');
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, 'mesh-viewer.js'), await viewerScript());

/** A tiny face: skin block, an iris, and a teeth bar whose `jawOpen` morph drops it 8 cm. */
async function faceGLB() {
  const root = new Group();
  const head = new Mesh(new BoxGeometry(0.4, 0.4, 0.3), new MeshStandardMaterial({ name: 'skin', color: '#e0b090' })); head.name = 'head'; head.position.y = 0.25;
  const iris = new Mesh(new SphereGeometry(0.04, 16, 12), new MeshStandardMaterial({ name: 'iris', color: '#3070c0' })); iris.name = 'eye_L'; iris.position.set(-0.08, 0.33, 0.15);
  const teethGeometry = new BoxGeometry(0.16, 0.04, 0.03), count = teethGeometry.getAttribute('position').count;
  const drop = teethGeometry.getAttribute('position').clone(); drop.name = 'jawOpen';
  for (let i = 0; i < count; i++) drop.setXYZ(i, 0, -0.08, 0);
  teethGeometry.morphAttributes.position = [drop]; teethGeometry.morphTargetsRelative = true;
  const teeth = new Mesh(teethGeometry, new MeshStandardMaterial({ name: 'teeth', color: '#ffffff' })); teeth.name = 'teeth'; teeth.position.set(0, 0.18, 0.17);
  teeth.updateMorphTargets();
  root.add(head, iris, teeth);
  ensureFileReader();
  return Buffer.from(await new GLTFExporter().parseAsync(root, { binary: true })).toString('base64');
}
const glbs = {
  fox: Buffer.from(await exportGLB(createCreature('vulpine'))).toString('base64'),
  courier: Buffer.from(await exportGLB(createCreature('biped'))).toString('base64'),
  face: await faceGLB(),
  single: null,
};
const harness = join(evidence, 'harness.html');
await writeFile(harness, `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage,#solo{width:960px;height:480px}</style>
<div id="stage"></div><div id="solo"></div>
${Object.entries(glbs).filter(([, v]) => v).map(([k, v]) => `<script id="${k}" type="text/plain">${v}</script>`).join('\n')}
<script src="mesh-viewer.js"></script>
<script>
const glb = id => document.getElementById(id).textContent;
window.ready = MeshViewer.mountStage(document.getElementById('stage'), {
  background: '#f4efe6', autoplay: false,
  models: {
    fox: { glb: glb('fox'), position: [-1.6, 0, 0] },
    courier: { glb: glb('courier'), position: [0, 0, 0], rotation: [0, 20, 0] },
    face: { glb: glb('face'), position: [1.4, 0.3, 0], scale: 2 },
  },
}).then(s => (window.stage = s));
</script></html>`);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 960, height: 960 } });
  const page = await context.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()); });
  await page.goto(pathToFileURL(harness).href, { waitUntil: 'load' });
  await page.evaluate(() => window.ready);

  // One renderer, one scene, three models.
  const shape = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, models: stage.models, sceneModels: stage.scene.children.filter(c => c.name === 'stage')[0].children.map(c => c.name) }));
  assert.equal(shape.canvases, 1, 'three models share one canvas');
  assert.deepEqual(shape.models, ['fox', 'courier', 'face']);
  assert.deepEqual(shape.sceneModels, ['model:fox', 'model:courier', 'model:face']);

  // Independent puppets.
  const independence = await page.evaluate(() => {
    const fox = stage.model('fox'), courier = stage.model('courier'), face = stage.model('face');
    const head = name => stage.model(name).bones.find(b => /head/.test(b));
    const foxHead = head('fox'), courierHead = head('courier');
    const before = { fox: fox.worldPoint(foxHead, [0, 0, 0.2]), courier: courier.worldPoint(courierHead, [0, 0, 0.2]) };
    fox.setPose(foxHead, { rotation: [0, 70, 0] });
    face.setMorph('teeth', 'jawOpen', 0.5);
    const part = fox.parts[0]; fox.setColor(part, '#ff0066');
    fox.play(fox.clips[0]);
    const after = { fox: fox.worldPoint(foxHead, [0, 0, 0.2]), courier: courier.worldPoint(courierHead, [0, 0, 0.2]) };
    const result = {
      foxMoved: Math.hypot(...after.fox.map((v, i) => v - before.fox[i])), courierMoved: Math.hypot(...after.courier.map((v, i) => v - before.courier[i])),
      foxPose: fox.getPose(foxHead).rotation, courierPose: courier.getPose(courierHead).rotation,
      jaw: face.getMorph('teeth', 'jawOpen'), foxColor: fox.getColor(part), courierColor: courier.parts.includes(part) ? courier.getColor(part) : null,
      playing: [fox.playing, courier.playing, face.playing],
      sameMaterial: fox.object(part).material === (courier.parts.includes(part) ? courier.object(part).material : null),
    };
    fox.pause(); fox.seek(0); fox.resetPose(); face.resetMorph();
    return result;
  });
  assert.ok(independence.foxMoved > 0.05, `posing the fox head moves its anchor (${independence.foxMoved})`);
  assert.equal(independence.courierMoved, 0, 'posing the fox leaves the courier untouched');
  assert.deepEqual(independence.foxPose.map(Math.round), [0, 70, 0]); assert.deepEqual(independence.courierPose, [0, 0, 0]);
  assert.equal(independence.jaw, 0.5);
  assert.equal(independence.foxColor, '#ff0066'); assert.notEqual(independence.courierColor, '#ff0066');
  assert.deepEqual(independence.playing, [true, false, false], 'play is scoped to one model');
  assert.equal(independence.sameMaterial, false);

  // World anchors follow placement, so one head can aim at another.
  const anchors = await page.evaluate(async () => {
    const face = stage.model('face'), courier = stage.model('courier');
    const eye = face.worldPoint('eye_L'), courierHead = courier.worldPoint(courier.bones.find(b => /head/.test(b)));
    face.setPlacement({ position: [1.4, 0.8, 0] });
    const lifted = face.worldPoint('eye_L');
    face.setPlacement({ position: [1.4, 0.3, 0] });
    const toFace = eye.map((v, i) => v - courierHead[i]);
    let unknown = null; try { stage.model('pip'); } catch (e) { unknown = e.message; }
    const duplicate = await stage.add('face', { glb: document.getElementById('face').textContent }).then(() => null, e => e.message);
    return { eye, lifted, toFace, unknown, duplicate, placement: face.getPlacement() };
  });
  // eye_L local (-0.08, 0.33, 0.15) scaled by 2 and moved to (1.4, 0.3, 0).
  assert.deepEqual(anchors.eye.map(v => Math.round(v * 1000) / 1000), [1.24, 0.96, 0.3]);
  assert.ok(Math.abs(anchors.lifted[1] - anchors.eye[1] - 0.5) < 1e-9, 'moving a model moves its anchors');
  assert.ok(anchors.toFace[0] > 1, 'the courier finds the face to its right');
  assert.match(anchors.unknown, /Unknown model "pip"; use one of fox, courier, face/);
  assert.match(anchors.duplicate, /Model "face" already exists/);
  assert.deepEqual(anchors.placement, { position: [1.4, 0.3, 0], rotation: [0, 0, 0], scale: [2, 2, 2] });

  // Framing: the whole stage fits the view; framing one model fills it with that model.
  const framing = await page.evaluate(() => {
    const project = box => { const pts = []; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(stage.camera.position.clone().set(x, y, z).project(stage.camera)); return pts; };
    const extent = box => { const pts = project(box); return { minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)) }; };
    stage.view('front'); stage.camera.updateMatrixWorld();
    const all = extent(stage.bounds());
    stage.frame({ model: 'face' }); stage.camera.updateMatrixWorld();
    const face = extent(stage.bounds('face'));
    let bad = null; try { stage.frame({ model: 'nobody' }); } catch (e) { bad = e.message; }
    let badOption = null; try { stage.frame({ zoom: 2 }); } catch (e) { badOption = e.message; }
    stage.view('front');
    return { all, face, bad, badOption };
  });
  const inside = e => e.minX >= -1 && e.maxX <= 1 && e.minY >= -1 && e.maxY <= 1;
  assert.ok(inside(framing.all), `the whole stage fits the front view: ${JSON.stringify(framing.all)}`);
  assert.ok(inside(framing.face), `the framed face is fully in view: ${JSON.stringify(framing.face)}`);
  const tight = e => Math.max(e.maxX - e.minX, e.maxY - e.minY) > 1.6;
  assert.ok(tight(framing.all), `the whole stage fills the frame edge to edge: ${JSON.stringify(framing.all)}`);
  assert.ok(tight(framing.face), `the framed face fills the frame: ${JSON.stringify(framing.face)}`);
  assert.match(framing.bad, /Unknown model "nobody"/);
  assert.match(framing.badOption, /Unknown frame option "zoom"/);

  // ID render: exact colors only, following the morph and a pose, with everything restored.
  const palette = { skin: '#ff0000', teeth: '#00ff00', iris: '#0000ff', fox: '#ffff00', other: '#ff00ff', background: '#000000' };
  const id = await page.evaluate(async palette => {
    const face = stage.model('face'), fox = stage.model('fox');
    const options = { width: 480, height: 240, background: palette.background, other: palette.other, materials: { 'face/skin': palette.skin, 'face/teeth': palette.teeth, 'face/iris': palette.iris }, parts: Object.fromEntries(fox.parts.map(p => [`fox/${p}`, palette.fox])) };
    const snapshot = () => { const list = []; stage.scene.traverse(o => { if (o.isMesh) list.push([o.uuid, (Array.isArray(o.material) ? o.material : [o.material]).map(m => m.uuid).join(), o.visible]); }); return JSON.stringify(list); };
    const materialsBefore = snapshot(), memoryBefore = { ...stage.renderer.info.memory }, background = stage.scene.background.getHexString(), environment = stage.scene.environment;
    const normalBefore = stage.screenshot();
    const closed = stage.idRender(options);
    face.setMorph('teeth', 'jawOpen', 1);
    const open = stage.idRender(options);
    const foxHead = fox.bones.find(b => /head/.test(b)); fox.setPose(foxHead, { rotation: [0, 0, 60] });
    const posed = stage.idRender(options);
    fox.resetPose(); face.resetMorph();
    const only = stage.idRender({ ...options, models: ['face'], materials: { 'face/skin': palette.skin, 'face/teeth': palette.teeth, 'face/iris': palette.iris }, parts: {} });
    const png = stage.screenshot({ id: options });
    const decoded = await new Promise(resolve => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); resolve(Array.from(g.getImageData(0, 0, img.width, img.height).data)); }; img.src = png; });
    const normalAfter = stage.screenshot();
    const errors = {};
    for (const [key, bad] of Object.entries({ material: { materials: { 'face/skn': '#ff0000' } }, color: { materials: { 'face/skin': 'red' } }, size: { width: 0 }, model: { models: ['pip'] } })) { try { stage.idRender(bad); } catch (e) { errors[key] = e.message; } }
    const summary = image => {
      const counts = MeshViewer.countColors(image), rows = {};
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) { const i = (y * image.width + x) * 4; const hex = '#' + [0, 1, 2].map(k => image.data[i + k].toString(16).padStart(2, '0')).join(''); if (hex === palette.teeth) { rows.sum = (rows.sum ?? 0) + y; rows.n = (rows.n ?? 0) + 1; } }
      return { counts, teethY: rows.n ? rows.sum / rows.n : null };
    };
    return {
      closed: summary(closed), open: summary(open), posed: summary(posed), only: summary(only),
      foxPixelsChanged: (() => { let d = 0; for (let i = 0; i < closed.data.length; i += 4) if ((closed.data[i] === 255 && closed.data[i + 1] === 255 && closed.data[i + 2] === 0) !== (posed.data[i] === 255 && posed.data[i + 1] === 255 && posed.data[i + 2] === 0)) d++; return d; })(),
      pngMatches: decoded.length === closed.data.length && decoded.every((v, i) => v === closed.data[i]),
      size: [closed.width, closed.height, closed.data.length],
      materialsRestored: snapshot() === materialsBefore, memoryBefore, memoryAfter: { ...stage.renderer.info.memory },
      normalUnchanged: normalBefore === normalAfter, background: stage.scene.background.getHexString() === background, environment: stage.scene.environment === environment,
      toneMapping: stage.renderer.toneMapping, aspect: stage.camera.aspect, target: stage.renderer.getRenderTarget(), errors,
      images: { closed: stage.screenshot({ id: options }), open: (() => { face.setMorph('teeth', 'jawOpen', 1); const u = stage.screenshot({ id: options }); face.resetMorph(); return u; })() },
    };
  }, palette);
  const allowed = new Set(Object.values(palette));
  for (const label of ['closed', 'open', 'posed']) {
    const colors = Object.keys(id[label].counts);
    assert.deepEqual(colors.filter(c => !allowed.has(c)), [], `${label}: only requested colors, no blends (${JSON.stringify(id[label].counts)})`);
    for (const c of [palette.skin, palette.teeth, palette.iris, palette.fox, palette.other, palette.background]) assert.ok(id[label].counts[c] > 0, `${label}: ${c} is visible (${JSON.stringify(id[label].counts)})`);
  }
  assert.deepEqual(id.size, [480, 240, 480 * 240 * 4]);
  assert.ok(id.open.teethY - id.closed.teethY > 3, `the teeth centroid drops with jawOpen (${id.closed.teethY} → ${id.open.teethY})`);
  assert.ok(id.foxPixelsChanged > 20, `the fox ID pixels follow a pose (${id.foxPixelsChanged} changed)`);
  assert.deepEqual(Object.keys(id.only.counts).sort(), [palette.background, palette.teeth, palette.iris, palette.skin].sort(), `models: ['face'] hides the others: ${JSON.stringify(id.only.counts)}`);
  assert.equal(id.pngMatches, true, 'screenshot({id}) PNG decodes to the same pixels');
  assert.equal(id.materialsRestored, true, 'every mesh gets its own materials and visibility back');
  assert.deepEqual(id.memoryAfter, id.memoryBefore, 'no leaked geometries or textures');
  assert.equal(id.normalUnchanged, true, 'the normal render is pixel-identical before and after');
  assert.ok(id.background && id.environment && id.target === null, 'background, environment and render target restored');
  assert.equal(id.toneMapping, 4, 'ACES tone mapping stays on for the normal render');
  assert.equal(id.aspect, 960 / 480, 'camera aspect restored');
  assert.match(id.errors.material, /Unknown material "face\/skn" in idRender; materials: .*skin/);
  assert.match(id.errors.color, /materials\.face\/skin must be a #rrggbb color/);
  assert.match(id.errors.size, /width must be an integer from 1 to 4096/);
  assert.match(id.errors.model, /Unknown model "pip"/);
  for (const [name, url] of Object.entries(id.images)) await writeFile(join(evidence, `id-${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
  await page.screenshot({ path: join(evidence, 'stage.png'), clip: { x: 0, y: 0, width: 960, height: 480 } });

  // Face driving: setters are deferred to one sync per frame, batched setters validate first, and an eye aims at another model.
  const driving = await page.evaluate(async () => {
    const face = stage.model('face'), courier = stage.model('courier');
    const teeth = face.object('teeth');
    face.setMorphs({ teeth: { jawOpen: 0.75 } });
    const pendingRaw = teeth.morphTargetInfluences[0], effective = face.getMorph('teeth', 'jawOpen');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const renderedRaw = teeth.morphTargetInfluences[0];
    let atomic = null; try { face.setMorphs({ teeth: { jawOpen: 0.1, jawOpn: 1 } }); } catch (e) { atomic = e.message; }
    const target = face.worldPoint('eye_L');
    const head = courier.bones.find(b => /head/.test(b));
    const aim = courier.aimBone(head, target, { maxYaw: 80, maxPitch: 40 });
    const o = courier.observe({ o: { node: head }, f: { node: head, point: [0, 0, 1] } });
    const f = o.f.map((v, i) => v - o.o[i]), d = target.map((v, i) => v - o.o[i]);
    const angle = Math.acos(Math.min(1, f.reduce((s, v, i) => s + v * d[i], 0) / Math.hypot(...f) / Math.hypot(...d))) * 180 / Math.PI;
    courier.resetPose(); face.resetMorph();
    return { pendingRaw, effective, renderedRaw, atomic, afterAtomic: face.getMorph('teeth', 'jawOpen'), aim, angle, skinCulled: (() => { let culled = 0; stage.scene.traverse(o => { if (o.isSkinnedMesh && o.frustumCulled) culled++; }); return culled; })() };
  });
  assert.equal(driving.pendingRaw, 0, 'a setter only records its input until the frame syncs');
  assert.equal(driving.effective, 0.75, 'getters see pending writes');
  assert.equal(driving.renderedRaw, 0.75, 'the render loop applies pending writes before drawing');
  assert.match(driving.atomic, /Unknown morph target for teeth: jawOpn/);
  assert.equal(driving.afterAtomic, 0, 'a rejected batch changes nothing');
  assert.ok(!driving.aim.clamped && driving.angle < 0.01, `aimBone points the courier head at the face eye (${driving.angle}° off, ${JSON.stringify(driving.aim)})`);
  assert.equal(driving.skinCulled, 0, 'skinned meshes are never culled by a stale sphere');

  // Add and remove at run time; dispose releases the context.
  const lifecycle = await page.evaluate(async () => {
    const extra = await stage.add('twin', { glb: document.getElementById('face').textContent, position: [2.4, 0, 0] });
    const listed = stage.models.slice(), twinEye = extra.worldPoint('eye_L');
    stage.remove('twin');
    let stale = null; try { extra.setMorph('teeth', 'jawOpen', 1); } catch (e) { stale = e.message; }
    return { listed, after: stage.models, twinEye, stale };
  });
  assert.match(lifecycle.stale, /Model "twin" was removed from the stage/);
  assert.deepEqual(lifecycle.listed, ['fox', 'courier', 'face', 'twin']);
  assert.deepEqual(lifecycle.after, ['fox', 'courier', 'face']);

  // The single-model viewer keeps its API and gains the same ID render.
  const single = await page.evaluate(async () => {
    const v = await MeshViewer.mount(document.getElementById('solo'), { glb: document.getElementById('face').textContent, autoplay: false, outline: 0.01 });
    const image = v.idRender({ materials: { skin: '#ff0000', teeth: '#00ff00', iris: '#0000ff' }, width: 200, height: 100 });
    let scoped = null; try { v.idRender({ models: ['face'] }); } catch (e) { scoped = e.message; }
    const result = { counts: MeshViewer.countColors(image), scoped, frameType: typeof v.frame, hulls: (() => { let n = 0; v.scene.traverse(o => { if (o.userData.outline && o.visible) n++; }); return n; })() };
    v.dispose(); return result;
  });
  assert.deepEqual(Object.keys(single.counts).sort(), ['#000000', '#0000ff', '#00ff00', '#ff0000'], `single viewer ID render: ${JSON.stringify(single.counts)}`);
  assert.match(single.scoped, /idRender models apply to a stage/);
  assert.ok(single.hulls > 0, 'outline hulls are visible again after the ID render');

  // Quality options trade image quality for frame time; dispose releases the WebGL context.
  const quality = await page.evaluate(async () => {
    const holder = document.createElement('div'); holder.style.cssText = 'width:320px;height:200px'; document.body.append(holder);
    const glb = document.getElementById('face').textContent, read = s => {
      let key = null; s.scene.traverse(o => { if (o.isDirectionalLight && o.castShadow) key = o; });
      return { antialias: s.renderer.getContext().getContextAttributes().antialias, pixelRatio: s.renderer.getPixelRatio(), shadows: s.renderer.shadowMap.enabled, shadowType: s.renderer.shadowMap.type, mapSize: key ? key.shadow.mapSize.x : null, environment: !!s.scene.environment };
    };
    const high = await MeshViewer.mountStage(holder, { models: { a: { glb } }, autoplay: false });
    const result = { high: read(high) };
    const gl = high.renderer.getContext(); high.dispose(); result.highLost = gl.isContextLost();
    const fast = await MeshViewer.mountStage(holder, { models: { a: { glb } }, autoplay: false, quality: 'fast' });
    result.fast = read(fast); fast.dispose();
    const mixed = await MeshViewer.mount(holder, { glb, autoplay: false, quality: { preset: 'fast', shadows: 512, pixelRatio: 0.5 } });
    result.mixed = read(mixed); const mixedGl = mixed.renderer.getContext(); mixed.dispose(); result.viewerLost = mixedGl.isContextLost();
    result.bad = await MeshViewer.mountStage(holder, { quality: { shadows: 1000 } }).then(() => null, e => e.message);
    result.canvases = holder.querySelectorAll('canvas').length; holder.remove();
    return result;
  });
  assert.deepEqual(quality.high, { antialias: true, pixelRatio: 1, shadows: true, shadowType: 1, mapSize: 2048, environment: true }, 'high quality is the default (PCFShadowMap, not the deprecated PCFSoftShadowMap)');
  assert.deepEqual(quality.fast, { antialias: false, pixelRatio: 1, shadows: false, shadowType: 1, mapSize: null, environment: false });
  assert.deepEqual(quality.mixed, { antialias: false, pixelRatio: 0.5, shadows: true, shadowType: 1, mapSize: 512, environment: false });
  assert.equal(quality.highLost, true, 'stage.dispose releases the WebGL context');
  assert.equal(quality.viewerLost, true, 'viewer.dispose releases the WebGL context');
  assert.match(quality.bad, /quality shadows must be true, false or a power-of-two map size/);
  assert.equal(quality.canvases, 0);

  // Bad input fails before or without leaving a canvas behind.
  const failures = await page.evaluate(async () => {
    const holder = document.createElement('div'); document.body.append(holder);
    const attempt = async options => MeshViewer.mountStage(holder, options).then(() => null, e => e.message);
    const result = {
      name: await attempt({ models: { '1st': { glb: document.getElementById('face').textContent } } }),
      option: await attempt({ modles: {} }),
      placement: await attempt({ models: { a: { glb: document.getElementById('face').textContent, scale: 0 } } }),
      corrupt: await attempt({ models: { a: { glb: document.getElementById('face').textContent }, b: { glb: new Uint8Array([1, 2, 3]) } } }),
    };
    result.canvases = holder.querySelectorAll('canvas').length; holder.remove();
    return result;
  });
  assert.match(failures.name, /Model name must be a letter/);
  assert.match(failures.option, /Unknown mountStage option "modles"/);
  assert.match(failures.placement, /scale must be positive/);
  assert.ok(failures.corrupt, 'a corrupt GLB rejects');
  assert.equal(failures.canvases, 0, 'failed mounts leave no canvas');
  await page.evaluate(() => stage.dispose());
  assert.equal(await page.evaluate(() => document.querySelectorAll('canvas').length), 0, 'dispose removes the canvas');
  assert.deepEqual(errors, [], 'console errors');
  assert.deepEqual(warnings.filter(w => /PCFSoftShadowMap/.test(w)), [], 'no deprecated shadow map warning');
  console.log(JSON.stringify({ closed: id.closed, open: id.open, posedFoxPixelsChanged: id.foxPixelsChanged }, null, 1));
  console.log(`Stage and ID render verified. Evidence in ${evidence}`);
} finally {
  await browser.close();
}
