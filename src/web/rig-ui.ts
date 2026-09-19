import { SkeletonHelper, Euler, Quaternion, MathUtils } from 'three';
import type { Group, Scene } from 'three';
import type { Project, Operation, Quat, Vec3 } from '../core/types.ts';

interface RigContext {
  project(): Project;
  root(): Group;
  selectedPart(): string | null;
  scene: Scene;
  op(operation: Operation): Promise<void>;
  status(message: string, error?: boolean): void;
}
export function installRigUI(context: RigContext) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  let selected: string | null = null;
  let helper: SkeletonHelper | null = null;
  const run = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (error) { context.status((error as Error).message, true); } };
  el('bone-panel').innerHTML = `<div class="panel-heading parts-heading"><span>SKELETON</span><label class="check-label"><input type="checkbox" id="show-bones" checked> Show</label></div><div id="bone-list" class="bone-list"></div><details class="bone-create"><summary>Add a bone</summary><label>Name<input id="bone-name" placeholder="hip_left"></label><label>Parent<select id="bone-parent"><option value="">Root</option></select></label><div class="vector"><label>X<input id="bx" type="number" step="any" value="0"></label><label>Y<input id="by" type="number" step="any" value="0"></label><label>Z<input id="bz" type="number" step="any" value="0"></label></div><button id="add-bone" class="primary">Add bone</button></details>`;
  el('rig-inspector').innerHTML = `<section id="bone-controls" hidden><div class="panel-heading parts-heading"><span>POSE</span><span id="selected-bone"></span></div><p class="subtle">Rotate the selected joint in degrees.</p><div class="vector"><label>X<input id="rx" type="number" step="any" value="0"></label><label>Y<input id="ry" type="number" step="any" value="0"></label><label>Z<input id="rz" type="number" step="any" value="0"></label></div><button id="apply-pose" class="primary">Apply pose</button><button id="reset-pose">Reset all poses</button><div class="panel-heading parts-heading"><span>BIND SELECTED PART</span></div><p class="subtle">Choose a part in the list, then bind it to this joint.</p><button id="bind-rigid">Rigid binding</button><label>Blend toward<select id="blend-bone"></select></label><button id="bind-linear">Blend along part Y</button><button id="unbind-part">Unbind part</button></section>`;
  function select(name: string) {
    selected = name; const bone = context.project().bones.find(bone => bone.name === name);
    el('bone-controls').hidden = !bone;
    if (!bone) return;
    el('selected-bone').textContent = name;
    const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(bone.pose));
    ['rx', 'ry', 'rz'].forEach((id, i) => el<HTMLInputElement>(id).value = String(Number(MathUtils.radToDeg([euler.x, euler.y, euler.z][i]).toFixed(2))));
    document.querySelectorAll<HTMLElement>('.bone-row').forEach(row => row.classList.toggle('active', row.dataset.name === name));
  }
  el('add-bone').onclick = run(async () => {
    await context.op({ op: 'bone.add', bone: { name: el<HTMLInputElement>('bone-name').value, parent: el<HTMLSelectElement>('bone-parent').value || null, position: ['bx', 'by', 'bz'].map(id => Number(el<HTMLInputElement>(id).value)) as Vec3 } });
    context.status('Bone added');
  });
  el('apply-pose').onclick = run(async () => {
    if (!selected) return;
    const angles = ['rx', 'ry', 'rz'].map(id => MathUtils.degToRad(Number(el<HTMLInputElement>(id).value)));
    await context.op({ op: 'pose', name: selected, rotation: new Quaternion().setFromEuler(new Euler(...angles as Vec3)).toArray() as Quat });
    context.status(`Posed ${selected}`);
  });
  el('reset-pose').onclick = run(async () => { await context.op({ op: 'pose.reset' }); context.status('Rest pose restored'); });
  const selectedPart = () => { const part = context.project().parts.find(part => part.name === context.selectedPart()); if (!part) throw new Error('Select a mesh part first'); return part; };
  el('bind-rigid').onclick = run(async () => { if (!selected) return; await context.op({ op: 'bind', name: selectedPart().name, binding: { type: 'rigid', bone: selected } }); context.status('Rigid binding applied'); });
  el('bind-linear').onclick = run(async () => { if (!selected) return; const part = selectedPart(); await context.op({ op: 'bind', name: part.name, binding: { type: 'linear', bones: [selected, el<HTMLSelectElement>('blend-bone').value], axis: 'y', range: [-part.geometry.size[1] / 2, part.geometry.size[1] / 2] } }); context.status('Blended skinning applied'); });
  el('unbind-part').onclick = run(async () => { await context.op({ op: 'unbind', name: selectedPart().name }); context.status('Part unbound'); });
  el('show-bones').onchange = () => { if (helper) helper.visible = el<HTMLInputElement>('show-bones').checked; };
  return (project: Project) => {
    if (helper) { context.scene.remove(helper); helper.dispose(); }
    helper = new SkeletonHelper(context.root()); helper.visible = el<HTMLInputElement>('show-bones').checked;
    for (const material of Array.isArray(helper.material) ? helper.material : [helper.material]) { material.depthTest = false; material.transparent = true; material.opacity = 0.85; }
    helper.renderOrder = 10;
    context.scene.add(helper);
    const list = el('bone-list'); list.replaceChildren();
    const parent = el<HTMLSelectElement>('bone-parent'), blend = el<HTMLSelectElement>('blend-bone');
    const previousParent = parent.value, previousBlend = blend.value;
    parent.replaceChildren(new Option('Root', '')); blend.replaceChildren();
    for (const bone of project.bones) {
      const button = document.createElement('button'); button.className = 'bone-row'; button.dataset.name = bone.name; button.textContent = `${bone.parent ? '↳ ' : '◇ '}${bone.name}`; button.onclick = () => select(bone.name); list.append(button);
      parent.add(new Option(bone.name, bone.name)); blend.add(new Option(bone.name, bone.name));
    }
    parent.value = previousParent; if (project.bones.some(b => b.name === previousBlend)) blend.value = previousBlend;
    if (!project.bones.some(bone => bone.name === selected)) selected = project.bones[0]?.name ?? null;
    el('bone-controls').hidden = !selected;
    if (selected) select(selected);
  };
}
