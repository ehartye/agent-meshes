import { Bone, Box3, Color, Euler, Material, MathUtils, Mesh, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { AnimationClip, Interpolant } from 'three';
import { bakePattern, uniformBase } from './pattern.ts';
import type { Pattern } from '../core/types.ts';

/** A pose offset applied on top of the rest pose and any playing clip. Rotation is XYZ Euler degrees; scale multiplies the bone and everything it carries. */
export interface PoseInput { rotation?: [number, number, number]; position?: [number, number, number]; scale?: [number, number, number] }
export interface Pose { rotation: [number, number, number]; position: [number, number, number]; scale: [number, number, number] }
/** A part's surface finish: metalness 0 is paint, 1 bare metal; roughness 0 is a mirror, 1 chalk. */
export interface MaterialValues { metalness: number; roughness: number }
export type MaterialInput = Partial<MaterialValues>;

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
export function createPuppet(gltf: { scene: Object3D; animations: AnimationClip[] }) {
  const root = gltf.scene;
  const bones = new Map<string, Bone>(), parts = new Map<string, Mesh>(), rest = new Map<string, Rest>(), offsets = new Map<string, Offset>();
  const morphRest = new Map<Mesh, number[]>(), morphOverrides = new Map<Mesh, Map<number, number>>();
  root.traverse(object => {
    if (object instanceof Bone) { bones.set(object.name, object); rest.set(object.name, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }); }
    else if (object instanceof Mesh && object.name) {
      // Preserve geometry groups and isolate every slot from other parts (and from other slots).
      object.material = Array.isArray(object.material) ? object.material.map(material => material.clone()) : object.material.clone();
      parts.set(object.name, object);
      if (object.morphTargetInfluences) morphRest.set(object, [...object.morphTargetInfluences]);
    }
  });
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

  const bone = (name: string): Bone => { const value = bones.get(name); if (!value) throw new Error(`Unknown bone: ${name}`); return value; };
  const object = (name: string): Mesh => { const value = parts.get(name); if (!value) throw new Error(`Unknown part: ${name}`); return value; };
  const clipOf = (name: string): AnimationClip => { const value = clips.get(name); if (!value) throw new Error(`Unknown clip: ${name}`); return value; };
  const materials = (mesh: Mesh, slot?: number): Material[] => {
    const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (slot === undefined) return values;
    if (!Number.isInteger(slot) || slot < 0 || slot >= values.length) throw new Error(`Invalid material slot for ${mesh.name}: ${slot}`);
    return [values[slot]];
  };
  const morph = (name: string, target: string): { mesh: Mesh; index: number } => {
    const mesh = object(name), index = mesh.morphTargetDictionary?.[target];
    if (!Number.isInteger(index) || index! < 0 || !mesh.morphTargetInfluences || index! >= mesh.morphTargetInfluences.length) throw new Error(`Unknown morph target for ${name}: ${target}`);
    return { mesh, index: index! };
  };
  /** The uniform base colors of a patterned part (not a shell, whose base is a per-vertex blend). */
  const partBase = (mesh: Mesh) => mesh.userData.shell || materials(mesh).length > 1 ? null : mesh.geometry.getAttribute('color_1') ?? null;
  const rebake = (mesh: Mesh) => bakePattern(mesh.geometry, mesh.userData.pattern as Pattern | undefined, mesh instanceof SkinnedMesh ? mesh.bindMatrix : mesh.matrixWorld);

  /** Rest, then the clip sample, then offsets. Resetting first keeps un-animated bones from accumulating. */
  function apply(): void {
    for (const [name, value] of bones) { const base = rest.get(name)!; value.position.copy(base.position); value.quaternion.copy(base.quaternion); value.scale.copy(base.scale); }
    for (const [mesh, values] of morphRest) for (let i = 0; i < values.length; i++) mesh.morphTargetInfluences![i] = values[i];
    for (const { binding, value } of bindings.values()) binding.setValue(value, 0);
    for (const sampler of samplers) sampler.binding.setValue(sampler.interpolant.evaluate(time), 0);
    for (const [name, offset] of offsets) { const value = bones.get(name)!; value.position.add(offset.position); value.quaternion.multiply(offset.quaternion); value.scale.multiply(offset.scale); }
    for (const [mesh, values] of morphOverrides) for (const [index, weight] of values) mesh.morphTargetInfluences![index] = weight;
    root.updateMatrixWorld(true);
    root.traverse(item => { if (item instanceof SkinnedMesh) { item.skeleton.update(); item.computeBoundingSphere(); } });
  }
  function select(name: string | null): void {
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
    time = 0; apply();
  }
  select(gltf.animations[0]?.name ?? null);

  const puppet = {
    root,
    get bones(): string[] { return [...bones.keys()]; },
    get parts(): string[] { return [...parts.keys()]; },
    get clips(): string[] { return [...clips.keys()]; },
    bone, object,
    /** Set a pose offset for one bone. Omitted fields keep their current offset. */
    setPose(name: string, pose: PoseInput): void {
      bone(name);
      const offset = offsets.get(name) ?? { position: new Vector3(), quaternion: new Quaternion(), euler: [0, 0, 0] as [number, number, number], scale: new Vector3(1, 1, 1) };
      if (pose.rotation) { offset.euler = [...pose.rotation]; offset.quaternion.setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as [number, number, number], 'XYZ')); }
      if (pose.position) offset.position.fromArray(pose.position);
      if (pose.scale) { if (pose.scale.some(v => !(v > 0))) throw new Error(`Scale must be positive: ${pose.scale}`); offset.scale.fromArray(pose.scale); }
      offsets.set(name, offset); apply();
    },
    getPose(name: string): Pose {
      bone(name);
      const offset = offsets.get(name);
      return offset
        ? { rotation: [...offset.euler], position: offset.position.toArray() as [number, number, number], scale: offset.scale.toArray() as [number, number, number] }
        : { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] };
    },
    /** Clear one bone's offset, or all offsets. */
    resetPose(name?: string): void { if (name === undefined) offsets.clear(); else { bone(name); offsets.delete(name); } apply(); },
    /** Override a named morph target after clip sampling. Finite weights may extrapolate beyond 0..1. */
    setMorph(name: string, target: string, weight: number): void {
      const { mesh, index } = morph(name, target);
      if (!Number.isFinite(weight)) throw new Error(`Morph weight must be finite: ${weight}`);
      const values = morphOverrides.get(mesh) ?? new Map<number, number>();
      values.set(index, weight); morphOverrides.set(mesh, values); apply();
    },
    /** Read the effective weight, including animation and any override. */
    getMorph(name: string, target: string): number { const { mesh, index } = morph(name, target); return mesh.morphTargetInfluences![index]; },
    /** Clear one target, one part, or all overrides; reveal the current clip or authored rest weights. */
    resetMorph(name?: string, target?: string): void {
      if (name === undefined) {
        if (target !== undefined) throw new Error('A part name is required to reset a morph target');
        morphOverrides.clear();
      } else if (target === undefined) morphOverrides.delete(object(name));
      else { const { mesh, index } = morph(name, target); morphOverrides.get(mesh)?.delete(index); }
      apply();
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
    seek(value: number): void { time = duration ? ((value % duration) + duration) % duration : 0; apply(); },
    /** Advance playback by dt seconds. Call once per rendered frame. */
    update(dt: number): void { if (playing && current !== null) puppet.seek(time + dt * speed); },
    /** World bounds of the visible, posed puppet, including current morph weights. */
    bounds(): Box3 {
      const box = new Box3(), point = new Vector3();
      root.traverseVisible(item => {
        if (!(item instanceof Mesh)) return;
        if (item instanceof SkinnedMesh || item.geometry.morphAttributes.position?.length) {
          const positions = item.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) box.expandByPoint(item.getVertexPosition(i, point).applyMatrix4(item.matrixWorld));
        } else {
          if (!item.geometry.boundingBox) item.geometry.computeBoundingBox();
          if (item.geometry.boundingBox) box.union(item.geometry.boundingBox.clone().applyMatrix4(item.matrixWorld));
        }
      });
      return box;
    },
  };
  return puppet;
}
export type Puppet = ReturnType<typeof createPuppet>;
