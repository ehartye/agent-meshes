import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPuppet } from '../render/puppet.ts';
import type { Puppet } from '../render/puppet.ts';
import { collectIdTargets } from '../render/id-render.ts';
import { parseQuality } from '../render/quality.ts';
import type { QualityInput } from '../render/quality.ts';
import type { IdImage, IdRenderOptions } from '../render/id-render.ts';
import type { GlbInput } from './room.ts';
import { addFloor, addOutlines, addRoomLights, bytesOf, captureId, createRenderer, idImageURL } from './room.ts';

export const version = '1';
export { viewDirection, viewNames } from './views.ts';
export type { ViewName, ViewSpec } from './views.ts';
import { viewDirection } from './views.ts';
import type { ViewName, ViewSpec } from './views.ts';
export type { Pose, PoseInput, MaterialValues, MaterialInput, Aim, AimOptions } from '../render/puppet.ts';
export type { Quality, QualityInput, QualityOptions, QualityPreset } from '../render/quality.ts';
export type { IdImage, IdRenderOptions, IdRenderColors } from '../render/id-render.ts';
export { countColors } from '../render/id-render.ts';
export { mountStage } from './stage.ts';
export type { Stage, StageOptions, StageModelOptions, StageTarget, FrameOptions } from './stage.ts';
export type { StageModel, Placement, PlacementInput } from '../render/stage.ts';
export type { Anchor, Anchors, Observations, PoseSample, PoseSampler } from '../render/observation.ts';
export { createAssembly, solveFrame } from '../render/assembly.ts';
export type { Assembly, AssemblySpec, AssemblyPiece, AssemblyJoint, AssemblySnapshot, AssemblyAnchor, AssemblyAction, AssemblyMatrix, AssemblyPoint } from '../render/assembly.ts';
export { createSweep } from '../render/sweep.ts';
export type { Sweep, SweepSpec, SweepSample } from '../render/sweep.ts';
export { createCarver } from './carver.ts';
export type { Carver, CarverOptions, CarverResult } from './carver.ts';
export type { CarveRequest, EllipticalCutter, SolidBounds } from '../render/carving.ts';
export { createPlanarFigure } from '../render/planar-figure.ts';
export { planarFigureProfile } from '../render/planar-figure.ts';
export { validatePlanarContour } from '../render/planar-figure.ts';
export type { PlanarPoint as PlanarFigurePoint, PlanarEffector, PlanarTargets, PlanarTargetPatch, PlanarLimb, PlanarContourInfo, PlanarFigureSnapshot, PlanarFigure } from '../render/planar-figure.ts';
export { createPlanarLinkage } from '../mechanisms/planar-linkage.ts';
export type { PlanarPoint, PlanarCrank, PlanarIntersection, PlanarLinkageSpec, PlanarLinkageSample, PlanarLinkage } from '../mechanisms/planar-linkage.ts';
export { createBeltDrive } from '../mechanisms/belt-drive.ts';
export type { BeltPoint, BeltPulley, BeltDriveSpec, BeltSegment, BeltDrive } from '../mechanisms/belt-drive.ts';

export interface MountOptions {
  /** GLB bytes, or the GLB as a base64 string (works from file:// where fetch does not). */
  glb: GlbInput;
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
  /** Renderer quality: `high` (default), `fast` (no MSAA, pixel ratio 1, no shadows) or `{preset?, antialias?, pixelRatio?, shadows?}`. */
  quality?: QualityInput;
}
/** Mount a rendered puppet inside a container element. The container decides the size. */
export async function mount(container: HTMLElement, options: MountOptions) {
  const quality = parseQuality(options.quality, devicePixelRatio);
  const gltf = await new GLTFLoader().parseAsync(bytesOf(options.glb), '');
  const puppet = createPuppet(gltf);
  const scene = new THREE.Scene();
  const background = options.background === undefined ? '#dce7eb' : options.background;
  if (background) scene.background = new THREE.Color(background);
  const renderer = createRenderer(container, !background, quality);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enabled = options.orbit ?? true;
  scene.add(gltf.scene); gltf.scene.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
  addRoomLights(renderer, scene, quality);
  const hulls = options.outline ? addOutlines(puppet, options.outline, options.outlineColor) : [];
  const floor = options.floor ?? true ? addFloor(scene, background) : null;

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
    // Every setter call since the last frame is applied here, once.
    puppet.sync();
    renderer.render(scene, camera);
  });
  const idRender = (id: IdRenderOptions): IdImage => {
    if (id.models !== undefined) throw new Error('idRender models apply to a stage (MeshViewer.mountStage); a single-model viewer renders its one model');
    const { models: _models, ...rest } = id;
    puppet.sync();
    return captureId(renderer, scene, camera, collectIdTargets([{ model: null, root: gltf.scene }]), rest, [...hulls, ...floor ? [floor] : []]);
  };

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
    /** Render one frame now and return it as a PNG data URL; `{id}` returns the ID render instead. */
    screenshot(options?: { id?: IdRenderOptions }): string {
      if (options?.id) return idImageURL(idRender(options.id));
      puppet.sync(); renderer.render(scene, camera); return renderer.domElement.toDataURL();
    },
    idRender,
    /** Run a callback before every rendered frame. Returns a function that removes it. */
    onFrame(listener: (viewer: Viewer) => void): () => void { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    resize,
    /** Stop rendering, release the WebGL context and remove the canvas. */
    dispose(): void { renderer.setAnimationLoop(null); observer?.disconnect(); controls.dispose(); scene.environment?.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); },
  };
  const viewer: Viewer = Object.assign(Object.create(puppet) as Puppet, extras);
  return viewer;
}
export interface ViewerExtras {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; animations: THREE.AnimationClip[];
  view(spec?: ViewName | ViewSpec, padding?: number): void;
  frame(padding?: number): void;
  setBackground(color: string | null): void;
  screenshot(options?: { id?: IdRenderOptions }): string;
  /** Render once with every surface in an exact unlit color, and return the pixels. Normal materials are restored. */
  idRender(options: IdRenderOptions): IdImage;
  onFrame(listener: (viewer: Viewer) => void): () => void;
  resize(): void;
  dispose(): void;
}
export type Viewer = Puppet & ViewerExtras;
