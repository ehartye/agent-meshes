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
interface Sampler { target: Object3D; property: 'position' | 'quaternion'; interpolant: Interpolant }

/**
 * Script control of a loaded glTF puppet: bones, parts, clips, poses and colors by name.
 * Works in Node (for tests) and in the browser (through the viewer). Nothing here renders.
 * Clips are sampled directly rather than through AnimationMixer, which only writes a property
 * when its sampled value changes and so cannot be composed with pose offsets frame by frame.
 */
export function createPuppet(gltf: { scene: Object3D; animations: AnimationClip[] }) {
  const root = gltf.scene;
  const bones = new Map<string, Bone>(), parts = new Map<string, Mesh>(), rest = new Map<string, Rest>(), offsets = new Map<string, Offset>();
  root.traverse(object => {
    if (object instanceof Bone) { bones.set(object.name, object); rest.set(object.name, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }); }
    else if (object instanceof Mesh && object.name) {
      // Exported meshes may share a material when their properties match. Give each part its own.
      object.material = (Array.isArray(object.material) ? object.material[0] : object.material as Material).clone();
      parts.set(object.name, object);
    }
  });
  const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
  let samplers: Sampler[] = [], current: string | null = null, duration = 0, time = 0, playing = false, speed = 1;

  const bone = (name: string): Bone => { const value = bones.get(name); if (!value) throw new Error(`Unknown bone: ${name}`); return value; };
  const object = (name: string): Mesh => { const value = parts.get(name); if (!value) throw new Error(`Unknown part: ${name}`); return value; };
  const clipOf = (name: string): AnimationClip => { const value = clips.get(name); if (!value) throw new Error(`Unknown clip: ${name}`); return value; };
  /** The uniform base colors of a patterned part (not a shell, whose base is a per-vertex blend). */
  const partBase = (mesh: Mesh) => mesh.userData.shell ? null : mesh.geometry.getAttribute('color_1') ?? null;
  const rebake = (mesh: Mesh) => bakePattern(mesh.geometry, mesh.userData.pattern as Pattern | undefined, mesh instanceof SkinnedMesh ? mesh.bindMatrix : mesh.matrixWorld);

  /** Rest, then the clip sample, then offsets. Resetting first keeps un-animated bones from accumulating. */
  function apply(): void {
    for (const [name, value] of bones) { const base = rest.get(name)!; value.position.copy(base.position); value.quaternion.copy(base.quaternion); value.scale.copy(base.scale); }
    for (const sampler of samplers) sampler.target[sampler.property].fromArray(sampler.interpolant.evaluate(time));
    for (const [name, offset] of offsets) { const value = bones.get(name)!; value.position.add(offset.position); value.quaternion.multiply(offset.quaternion); value.scale.multiply(offset.scale); }
    root.updateMatrixWorld(true);
    root.traverse(item => { if (item instanceof SkinnedMesh) { item.skeleton.update(); item.computeBoundingSphere(); } });
  }
  function select(name: string | null): void {
    samplers = []; current = null; duration = 0;
    if (name !== null) {
      const clip = clipOf(name);
      for (const track of clip.tracks) {
        const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
        const target = PropertyBinding.findNode(root, nodeName) as Object3D | null;
        // createInterpolant exists on every KeyframeTrack at runtime but is missing from the typings.
        const sampled = track as typeof track & { createInterpolant(): Interpolant };
        if (target && (propertyName === 'position' || propertyName === 'quaternion')) samplers.push({ target, property: propertyName, interpolant: sampled.createInterpolant() });
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
    /** A patterned part keeps its color in the base attribute under the ink; a plain part in its material; a shell tints through its material. */
    setColor(name: string, hex: string): void {
      const mesh = object(name), base = partBase(mesh);
      if (!base) { (mesh.material as Material & { color: Color }).color.set(hex); return; }
      const c = new Color(hex); for (let i = 0; i < base.count; i++) base.setXYZ(i, c.r, c.g, c.b);
      base.needsUpdate = true; rebake(mesh);
    },
    getColor(name: string): string {
      const mesh = object(name), base = partBase(mesh);
      return `#${(base ? new Color().setRGB(base.getX(0), base.getY(0), base.getZ(0)) : (mesh.material as Material & { color: Color }).color).getHexString()}`;
    },
    /** Set a part's finish, 0 to 1 each: metalness 1 is bare metal, roughness 0 a mirror. Omitted fields keep their value. */
    setMaterial(name: string, finish: MaterialInput): void {
      const material = object(name).material as Material & MaterialValues;
      for (const key of ['metalness', 'roughness'] as const) {
        const value = finish[key];
        if (value === undefined) continue;
        if (!(value >= 0 && value <= 1)) throw new Error(`${key} must be 0 to 1: ${value}`);
        material[key] = value;
      }
    },
    getMaterial(name: string): MaterialValues { const material = object(name).material as Material & MaterialValues; return { metalness: material.metalness, roughness: material.roughness }; },
    /**
     * Re-bake a painted pattern (or none) into the mesh's vertex colors at its bind-pose world points, instantly and
     * without a remesh. Shells and patterned parts export their un-patterned base colors as COLOR_1 (rgb plus the
     * occlusion shade), so swapping patterns is idempotent; a flat part gets a uniform base from its material color the
     * first time and carries its color in the vertices from then on, where setColor and getColor still find it.
     */
    setPattern(name: string, pattern: Pattern | null): void {
      const mesh = object(name), geometry = mesh.geometry, material = mesh.material as Material & { color: Color; vertexColors: boolean };
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
    /** World bounds of the posed puppet. Skinned meshes are measured vertex by vertex, since their bind-pose boxes ignore pose and scale. */
    bounds(): Box3 {
      const box = new Box3(), point = new Vector3();
      root.traverse(item => {
        if (!(item instanceof Mesh) || !item.visible) return;
        if (item instanceof SkinnedMesh) {
          const positions = item.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) box.expandByPoint(item.getVertexPosition(i, point).applyMatrix4(item.matrixWorld));
        } else box.expandByObject(item);
      });
      return box;
    },
  };
  return puppet;
}
export type Puppet = ReturnType<typeof createPuppet>;
