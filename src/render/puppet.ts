import { Bone, Box3, Color, Euler, Material, MathUtils, Matrix4, Mesh, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Sphere, Vector3 } from 'three';
import type { AnimationClip, Interpolant, Skeleton } from 'three';
import { bakePattern, uniformBase } from './pattern.ts';
import type { Pattern } from '../core/types.ts';
import { clonePoseSource, finiteTriple, observePoints } from './observation.ts';
import type { Anchors, Observations, PoseSample, PoseSampler } from './observation.ts';

/** A pose offset applied on top of the rest pose and any playing clip. Rotation is XYZ Euler degrees; scale multiplies the bone and everything it carries. */
export interface PoseInput { rotation?: [number, number, number]; position?: [number, number, number]; scale?: [number, number, number] }
export interface Pose { rotation: [number, number, number]; position: [number, number, number]; scale: [number, number, number] }
/** A part's surface finish: metalness 0 is paint, 1 bare metal; roughness 0 is a mirror, 1 chalk. */
export interface MaterialValues { metalness: number; roughness: number }
export type MaterialInput = Partial<MaterialValues>;
/** Limits for `aimBone`, in degrees either side of the bone's un-offset forward (+Z). */
export interface AimOptions { maxYaw?: number; maxPitch?: number }
/** The aim applied: yaw turns +Z toward the bone's +X, pitch toward its +Y (degrees); `clamped` when a limit cut it short. */
export interface Aim { yaw: number; pitch: number; clamped: boolean }

interface Rest { position: Vector3; quaternion: Quaternion; scale: Vector3 }
interface Offset { position: Vector3; quaternion: Quaternion; euler: [number, number, number]; scale: Vector3 }
// These methods exist in Three's PropertyBinding implementation but are absent from its typings.
interface Binding extends PropertyBinding { getValue(buffer: number[], offset: number): void; setValue(buffer: ArrayLike<number>, offset: number): void }
interface BoundRest { binding: Binding; value: number[] }
interface Sampler { binding: Binding; interpolant: Interpolant }

/**
 * Script control of a loaded glTF puppet: bones, parts, clips, poses and colors by name.
 * Works in Node (for tests) and in the browser (through the viewer). Nothing here renders.
 * Clips are sampled directly rather than through AnimationMixer, which only writes a property
 * when its sampled value changes and so cannot be composed with pose offsets frame by frame.
 */
export function createPuppet(gltf: GltfSource) {
  return buildPuppet(gltf, true, primitiveGroups(gltf)).puppet;
}

/** A loaded glTF: GLTFLoader's result, or any `{scene, animations}`. */
export interface GltfSource { scene: Object3D; animations: AnimationClip[]; parser?: { associations?: { get(object: Object3D): { meshes?: number; primitives?: number } | undefined } } }
/**
 * A glTF mesh with several primitives (skin, lids, teeth sharing one set of morph names) loads as a
 * group named after its node holding one three.js mesh per primitive. Map each such group's name to
 * its primitive names, from the loader's associations, so morphs can address the whole glTF mesh.
 */
function primitiveGroups(gltf: GltfSource): Map<string, string[]> {
  const groups = new Map<string, string[]>(), associations = gltf.parser?.associations;
  if (!associations) return groups;
  gltf.scene.traverse(node => {
    const mesh = associations.get(node)?.meshes;
    if (node instanceof Mesh || !node.name || mesh === undefined || associations.get(node)?.primitives !== undefined) return;
    const primitives = node.children.filter(child => child instanceof Mesh && child.name && associations.get(child)?.meshes === mesh);
    if (primitives.length) groups.set(node.name, primitives.map(child => child.name));
  });
  return groups;
}

function buildPuppet(gltf: GltfSource, capture: boolean, groupNames: ReadonlyMap<string, string[]>) {
  // Geometry is shared read-only; the lightweight authored hierarchy precedes all clip sampling.
  const authored = capture ? clonePoseSource(gltf) : null;
  const root = gltf.scene;
  const bones = new Map<string, Bone>(), parts = new Map<string, Mesh>(), rest = new Map<string, Rest>(), offsets = new Map<string, Offset>();
  const morphRest = new Map<Mesh, number[]>(), morphOverrides = new Map<Mesh, Map<number, number>>();
  const ownedMaterials = new Set<Material>(), ownedSkeletons = new Set<Skeleton>();
  root.traverse(object => {
    if (object instanceof Bone) { bones.set(object.name, object); rest.set(object.name, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }); }
    else if (object instanceof Mesh) {
      // Preserve geometry groups and isolate every slot from other parts (and from other slots).
      object.material = Array.isArray(object.material) ? object.material.map(material => material.clone()) : object.material.clone();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) ownedMaterials.add(material);
      if (object instanceof SkinnedMesh) {
        ownedSkeletons.add(object.skeleton);
        // Three culls a skin by a bounding sphere it computes once; poses and clips move the skin away
        // from that sphere, and recomputing it walks every vertex. Skins are drawn unculled instead.
        object.frustumCulled = false;
      }
      if (object.name) parts.set(object.name, object);
      if (object.morphTargetInfluences) morphRest.set(object, [...object.morphTargetInfluences]);
    }
  });
  // Multi-primitive glTF meshes with morph targets, addressable by name wherever a morph takes a part (a part name
  // wins). A morph-free one (an eyeball's white, iris and pupil) is not a morph group.
  const meshGroups = new Map<string, Mesh[]>();
  for (const [name, members] of groupNames) {
    const meshes = members.map(member => parts.get(member)).filter((mesh): mesh is Mesh => !!mesh);
    if (!parts.has(name) && meshes.some(mesh => mesh.morphTargetInfluences?.length)) meshGroups.set(name, meshes);
  }
  const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
  const bindings = new Map<string, BoundRest>();
  // Capture all animated properties before sampling any clip: ordinary nodes also need their
  // authored values restored when the next clip leaves a property unanimated.
  for (const clip of gltf.animations) for (const track of clip.tracks) {
    if (bindings.has(track.name)) continue;
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (!['position', 'quaternion', 'scale', 'morphTargetInfluences'].includes(parsed.propertyName) || !PropertyBinding.findNode(root, parsed.nodeName)) continue;
    const binding = new PropertyBinding(root, track.name, parsed) as Binding, value: number[] = [];
    binding.getValue(value, 0);
    bindings.set(track.name, { binding, value });
  }
  let samplers: Sampler[] = [], current: string | null = null, duration = 0, time = 0, playing = false, speed = 1;
  // Setters only record their input and mark the puppet dirty; the whole rest + clip + offset
  // application runs once, in sync(), before a render or any read of the live three.js state.
  let dirty = false;
  const invalidate = (): void => { dirty = true; };
  function sync(): void { if (dirty) apply(); }

  const bone = (name: string): Bone => { const value = bones.get(name); if (!value) throw new Error(`Unknown bone: ${name}`); return value; };
  const object = (name: string): Mesh => { const value = parts.get(name); if (!value) throw new Error(`Unknown part: ${name}`); return value; };
  const clipOf = (name: string): AnimationClip => { const value = clips.get(name); if (!value) throw new Error(`Unknown clip: ${name}`); return value; };
  const materials = (mesh: Mesh, slot?: number): Material[] => {
    const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (slot === undefined) return values;
    if (!Number.isInteger(slot) || slot < 0 || slot >= values.length) throw new Error(`Invalid material slot for ${mesh.name}: ${slot}`);
    return [values[slot]];
  };
  /** The meshes a morph name addresses: one part, or every primitive of a multi-primitive glTF mesh. */
  const morphMeshes = (name: string): Mesh[] => { const part = parts.get(name); if (part) return [part]; const group = meshGroups.get(name); if (group) return group; return [object(name)]; };
  const morph = (name: string, target: string): { mesh: Mesh; index: number }[] => {
    const found: { mesh: Mesh; index: number }[] = [];
    for (const mesh of morphMeshes(name)) {
      const index = mesh.morphTargetDictionary?.[target];
      if (Number.isInteger(index) && index! >= 0 && mesh.morphTargetInfluences && index! < mesh.morphTargetInfluences.length) found.push({ mesh, index: index! });
    }
    if (!found.length) throw new Error(`Unknown morph target for ${name}: ${target}`);
    return found;
  };
  /** The uniform base colors of a patterned part (not a shell, whose base is a per-vertex blend). */
  const partBase = (mesh: Mesh) => mesh.userData.shell || materials(mesh).length > 1 ? null : mesh.geometry.getAttribute('color_1') ?? null;
  const rebake = (mesh: Mesh) => { sync(); bakePattern(mesh.geometry, mesh.userData.pattern as Pattern | undefined, mesh instanceof SkinnedMesh ? mesh.bindMatrix : mesh.matrixWorld); };

  /** Rest, then the clip sample, then offsets. Resetting first keeps un-animated bones from accumulating. */
  function apply(): void {
    dirty = false;
    for (const [name, value] of bones) { const base = rest.get(name)!; value.position.copy(base.position); value.quaternion.copy(base.quaternion); value.scale.copy(base.scale); }
    for (const [mesh, values] of morphRest) for (let i = 0; i < values.length; i++) mesh.morphTargetInfluences![i] = values[i];
    for (const { binding, value } of bindings.values()) binding.setValue(value, 0);
    for (const sampler of samplers) sampler.binding.setValue(sampler.interpolant.evaluate(time), 0);
    for (const [name, offset] of offsets) { const value = bones.get(name)!; value.position.add(offset.position); value.quaternion.multiply(offset.quaternion); value.scale.multiply(offset.scale); }
    for (const [mesh, values] of morphOverrides) for (const [index, weight] of values) mesh.morphTargetInfluences![index] = weight;
    root.updateMatrixWorld(true);
    for (const skeleton of ownedSkeletons) skeleton.update();
  }
  function select(name: string | null, update = true): void {
    const clip = name === null ? null : clipOf(name);
    samplers = []; current = null; duration = 0;
    if (clip) {
      for (const track of clip.tracks) {
        const bound = bindings.get(track.name);
        // createInterpolant exists on every KeyframeTrack at runtime but is missing from the typings.
        const sampled = track as typeof track & { createInterpolant(): Interpolant };
        if (bound) samplers.push({ binding: bound.binding, interpolant: sampled.createInterpolant() });
      }
      current = name; duration = clip.duration;
    }
    time = 0; if (update) invalidate();
  }
  select(gltf.animations[0]?.name ?? null);
  apply();
  // One exact sphere per skin for three's transparent sorting and raycasting; bounds() refreshes it.
  root.traverse(item => { if (item instanceof SkinnedMesh) item.computeBoundingSphere(); });

  function checkPose(name: string, pose: PoseInput): void {
    bone(name);
    if (typeof pose !== 'object' || pose === null) throw new Error(`Pose for ${name} must be an object with rotation, position or scale`);
    for (const key of ['rotation', 'position', 'scale'] as const) if (pose[key] !== undefined) finiteTriple(pose[key]!, `Pose ${key} for ${name}`);
    if (pose.scale && pose.scale.some(v => !(v > 0))) throw new Error(`Scale must be positive: ${pose.scale}`);
  }
  const offsetOf = (name: string): Offset => {
    const offset = offsets.get(name) ?? { position: new Vector3(), quaternion: new Quaternion(), euler: [0, 0, 0] as [number, number, number], scale: new Vector3(1, 1, 1) };
    offsets.set(name, offset);
    return offset;
  };
  function putPose(name: string, pose: PoseInput): void {
    bone(name);
    const offset = offsetOf(name);
    if (pose.rotation) { offset.euler = [...pose.rotation]; offset.quaternion.setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as [number, number, number], 'XYZ')); }
    if (pose.position) offset.position.fromArray(pose.position);
    if (pose.scale) { if (pose.scale.some(v => !(v > 0))) throw new Error(`Scale must be positive: ${pose.scale}`); offset.scale.fromArray(pose.scale); }
    offsets.set(name, offset);
  }

  function putMorph(name: string, target: string, weight: number): void {
    for (const { mesh, index } of morph(name, target)) {
      const values = morphOverrides.get(mesh) ?? new Map<number, number>();
      values.set(index, weight); morphOverrides.set(mesh, values);
    }
  }
  function checkMorph(name: string, target: string, weight: number): void {
    morph(name, target);
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`Morph weight must be finite: ${weight}`);
  }

  const puppet = {
    /** The model's scene root, with every pending change applied. */
    get root(): Object3D { sync(); return root; },
    /**
     * Apply pending setter changes to the three.js objects now. The viewer and stage call this once
     * before every render, and every puppet getter calls it; call it yourself only before reading
     * bone, mesh or morph state straight off three.js objects you kept from earlier.
     */
    sync,
    /** Observe named local points without changing playback or controls. */
    observe(anchors: Anchors, relativeTo?: string): Observations { sync(); return observePoints(root, anchors, relativeTo); },
    /** Independent authored transforms/materials. Later scene additions are omitted; geometry/textures stay shared. */
    createPoseSampler(): PoseSampler {
      if (!authored) throw new Error('Nested pose samplers are unsupported');
      const sampled = buildPuppet(clonePoseSource(authored), false, groupNames);
      let disposed = false;
      const alive = () => { if (disposed) throw new Error('Pose sampler is disposed'); };
      return {
        root: sampled.puppet.root,
        sample(input) { alive(); sampled.sample(input); },
        observe(anchors, relativeTo) { alive(); return sampled.puppet.observe(anchors, relativeTo); },
        dispose() { if (disposed) return; disposed = true; sampled.release(); },
      };
    },
    get bones(): string[] { return [...bones.keys()]; },
    get parts(): string[] { return [...parts.keys()]; },
    /** Multi-primitive glTF meshes with morph targets (a face whose skin, lids and teeth share morph names); each name drives all its primitives' morphs. Morph-free ones (eyeballs) are left out. */
    get morphGroups(): string[] { return [...meshGroups.keys()]; },
    /** Morph target names of a part or a multi-primitive glTF mesh, in first-seen order. */
    morphTargets(name: string): string[] {
      const names = new Set<string>();
      for (const mesh of morphMeshes(name)) for (const target of Object.keys(mesh.morphTargetDictionary ?? {})) names.add(target);
      return [...names];
    },
    get clips(): string[] { return [...clips.keys()]; },
    /** A bone, with pending changes applied. */
    bone(name: string): Bone { const value = bone(name); sync(); return value; },
    /** A part's mesh, with pending changes applied. */
    object(name: string): Mesh { const value = object(name); sync(); return value; },
    /** Set a pose offset for one bone. Omitted fields keep their current offset. Cheap: applied once before the next render or read. */
    setPose(name: string, pose: PoseInput): void {
      checkPose(name, pose); putPose(name, pose); invalidate();
    },
    /** Set pose offsets for several bones at once (`{eye_L: {rotation}, jaw: {...}}`). Everything is validated before anything changes. */
    setPoses(poses: Readonly<Record<string, PoseInput>>): void {
      const entries = Object.entries(poses);
      for (const [name, pose] of entries) checkPose(name, pose);
      for (const [name, pose] of entries) putPose(name, pose);
      invalidate();
    },
    /**
     * Turn a bone so its forward axis (+Z, the glTF facing) points at a world-space point, as a pose
     * rotation offset over its rest pose and any clip. Yaw turns toward the bone's +X, pitch toward
     * its +Y, each clamped to `maxYaw`/`maxPitch` degrees. The bone's position and scale offsets stay.
     */
    aimBone(name: string, target: readonly [number, number, number], options: AimOptions = {}): Aim {
      const value = bone(name);
      finiteTriple(target, 'aimBone target');
      if (typeof options !== 'object' || options === null) throw new Error('aimBone options must be an object with maxYaw and maxPitch');
      for (const key of Object.keys(options)) if (key !== 'maxYaw' && key !== 'maxPitch') throw new Error(`Unknown aimBone option "${key}"; use maxYaw, maxPitch`);
      const limit = (key: 'maxYaw' | 'maxPitch', fallback: number): number => {
        const given = options[key];
        if (given === undefined) return fallback;
        if (typeof given !== 'number' || !(given >= 0 && given <= 180)) throw new Error(`aimBone ${key} must be a number of degrees from 0 to 180: ${given}`);
        return given;
      };
      const maxYaw = limit('maxYaw', 180), maxPitch = limit('maxPitch', 90);
      sync();
      // The bone's frame without its own rotation offset: parent world x translate x (rest or clip) rotation.
      const offset = offsets.get(name);
      const base = value.quaternion.clone();
      if (offset) base.multiply(offset.quaternion.clone().invert());
      const frame = new Matrix4().compose(value.position, base, new Vector3(1, 1, 1));
      if (value.parent) frame.premultiply(value.parent.matrixWorld);
      const local = new Vector3().fromArray(target).applyMatrix4(frame.invert());
      if (local.lengthSq() < 1e-24) throw new Error(`aimBone target is at the ${name} pivot`);
      const rawYaw = MathUtils.radToDeg(Math.atan2(local.x, local.z)), rawPitch = MathUtils.radToDeg(Math.atan2(local.y, Math.hypot(local.x, local.z)));
      const yaw = Math.max(-maxYaw, Math.min(maxYaw, rawYaw)), pitch = Math.max(-maxPitch, Math.min(maxPitch, rawPitch));
      const record = offsetOf(name);
      // Yaw about +Y, then pitch about the turned +X (a negative X rotation lifts +Z toward +Y).
      record.quaternion.setFromEuler(new Euler(MathUtils.degToRad(-pitch), MathUtils.degToRad(yaw), 0, 'YXZ'));
      const euler = new Euler().setFromQuaternion(record.quaternion, 'XYZ');
      record.euler = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as [number, number, number];
      invalidate();
      return { yaw, pitch, clamped: yaw !== rawYaw || pitch !== rawPitch };
    },
    getPose(name: string): Pose {
      bone(name);
      const offset = offsets.get(name);
      return offset
        ? { rotation: [...offset.euler], position: offset.position.toArray() as [number, number, number], scale: offset.scale.toArray() as [number, number, number] }
        : { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };
    },
    /** Clear one bone's offset, or all offsets. */
    resetPose(name?: string): void { if (name === undefined) offsets.clear(); else { bone(name); offsets.delete(name); } invalidate(); },
    /** Override a named morph target after clip sampling. Finite weights may extrapolate beyond 0..1. */
    setMorph(name: string, target: string, weight: number): void {
      checkMorph(name, target, weight); putMorph(name, target, weight); invalidate();
    },
    /** Override many morph targets at once, by part then target (`{face: {jawOpen: .4, mouthSmileLeft: .2}}`). Everything is validated before anything changes. */
    setMorphs(weights: Readonly<Record<string, Readonly<Record<string, number>>>>): void {
      const entries = Object.entries(weights).flatMap(([name, targets]) => {
        morphMeshes(name);
        if (typeof targets !== 'object' || targets === null) throw new Error(`Morph weights for ${name} must be an object of target weights`);
        return Object.entries(targets).map(([target, weight]) => [name, target, weight] as const);
      });
      for (const [name, target, weight] of entries) checkMorph(name, target, weight);
      for (const [name, target, weight] of entries) putMorph(name, target, weight);
      invalidate();
    },
    /** Read the effective weight, including animation and any override. */
    getMorph(name: string, target: string): number { const [{ mesh, index }] = morph(name, target); sync(); return mesh.morphTargetInfluences![index]; },
    /** Clear one target, one part, or all overrides; reveal the current clip or authored rest weights. */
    resetMorph(name?: string, target?: string): void {
      if (name === undefined) {
        if (target !== undefined) throw new Error('A part name is required to reset a morph target');
        morphOverrides.clear();
      } else if (target === undefined) for (const mesh of morphMeshes(name)) morphOverrides.delete(mesh);
      else for (const { mesh, index } of morph(name, target)) morphOverrides.get(mesh)?.delete(index);
      invalidate();
    },
    /** Set all material slots, or one zero-based slot. Single-material patterned parts keep their color under the ink; other parts tint their material. */
    setColor(name: string, hex: string, slot?: number): void {
      const mesh = object(name), selected = materials(mesh, slot), base = partBase(mesh);
      if (!base) { for (const material of selected) (material as Material & { color: Color }).color.set(hex); return; }
      const c = new Color(hex); for (let i = 0; i < base.count; i++) base.setXYZ(i, c.r, c.g, c.b);
      base.needsUpdate = true; rebake(mesh);
    },
    /** Read one material slot (the first by default). */
    getColor(name: string, slot = 0): string {
      const mesh = object(name), material = materials(mesh, slot)[0], base = partBase(mesh);
      return `#${(base ? new Color().setRGB(base.getX(0), base.getY(0), base.getZ(0)) : (material as Material & { color: Color }).color).getHexString()}`;
    },
    /** Set all material slots, or one zero-based slot. Metalness and roughness are 0..1; omitted fields keep their value. */
    setMaterial(name: string, finish: MaterialInput, slot?: number): void {
      const selected = materials(object(name), slot) as (Material & MaterialValues)[];
      for (const key of ['metalness', 'roughness'] as const) {
        const value = finish[key];
        if (value === undefined) continue;
        if (!(value >= 0 && value <= 1)) throw new Error(`${key} must be 0 to 1: ${value}`);
      }
      for (const material of selected) for (const key of ['metalness', 'roughness'] as const) if (finish[key] !== undefined) material[key] = finish[key];
    },
    /** Read one material slot (the first by default). */
    getMaterial(name: string, slot = 0): MaterialValues { const material = materials(object(name), slot)[0] as Material & MaterialValues; return { metalness: material.metalness, roughness: material.roughness }; },
    /**
     * Re-bake a painted pattern (or none) into the mesh's vertex colors at its bind-pose world points, instantly and
     * without a remesh. Shells and patterned parts export their un-patterned base colors as COLOR_1 (rgb plus the
     * occlusion shade), so swapping patterns is idempotent; a flat part gets a uniform base from its material color the
     * first time and carries its color in the vertices from then on, where setColor and getColor still find it.
     * Multi-material parts are rejected before any mutation, since a uniform base would erase group colors.
     */
    setPattern(name: string, pattern: Pattern | null): void {
      const mesh = object(name), selected = materials(mesh);
      if (selected.length !== 1) throw new Error(`Patterns are unsupported for multi-material parts: ${name}`);
      const geometry = mesh.geometry, material = selected[0] as Material & { color: Color; vertexColors: boolean };
      if (!geometry.getAttribute('color_1')) {
        geometry.setAttribute('color_1', uniformBase(geometry.getAttribute('position').count, material.color));
        material.color.set('#ffffff'); material.vertexColors = true; material.needsUpdate = true;
      }
      if (pattern) mesh.userData.pattern = structuredClone(pattern); else delete mesh.userData.pattern;
      rebake(mesh);
    },
    /** The pattern baked into a mesh, from the export or the last setPattern; null when it is plain. */
    getPattern(name: string): Pattern | null { return (object(name).userData.pattern as Pattern | undefined) ?? null; },
    setVisible(name: string, visible: boolean): void { object(name).visible = visible; },
    /** Play a clip by name, or resume the current one. */
    play(name?: string): void { if (name !== undefined && name !== current) select(name); else if (current === null && clips.size) select([...clips.keys()][0]); playing = true; },
    pause(): void { playing = false; },
    get playing(): boolean { return playing; },
    get clip(): string | null { return current; },
    get duration(): number { return duration; },
    get time(): number { return time; },
    set time(value: number) { puppet.seek(value); },
    get speed(): number { return speed; },
    set speed(value: number) { speed = value; },
    seek(value: number): void { time = duration ? ((value % duration) + duration) % duration : 0; invalidate(); },
    /** Advance playback by dt seconds. Call once per rendered frame. */
    update(dt: number): void { if (playing && current !== null) puppet.seek(time + dt * speed); },
    /** World bounds of the visible, posed puppet, including current morph weights. */
    bounds(): Box3 {
      sync();
      const box = new Box3(), point = new Vector3();
      root.traverseVisible(item => {
        if (!(item instanceof Mesh)) return;
        if (item instanceof SkinnedMesh || item.geometry.morphAttributes.position?.length) {
          const positions = item.geometry.getAttribute('position'), local = new Box3();
          for (let i = 0; i < positions.count; i++) { item.getVertexPosition(i, point); local.expandByPoint(point); box.expandByPoint(point.applyMatrix4(item.matrixWorld)); }
          // The walk already has the posed skin: refresh its sphere (for raycasting and sorting) for free.
          if (item instanceof SkinnedMesh && !local.isEmpty()) { item.boundingBox = local; item.boundingSphere = local.getBoundingSphere(item.boundingSphere ?? new Sphere()); }
        } else {
          if (!item.geometry.boundingBox) item.geometry.computeBoundingBox();
          if (item.geometry.boundingBox) box.union(item.geometry.boundingBox.clone().applyMatrix4(item.matrixWorld));
        }
      });
      return box;
    },
  };
  return {
    puppet,
    sample(input: PoseSample): void {
      // Complete validation precedes changes to the last successful sample.
      if (input.clip !== null) clipOf(input.clip);
      if (!Number.isFinite(input.time)) throw new Error('Sample time must be finite');
      const poses = Object.entries(input.poses ?? {}), morphs = input.morphs ?? [];
      if (poses.length > 4096 || morphs.length > 4096) throw new Error('At most 4096 pose or morph controls');
      for (const [name, pose] of poses) {
        bone(name);
        for (const key of ['rotation', 'position', 'scale'] as const) if (pose[key]) {
          finiteTriple(pose[key]!, `Pose ${key}`);
          if (key === 'scale' && pose.scale!.some(v => v <= 0)) throw new Error('Pose scale must be positive');
        }
      }
      for (const value of morphs) { morph(value.part, value.target); if (!Number.isFinite(value.weight)) throw new Error('Morph weight must be finite'); }
      offsets.clear(); morphOverrides.clear(); select(input.clip, false);
      time = duration ? ((input.time % duration) + duration) % duration : 0;
      for (const [name, pose] of poses) putPose(name, pose);
      for (const value of morphs) putMorph(value.part, value.target, value.weight);
      apply();
    },
    release(): void {
      for (const skeleton of ownedSkeletons) skeleton.dispose();
      for (const material of ownedMaterials) material.dispose();
      root.removeFromParent();
    },
  };
}
export type Puppet = ReturnType<typeof createPuppet>;
