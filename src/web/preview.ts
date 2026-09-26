// Control shell for preview.html. The viewer runtime (window.MeshViewer) is loaded first.
import type { mount as mountViewer, Viewer } from './viewer.ts';
import { morphControls } from './preview-morphs.ts';
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
  // A morph-only model (a talking head) has no clips: hide the playback controls and show its morphs instead.
  if (!viewer.clips.length) for (const id of ['play', 'clip', 'scrub']) (document.getElementById(id) as HTMLElement).hidden = true;
  const controls = morphControls(viewer);
  const panel = document.getElementById('morphs')!;
  const sliders = new Map<string, HTMLInputElement>();
  const apply = (target: string, weight: number) => { for (const owner of controls.targets.find(c => c.target === target)!.owners) viewer.setMorph(owner, target, weight); };
  if (controls.targets.length) {
    panel.hidden = false;
    if (Object.keys(controls.presets).length > 1) {
      const row = panel.appendChild(document.createElement('div')); row.className = 'presets';
      for (const [name, weights] of Object.entries(controls.presets)) {
        const preset = row.appendChild(document.createElement('button')); preset.textContent = name; preset.dataset.preset = name;
        preset.onclick = () => { for (const [target, slider] of sliders) { const w = weights[target] ?? 0; slider.value = String(w); apply(target, w); } };
      }
    }
    for (const { target } of controls.targets) {
      const label = panel.appendChild(document.createElement('label'));
      label.append(target);
      const slider = label.appendChild(document.createElement('input'));
      Object.assign(slider, { type: 'range', min: '0', max: '1', step: '0.01', value: '0' });
      slider.dataset.morph = target; slider.setAttribute('aria-label', target);
      slider.oninput = () => apply(target, Number(slider.value));
      sliders.set(target, slider);
    }
  }
  // Kept for existing browser checks that drive the page through window.meshPreview.
  Object.assign(window, { meshPreview: {
    viewer, gltf: { scene: viewer.root, animations: viewer.animations }, renderer: viewer.renderer, scene: viewer.scene, camera: viewer.camera,
    // Checks read bones straight off the scene, so apply the seek now rather than at the next frame.
    seek: (time: number) => { viewer.seek(time); viewer.sync(); scrub.value = String(viewer.time); },
    setPlaying: (value: boolean) => { if (value) viewer.play(); else viewer.pause(); sync(); },
  } });
  document.getElementById('status')!.textContent = `${viewer.clips.length} clips · ${controls.targets.length} morphs · Drag to orbit · Scroll to zoom`;
}
void start().catch(error => { document.getElementById('status')!.textContent = `Could not open model: ${error.message}`; console.error(error); });
