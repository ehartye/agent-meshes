import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPuppet } from '../render/puppet.ts';
import type { Puppet } from '../render/puppet.ts';

export const version = '1';
export type { Pose, PoseInput } from '../render/puppet.ts';

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
}
export type ViewName = 'front' | 'side' | 'top' | 'perspective';
export interface ViewSpec { position: [number, number, number]; target?: [number, number, number] }

const directions: Record<ViewName, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0.12, 1), side: new THREE.Vector3(1, 0.12, 0), top: new THREE.Vector3(0, 1, 0.0001), perspective: new THREE.Vector3(1, 0.65, 1.4),
};

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
  scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 2.6));
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
      camera.position.copy(center).add(directions[spec].clone().normalize().multiplyScalar(distance)); controls.target.copy(center);
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
    dispose(): void { renderer.setAnimationLoop(null); observer?.disconnect(); controls.dispose(); renderer.dispose(); renderer.domElement.remove(); },
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
