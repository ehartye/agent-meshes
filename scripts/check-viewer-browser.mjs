// Exercises the standalone viewer runtime in Chromium: mount from base64, pose, recolor, play,
// reduced-motion start state and screenshots. Writes evidence under artifacts/viewer-check.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createCreature } from '../src/recipes/index.ts';
import { exportGLB } from '../src/export.ts';
import { viewerScript } from '../src/preview-html.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(repository, 'artifacts/viewer-check');
await mkdir(evidence, { recursive: true });
const runtime = join(evidence, 'mesh-viewer.js');
await writeFile(runtime, await viewerScript());
const glb = Buffer.from(await exportGLB(createCreature('vulpine'))).toString('base64');
const page_ = join(evidence, 'harness.html');
await writeFile(page_, `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:0}#stage{width:800px;height:500px}</style>
<div id="stage"></div><script id="glb" type="text/plain">${glb}</script><script src="mesh-viewer.js"></script>
<script>window.ready = MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: '#f4efe6' }).then(v => (window.viewer = v));</script></html>`);

const browser = await chromium.launch();
try {
  for (const [label, reducedMotion] of [['default', 'no-preference'], ['reduced', 'reduce']]) {
    const context = await browser.newContext({ offline: true, viewport: { width: 800, height: 500 }, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(pathToFileURL(page_).href, { waitUntil: 'load' });
    await page.evaluate(() => window.ready);
    const state = await page.evaluate(() => ({ playing: viewer.playing, clips: viewer.clips, bones: viewer.bones.length, parts: viewer.parts.length, version: MeshViewer.version, environment: !!viewer.scene.environment, outlines: viewer.scene.children.filter(o => o.userData.outline).length }));
    assert.equal(state.environment, true, `${label}: the scene has environment lighting`);
    assert.equal(state.outlines, 0, `${label}: no outline meshes unless asked`);
    assert.equal(state.playing, reducedMotion === 'no-preference', `${label}: autoplay should follow reduced-motion preference`);
    assert.deepEqual(state.clips, ['walk', 'trot']);
    assert.ok(state.bones > 10 && state.parts > 5, `${label}: puppet lists bones and parts`);
    if (label === 'default') {
      const result = await page.evaluate(async () => {
        viewer.pause(); viewer.seek(0);
        const before = viewer.screenshot();
        const head = viewer.bones.find(name => /head/.test(name)) ?? viewer.bones[0];
        viewer.setPose(head, { rotation: [0, 60, 0] });
        const posed = viewer.screenshot();
        const part = viewer.parts[0]; viewer.setColor(part, '#ff0066');
        const recolored = viewer.screenshot();
        const matte = viewer.getMaterial(part); viewer.setMaterial(part, { metalness: 1, roughness: 0.1 });
        const chromed = viewer.screenshot();
        viewer.resetPose(); viewer.play('trot');
        await new Promise(resolve => setTimeout(resolve, 250));
        const played = viewer.screenshot();
        viewer.view('front'); const front = viewer.screenshot(), time = viewer.time, clip = viewer.clip;
        // Every named view moves the camera somewhere different; an unknown name is a plain Error that lists them.
        const views = {}; for (const name of ['front', 'back', 'left', 'right', 'side', 'top', 'bottom', 'perspective']) { viewer.view(name); views[name] = viewer.camera.position.toArray().map(v => Math.round(v * 100) / 100); }
        let rejected = null; try { viewer.view('rear'); } catch (error) { rejected = { type: error.constructor.name, message: error.message }; }
        viewer.view('front');
        // Patterns re-bake in place: dots change the frame, null restores the flat part's look, getPattern reports.
        viewer.pause(); viewer.seek(0);
        const plain = viewer.screenshot(); viewer.setPattern(part, { type: 'dots', color: '#ffffff', size: 0.05 });
        const dotted = viewer.screenshot(), pattern = viewer.getPattern(part); viewer.setPattern(part, null);
        const restored = viewer.screenshot(); viewer.play('trot');
        return { head, part, color: viewer.getColor(part), matte, material: viewer.getMaterial(part), pose: viewer.getPose(head), changedByPose: before !== posed, changedByColor: posed !== recolored, changedByMaterial: recolored !== chromed, changedByPlay: chromed !== played, time, clip, front, changedByPattern: plain !== dotted, restoredByNull: restored === plain, pattern, cleared: viewer.getPattern(part), views, rejected };
      });
      assert.equal(result.changedByPose, true, 'posing a bone changes the rendered frame');
      assert.equal(result.changedByColor, true, 'recoloring a part changes the rendered frame');
      assert.equal(result.changedByMaterial, true, 'switching a part to chrome changes the rendered frame');
      assert.equal(result.changedByPlay, true, 'playing a clip changes the rendered frame');
      assert.equal(result.changedByPattern, true, 'painting dots on a part changes the rendered frame');
      assert.equal(result.restoredByNull, true, 'clearing the pattern restores the frame');
      assert.deepEqual(result.pattern, { type: 'dots', color: '#ffffff', size: 0.05 });
      assert.equal(result.cleared, null);
      assert.equal(result.color, '#ff0066');
      assert.deepEqual(result.matte, { metalness: 0.08, roughness: 0.65 });
      assert.deepEqual(result.material, { metalness: 1, roughness: 0.1 });
      assert.deepEqual(result.pose, { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] });
      assert.equal(result.clip, 'trot');
      assert.ok(result.time > 0.1, `playback advanced (${result.time})`);
      const { views } = result;
      assert.deepEqual(views.side, views.right, 'side is the right view');
      assert.ok(views.back[2] < 0 && views.front[2] > 0 && views.left[0] < 0 && views.right[0] > 0, `back, front, left and right face the model from their own sides: ${JSON.stringify(views)}`);
      assert.ok(views.bottom[1] < views.top[1] && views.bottom[1] < 0, `bottom looks up from below the floor: ${JSON.stringify(views)}`);
      assert.equal(new Set(Object.values(views).filter((p, i, all) => all.indexOf(p) === i).map(p => p.join())).size, 7, 'seven distinct camera positions for eight names');
      assert.equal(result.rejected?.type, 'Error', `unknown view is a plain Error: ${JSON.stringify(result.rejected)}`);
      assert.match(result.rejected?.message ?? '', /Unknown view "rear"; use one of front, back, left, right, side, top, bottom, perspective/);
      await writeFile(join(evidence, 'front.png'), Buffer.from(result.front.split(',')[1], 'base64'));
      // Ink outlines: an inverted hull per mesh, following the same skeleton.
      const outlined = await page.evaluate(async () => {
        viewer.dispose();
        const v = await MeshViewer.mount(document.getElementById('stage'), { glb: document.getElementById('glb').textContent, background: '#f4efe6', outline: 0.02, autoplay: false });
        const hulls = []; v.scene.traverse(o => { if (o.userData.outline) hulls.push(o); });
        const skinned = hulls.filter(h => h.isSkinnedMesh).length;
        const before = v.screenshot(); v.setPose(v.bones[0], { rotation: [0, 40, 0] }); const after = v.screenshot();
        v.setMaterial(v.parts[0], { metalness: 1, roughness: 0.1 });
        const hull = hulls.find(h => h.name === `${v.parts[0]}_outline`);
        window.viewer = v; return { hulls: hulls.length, skinned, parts: v.parts.length, moved: before !== after, color: hulls[0] && hulls[0].material.color.getHexString(), hullMaterial: hull && hull.material.type, hullMetalness: hull && hull.material.metalness };
      });
      assert.equal(outlined.hulls, outlined.parts, 'one outline hull per visible part');
      assert.ok(outlined.skinned > 0, 'skinned parts get skinned hulls');
      assert.equal(outlined.moved, true, 'outlined puppet still poses');
      assert.equal(outlined.color, '111111');
      assert.equal(outlined.hullMaterial, 'MeshBasicMaterial', 'setMaterial leaves the outline hull ink alone');
      assert.equal(outlined.hullMetalness, undefined, 'setMaterial does not write metalness onto the hull');
      await page.screenshot({ path: join(evidence, 'outline.png') });
    }
    if (label === 'default') {
      // Projection and floor defaults, each in a fresh container so nothing carries over from the mounts above.
      const projection = await page.evaluate(async () => {
        const glbText = document.getElementById('glb').textContent;
        const make = (width = 400, height = 300) => { const el = document.createElement('div'); el.style.cssText = `width:${width}px;height:${height}px`; document.body.append(el); return el; };
        const base = { glb: glbText, background: '#f4efe6', autoplay: false };
        const matrix = camera => camera.projectionMatrix.elements.map(v => Math.round(v * 1e6) / 1e6);
        // The box of nonblack pixels in an ID render: where the model's silhouette sits in the frame.
        const silhouette = image => {
          let minX = image.width, maxX = -1, minY = image.height, maxY = -1;
          for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            if (image.data[i] || image.data[i + 1] || image.data[i + 2]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
          }
          return { width: maxX - minX + 1, height: maxY - minY + 1, minX, maxX, minY, maxY };
        };
        const ink = { other: '#ff0000', width: 400, height: 300 };
        const alphaPixels = async url => {
          const image = new Image(); image.src = url; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let seen = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) seen++;
          return seen;
        };
        const out = {};

        // Omitted projection and an explicit 'perspective' are the same camera and the same pixels, and both match the camera built before the option existed.
        const omitted = await MeshViewer.mount(make(), { ...base, view: 'front' });
        const explicit = await MeshViewer.mount(make(), { ...base, view: 'front', projection: 'perspective' });
        const Perspective = omitted.camera.constructor;
        const legacy = new Perspective(38, 400 / 300, 0.01, omitted.camera.far);
        out.omitted = { type: omitted.camera.type, fov: omitted.camera.fov, near: omitted.camera.near, far: omitted.camera.far, aspect: omitted.camera.aspect, position: omitted.camera.position.toArray(), matrix: matrix(omitted.camera) };
        out.legacyMatrix = matrix(legacy);
        out.explicit = { type: explicit.camera.type, far: explicit.camera.far, position: explicit.camera.position.toArray(), matrix: matrix(explicit.camera) };
        out.samePixels = omitted.screenshot() === explicit.screenshot();
        out.sameIdPixels = omitted.idRender(ink).data.join() === explicit.idRender(ink).data.join();
        const perspectiveWidths = [];
        for (const distance of [3, 6]) {
          const center = explicit.bounds().getCenter(new explicit.camera.position.constructor());
          explicit.view({ position: [center.x, center.y, center.z + distance], target: center.toArray() });
          perspectiveWidths.push(silhouette(explicit.idRender(ink)).width);
        }
        out.perspectiveWidths = perspectiveWidths;
        omitted.dispose(); explicit.dispose();

        // Orthographic: an OrthographicCamera, fitted into the frame, and the model keeps its size however far the camera stands.
        const ortho = await MeshViewer.mount(make(), { ...base, view: 'front', projection: 'orthographic' });
        out.ortho = { type: ortho.camera.type, isOrthographic: ortho.camera.isOrthographicCamera, hasFov: 'fov' in ortho.camera };
        out.orthoFit = silhouette(ortho.idRender(ink));
        const before = matrix(ortho.camera);
        const orthoWidths = [];
        for (const distance of [3, 6, 12]) {
          const center = ortho.bounds().getCenter(new ortho.camera.position.constructor());
          ortho.view({ position: [center.x, center.y, center.z + distance], target: center.toArray() });
          orthoWidths.push(silhouette(ortho.idRender(ink)).width);
        }
        out.orthoWidths = orthoWidths;
        out.orthoMatrixAfterIdRender = matrix(ortho.camera).join() === before.join();
        ortho.view('front'); ortho.frame();
        out.orthoRefit = silhouette(ortho.idRender(ink)).width;
        // A container resize keeps the half-height and changes the width.
        const halfBefore = ortho.camera.top;
        ortho.renderer.domElement.parentElement.style.width = '200px'; ortho.resize();
        out.orthoResize = { halfBefore, halfAfter: ortho.camera.top, aspectAfter: (ortho.camera.right - ortho.camera.left) / (ortho.camera.top - ortho.camera.bottom) };
        ortho.dispose();
        // An explicit position at mount time still gets a sized frustum.
        const explicitOrtho = await MeshViewer.mount(make(), { ...base, projection: 'orthographic', view: { position: [0, 1, 5] } });
        out.explicitOrthoWidth = silhouette(explicitOrtho.idRender(ink)).width;
        explicitOrtho.dispose();

        // The stage takes the same option.
        const stageOptions = { models: { fox: { glb: glbText } }, background: '#f4efe6', autoplay: false };
        const stagePerspective = await MeshViewer.mountStage(make(), stageOptions);
        const stageOrtho = await MeshViewer.mountStage(make(), { ...stageOptions, projection: 'orthographic' });
        stageOrtho.frame();
        out.stage = { perspective: stagePerspective.camera.type, orthographic: stageOrtho.camera.type, orthoFit: silhouette(stageOrtho.idRender({ ...ink, models: ['fox'] })), perspectiveMatrix: matrix(stagePerspective.camera) };
        out.stageLegacyMatrix = matrix(new Perspective(38, 400 / 300, stagePerspective.camera.near, stagePerspective.camera.far));
        stagePerspective.dispose(); stageOrtho.dispose();

        // An invalid value is rejected before any canvas or WebGL context exists, with the allowed values listed.
        out.rejected = {};
        for (const [name, value] of [['isometric', 'isometric'], ['uppercase', 'Orthographic'], ['null', null], ['number', 1]]) {
          for (const kind of ['mount', 'mountStage']) {
            const el = make();
            try { await (kind === 'mount' ? MeshViewer.mount(el, { ...base, projection: value }) : MeshViewer.mountStage(el, { ...stageOptions, projection: value })); out.rejected[`${kind} ${name}`] = { message: 'accepted', canvases: 0 }; }
            catch (error) { out.rejected[`${kind} ${name}`] = { message: error.message, canvases: el.querySelectorAll('canvas').length }; }
          }
        }

        // Floor defaults: a 200 x 200 plane just under the origin, a shadow-only plane when the background is transparent.
        const floorOf = viewer => viewer.scene.children.find(o => o.isMesh && o.geometry.type === 'PlaneGeometry');
        const withFloor = await MeshViewer.mount(make(), { glb: glbText, autoplay: false, background: null, view: 'front' });
        const plane = floorOf(withFloor);
        out.floor = { geometry: plane.geometry.type, size: [plane.geometry.parameters.width, plane.geometry.parameters.height], y: plane.position.y, rotationX: plane.rotation.x, material: plane.material.type, opacity: plane.material.opacity, receivesShadow: plane.receiveShadow, discs: withFloor.scene.children.filter(o => o.isMesh && o.geometry.type === 'CircleGeometry').length };
        out.shadowPixels = await alphaPixels(withFloor.screenshot());
        withFloor.dispose();
        const noFloor = await MeshViewer.mount(make(), { glb: glbText, autoplay: false, background: null, view: 'front', floor: false });
        out.noFloorPlane = !!floorOf(noFloor);
        out.noFloorPixels = await alphaPixels(noFloor.screenshot());
        noFloor.dispose();
        const colored = await MeshViewer.mount(make(), { glb: glbText, autoplay: false });
        const coloredPlane = floorOf(colored);
        out.defaults = { background: '#' + colored.scene.background.getHexString(), floorMaterial: coloredPlane.material.type, floorColor: '#' + coloredPlane.material.color.getHexString(), orbit: colored.controls.enabled };
        colored.dispose();
        return out;
      });
      const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);
      // Default output must not change.
      assert.equal(projection.omitted.type, 'PerspectiveCamera', 'an omitted projection is a perspective camera');
      assert.deepEqual([projection.omitted.fov, projection.omitted.near, projection.omitted.aspect], [38, 0.01, 400 / 300], 'the omitted-projection camera keeps the 38 degree lens');
      same(projection.omitted.matrix, projection.legacyMatrix, 'the omitted-projection matrix equals a PerspectiveCamera(38, aspect, 0.01, far)');
      same(projection.explicit, { type: 'PerspectiveCamera', far: projection.omitted.far, position: projection.omitted.position, matrix: projection.omitted.matrix }, "projection: 'perspective' is the omitted camera, matrix and position included");
      assert.equal(projection.samePixels, true, "projection: 'perspective' renders the same pixels as an omitted projection");
      assert.equal(projection.sameIdPixels, true, "projection: 'perspective' renders the same ID pixels as an omitted projection");
      assert.notEqual(projection.perspectiveWidths[0], projection.perspectiveWidths[1], `perspective size changes with distance: ${projection.perspectiveWidths}`);
      assert.equal(projection.stage.perspective, 'PerspectiveCamera', 'the stage defaults to perspective');
      same(projection.stage.perspectiveMatrix, projection.stageLegacyMatrix, 'the stage default matrix equals a PerspectiveCamera(38, aspect, near, far) with the stage fitted near and far');
      // Orthographic.
      assert.deepEqual(projection.ortho, { type: 'OrthographicCamera', isOrthographic: true, hasFov: false });
      assert.ok(projection.orthoFit.minX > 0 && projection.orthoFit.maxX < 399 && projection.orthoFit.minY > 0 && projection.orthoFit.maxY < 299, `the orthographic fit keeps the model inside the frame: ${JSON.stringify(projection.orthoFit)}`);
      assert.ok(projection.orthoFit.width > 100 || projection.orthoFit.height > 100, `the orthographic fit fills a good part of the frame: ${JSON.stringify(projection.orthoFit)}`);
      assert.equal(new Set(projection.orthoWidths).size, 1, `orthographic size is identical at every camera distance: ${projection.orthoWidths}`);
      assert.equal(projection.orthoMatrixAfterIdRender, true, 'an ID render restores the orthographic camera');
      assert.ok(Math.abs(projection.orthoRefit - projection.orthoFit.width) <= 1, `frame() refits an orthographic view to the same size: ${projection.orthoRefit} vs ${projection.orthoFit.width}`);
      assert.equal(projection.orthoResize.halfAfter, projection.orthoResize.halfBefore, 'a container resize keeps the orthographic half-height');
      assert.ok(Math.abs(projection.orthoResize.aspectAfter - 200 / 300) < 1e-9, `the orthographic aspect follows the container: ${projection.orthoResize.aspectAfter}`);
      assert.ok(projection.explicitOrthoWidth > 20, `an explicit {position} view of an orthographic viewer is sized to the model: ${projection.explicitOrthoWidth}`);
      assert.equal(projection.stage.orthographic, 'OrthographicCamera', 'mountStage takes projection');
      assert.ok(projection.stage.orthoFit.width > 50 && projection.stage.orthoFit.minX > 0 && projection.stage.orthoFit.maxX < 399, `the orthographic stage frames its model: ${JSON.stringify(projection.stage.orthoFit)}`);
      // Invalid values.
      for (const kind of ['mount', 'mountStage']) {
        for (const name of ['isometric', 'uppercase', 'null', 'number']) {
          const rejected = projection.rejected[`${kind} ${name}`];
          assert.match(rejected.message, /^Unknown projection .*; use one of perspective, orthographic$/, `${kind} ${name} is rejected with the allowed values: ${rejected.message}`);
          assert.equal(rejected.canvases, 0, `${kind} ${name}: nothing was created`);
        }
      }
      assert.equal(projection.rejected['mount isometric'].message, 'Unknown projection "isometric"; use one of perspective, orthographic');
      // Floor and background defaults, stated in viewer-api.md.
      assert.deepEqual(projection.floor, { geometry: 'PlaneGeometry', size: [200, 200], y: -0.012, rotationX: -Math.PI / 2, material: 'ShadowMaterial', opacity: 0.18, receivesShadow: true, discs: 0 }, 'the default floor with background null is a 200 x 200 shadow plane, not a disc');
      assert.ok(projection.shadowPixels > projection.noFloorPixels + 100, `a transparent capture with the default floor adds shadow pixels beyond the model (${projection.shadowPixels} vs ${projection.noFloorPixels})`);
      assert.equal(projection.noFloorPlane, false, 'floor: false draws no plane');
      assert.deepEqual(projection.defaults, { background: '#dce7eb', floorMaterial: 'MeshStandardMaterial', floorColor: '#dce7eb', orbit: true }, 'the defaults are background #dce7eb, a floor of the same color, orbit on');
      console.log(`Projection: omitted == perspective (matrix and pixels); orthographic widths ${projection.orthoWidths} at three distances vs perspective ${projection.perspectiveWidths}; invalid value -> ${projection.rejected['mount isometric'].message}`);
      console.log(`Floor: ${JSON.stringify(projection.floor)}; opaque pixels with the default floor ${projection.shadowPixels}, with floor:false ${projection.noFloorPixels}`);
    }
    await page.screenshot({ path: join(evidence, `${label}.png`) });
    assert.deepEqual(errors, [], `${label}: console errors`);
    await context.close();
  }
  console.log(`Viewer runtime verified. Evidence in ${evidence}`);
} finally {
  await browser.close();
}
