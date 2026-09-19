import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene } from '../render/scene.ts';
import type { Project, GeometryKind, Vec3 } from '../core/types.ts';
import { installRigUI } from './rig-ui.ts';
import { installAnimationUI } from './animation-ui.ts';
import { createCreature, creatureKinds, creatureInfo } from '../recipes/index.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const status = (message: string, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
export async function api(path: string, body?: unknown): Promise<Project> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
const action = (fn: () => unknown | Promise<unknown>) => async () => { try { await fn(); } catch (error) { status((error as Error).message, true); } };
const viewport = el('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor('#dce7eb'); renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#dce7eb', 22, 55);
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 150);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minDistance = 0.1; controls.maxDistance = 80;
scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 2.6));
const key = new THREE.DirectionalLight('#fff2d8', 3.7); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -10; key.shadow.camera.right = 10; key.shadow.camera.top = 10; key.shadow.camera.bottom = -10; key.shadow.normalBias = 0.025; scene.add(key);
const fill = new THREE.DirectionalLight('#b2e2f0', 1.2); fill.position.set(-5, 3, -3); scene.add(fill);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#dce7eb', roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(30, 30, '#8eacb8', '#b5cbd4'); grid.position.y = -0.009; (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.28; scene.add(grid);
export let project: Project = { version: 1, name: 'Untitled', parts: [], bones: [], clips: [] };
export let built = buildScene(project); scene.add(built.root);
let selected: string | null = null;
let currentView = 'perspective';
const extensions: ((project: Project) => void)[] = [];
export const onProject = (fn: (project: Project) => void) => extensions.push(fn);
export const frameCallbacks: ((dt: number) => void)[] = [];
export { scene, renderer, camera, controls, action, el };

export function setCamera(view = currentView): void {
  currentView = view;
  const box = new THREE.Box3().setFromObject(built.root);
  const center = box.isEmpty() ? new THREE.Vector3(0, 0.8, 0) : box.getCenter(new THREE.Vector3());
  const size = box.isEmpty() ? 2 : box.getSize(new THREE.Vector3()).length();
  const distance = Math.max(size * 1.8, 3);
  controls.maxDistance = Math.max(80, distance * 4);
  camera.far = Math.max(150, distance * 10); camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog('#dce7eb', Math.max(22, distance * 2.5), Math.max(55, distance * 6));
  const direction = view === 'front' ? new THREE.Vector3(0, 0.04, 1) : view === 'side' ? new THREE.Vector3(1, 0.04, 0) : view === 'top' ? new THREE.Vector3(0, 1, 0.001) : new THREE.Vector3(1, 0.65, 1.4);
  camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
  controls.target.copy(center); controls.update();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
}
function select(name: string | null): void {
  selected = name;
  const part = project.parts.find(part => part.name === name);
  el('part-form').hidden = !part; el('inspector-empty').hidden = !!part;
  if (el('selection-label')) el('selection-label').textContent = part ? part.name : 'No part selected';
  document.querySelectorAll<HTMLButtonElement>('.part-row').forEach(button => button.classList.toggle('active', button.dataset.name === name));
  if (!part) return;
  (el('part-name') as HTMLInputElement).value = part.name;
  (el('part-color') as HTMLInputElement).value = part.color;
  ['px', 'py', 'pz'].forEach((id, i) => (el(id) as HTMLInputElement).value = String(part.position[i]));
  ['sx', 'sy', 'sz'].forEach((id, i) => (el(id) as HTMLInputElement).value = String(part.geometry.size[i]));
}
export function showProject(next: Project): void {
  if (JSON.stringify(next) === JSON.stringify(project)) return;
  const changed = project.name !== next.name || project.parts.length === 0;
  project = next; built.dispose(); built = buildScene(project); scene.add(built.root);
  el('project-name').textContent = project.name; el('part-count').textContent = String(project.parts.length);
  el('empty-stage').hidden = project.parts.length > 0;
  const list = el('part-list'); list.replaceChildren();
  project.parts.forEach(part => {
    const button = document.createElement('button'); button.className = 'part-row'; button.dataset.name = part.name;
    const dot = document.createElement('i'); dot.className = 'part-dot'; dot.style.background = part.color;
    const name = document.createElement('span'); name.textContent = part.name;
    const kind = document.createElement('small'); kind.textContent = part.geometry.type;
    button.append(dot, name, kind); button.onclick = () => select(part.name); list.append(button);
  });
  select(project.parts.some(p => p.name === selected) ? selected : project.parts[0]?.name ?? null);
  if (changed) setCamera();
  extensions.forEach(fn => fn(project));
}
function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export { download };
el('add-part').onclick = action(async () => {
  const type = (el('primitive') as HTMLSelectElement).value as GeometryKind;
  let index = 1; while (project.parts.some(p => p.name === `${type}_${index}`)) index++;
  const name = `${type}_${index}`;
  showProject(await api('op', { op: 'add', part: { name, geometry: { type }, position: [0, 0.5, 0], color: '#d9a34b' } })); select(name); status(`Added ${name}`);
});
el('part-form').onsubmit = event => { event.preventDefault(); void action(async () => {
  const part = project.parts.find(p => p.name === selected)!;
  const vector = (ids: string[]) => ids.map(id => Number((el(id) as HTMLInputElement).value)) as Vec3;
  const size = vector(['sx', 'sy', 'sz']);
  showProject(await api('op', { op: 'update', name: selected, changes: { position: vector(['px', 'py', 'pz']), ...(JSON.stringify(size) === JSON.stringify(part.geometry.size) ? {} : { geometry: { ...part.geometry, size } }), color: (el('part-color') as HTMLInputElement).value } })); status(`Updated ${selected}`);
})(); };
el('remove-part').onclick = action(async () => { showProject(await api('op', { op: 'remove', name: selected })); status('Part removed'); });
el('new-project').onclick = action(async () => { const name = prompt('Project name', 'Untitled'); if (name) { showProject(await api('new', { name })); status('New project'); } });
el('undo').onclick = action(async () => { showProject(await api('undo', {})); status('Undone'); });
el('redo').onclick = action(async () => { showProject(await api('redo', {})); status('Redone'); });
el('fit').onclick = () => setCamera();
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => setCamera(button.dataset.view));
el('download-project').onclick = () => download(`${project.name.replace(/[^a-z0-9_-]/gi, '-')}.mesh.json`, new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
el('open-project').onclick = () => el('file-input').click();
el<HTMLInputElement>('file-input').onchange = action(async () => { const file = el<HTMLInputElement>('file-input').files?.[0]; if (file) { showProject(await api('project', JSON.parse(await file.text()))); status(`Opened ${file.name}`); } });
const ray = new THREE.Raycaster();
let down = [0, 0];
renderer.domElement.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY]; });
renderer.domElement.addEventListener('pointerup', event => {
  if (Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
  const hit = ray.intersectObject(built.root, true)[0]; if (hit?.object.userData.part) select(hit.object.userData.part);
});
new ResizeObserver(() => { const w = viewport.clientWidth, h = viewport.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }).observe(viewport);
let last = performance.now();
renderer.setAnimationLoop(now => { const dt = Math.min((now - last) / 1000, 0.1); last = now; frameCallbacks.forEach(fn => fn(dt)); controls.update(); renderer.render(scene, camera); });
setCamera();
const events = new EventSource('/api/events');
onProject(installRigUI({ project: () => project, root: () => built.root, selectedPart: () => selected, scene, op: async op => {
  if (op.op !== 'pose') { showProject(await api('op', op)); return; }
  const positions = new Map([...built.bones].map(([name, bone]) => [name, bone.position.clone()]));
  const operations = project.bones.map(def => ({ op: 'pose', name: def.name, rotation: def.name === op.name ? op.rotation : new THREE.Quaternion().fromArray(def.rotation).invert().multiply(built.bones.get(def.name)!.quaternion).normalize().toArray() }));
  showProject(await api('batch', { operations }));
  for (const [name, position] of positions) built.bones.get(name)?.position.copy(position);
  built.root.updateMatrixWorld(true); built.skeleton.update();
}, status }));
const animation = installAnimationUI({ project: () => project, built: () => built, op: async op => { showProject(await api('op', op)); }, status });
onProject(animation.projectChanged); frameCallbacks.push(animation.update);
const recipePicker = el('recipe-picker');
recipePicker.innerHTML = '<div class="panel-heading recipe-heading">START WITH A CREATURE</div><div class="recipe-grid"></div><p class="recipe-note">Load a rigged model. Make it your own.</p>';
for (const kind of creatureKinds) {
  const info = creatureInfo[kind], button = document.createElement('button');
  button.className = 'recipe-button'; button.dataset.recipe = kind;
  button.title = `${info.name} · ${info.description}`;
  button.innerHTML = `<span class="recipe-number" style="color:${info.color}">${info.legs}</span><span>${info.label}<small>${kind === 'equine' || kind === 'vulpine' ? 'walk · trot' : info.gait}</small></span>`;
  button.onclick = action(async () => {
    showProject(await api('project', createCreature(kind)));
    animation.seek(0); animation.play(!matchMedia('(prefers-reduced-motion: reduce)').matches);
    const skeleton = el<HTMLInputElement>('show-bones'); skeleton.checked = false; skeleton.dispatchEvent(new Event('change'));
    setCamera('perspective'); status(`${info.name} · ${info.legs} legs · ${info.gait} · Undo restores your previous project`);
  });
  recipePicker.querySelector('.recipe-grid')!.append(button);
}
onProject(project => {
  document.querySelectorAll<HTMLButtonElement>('[data-recipe]').forEach(button => {
    const active = creatureInfo[button.dataset.recipe as typeof creatureKinds[number]].name === project.name;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
});
el('export-panel').innerHTML = '<div class="panel-heading parts-heading"><span>DELIVER</span></div><button id="export-glb" class="primary" style="width:100%;margin-top:12px">Export animated GLB</button>';
el('export-glb').onclick = action(async () => {
  const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error((await response.json()).error ?? 'Export failed');
  download(`${project.name.replace(/[^a-z0-9_-]/gi, '-')}.glb`, await response.blob()); status('Exported model, rig and animation clips');
});
events.onopen = () => { el('connection').textContent = 'Connected'; el('connection-dot').classList.add('online'); };
events.onerror = () => { el('connection').textContent = 'Reconnecting'; el('connection-dot').classList.remove('online'); };
events.onmessage = event => { try { const data = JSON.parse(event.data); showProject(data.project ?? data); } catch (error) { status((error as Error).message, true); } };
void action(async () => { showProject(await api('project')); status('Ready · Add a part or open a project'); })();
Object.assign(window, { meshWorkbench: { get project() { return project; }, get root() { return built.root; }, setCamera, renderer, scene, camera, animation, renderFrame: () => renderer.render(scene, camera) } });
