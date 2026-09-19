// Control shell for preview.html. The viewer runtime (window.MeshViewer) is loaded first.
import type { mount as mountViewer, Viewer } from './viewer.ts';
declare const MeshViewer: { mount: typeof mountViewer; version: string };

async function start() {
  const data = JSON.parse(document.getElementById('asset')!.textContent!) as { name: string; glb: string };
  document.getElementById('title')!.textContent = data.name;
  const viewer: Viewer = await MeshViewer.mount(document.getElementById('stage')!, { glb: data.glb });
  const select = document.getElementById('clip') as HTMLSelectElement, scrub = document.getElementById('scrub') as HTMLInputElement, button = document.getElementById('play')!;
  for (const clip of viewer.clips) select.add(new Option(clip, clip));
  const sync = () => { button.textContent = viewer.playing ? 'Pause' : 'Play'; scrub.max = String(viewer.duration || 1); };
  select.onchange = () => { const playing = viewer.playing; viewer.play(select.value); if (!playing) viewer.pause(); sync(); };
  button.onclick = () => { if (viewer.playing) viewer.pause(); else viewer.play(); sync(); };
  scrub.oninput = () => { viewer.pause(); viewer.seek(Number(scrub.value)); sync(); };
  viewer.onFrame(() => { if (viewer.playing) scrub.value = String(viewer.time); });
  document.getElementById('download')!.onclick = () => { const a = document.createElement('a'); a.href = `data:model/gltf-binary;base64,${data.glb}`; a.download = `${data.name}.glb`; a.click(); };
  sync();
  // Kept for existing browser checks that drive the page through window.meshPreview.
  Object.assign(window, { meshPreview: {
    viewer, gltf: { scene: viewer.root, animations: viewer.animations }, renderer: viewer.renderer, scene: viewer.scene, camera: viewer.camera,
    seek: (time: number) => { viewer.seek(time); scrub.value = String(viewer.time); },
    setPlaying: (value: boolean) => { if (value) viewer.play(); else viewer.pause(); sync(); },
  } });
  document.getElementById('status')!.textContent = `${viewer.clips.length} clips · Drag to orbit · Scroll to zoom`;
}
void start().catch(error => { document.getElementById('status')!.textContent = `Could not open model: ${error.message}`; console.error(error); });
