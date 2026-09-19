import { AnimationMixer, LoopRepeat, SkinnedMesh, Quaternion, Vector3 } from 'three';
import type { AnimationAction } from 'three';
import type { Project, Operation, Quat, Vec3 } from '../core/types.ts';
import type { buildScene } from '../render/scene.ts';
interface Context {
  project(): Project;
  built(): ReturnType<typeof buildScene>;
  op(operation: Operation): Promise<void>;
  status(message: string, error?: boolean): void;
}
export function installAnimationUI(context: Context) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  el('timeline').innerHTML = `<button id="play" aria-label="Play animation">▶</button><button id="step" aria-label="Step one frame">▸|</button><select id="clip-select" aria-label="Animation clip"><option value="">No animation</option></select><input id="time-scrub" aria-label="Animation time" type="range" min="0" max="2" step="0.001" value="0"><span id="time-label">0.00 s</span><button id="new-clip">New clip</button><button id="record-key" title="Record the current bone poses at this time">Key pose</button>`;
  let mixer: AnimationMixer | null = null, action: AnimationAction | null = null;
  let playing = false, time = 0, selected = '';
  const report = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (error) { context.status((error as Error).message, true); } };
  function refreshGeometry() {
    const built = context.built(); built.root.updateMatrixWorld(true); built.skeleton.update();
    built.root.traverse(object => { if (object instanceof SkinnedMesh) { object.computeBoundingSphere(); object.computeBoundingBox(); } });
  }
  function activate(name = selected) {
    selected = name;
    const clip = context.built().clips.find(clip => clip.name === selected);
    if (!clip || !mixer) { action = null; return; }
    mixer.stopAllAction();
    for (const def of context.project().bones) { const bone = context.built().bones.get(def.name)!; bone.position.fromArray(def.position); bone.quaternion.fromArray(def.rotation); }
    action = mixer.clipAction(clip); action.setLoop(LoopRepeat, Infinity).play();
    el<HTMLSelectElement>('clip-select').value = selected;
    el<HTMLInputElement>('time-scrub').max = String(clip.duration);
  }
  function seek(next: number, name = selected) {
    if (!Number.isFinite(next)) throw new Error('Animation time must be finite');
    if (name !== selected || !action) activate(name);
    const duration = action?.getClip().duration ?? 2;
    time = Math.max(0, Math.min(next, duration));
    if (mixer && action) mixer.setTime(time);
    refreshGeometry(); el<HTMLInputElement>('time-scrub').value = String(time); el('time-label').textContent = `${time.toFixed(2)} s`;
  }
  function play(value: boolean) {
    if (value && !action) activate();
    playing = value && !!action; el('play').textContent = playing ? 'Ⅱ' : '▶'; el('play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
  }
  el('play').onclick = () => play(!playing);
  el('step').onclick = () => { play(false); seek(time + 1 / 24); };
  el<HTMLInputElement>('time-scrub').oninput = () => { play(false); seek(Number(el<HTMLInputElement>('time-scrub').value)); };
  el<HTMLSelectElement>('clip-select').onchange = () => { activate(el<HTMLSelectElement>('clip-select').value); seek(0); };
  el('new-clip').onclick = report(async () => {
    const project = context.project(); if (!project.bones.length) throw new Error('Add a skeleton before creating a clip');
    const name = prompt('Clip name', 'motion'); if (!name) return;
    if (project.clips.some(clip => clip.name === name)) throw new Error('A clip with that name already exists');
    await context.op({ op: 'clip.set', clip: { name, duration: 2, tracks: project.bones.map(bone => ({ bone: bone.name, property: 'rotation', keys: [{ time: 0, value: [...bone.pose] as Quat }, { time: 2, value: [...bone.pose] as Quat }] })) } });
    activate(name); seek(0); context.status(`Created ${name} · 2 seconds`);
  });
  el('record-key').onclick = report(async () => {
    const project = context.project(); const clip = structuredClone(project.clips.find(clip => clip.name === selected));
    if (!clip) throw new Error('Create or select a clip first');
    for (const def of project.bones) {
      const bone = context.built().bones.get(def.name)!;
      const rotation = new Quaternion().fromArray(def.rotation).invert().multiply(bone.quaternion).normalize().toArray() as Quat;
      const position = bone.position.clone().sub(new Vector3().fromArray(def.position)).toArray() as Vec3;
      for (const property of ['rotation', 'position'] as const) {
        const value = property === 'rotation' ? rotation : position;
        const neutral: Quat | Vec3 = property === 'rotation' ? [0, 0, 0, 1] : [0, 0, 0];
        let track = clip.tracks.find(track => track.bone === def.name && track.property === property);
        if (!track) { track = { bone: def.name, property, keys: [{ time: 0, value: [...neutral] }, { time: clip.duration, value: [...neutral] }] }; clip.tracks.push(track); }
        const keyTime = time >= clip.duration ? clip.duration : Math.min(clip.duration, Math.round(time * 1000) / 1000);
        track.keys = track.keys.filter(key => Math.abs(key.time - keyTime) > 1e-6);
        track.keys.push({ time: keyTime, value }); track.keys.sort((a, b) => a.time - b.time);
        if (keyTime === 0) track.keys.at(-1)!.value = [...value];
        if (keyTime === clip.duration) track.keys[0].value = [...value];
      }
    }
    const recordedTime = time;
    await context.op({ op: 'clip.set', clip }); seek(recordedTime, clip.name); context.status(`Keyed pose at ${time.toFixed(2)} s`);
  });
  return {
    seek, play,
    get time() { return time; },
    update(dt: number) { if (playing && action) seek((time + dt) % action.getClip().duration); },
    projectChanged(project: Project) {
      if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); }
      mixer = new AnimationMixer(context.built().root); action = null; play(false);
      const select = el<HTMLSelectElement>('clip-select'); select.replaceChildren();
      if (!project.clips.length) select.add(new Option('No animation', ''));
      project.clips.forEach(clip => select.add(new Option(clip.name, clip.name)));
      if (!project.clips.some(clip => clip.name === selected)) { selected = project.clips[0]?.name ?? ''; time = 0; }
      select.value = selected; el<HTMLInputElement>('time-scrub').max = String(project.clips.find(clip => clip.name === selected)?.duration ?? 2);
      el<HTMLInputElement>('time-scrub').value = String(time); el('time-label').textContent = `${time.toFixed(2)} s`;
    },
  };
}
