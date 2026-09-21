import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPuppet } from '../render/puppet.ts';
import type { Puppet } from '../render/puppet.ts';

export const version = '1';
export type { Pose, PoseInput, MaterialValues, MaterialInput } from '../render/puppet.ts';
export type { Anchor, Anchors, Observations, PoseSample, PoseSampler } from '../render/observation.ts';
export { createSweep } from '../render/sweep.ts';
export type { Sweep, SweepSpec, SweepSample } from '../render/sweep.ts';
export { createCarver } from './carver.ts';
export type { Carver, CarverOptions, CarverResult } from './carver.ts';
export type { CarveRequest, EllipticalCutter, SolidBounds } from '../render/carving.ts';
export { createPlanarLinkage } from '../mechanisms/planar-linkage.ts';
export type { PlanarPoint, PlanarCrank, PlanarIntersection, PlanarLinkageSpec, PlanarLinkageSample, PlanarLinkage } from '../mechanisms/planar-linkage.ts';

export interface MountOptions {
  /** GLB bytes, or the GLB as a base64 string (works from file:// where fetch does not). */
  glb: ArrayBuffer | Uint8Array | string;
  /** Start playing the first clip. Defaults to true unless the viewer prefers reduced motion. */
  autoplay?: boolean;
  /** Scene background color, or null for transparent. */
  background?: string | null;
  /** Let the viewer drag to orbit and scroll to zoom. Default true. */
  orbit?: boolean;
  /** Draw a shadow-catching floor under the model. Default true. */
  floor?: boolean;
  /** Initial camera view. Default 'perspective'. */
  view?: ViewName | ViewSpec;
  /** Ink outline thickness in meters (an inverted hull behind every part). Default none. */
  outline?: number;
  /** Outline color. Default near-black. */
  outlineColor?: string;
}
/** Camera directions. `side` is the model's right (+x); `top` and `bottom` lean a hair off the pole so the orbit up vector stays defined. */
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'side' | 'top' | 'bottom' | 'perspective';
export interface ViewSpec { position: [number, number, number]; target?: [number, number, number] }

const directions: Record<ViewName, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0.12, 1), back: new THREE.Vector3(0, 0.12, -1),
  left: new THREE.Vector3(-1, 0.12, 0), right: new THREE.Vector3(1, 0.12, 0), side: new THREE.Vector3(1, 0.12, 0),
  top: new THREE.Vector3(0, 1, 0.0001), bottom: new THREE.Vector3(0, -1, 0.0001), perspective: new THREE.Vector3(1, 0.65, 1.4),
};
export const viewNames = Object.keys(directions) as ViewName[];
/** The camera direction of a named view (a fresh vector); an unknown name throws an Error listing the valid names. */
export function viewDirection(name: string): THREE.Vector3 {
  const direction = Object.hasOwn(directions, name) ? directions[name as ViewName] : null;
  if (!direction) throw new Error(`Unknown view "${name}"; use one of ${viewNames.join(', ')}, or {position, target}`);
  return direction.clone();
}

function bytesOf(glb: MountOptions['glb']): ArrayBuffer {
  if (typeof glb === 'string') return Uint8Array.from(atob(glb), char => char.charCodeAt(0)).buffer as ArrayBuffer;
  if (glb instanceof Uint8Array) return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  return glb;
}

/** Mount a rendered puppet inside a container element. The container decides the size. */
export async function mount(container: HTMLElement, options: MountOptions) {
  const gltf = await new GLTFLoader().parseAsync(bytesOf(options.glb), '');
  const puppet = createPuppet(gltf);
  const scene = new THREE.Scene();
  const background = options.background === undefined ? '#dce7eb' : options.background;
  if (background) scene.background = new THREE.Color(background);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !background, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  container.append(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enabled = options.orbit ?? true;
  scene.add(gltf.scene); gltf.scene.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
  // Image-based light from a procedural room: soft fill, believable speculars, no assets to load.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 1.3));
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const hulls = new Map<string, THREE.Mesh>();
  if (options.outline) {
    const thickness = options.outline, ink = new THREE.MeshBasicMaterial({ color: options.outlineColor ?? '#111111', side: THREE.BackSide });
    for (const name of puppet.parts) {
      const mesh = puppet.object(name);
      // Inverted hull: the same geometry pushed out along its normals, drawn back-face only.
      const source = mesh.geometry.clone(); if (!source.getAttribute('normal')) source.computeVertexNormals();
      const pos = source.getAttribute('position'), nor = source.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) + nor.getX(i) * thickness, pos.getY(i) + nor.getY(i) * thickness, pos.getZ(i) + nor.getZ(i) * thickness);
      pos.needsUpdate = true;
      let hull: THREE.Mesh;
      if (mesh instanceof THREE.SkinnedMesh) { const skinned = new THREE.SkinnedMesh(source, ink); mesh.parent!.add(skinned); skinned.bind(mesh.skeleton, mesh.bindMatrix); hull = skinned; }
      else { hull = new THREE.Mesh(source, ink); mesh.parent!.add(hull); hull.position.copy(mesh.position); hull.quaternion.copy(mesh.quaternion); hull.scale.copy(mesh.scale); }
      hull.name = `${name}_outline`; hull.userData.outline = true; hull.castShadow = false; hull.receiveShadow = false; hull.renderOrder = -1;
      hulls.set(name, hull);
    }
    const setVisible = puppet.setVisible.bind(puppet);
    puppet.setVisible = (name, visible) => { setVisible(name, visible); const hull = hulls.get(name); if (hull) hull.visible = visible; };
  }
  const key = new THREE.DirectionalLight('#fff2d8', 3.7); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.normalBias = 0.025; scene.add(key);
  const fill = new THREE.DirectionalLight('#b2e2f0', 1.2); fill.position.set(-5, 3, -3); scene.add(fill);
  let floor: THREE.Mesh | null = null;
  if (options.floor ?? true) {
    floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), background ? new THREE.MeshStandardMaterial({ color: background, roughness: 1 }) : new THREE.ShadowMaterial({ opacity: 0.18 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.receiveShadow = true; scene.add(floor);
  }

  function resize(): void {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(container); resize();

  /** Point the camera at the model from a named direction or an explicit position. */
  function view(spec: ViewName | ViewSpec = 'perspective', padding = 1.8): void {
    const box = puppet.bounds(), center = box.getCenter(new THREE.Vector3());
    if (typeof spec === 'string') {
      const distance = Math.max(box.getSize(new THREE.Vector3()).length() * padding, 3);
      camera.far = Math.max(200, distance * 10); camera.updateProjectionMatrix();
      camera.position.copy(center).add(viewDirection(spec).normalize().multiplyScalar(distance)); controls.target.copy(center);
    } else { camera.position.fromArray(spec.position); controls.target.copy(spec.target ? new THREE.Vector3().fromArray(spec.target) : center); }
    controls.update();
  }
  view(options.view);
  if (options.autoplay ?? !matchMedia('(prefers-reduced-motion: reduce)').matches) puppet.play();

  const frameListeners = new Set<(viewer: Viewer) => void>();
  let last = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    puppet.update(dt); controls.update();
    for (const listener of frameListeners) listener(viewer);
    renderer.render(scene, camera);
  });

  const extras: ViewerExtras = {
    renderer, scene, camera, controls, animations: gltf.animations,
    view,
    /** Re-fit the camera to the model from the current direction. */
    frame(padding = 1.8): void {
      const box = puppet.bounds(), center = box.getCenter(new THREE.Vector3());
      const direction = camera.position.clone().sub(controls.target).normalize();
      const distance = Math.max(box.getSize(new THREE.Vector3()).length() * padding, 3);
      controls.target.copy(center); camera.position.copy(center).add(direction.multiplyScalar(distance)); controls.update();
    },
    setBackground(color: string | null): void { scene.background = color ? new THREE.Color(color) : null; if (floor && floor.material instanceof THREE.MeshStandardMaterial && color) floor.material.color.set(color); },
    /** Render one frame now and return it as a PNG data URL. */
    screenshot(): string { renderer.render(scene, camera); return renderer.domElement.toDataURL(); },
    /** Run a callback before every rendered frame. Returns a function that removes it. */
    onFrame(listener: (viewer: Viewer) => void): () => void { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    resize,
    dispose(): void { renderer.setAnimationLoop(null); observer?.disconnect(); controls.dispose(); scene.environment?.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
  const viewer: Viewer = Object.assign(Object.create(puppet) as Puppet, extras);
  return viewer;
}
export interface ViewerExtras {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; animations: THREE.AnimationClip[];
  view(spec?: ViewName | ViewSpec, padding?: number): void;
  frame(padding?: number): void;
  setBackground(color: string | null): void;
  screenshot(): string;
  onFrame(listener: (viewer: Viewer) => void): () => void;
  resize(): void;
  dispose(): void;
}
export type Viewer = Puppet & ViewerExtras;
