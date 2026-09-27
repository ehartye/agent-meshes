import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBlender } from '../src/refine.ts';
import { PREVIEW_SHADINGS, PREVIEW_VIEWS, parsePreviewOptions, previewFiles, previewJob, resolvePreviewSource, runPreview, workerAlive } from '../src/preview.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function scratch() { const d = await mkdtemp(join(tmpdir(), 'mesh-preview-')); directories.push(d); return d; }

it('defaults to front, three-quarter and side head views in matcap at 512 px with one rest pose', () => {
  const settings = parsePreviewOptions({});
  expect(settings).toMatchObject({ views: ['front', 'q34', 'side'], shadings: ['matcap'], size: 512, sheet: false, rest: true, hide: [] });
  expect(settings.poses).toEqual([{ name: 'rest', shapes: {} }]);
  expect(previewFiles(settings)).toEqual(['rest-front-matcap.png', 'rest-q34-matcap.png', 'rest-side-matcap.png']);
});

it('expands the head, body and all aliases and rejects unknown views and shadings', () => {
  expect(parsePreviewOptions({ views: 'head' }).views).toEqual(['front', 'q34', 'side', 'below', 'close']);
  expect(parsePreviewOptions({ views: 'body' }).views).toEqual(['body-front', 'body-q34', 'body-side', 'body-back']);
  expect(parsePreviewOptions({ shading: 'all' }).shadings).toEqual([...PREVIEW_SHADINGS]);
  expect(parsePreviewOptions({ views: 'front,close', shading: 'wire,cavity' }).views).toEqual(['front', 'close']);
  for (const view of PREVIEW_VIEWS) expect(parsePreviewOptions({ views: view }).views).toEqual([view]);
  expect(() => parsePreviewOptions({ views: 'top' })).toThrow(/Unknown view top/);
  expect(() => parsePreviewOptions({ shading: 'toon' })).toThrow(/Unknown shading toon/);
  expect(() => parsePreviewOptions({ views: 'front,front' })).toThrow(/twice/);
});

it('parses --shape weights onto every pose and named --pose states into their own files', () => {
  const settings = parsePreviewOptions({ shape: 'eyeBlinkLeft=1,jawOpen=.5', pose: ['smile:mouthSmileLeft=1,mouthSmileRight=1', 'neutral'], views: 'front' });
  expect(settings.poses).toEqual([
    { name: 'smile', shapes: { eyeBlinkLeft: 1, jawOpen: .5, mouthSmileLeft: 1, mouthSmileRight: 1 } },
    { name: 'neutral', shapes: { eyeBlinkLeft: 1, jawOpen: .5 } },
  ]);
  expect(previewFiles(settings)).toEqual(['smile-front-matcap.png', 'neutral-front-matcap.png']);
  expect(parsePreviewOptions({ shape: 'jawOpen=1' }).poses).toEqual([{ name: 'rest', shapes: { jawOpen: 1 } }]);
  for (const bad of ['jawOpen', 'jawOpen=2', 'jawOpen=-1', 'jawOpen=x', '=1', 'jawOpen=1,jawOpen=0']) expect(() => parsePreviewOptions({ shape: bad }), bad).toThrow();
  for (const bad of ['bad name:jawOpen=1', ':jawOpen=1']) expect(() => parsePreviewOptions({ pose: [bad] }), bad).toThrow();
  expect(() => parsePreviewOptions({ pose: ['a', 'a'] })).toThrow(/twice/);
});

it('validates the size, sheet, rest, hide and target options', () => {
  expect(parsePreviewOptions({ size: '256', sheet: true, rest: false, hide: 'hair*,brows', target: 'face' })).toMatchObject({ size: 256, sheet: true, rest: false, hide: ['hair*', 'brows'], target: 'face' });
  for (const size of ['32', '5000', '12.5', 'big']) expect(() => parsePreviewOptions({ size }), size).toThrow(/size/);
});

it('lists the sheet after the renders and writes a job the Blender script reads', () => {
  const settings = parsePreviewOptions({ views: 'front', shading: 'matcap,wire', sheet: true });
  expect(previewFiles(settings)).toEqual(['rest-front-matcap.png', 'rest-front-wire.png', 'sheet.png']);
  expect(previewJob('/a/head.py', '/a/preview', settings)).toEqual({
    source: '/a/head.py', outDir: '/a/preview', views: ['front'], shadings: ['matcap', 'wire'], poses: [{ name: 'rest', shapes: {} }],
    size: 512, sheet: true, rest: true, hide: [], target: null,
  });
});

it('resolves a Blender build.json to its script and a .py to itself, and rejects other inputs', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'head.py'), 'def build():\n    return []\n');
  await writeFile(join(dir, 'build.json'), JSON.stringify({ version: 1, name: 'head', blender: { script: 'head.py' }, output: 'out' }));
  await writeFile(join(dir, 'ops.json'), JSON.stringify({ version: 1, operations: 'x.json', output: 'out' }));
  expect(await resolvePreviewSource(join(dir, 'build.json'))).toBe(join(dir, 'head.py'));
  expect(await resolvePreviewSource(join(dir, 'head.py'))).toBe(join(dir, 'head.py'));
  await expect(resolvePreviewSource(join(dir, 'ops.json'))).rejects.toThrow(/blender/);
  await expect(resolvePreviewSource(join(dir, 'missing.py'))).rejects.toThrow();
});

it('treats a worker as alive only while its heartbeat is fresh', async () => {
  const queue = await scratch();
  expect(await workerAlive(queue)).toBe(false);
  await writeFile(join(queue, 'worker.json'), JSON.stringify({ pid: 1, time: Date.now() / 1000 }));
  expect(await workerAlive(queue)).toBe(true);
  await writeFile(join(queue, 'worker.json'), JSON.stringify({ pid: 1, time: Date.now() / 1000 - 30 }));
  expect(await workerAlive(queue)).toBe(false);
});

it('hands a job to a live worker through its queue and returns its manifest', async () => {
  const dir = await scratch(), queue = join(dir, 'queue');
  await mkdir(queue);
  await writeFile(join(dir, 'head.py'), 'def build():\n    return []\n');
  await writeFile(join(queue, 'worker.json'), JSON.stringify({ pid: 1, time: Date.now() / 1000 }));
  // A stand-in worker: answer the first job dropped in the queue.
  const answer = (async () => {
    for (let i = 0; i < 200; i++) {
      const { readdir } = await import('node:fs/promises');
      const job = (await readdir(queue)).find(name => name.endsWith('.job.json'));
      if (job) {
        const body = JSON.parse(await readFile(join(queue, job), 'utf8'));
        expect(body.source).toBe(join(dir, 'head.py'));
        await writeFile(join(queue, job.replace('.job.json', '.done.json')), JSON.stringify({ ok: true, manifest: { files: ['rest-front-matcap.png'], seconds: .1 } }));
        return;
      }
      await new Promise(done => setTimeout(done, 20));
    }
  })();
  const manifest = await runPreview(join(dir, 'head.py'), parsePreviewOptions({ views: 'front' }), { outDir: join(dir, 'preview'), queue });
  await answer;
  expect(manifest).toMatchObject({ files: ['rest-front-matcap.png'], worker: true });
});

const blender = findBlender();
const maybe = blender ? it : it.skip;

maybe('renders matcap, wire and posed shape-key previews of an authored source in one Blender run', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'blob.py'), [
    'import bpy',
    'from agent_meshes_author import shape_key',
    'def build():',
    '    bpy.ops.mesh.primitive_uv_sphere_add(radius=.1, location=(0, 0, 1.6))',
    '    obj = bpy.context.object',
    '    obj.name = "face"',
    '    shape_key(obj, "jawOpen", [tuple(v.co + v.co.normalized() * .02) for v in obj.data.vertices])',
    '    shape_key(obj, "eyeBlinkLeft", [tuple(v.co) for v in obj.data.vertices])',
    '    return [obj]',
  ].join('\n'));
  const out = join(dir, 'preview');
  const manifest = await runPreview(join(dir, 'blob.py'), parsePreviewOptions({ views: 'front,side', shading: 'matcap,wire', pose: ['rest', 'open:jawOpen=1'], size: '128', sheet: true }), { outDir: out, queue: join(dir, 'no-worker') });
  expect(manifest.files).toEqual(['rest-front-matcap.png', 'rest-front-wire.png', 'rest-side-matcap.png', 'rest-side-wire.png',
    'open-front-matcap.png', 'open-front-wire.png', 'open-side-matcap.png', 'open-side-wire.png']);
  expect(manifest.worker).toBe(false);
  for (const file of [...manifest.files, 'sheet.png', 'preview.json']) expect((await stat(join(out, file))).size).toBeGreaterThan(0);
  const png = await readFile(join(out, 'rest-front-matcap.png'));
  expect(png.readUInt32BE(16)).toBe(128);
  // The open pose's larger sphere fills more of the frame: its PNG differs from the rest one.
  expect((await readFile(join(out, 'open-front-matcap.png'))).equals(png)).toBe(false);
}, 240000);
