// Offline proof: actual GLB clip exposures on a separate renderer leave the live puppet untouched.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createCreature } from '../src/recipes/index.ts';
import { exportGLB } from '../src/export.ts';
import { viewerScript } from '../src/preview-html.ts';

const output = resolve('.agent-meshes/check-pose-sampler');
await mkdir(output, { recursive: true });
const bytes = process.argv[2] ? await readFile(resolve(process.argv[2])) : await exportGLB(createCreature('equine', { gaits: ['gallop'] }));
await writeFile(join(output, 'mesh-viewer.js'), await viewerScript());
await writeFile(join(output, 'harness.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#eee9df}#live{width:800px;height:400px}#capture{position:absolute;left:-1000px;width:320px;height:200px}#strip{display:grid;grid-template-columns:repeat(4,200px)}#strip img{width:200px}</style><div id="live"></div><div id="capture"></div><div id="strip"></div><script id="glb" type="text/plain">${Buffer.from(bytes).toString('base64')}</script><script src="mesh-viewer.js"></script><script>window.ready=Promise.all(['live','capture'].map(id=>MeshViewer.mount(document.getElementById(id),{glb:document.getElementById('glb').textContent,autoplay:false,view:'front',background:'#eee9df'}))).then(([live,capture])=>Object.assign(window,{live,capture}));</script>`);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 800, height: 780 } });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(join(output, 'harness.html')).href); await page.evaluate(() => window.ready);
  await page.evaluate(() => { for (const viewer of [window.live, window.capture]) { viewer.view('side'); viewer.frame(1); } });
  const result = await page.evaluate(() => {
    const { live, capture } = window, clip = live.clips.find(name => /gallop/.test(name)) ?? live.clips[0];
    live.play(clip); live.seek(live.duration * .31); live.speed = .8;
    const anchor = live.bones.find(name => /front.*ankle/.test(name)) ?? live.bones.at(-1);
    const state = () => JSON.stringify({ time: live.time, playing: live.playing, speed: live.speed, clip: live.clip, camera: live.camera.matrixWorld.toArray(), points: live.observe({ point: { node: anchor } }) });
    const before = state(), pixels = live.screenshot(), sampler = live.createPoseSampler();
    capture.root.removeFromParent(); capture.scene.add(sampler.root);
    const samples = [], images = [], started = performance.now();
    for (let i = 0; i < 12; i++) {
      sampler.sample({ clip, time: live.duration * i / 12 });
      samples.push(sampler.observe({ point: { node: anchor } }).point);
      capture.renderer.render(capture.scene, capture.camera);
      const image = capture.renderer.domElement.toDataURL(); images.push(image);
      const img = document.createElement('img'); img.src = image; img.alt = `Actual clip exposure ${i + 1}`; document.getElementById('strip').append(img);
    }
    const elapsed = performance.now() - started, unchanged = before === state() && pixels === live.screenshot();
    sampler.dispose(); sampler.dispose(); capture.renderer.render(capture.scene, capture.camera);
    const geometry = live.object(live.parts[0]).geometry;
    const retained = geometry.attributes.position.count > 0;
    live.pause();
    return { clip, anchor, exposures: images.length, distinctImages: new Set(images).size, samples, elapsedMs: elapsed, unchanged, retained };
  });
  assert.equal(result.exposures, 12); assert.ok(result.distinctImages >= 10, 'actual poses produce distinct images');
  assert.equal(result.unchanged, true, 'capture preserves live time/playback/camera/pose/pixels'); assert.equal(result.retained, true);
  assert.ok(new Set(result.samples.map(point => point.join(','))).size >= 10, 'sampled joint actually moves');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  await page.screenshot({ path: join(output, 'twelve-exposures.png'), fullPage: true });
  await writeFile(join(output, 'result.json'), JSON.stringify({ ...result, errors, requests }, null, 2));
  console.log(JSON.stringify({ ...result, samples: `${result.samples.length} recorded points`, output }));
  await context.close();
} finally { await browser.close(); }
