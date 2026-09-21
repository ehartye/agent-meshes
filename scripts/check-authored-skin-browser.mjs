// Optional real Blender -> GLB -> offline public viewer deformation proof.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorGLB } from '../src/author.ts';
import { verifyGLB } from '../src/export.ts';
import { viewerScript } from '../src/preview-html.ts';

const output = resolve('.agent-meshes/skin-proof');
await mkdir(output, { recursive: true });
const result = await authorGLB(resolve('tests/blender_author_skin_fixture.py'), join(output, 'model.glb'));
const bytes = await readFile(result.output);
const report = await verifyGLB(bytes);
assert.equal(report.errors, 0);
await writeFile(join(output, 'mesh-viewer.js'), await viewerScript());
await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0}#stage{width:800px;height:600px}</style><div id="stage"></div><script src="mesh-viewer.js"></script><script>window.ready=MeshViewer.mount(document.getElementById('stage'),{glb:'${bytes.toString('base64')}',autoplay:false,floor:false,background:'#eee9df'}).then(v=>window.viewer=v);</script>`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, offline: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(join(output, 'index.html')).href);
  await page.evaluate(() => window.ready);
  const measured = await page.evaluate(() => {
    const skinned = []; viewer.root.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
    if (skinned.length !== 1) throw new Error(`Expected one skinned surface, got ${skinned.length}`);
    const mesh = skinned[0], vector = mesh.position.clone();
    const positions = () => {
      viewer.root.updateMatrixWorld(true); mesh.skeleton.update();
      return Array.from({length:mesh.geometry.attributes.position.count}, (_, i) => mesh.localToWorld(mesh.getVertexPosition(i, vector)).toArray());
    };
    viewer.seek(0); const rest = positions(), restImage = viewer.screenshot();
    viewer.seek(1); const bent = positions(), bentImage = viewer.screenshot();
    viewer.seek(0); const restored = positions();
    const distances = (a,b) => a.map((p,i) => Math.hypot(...p.map((v,j) => v-b[i][j])));
    const weights = mesh.geometry.attributes.skinWeight;
    const sums = Array.from({length:weights.count}, (_,i) => weights.getX(i)+weights.getY(i)+weights.getZ(i)+weights.getW(i));
    return { clips: viewer.clips, bones: mesh.skeleton.bones.map(b => b.name), rest, moved: distances(rest,bent), restored: Math.max(...distances(rest,restored)), sums, pixelChange: restImage !== bentImage };
  });
  assert.ok(measured.clips.length > 0);
  assert.ok(measured.bones.includes('root') && measured.bones.includes('tip'));
  assert.ok(measured.sums.every(sum => Math.abs(sum-1) < 1e-6));
  const expected = [0,.7,1.3,2].flatMap(z => [[-.2,-.2],[.2,-.2],[.2,.2],[-.2,.2]].map(([x,y]) => [
    2+Math.cos(.2)*1.1*x-Math.sin(.2)*.9*y, .4+1.3*z, 1-Math.sin(.2)*1.1*x-Math.cos(.2)*.9*y,
  ]));
  for (const point of measured.rest) assert.ok(expected.some(p => Math.hypot(...p.map((v,i)=>v-point[i])) < 1e-5), 'export preserves authored world coordinates and glTF axis conversion');
  assert.ok(Math.max(...measured.moved) > .5, `actual skinned vertices move: ${JSON.stringify(measured)}`);
  assert.ok(measured.moved.filter(d => d < 1e-6).length >= 4, 'root-only vertices remain pinned');
  assert.ok(measured.restored < 1e-6, 'seeking rest restores deformed vertices');
  assert.equal(measured.pixelChange, true);
  await page.screenshot({ path: join(output, 'rest.png') });
  await page.evaluate(() => viewer.seek(1));
  await page.screenshot({ path: join(output, 'bent.png') });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'proof.json'), JSON.stringify({ result, report, measured }, null, 2));
  console.log(`PASS authored skin: ${bytes.length} bytes, normalized weights, pinned root, moving vertices/pixels, reset and zero browser errors`);
} finally { await browser.close(); }
