#!/usr/bin/env node
// Labelled contact sheet for a SET of static GLBs: one row per model, one column per view, every cell drawn from the
// SAME fixed camera. There is no per-model auto-framing, so a tall piece looks taller than a short one and a proportion
// error shows up across the set. Uses the managed runtime's MeshViewer and its Chromium, like the plugin's own renders.
// Generalised from the chess set's render.mjs and lineup.mjs.
//
//   node recipes/set-sheet.mjs [options] a.glb b.glb ...
//     --out sheet.png            output PNG (default set-sheet.png)
//     --views front,side,q34,top views, left to right (default). Built in: front, side, q34, top, back, back-q34.
//     --camera name=px,py,pz>tx,ty,tz   add or replace a view with an absolute position and target (repeatable),
//                                for close-ups: --camera basefront=0,0.4,2>0,0.4,0
//     --target x,y,z --dist D    the shared camera target and distance (default: the union bounds of all models)
//     --size 360x520             frame size in pixels before cropping (default)
//     --crop-bottom 0.3          keep only the lower 30% of every frame (bases, pivots, plinths)
//     --supersample N            render N times larger, no downscale (default 1, or 2 with --crop-bottom)
//     --cell-scale S             scale the finished sheet by S (default 1)
//     --background '#c9d1d8'     CSS colour behind the models
//     --label '{name} {view}'    cell label; --no-labels turns it off
//     --frames dir               also keep each cell as dir/<name>_<view>.png
//     --json                     print the cameras and cell layout as JSON on stdout
//     --plugin-root DIR          the agent-meshes plugin (default: the parent of this file)
//     --runtime-root DIR         use this installed managed release instead of the one that matches the plugin
// The camera is a 38 degree vertical field of view, +Y up, models face +Z: `front` looks from +Z, `side` from +X.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectGLB } from './lib/glb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node set-sheet.mjs [--out sheet.png] [--views front,side,q34,top] [--camera name=px,py,pz>tx,ty,tz] [--target x,y,z --dist D] [--size WxH] [--crop-bottom F] [--supersample N] [--cell-scale S] [--background css] [--label tmpl|--no-labels] [--frames dir] [--json] <file.glb ...>';
const FOV = 38; // degrees, vertical; matches MeshViewer
const DIRECTIONS = { front: [0, 0, 1], side: [1, 0, 0], back: [0, 0, -1], q34: [0.62, 0.36, 0.84], 'back-q34': [-0.62, 0.36, -0.84], top: [0, 1, 0.0005] };

const opt = { out: 'set-sheet.png', views: ['front', 'side', 'q34', 'top'], cameras: {}, size: [360, 520], background: '#c9d1d8', label: '{name} {view}', cellScale: 1, files: [], pluginRoot: resolve(here, '..') };
const args = process.argv.slice(2);
const take = name => { const v = args.shift(); if (v === undefined) throw new Error(`${name} needs a value`); return v; };
const nums = (name, v, n) => { const a = v.split(',').map(Number); if (a.length !== n || a.some(x => !Number.isFinite(x))) throw new Error(`${name} needs ${n} comma-separated numbers, got "${v}"`); return a; };
try {
  while (args.length) {
    const arg = args.shift();
    if (arg === '--out') opt.out = take(arg);
    else if (arg === '--views') opt.views = take(arg).split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--camera') { const v = take(arg), m = /^([\w-]+)=([^>]+)>(.+)$/.exec(v); if (!m) throw new Error('--camera needs name=px,py,pz>tx,ty,tz'); opt.cameras[m[1]] = { position: nums(arg, m[2], 3), target: nums(arg, m[3], 3) }; }
    else if (arg === '--target') opt.target = nums(arg, take(arg), 3);
    else if (arg === '--dist') { opt.dist = Number(take(arg)); if (!(opt.dist > 0)) throw new Error('--dist must be positive'); }
    else if (arg === '--size') { const m = /^(\d+)x(\d+)$/.exec(take(arg)); if (!m) throw new Error('--size needs WxH'); opt.size = [Number(m[1]), Number(m[2])]; }
    else if (arg === '--crop-bottom') { opt.crop = Number(take(arg)); if (!(opt.crop > 0 && opt.crop <= 1)) throw new Error('--crop-bottom is a fraction in (0, 1]'); }
    else if (arg === '--supersample') { opt.ss = Number(take(arg)); if (!(opt.ss >= 1 && opt.ss <= 4)) throw new Error('--supersample is 1 to 4'); }
    else if (arg === '--cell-scale') { opt.cellScale = Number(take(arg)); if (!(opt.cellScale > 0)) throw new Error('--cell-scale must be positive'); }
    else if (arg === '--background') opt.background = take(arg);
    else if (arg === '--label') opt.label = take(arg);
    else if (arg === '--no-labels') opt.label = null;
    else if (arg === '--frames') opt.frames = resolve(take(arg));
    else if (arg === '--json') opt.json = true;
    else if (arg === '--plugin-root') opt.pluginRoot = resolve(take(arg));
    else if (arg === '--runtime-root') opt.runtimeRoot = resolve(take(arg));
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else opt.files.push(arg);
  }
  if (!opt.files.length) throw new Error('no GLB files given');
  for (const v of opt.views) if (!DIRECTIONS[v] && !opt.cameras[v]) throw new Error(`unknown view "${v}" (built in: ${Object.keys(DIRECTIONS).join(', ')}; or add it with --camera)`);
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }
opt.ss ??= opt.crop ? 2 : 1;

// ---- the shared camera: from the union of every model's world bounds unless given -------------------------------
const infos = opt.files.map(file => inspectGLB(file));
const lo = [0, 1, 2].map(k => Math.min(...infos.map(i => i.min[k]))), hi = [0, 1, 2].map(k => Math.max(...infos.map(i => i.max[k])));
const target = opt.target ?? lo.map((v, k) => (v + hi[k]) / 2);
const half = Math.max(hi[1] - lo[1], 0.01) / 2, reach = Math.max(hi[0] - lo[0], hi[2] - lo[2], 0.01) / 2, aspect = opt.size[0] / opt.size[1];
const fit = Math.max(half, reach / aspect) / Math.tan(FOV / 2 * Math.PI / 180);
const dist = opt.dist ?? +(fit * 1.12 + reach).toFixed(3);
const cameras = {};
for (const view of opt.views) {
  if (opt.cameras[view]) { cameras[view] = opt.cameras[view]; continue; }
  const d = DIRECTIONS[view], n = Math.hypot(...d);
  cameras[view] = { position: target.map((t, k) => +(t + d[k] / n * dist).toFixed(4)), target: target.map(t => +t.toFixed(4)) };
}

// ---- runtime: the viewer script and Chromium come from the managed release -------------------------------------------
let runtimeRoot = opt.runtimeRoot;
if (!runtimeRoot) {
  const { resolveRuntime } = await import(pathToFileURL(join(opt.pluginRoot, 'scripts', 'managed-runtime.js')).href);
  try { runtimeRoot = resolveRuntime(opt.pluginRoot).root; } catch (error) { console.error(`${error.message}\n(Run the mesh-setup skill, or pass --runtime-root <installed managed release>.)`); process.exit(2); }
}
const scratch = mkdtempSync(join(tmpdir(), 'set-sheet-'));
try {
  const viewerFile = join(scratch, 'mesh-viewer.js');
  execFileSync(process.execPath, [join(runtimeRoot, 'scripts', 'agent-meshes.mjs'), 'viewer', viewerFile], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  const { chromium } = createRequire(join(runtimeRoot, 'package.json'))('playwright');

  const [W, H] = opt.size.map(v => v * opt.ss), keep = opt.crop ?? 1, cw = W, ch = Math.round(H * keep);
  const models = opt.files.map((file, i) => ({ name: basename(file, extname(file)), glb: readFileSync(file).toString('base64'), info: infos[i] }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(`<body style="margin:0"><div id="s" style="width:${W}px;height:${H}px"></div></body>`);
    await page.addScriptTag({ path: viewerFile });
    const result = await page.evaluate(async ({ models, cameras, background, cw, ch, W, H, label, scale }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const frames = {};
      for (const m of models) {
        const host = document.getElementById('s'); host.innerHTML = '';
        const v = await MeshViewer.mount(host, { glb: m.glb, autoplay: false, background, floor: false, orbit: false, quality: 'high' });
        frames[m.name] = {};
        for (const [view, cam] of Object.entries(cameras)) { v.view(cam); await wait(150); frames[m.name][view] = v.screenshot(); }
        v.dispose();
      }
      const views = Object.keys(cameras), pad = 0;
      const sheet = document.createElement('canvas'); sheet.width = Math.round(cw * views.length * scale); sheet.height = Math.round(ch * models.length * scale);
      const g = sheet.getContext('2d'); g.fillStyle = background; g.fillRect(0, 0, sheet.width, sheet.height);
      const cells = {};
      for (let r = 0; r < models.length; r++) for (let c = 0; c < views.length; c++) {
        const im = new Image(); im.src = frames[models[r].name][views[c]]; await im.decode();
        const x = Math.round(c * cw * scale), y = Math.round(r * ch * scale), w = Math.round(cw * scale), h = Math.round(ch * scale);
        g.drawImage(im, 0, H - ch, W, ch, x, y, w, h); // the lower `keep` of the frame
        if (label) {
          const text = label.replace('{name}', models[r].name).replace('{view}', views[c]), size = Math.max(11, Math.round(13 * Math.sqrt(scale) * Math.max(1, W / 360)));
          g.font = `${size}px sans-serif`; const tw = g.measureText(text).width;
          g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(x + 2, y + 2, tw + 8, size + 6); g.fillStyle = '#000'; g.fillText(text, x + 6, y + size + 2);
        }
        (cells[models[r].name] ??= {})[views[c]] = frames[models[r].name][views[c]];
      }
      return { sheet: sheet.toDataURL('image/png'), cells };
    }, { models: models.map(({ name, glb }) => ({ name, glb })), cameras, background: opt.background, cw, ch, W, H, label: opt.label, scale: opt.cellScale });
    const png = d => Buffer.from(d.split(',')[1], 'base64');
    writeFileSync(opt.out, png(result.sheet));
    if (opt.frames) {
      mkdirSync(opt.frames, { recursive: true });
      for (const [name, byView] of Object.entries(result.cells)) for (const [view, data] of Object.entries(byView)) writeFileSync(join(opt.frames, `${name}_${view}.png`), png(data));
    }
  } finally { await browser.close(); }
  const summary = { out: resolve(opt.out), models: models.map(m => m.name), views: opt.views, cell: [Math.round(cw * opt.cellScale), Math.round(ch * opt.cellScale)], cropBottom: opt.crop ?? null, target, dist, fov: FOV, cameras };
  if (opt.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`wrote ${summary.out}: ${models.length} models x ${opt.views.length} views, shared camera target [${target.map(v => v.toFixed(2))}] distance ${dist}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
