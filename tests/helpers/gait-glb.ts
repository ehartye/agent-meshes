/**
 * A synthetic walker encoded to GLB in Node, with analytic motion whose gait metrics are known.
 * glTF coordinates: Y up, meters, the walker faces +Z, its anatomical left is +X.
 * Bones use UE-mannequin names; feet are root children placed by closed-form two-link IK.
 */
import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ensureFileReader } from '../../src/node-file-reader.ts';

export interface WalkerOptions {
  duration?: number; stance?: number; stride?: number; lift?: number;
  /** Pelvis vertical bob amplitude (m); pelvis height is 0.84 + bob cos(4 pi phase). */
  bob?: number;
  /** Pelvis yaw amplitude (deg); spine and chest each counter-twist by the same amplitude. */
  yaw?: number;
  /** Pelvis roll amplitude (deg), peaking in single support with the swing-side hip low. */
  roll?: number;
  /** Constant forward bend of spine_01 (deg). */
  lean?: number;
  /** Chest (spine_02) pitch amplitude (deg) at twice the stride frequency; the neck cancels half of it. */
  chestPitch?: number;
  /** Upper-arm swing amplitude (deg); positive swings arms against the same-side leg. */
  arm?: number;
  /** False starts the swing from rest, a velocity pop at liftoff. */
  smoothLiftoff?: boolean;
  /** Move the final key of the left foot (m) so the loop seam opens. */
  seamError?: number;
  /** Names of the two foot meshes. */
  footMeshes?: [string, string];
  /** Declared gait extras; false omits them. */
  declare?: boolean;
  fps?: number;
}

const deg = Math.PI / 180;
const q = (axis: [number, number, number], degrees: number) => new Quaternion().setFromAxisAngle(new Vector3(...axis), degrees * deg);

export function walkerDefaults(options: WalkerOptions = {}) {
  return { duration: 1.2, stance: 0.6, stride: 0.6, lift: 0.1, bob: 0.02, yaw: 4, roll: 5, lean: 6, chestPitch: 3, arm: 20, seamError: 0, smoothLiftoff: true, footMeshes: ['left-outsole', 'right-outsole'] as [string, string], declare: true, fps: 60, ...options };
}

export function footPath(phase: number, o: ReturnType<typeof walkerDefaults>): { z: number; y: number } {
  const p = ((phase % 1) + 1) % 1;
  if (p < o.stance) return { z: o.stride * (0.5 - p / o.stance), y: 0 };
  const u = (p - o.stance) / (1 - o.stance), smooth = u * u * u * (10 + u * (-15 + 6 * u));
  // Quintic swing matching the stance velocity at liftoff and touchdown, so contacts do not pop.
  const travel = o.smoothLiftoff ? o.stride * (1 - o.stance) / o.stance : 0;
  return { z: -o.stride / 2 - travel * u + (o.stride + travel) * smooth, y: o.lift * Math.sin(Math.PI * u) ** 3 };
}

export async function walkerGLB(options: WalkerOptions = {}): Promise<Uint8Array> {
  ensureFileReader();
  const o = walkerDefaults(options);
  const bone = (name: string, parent: Bone | null, position: [number, number, number]) => {
    const b = new Bone(); b.name = name; b.position.set(...position); parent?.add(b); return b;
  };
  const root = bone('root', null, [0, 0, 0]);
  const pelvis = bone('pelvis', root, [0, 0.84, 0]);
  const spine = bone('spine_01', pelvis, [0, 0.1, 0]);
  const chest = bone('spine_02', spine, [0, 0.25, 0]);
  const neck = bone('neck_01', chest, [0, 0.25, 0]);
  const head = bone('head', neck, [0, 0.1, 0]);
  const bones = [root, pelvis, spine, chest, neck, head];
  const legs: Record<'l' | 'r', { thigh: Bone; calf: Bone; foot: Bone; offset: number; x: number }> = {} as never;
  const arms: Record<'l' | 'r', Bone> = {} as never;
  for (const [side, x, offset] of [['l', 0.1, 0], ['r', -0.1, 0.5]] as const) {
    const thigh = bone(`thigh_${side}`, pelvis, [x, 0, 0]);
    const calf = bone(`calf_${side}`, root, [x, 0.5, 0]);
    const foot = bone(`foot_${side}`, root, [x, 0.08, 0]);
    const upper = bone(`upperarm_${side}`, chest, [x * 2, 0.22, 0]);
    const lower = bone(`lowerarm_${side}`, upper, [0, -0.28, 0]);
    legs[side] = { thigh, calf, foot, offset, x }; arms[side] = upper;
    bones.push(thigh, calf, foot, upper, lower);
  }
  const frames = Math.round(o.duration * o.fps), times: number[] = [];
  const values = new Map<string, number[]>();
  const push = (key: string, ...v: number[]) => { if (!values.has(key)) values.set(key, []); values.get(key)!.push(...v); };
  const l1 = 0.42, l2 = 0.42;
  for (let frame = 0; frame <= frames; frame++) {
    const phase = frame / frames, t = phase * o.duration, tau = 2 * Math.PI * phase;
    times.push(t);
    pelvis.position.set(0, 0.84 + o.bob * Math.cos(2 * tau), 0);
    pelvis.quaternion.copy(q([0, 1, 0], o.yaw * Math.sin(tau))).multiply(q([0, 0, 1], o.roll * Math.sin(tau - 0.1 * Math.PI)));
    spine.quaternion.copy(q([1, 0, 0], o.lean)).multiply(q([0, 1, 0], -o.yaw * Math.sin(tau)));
    chest.quaternion.copy(q([1, 0, 0], o.chestPitch * Math.sin(2 * tau))).multiply(q([0, 1, 0], -o.yaw * Math.sin(tau)));
    neck.quaternion.copy(q([1, 0, 0], -0.5 * o.chestPitch * Math.sin(2 * tau)));
    root.updateMatrixWorld(true);
    for (const b of [pelvis, spine, chest, neck]) {
      push(`${b.name}.quaternion`, ...b.quaternion.toArray());
    }
    push('pelvis.position', ...pelvis.position.toArray());
    for (const side of ['l', 'r'] as const) {
      const leg = legs[side], path = footPath(phase + leg.offset, o);
      const hip = leg.thigh.getWorldPosition(new Vector3());
      const ankle = new Vector3(leg.x, 0.08 + path.y, path.z + (side === 'l' && frame === frames ? o.seamError : 0));
      const delta = ankle.clone().sub(hip), distance = delta.length(), direction = delta.clone().normalize();
      const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance), height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const bend = new Vector3(0, 0, 1).addScaledVector(direction, -direction.z).normalize();
      const knee = hip.clone().addScaledVector(direction, along).addScaledVector(bend, height);
      push(`calf_${side}.position`, ...knee.toArray());
      push(`foot_${side}.position`, ...ankle.toArray());
      const swing = (side === 'l' ? 1 : -1) * o.arm * Math.cos(tau);
      push(`upperarm_${side}.quaternion`, ...q([1, 0, 0], swing).toArray());
    }
  }
  // Reset to the rest pose before binding the skin.
  for (const b of bones) b.quaternion.identity();
  pelvis.position.set(0, 0.84, 0);
  for (const side of ['l', 'r'] as const) { legs[side].calf.position.set(legs[side].x, 0.5, 0); legs[side].foot.position.set(legs[side].x, 0.08, 0); }
  const tracks = [...values].map(([name, data]) => name.endsWith('quaternion')
    ? new QuaternionKeyframeTrack(name, times, data) : new VectorKeyframeTrack(name, times, data));
  const clip = new AnimationClip('walk', o.duration, tracks);

  const scene = new Scene(), rig = new Group(); rig.name = 'walker-rig'; scene.add(rig); rig.add(root);
  if (o.declare) rig.userData = { gait: { format: 'agent-meshes/gait/1', height: 1.75, clips: { walk: {
    stance: o.stance, travelSpeed: o.stride / (o.stance * o.duration), contactPhase: { foot_l: 0, foot_r: 0.5 },
  } } } };
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  const material = new MeshStandardMaterial();
  const skinned = (name: string, geometry: BoxGeometry, boneIndex: number) => {
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0).map((_, i) => i % 4 ? 0 : boneIndex), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Array(count * 4).fill(0).map((_, i) => i % 4 ? 0 : 1), 4));
    const mesh = new SkinnedMesh(geometry, material); mesh.name = name; rig.add(mesh); mesh.bind(skeleton, new Matrix4());
    return mesh;
  };
  for (const side of ['l', 'r'] as const) {
    const sole = new BoxGeometry(0.09, 0.02, 0.24).translate(legs[side].x, 0.01, 0.04);
    skinned(o.footMeshes[side === 'l' ? 0 : 1], sole, bones.indexOf(legs[side].foot));
  }
  skinned('torso', new BoxGeometry(0.3, 0.6, 0.2).translate(0, 1.25, 0), bones.indexOf(chest));
  skinned('skull', new BoxGeometry(0.2, 0.25, 0.2).translate(0, 1.6, 0), bones.indexOf(head));
  const output = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] });
  if (!(output instanceof ArrayBuffer)) throw new Error('Exporter did not produce a binary GLB');
  return new Uint8Array(output);
}
