import { Box3, Euler, Group, MathUtils, Vector3 } from 'three';
import type { Object3D } from 'three';
import { createPuppet } from './puppet.ts';
import type { GltfSource, Puppet } from './puppet.ts';
import { finiteTriple } from './observation.ts';

type Triple = [number, number, number];
/** Where a model stands on the stage: meters, XYZ Euler degrees, and a positive scale (one number is uniform). */
export interface PlacementInput { position?: Triple; rotation?: Triple; scale?: number | Triple }
export interface Placement { position: Triple; rotation: Triple; scale: Triple }

const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A model name: a letter, then up to 63 letters, digits, `_` or `-`. Names key colors (`pip/iris`), so no `/` or `#`. */
export function parseModelName(name: unknown): string {
  if (typeof name !== 'string' || !namePattern.test(name)) throw new Error(`Model name must be a letter followed by up to 63 letters, digits, _ or -: ${JSON.stringify(name)}`);
  return name;
}

/** Validate a placement, filling omitted fields from `base` (identity by default). */
export function parsePlacement(input: unknown, base?: Placement): Placement {
  const result: Placement = base ? structuredClone(base) : { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  if (input === undefined) return result;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Placement must be an object with position, rotation and scale');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!['position', 'rotation', 'scale'].includes(key)) throw new Error(`Unknown placement field "${key}"; use position, rotation or scale`);
  for (const key of ['position', 'rotation'] as const) if (value[key] !== undefined) {
    finiteTriple(value[key] as number[], key); result[key] = [...value[key] as Triple];
  }
  if (value.scale !== undefined) {
    const scale = typeof value.scale === 'number' ? [value.scale, value.scale, value.scale] : value.scale as number[];
    finiteTriple(scale, 'scale');
    if (scale.some(v => v <= 0)) throw new Error(`scale must be positive: ${JSON.stringify(value.scale)}`);
    result.scale = [...scale] as Triple;
  }
  return result;
}

/**
 * Distance from the box center, along `direction` (center toward camera), at which every corner of
 * the box lies inside a perspective frustum with vertical `fovDegrees` and `aspect`. `padding` > 1
 * leaves a margin by narrowing the usable field of view.
 */
export function fitBoxDistance(min: Triple, max: Triple, direction: Triple, fovDegrees: number, aspect: number, padding: number): number {
  if (!(padding > 0) || !Number.isFinite(padding)) throw new Error(`padding must be a positive number: ${padding}`);
  const back = new Vector3(...direction).normalize();
  const right = new Vector3(0, 1, 0).cross(back).normalize(), up = back.clone().cross(right);
  const tanV = Math.tan(MathUtils.degToRad(fovDegrees) / 2) / padding, tanH = tanV * aspect;
  const center = new Vector3(...min).add(new Vector3(...max)).multiplyScalar(0.5), corner = new Vector3();
  let distance = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    corner.set(x, y, z).sub(center);
    distance = Math.max(distance, corner.dot(back) + Math.max(Math.abs(corner.dot(right)) / tanH, Math.abs(corner.dot(up)) / tanV));
  }
  return distance;
}

export interface StageModelExtras {
  /** The model's stage name. */
  readonly name: string;
  /** The placement group that carries the model's transform; its child is the puppet `root`. */
  readonly group: Group;
  /** Move, turn or scale the model. Omitted fields keep their value; invalid input changes nothing. */
  setPlacement(input: PlacementInput): void;
  getPlacement(): Placement;
  /** World-space position of a named node (a bone, part or empty), optionally offset by a local point. */
  worldPoint(node: string, point?: Triple): Triple;
}
export type StageModel = Puppet & StageModelExtras;
interface Entry { model: StageModel; placement: Placement; sync(): void; release(): void }

/**
 * Several glTF models in one scene graph, each with its own placement and independent puppet.
 * Renderer-free: the web stage adds a renderer, camera and room around `root`.
 */
export function createStageScene() {
  const root = new Group(); root.name = 'stage';
  const entries = new Map<string, Entry>();
  const entry = (name: string): Entry => {
    const value = entries.get(name);
    if (!value) throw new Error(`Unknown model "${name}"; ${entries.size ? `use one of ${[...entries.keys()].join(', ')}` : 'the stage is empty'}`);
    return value;
  };
  const place = (group: Group, placement: Placement) => {
    group.position.fromArray(placement.position);
    group.quaternion.setFromEuler(new Euler(...placement.rotation.map(MathUtils.degToRad) as Triple, 'XYZ'));
    group.scale.fromArray(placement.scale);
    group.updateMatrixWorld(true);
  };
  const names = (target?: string | readonly string[]): string[] => {
    const list = target === undefined ? [...entries.keys()] : typeof target === 'string' ? [target] : [...target];
    for (const name of list) entry(name);
    return list;
  };

  const stage = {
    root,
    get models(): string[] { return [...entries.keys()]; },
    model(name: string): StageModel { return entry(name).model; },
    /** Whether `name` is free for `add` (validates the name). */
    check(name: string): void {
      parseModelName(name);
      if (entries.has(name)) throw new Error(`Model "${name}" already exists; remove it first or pick another name`);
    },
    /** Add a loaded glTF under `name` at `placement`. The puppet takes ownership of the scene. */
    add(name: string, gltf: GltfSource, placement?: PlacementInput): StageModel {
      stage.check(name);
      const parsed = parsePlacement(placement);
      const group = new Group(); group.name = `model:${name}`;
      root.add(group); place(group, parsed);
      group.add(gltf.scene);
      const puppet = createPuppet(gltf);
      const extras: StageModelExtras = {
        name, group,
        setPlacement(input) { const next = parsePlacement(input, record.placement); record.placement = next; place(group, next); puppet.seek(puppet.time); },
        getPlacement() { return structuredClone(record.placement); },
        worldPoint(node, point = [0, 0, 0]) { return [...puppet.observe({ point: { node, point } }).point] as Triple; },
      };
      // A handle kept after remove() must not silently drive a released model.
      let released = false;
      const model = new Proxy(Object.assign(Object.create(puppet) as Puppet, extras) as StageModel, {
        get(target, key, receiver) {
          if (released && key !== 'name') throw new Error(`Model "${name}" was removed from the stage`);
          return Reflect.get(target, key, receiver);
        },
      });
      const record: Entry = {
        model, placement: parsed, sync: puppet.sync,
        release() {
          released = true;
          group.removeFromParent();
          group.traverse(object => {
            const mesh = object as Object3D & { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[]; skeleton?: { dispose(): void } };
            mesh.geometry?.dispose(); mesh.skeleton?.dispose();
            for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) material.dispose();
          });
          group.remove(gltf.scene);
        },
      };
      entries.set(name, record);
      return model;
    },
    /** Remove a model and release its geometry, materials and skeletons. */
    remove(name: string): void { entry(name).release(); entries.delete(name); },
    /** World bounds of the whole stage, one model, or a list of models. */
    bounds(target?: string | readonly string[]): Box3 {
      const box = new Box3();
      for (const name of names(target)) box.union(entry(name).model.bounds());
      return box;
    },
    /** Advance every model's playback. Changes are applied by `sync`. */
    update(dt: number): void { for (const { model } of entries.values()) model.update(dt); },
    /** Apply every model's pending setter and playback changes: once per frame, before rendering. */
    sync(): void { for (const record of entries.values()) record.sync(); },
    /** Validate a model list (all models when omitted). */
    names,
  };
  return stage;
}
export type StageScene = ReturnType<typeof createStageScene>;
