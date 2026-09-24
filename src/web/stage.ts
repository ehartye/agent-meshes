import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createStageScene, fitBoxDistance, parsePlacement } from '../render/stage.ts';
import type { PlacementInput, StageModel } from '../render/stage.ts';
import { collectIdTargets } from '../render/id-render.ts';
import { parseQuality } from '../render/quality.ts';
import type { QualityInput } from '../render/quality.ts';
import type { IdImage, IdRenderOptions } from '../render/id-render.ts';
import { addFloor, addOutlines, addRoomLights, bytesOf, captureId, createRenderer, idImageURL } from './room.ts';
import type { GlbInput } from './room.ts';
import { viewDirection } from './views.ts';
import type { ViewName, ViewSpec } from './views.ts';

export interface StageModelOptions extends PlacementInput {
  /** GLB bytes or a base64 string. */
  glb: GlbInput;
  /** Start this model's first clip. Default: the stage's `autoplay`. */
  autoplay?: boolean;
}
export interface StageOptions {
  /** Models to load, by name, in order. More can be added later with `stage.add`. */
  models?: Record<string, StageModelOptions>;
  /** Start every model's first clip. Default true unless the viewer prefers reduced motion. */
  autoplay?: boolean;
  /** Scene background color, or null for transparent. Default `#dce7eb`. */
  background?: string | null;
  orbit?: boolean;
  floor?: boolean;
  /** Initial camera view of the whole stage. Default `front`. */
  view?: ViewName | ViewSpec;
  outline?: number;
  outlineColor?: string;
  /** Renderer quality: `high` (default), `fast` (no MSAA, pixel ratio 1, no shadows) or `{preset?, antialias?, pixelRatio?, shadows?}`. */
  quality?: QualityInput;
}
/** Which models a camera or bounds call covers: one name, a list, or all when omitted. */
export type StageTarget = string | readonly string[];
export interface FrameOptions { model?: StageTarget; padding?: number }

const stageOptionKeys = ['models', 'autoplay', 'background', 'orbit', 'floor', 'view', 'outline', 'outlineColor', 'quality'];
const modelOptionKeys = ['glb', 'autoplay', 'position', 'rotation', 'scale'];
function checkKeys(value: object, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} option "${key}"; use ${allowed.join(', ')}`);
}

/**
 * Mount several GLB models on one stage: one renderer, scene, camera, room and floor. Each model
 * has its own placement and an independent puppet (`stage.model(name).setMorph(...)`).
 */
export async function mountStage(container: HTMLElement, options: StageOptions = {}): Promise<Stage> {
  checkKeys(options, stageOptionKeys, 'mountStage');
  const initial = Object.entries(options.models ?? {});
  const content = createStageScene();
  const quality = parseQuality(options.quality, devicePixelRatio);
  // Validate every name and placement before creating a WebGL context.
  for (const [name, model] of initial) { content.check(name); checkKeys(model, modelOptionKeys, `model "${name}"`); parsePlacement({ position: model.position, rotation: model.rotation, scale: model.scale }); }
  const scene = new THREE.Scene();
  const background = options.background === undefined ? '#dce7eb' : options.background;
  if (background) scene.background = new THREE.Color(background);
  const renderer = createRenderer(container, !background, quality);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enabled = options.orbit ?? true;
  scene.add(content.root);
  addRoomLights(renderer, scene, quality);
  const floor = options.floor ?? true ? addFloor(scene, background) : null;
  const hulls = new Map<string, THREE.Mesh[]>();
  const autoplay = options.autoplay ?? !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pending = new Set<string>();
  let disposed = false;

  function resize(): void {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(container); resize();

  const boxOf = (target?: StageTarget): THREE.Box3 => {
    const box = content.bounds(target);
    if (box.isEmpty()) throw new Error(target === undefined ? 'The stage has no visible models to frame' : `Nothing visible to frame in ${JSON.stringify(target)}`);
    return box;
  };
  function place(direction: THREE.Vector3, box: THREE.Box3, padding: number): void {
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const distance = Math.max(fitBoxDistance(box.min.toArray(), box.max.toArray(), direction.toArray(), camera.fov, camera.aspect, padding), size * 0.05, 1e-3);
    camera.near = Math.max(0.001, distance / 1000); camera.far = Math.max(200, distance * 10); camera.updateProjectionMatrix();
    controls.target.copy(center); camera.position.copy(center).add(direction.normalize().multiplyScalar(distance)); controls.update();
  }
  const paddingOf = (options?: FrameOptions) => {
    if (options) checkKeys(options, ['model', 'padding'], 'frame');
    return options?.padding ?? 1.1;
  };

  async function add(name: string, model: StageModelOptions): Promise<StageModel> {
    if (disposed) throw new Error('The stage is disposed');
    content.check(name);
    if (pending.has(name)) throw new Error(`Model "${name}" is already loading`);
    checkKeys(model, modelOptionKeys, `model "${name}"`);
    const placement = { position: model.position, rotation: model.rotation, scale: model.scale };
    parsePlacement(placement);
    const bytes = bytesOf(model.glb);
    pending.add(name);
    try {
      const gltf = await new GLTFLoader().parseAsync(bytes, '');
      if (disposed) throw new Error('The stage is disposed');
      gltf.scene.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
      const added = content.add(name, gltf, placement);
      if (options.outline) hulls.set(name, addOutlines(added, options.outline, options.outlineColor));
      if (model.autoplay ?? autoplay) added.play();
      return added;
    } finally { pending.delete(name); }
  }
  try { for (const [name, model] of initial) await add(name, model); }
  catch (error) {
    // A model that fails to parse must not leave a live WebGL context behind.
    disposed = true; observer?.disconnect(); controls.dispose();
    for (const name of content.models) content.remove(name);
    scene.environment?.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    throw error;
  }

  const frameListeners = new Set<(stage: Stage) => void>();
  let last = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    content.update(dt); controls.update();
    for (const listener of frameListeners) listener(stage);
    // Every setter call since the last frame is applied here, once per model.
    content.sync();
    renderer.render(scene, camera);
  });

  function idRender(id: IdRenderOptions): IdImage {
    const { models, ...rest } = id;
    content.sync();
    const shown = content.names(models);
    const roots = shown.map(name => ({ model: name, root: content.model(name).root }));
    const hidden = content.models.filter(name => !shown.includes(name)).map(name => content.model(name).group);
    return captureId(renderer, scene, camera, collectIdTargets(roots), rest, [...[...hulls.values()].flat(), ...floor ? [floor] : [], ...hidden]);
  }

  const stage: Stage = {
    renderer, scene, camera, controls,
    /** Model names in the order they were added. */
    get models(): string[] { return content.models; },
    /** One model's independent puppet, placement and world anchors. Unknown names throw, listing the models. */
    model(name: string): StageModel { return content.model(name); },
    add,
    /** Remove a model and release its GPU resources. */
    remove(name: string): void { content.remove(name); hulls.delete(name); },
    /** World bounds of the whole stage, one model or a list of models (visible, posed, morphed, skinned). */
    bounds(target?: StageTarget): THREE.Box3 { return content.bounds(target); },
    /** Look at the stage (or `model`) from a named direction or an explicit position; named views fit the bounds. */
    view(spec: ViewName | ViewSpec = 'front', frame?: FrameOptions): void {
      const padding = paddingOf(frame);
      if (typeof spec === 'string') { const direction = viewDirection(spec); place(direction, boxOf(frame?.model), padding); return; }
      const box = content.bounds(frame?.model);
      camera.position.fromArray(spec.position);
      controls.target.copy(spec.target ? new THREE.Vector3().fromArray(spec.target) : box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()));
      controls.update();
    },
    /** Fit the whole stage, or `model`, from the current direction. `padding` > 1 leaves a margin (default 1.1). */
    frame(frame?: FrameOptions): void {
      const padding = paddingOf(frame), box = boxOf(frame?.model);
      place(camera.position.clone().sub(controls.target), box, padding);
    },
    setBackground(color: string | null): void { scene.background = color ? new THREE.Color(color) : null; if (floor && floor.material instanceof THREE.MeshStandardMaterial && color) floor.material.color.set(color); },
    /** Render one frame now and return it as a PNG data URL; `{id}` returns the ID render instead. */
    screenshot(options?: { id?: IdRenderOptions }): string {
      if (options?.id) return idImageURL(idRender(options.id));
      content.sync(); renderer.render(scene, camera); return renderer.domElement.toDataURL();
    },
    /** Render once with every surface in an exact unlit color and return top-row-first RGBA pixels. */
    idRender,
    /** Run a callback before every rendered frame (drive faces here). Returns a function that removes it. */
    onFrame(listener: (stage: Stage) => void): () => void { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    /** Apply every model's pending changes now. Rendering, getters and idRender already do this. */
    sync(): void { content.sync(); },
    resize,
    /** Stop rendering, release every model and the WebGL context, and remove the canvas. Model handles throw afterwards. */
    dispose(): void {
      if (disposed) return; disposed = true;
      renderer.setAnimationLoop(null); observer?.disconnect(); controls.dispose();
      for (const name of content.models) content.remove(name);
      scene.environment?.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
  if (content.models.length) stage.view(options.view ?? 'front');
  else if (options.view && typeof options.view !== 'string') stage.view(options.view);
  return stage;
}
export interface Stage {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  readonly models: string[];
  model(name: string): StageModel;
  add(name: string, model: StageModelOptions): Promise<StageModel>;
  remove(name: string): void;
  bounds(target?: StageTarget): THREE.Box3;
  view(spec?: ViewName | ViewSpec, frame?: FrameOptions): void;
  frame(frame?: FrameOptions): void;
  setBackground(color: string | null): void;
  screenshot(options?: { id?: IdRenderOptions }): string;
  idRender(options: IdRenderOptions): IdImage;
  onFrame(listener: (stage: Stage) => void): () => void;
  sync(): void;
  resize(): void;
  dispose(): void;
}
