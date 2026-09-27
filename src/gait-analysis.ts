import { AnimationClip, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { Interpolant } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readGLB } from './gltf-read.ts';

/**
 * Gait analysis of a skinned, animated GLB, with no renderer: clips are sampled from their
 * keyframe tracks and skinned vertices are posed as three.js poses them. It reads biped rigs by
 * bone name (stylized `rig-*`, UE-mannequin / Mesh2Motion and Mixamo conventions) and reports
 * per-phase body curves plus locomotion metrics: foot contact, skating, loop seam, knee angles,
 * head bob, torso lean, spine flex, shoulder-pelvis counter-rotation and pelvis drop.
 *
 * Frame: glTF Y is up. Forward is the travel direction, detected from planted feet moving
 * backward in an in-place loop. Anatomical left is up x forward. Left and right legs and arms
 * are assigned by geometry at rest, not by name, so rigs with mirrored naming compare cleanly.
 */

export type Vec3 = [number, number, number];
export const GAIT_CURVES_FORMAT = 'agent-meshes/gait-curves/1';
export const GAIT_EXTRAS_FORMAT = 'agent-meshes/gait/1';
/** Curves scored against references: pelvis bob and roll, spine and head pitch, knees, ankles, foot heights. */
export const SCORED_CURVES = ['pelvisHeight', 'pelvisRoll', 'chestPitch', 'headPitch', 'kneeLeft', 'kneeRight', 'ankleLeft', 'ankleRight', 'footHeightLeft', 'footHeightRight'] as const;

interface Leg { thigh: string; calf: string; foot: string; toe?: string }
interface Arm { upper: string; lower: string }
export interface GaitBones {
  pelvis: string; spine: string[]; neck: string | null; head: string;
  /** `a` is the leg or arm named left, `b` the one named right; anatomy is decided later by geometry. */
  legs: { a: Leg; b: Leg }; arms: { a: Arm; b: Arm };
}
export interface DeclaredClip { stance?: number; travelSpeed?: number; contactPhase?: Record<string, number> }
export interface DeclaredGait { format: string; height?: number; clips?: Record<string, DeclaredClip> }
interface Rest { position: Vector3; quaternion: Quaternion; scale: Vector3 }
export interface GaitSource { scene: Object3D; clips: AnimationClip[]; declared: DeclaredGait | null; rest: Map<Object3D, Rest> }

export interface GaitOptions {
  clip: string; samples?: number; fps?: number; height?: number; travelSpeed?: number; forward?: Vec3;
  references?: GaitReport[]; referenceLabels?: string[];
}
export interface GaitMetrics {
  /** Largest |lowest foot vertex height| over planted frames, meters; null for a rig without skinned feet. */
  groundError: number | null;
  /** Largest planted contact-point world speed (with travel added) as a fraction of travel speed. */
  skate: number;
  /** Planted contact-point backward speed over travel speed, min and max. */
  stanceSpeedRatio: { min: number; max: number };
  /** Largest vertex distance between the first and last frame, meters. */
  seam: number;
  /** Largest foot velocity discontinuity (second difference of per-frame velocity) within two frames of a touchdown or liftoff, m/s. */
  contactVelocityJump: number; contactVelocityJumpRatio: number;
  /** Fraction of frames with no foot on the ground (every foot's lowest vertex above 5 mm, or no planted foot). */
  flightFraction: number;
  kneeMaxInteriorDeg: number; kneeMinInteriorDeg: number; kneePopDeg: number;
  /** Head vertical travel scaled to a 1.75 m body, and raw. */
  headBob: number; headBobM: number; headBobPeaks: number;
  headPitchRangeDeg: number; chestPitchRangeDeg: number; headPitchRatio: number;
  torsoLeanDeg: number;
  spineJointRangeDeg: Record<string, number>;
  counterRotationDeg: number; counterRotationCorrelation: number;
  pelvisDropDeg: number; pelvisDropBySideDeg: { left: number; right: number };
  armCounterswing: number;
  pelvisBob: number;
}
export interface CurveScore { shift: number; r: Record<string, number>; minR: number; meanR: number }
/** Raw scores against the reference, and `symmetric` scores of the mirrored-gait parts of both. */
export interface GaitComparison extends CurveScore { reference: string; clip: string; symmetric: CurveScore }
export interface GaitReport {
  format: string; clip: string; duration: number; samples: number; fps: number; height: number; travelSpeed: number;
  forward: Vec3; contactSource: 'declared' | 'auto'; phaseZero: number;
  bones: GaitBones & { left: { leg: string; arm: string } }; /** Skinned vertices counted as each foot (strongest influence is the foot bone or below it); null without skinned feet. */
  feet: { left: number; right: number } | null;
  metrics: GaitMetrics; curves: Record<string, number[]>;
  comparisons?: GaitComparison[];
  source?: Record<string, unknown>;
}

const UP = new Vector3(0, 1, 0);
const DEG = 180 / Math.PI;

/** GLTFLoader cannot decode images in Node; analysis needs no materials, so drop them first. */
function withoutTextures(bytes: Uint8Array): ArrayBuffer {
  const { json, bin } = readGLB(bytes) as { json: Record<string, unknown> & { materials?: { name?: string }[] }; bin?: Uint8Array };
  delete json.images; delete json.textures; delete json.samplers;
  if (json.materials) json.materials = json.materials.map(material => ({ ...(material.name ? { name: material.name } : {}) }));
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key] as string[] | undefined;
    if (list) json[key] = list.filter(name => !/^KHR_(materials|texture)_/.test(name));
  }
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const jsonLength = text.length + pad(text.length), binLength = bin ? bin.length + pad(bin.length) : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true); view.setUint32(at + 4, 0x004e4942, true); out.set(bin, at + 8);
  }
  return out.buffer;
}

export async function loadGait(bytes: Uint8Array): Promise<GaitSource> {
  const gltf = await new GLTFLoader().parseAsync(withoutTextures(bytes), '');
  const rest = new Map<Object3D, Rest>();
  let declared: DeclaredGait | null = null;
  gltf.scene.traverse(object => {
    rest.set(object, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() });
    const gait = (object.userData as { gait?: DeclaredGait }).gait;
    if (gait && gait.format === GAIT_EXTRAS_FORMAT) declared = gait;
  });
  return { scene: gltf.scene, clips: gltf.animations, declared, rest };
}

const sideOf = (name: string): 'a' | 'b' | null => {
  if (/left/i.test(name)) return 'a';
  if (/right/i.test(name)) return 'b';
  if (/(^|[_.\-\s])l($|[_.\-\s])/i.test(name)) return 'a';
  if (/(^|[_.\-\s])r($|[_.\-\s])/i.test(name)) return 'b';
  return null;
};
const baseOf = (name: string) => name.toLowerCase().replace(/left|right/g, '').replace(/(^|[_.\-\s])[lr](?=$|[_.\-\s])/g, '$1').replace(/[^a-z]/g, '');

/** Find the biped joints by name; the spine is every joint between pelvis and head, less the neck. */
export function resolveGaitBones(names: string[], parentOf: (name: string) => string | null): GaitBones {
  const unsided = names.filter(name => !sideOf(name));
  const find = (list: string[], pattern: RegExp, label: string) => {
    const hit = list.find(name => pattern.test(baseOf(name)));
    if (!hit) throw Object.assign(new Error(`Gait analysis cannot find a ${label} bone`), { code: 'GAIT_BONES' });
    return hit;
  };
  const pelvis = find(unsided, /(pelvis|hips?)$/, 'pelvis'), head = find(unsided, /head$/, 'head');
  const chain: string[] = [];
  for (let at = parentOf(head); at !== pelvis; at = parentOf(at)) {
    if (at === null) throw Object.assign(new Error(`Head ${head} does not descend from pelvis ${pelvis}`), { code: 'GAIT_BONES' });
    chain.unshift(at);
  }
  const neck = [...chain].reverse().find(name => /neck/.test(baseOf(name))) ?? null;
  const spine = chain.filter(name => !/neck/.test(baseOf(name)));
  if (!spine.length) throw Object.assign(new Error('Gait analysis needs at least one spine joint between pelvis and head'), { code: 'GAIT_BONES' });
  const side = (s: 'a' | 'b') => {
    const list = names.filter(name => sideOf(name) === s);
    const thigh = find(list, /(thigh|upleg|upperleg)$/, `${s === 'a' ? 'left' : 'right'} thigh`);
    const calf = find(list.filter(n => n !== thigh), /(calf|shin|lowerleg|leg)$/, 'calf');
    const foot = find(list, /(foot|ankle)$/, 'foot');
    const toe = list.find(name => /(ball|toe|toebase|toes)$/.test(baseOf(name)));
    const lower = find(list, /(forearm|lowerarm)$/, 'forearm');
    const upper = find(list.filter(n => n !== lower), /(upperarm|arm)$/, 'upper arm');
    return { leg: { thigh, calf, foot, ...(toe ? { toe } : {}) }, arm: { upper, lower } };
  };
  const a = side('a'), b = side('b');
  return { pelvis, spine, neck, head, legs: { a: a.leg, b: b.leg }, arms: { a: a.arm, b: b.arm } };
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  const flatA = Math.sqrt(aa / n) < 1e-6, flatB = Math.sqrt(bb / n) < 1e-6;
  if (flatA && flatB) return 1;
  if (flatA || flatB) return 0;
  return ab / Math.sqrt(aa * bb);
}

function resample(values: number[], n: number): number[] {
  if (values.length === n) return values;
  return Array.from({ length: n }, (_, i) => {
    const x = i * values.length / n, k = Math.floor(x), u = x - k;
    return values[k % values.length] * (1 - u) + values[(k + 1) % values.length] * u;
  });
}

const LATERAL = new Set(['pelvisRoll', 'pelvisYaw', 'shoulderYaw']);
/**
 * The part of each curve a left/right-mirrored gait can have. A symmetric gait repeats its sagittal
 * body curves every half cycle (even harmonics), flips its lateral ones (odd harmonics), and gives
 * each leg the other's curve half a cycle later. Hand-keyed clips often limp a little; scoring a
 * symmetric gait against the symmetric part of a reference ignores that asymmetry, nothing more.
 */
export function symmetrizeCurves(curves: Record<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, values] of Object.entries(curves)) {
    const n = values.length, half = (k: number) => (k + n / 2) % n;
    if (n % 2) { out[key] = values; continue; }
    const pair = key.endsWith('Left') ? `${key.slice(0, -4)}Right` : key.endsWith('Right') ? `${key.slice(0, -5)}Left` : null;
    if (pair && curves[pair]) {
      const left = key.endsWith('Left') ? values : curves[pair], right = key.endsWith('Left') ? curves[pair] : values;
      const mirrored = left.map((v, k) => (v + right[half(k)]) / 2);
      out[key] = key.endsWith('Left') ? mirrored : mirrored.map((_, k) => mirrored[half(k)]);
    } else out[key] = values.map((v, k) => (v + (LATERAL.has(key) ? -1 : 1) * values[half(k)]) / 2);
  }
  return out;
}

/** One circular phase shift for all shared curves, maximizing their mean correlation. */
export function alignCurves(ours: Record<string, number[]>, reference: Record<string, number[]>): { shift: number; r: Record<string, number>; mean: number } {
  const keys = Object.keys(ours).filter(key => reference[key]);
  if (!keys.length) throw new Error('No shared curves to compare');
  const n = ours[keys[0]].length, refs = Object.fromEntries(keys.map(key => [key, resample(reference[key], n)]));
  let best = { shift: 0, r: {} as Record<string, number>, mean: -Infinity };
  for (let shift = 0; shift < n; shift++) {
    const r = Object.fromEntries(keys.map(key => [key, pearson(ours[key], ours[key].map((_, i) => refs[key][(i + shift) % n]))]));
    const mean = Object.values(r).reduce((s, v) => s + v, 0) / keys.length;
    if (mean > best.mean + 1e-12) best = { shift, r, mean };
  }
  return best;
}

/** Interior knee angle in degrees: 180 is straight, above 180 bends the knee backward. */
export function kneeInterior(hip: Vec3, knee: Vec3, ankle: Vec3, forward: Vec3): number {
  const h = new Vector3(...hip), k = new Vector3(...knee), a = new Vector3(...ankle), f = new Vector3(...forward);
  const thigh = k.clone().sub(h), shin = a.clone().sub(k);
  const flexion = thigh.angleTo(shin) * DEG;
  // Float32 keys put a straight leg within about 1e-5 degrees of either side of the line.
  if (flexion < 0.01) return 180;
  const line = a.clone().sub(h), offset = k.clone().sub(h).addScaledVector(line, -k.clone().sub(h).dot(line) / Math.max(line.lengthSq(), 1e-12));
  return offset.dot(f) >= 0 ? 180 - flexion : 180 + flexion;
}

interface Bound { target: Object3D; property: 'position' | 'quaternion' | 'scale'; interpolant: Interpolant }
function bindClip(source: GaitSource, clip: AnimationClip): Bound[] {
  const bound: Bound[] = [];
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
    const target = PropertyBinding.findNode(source.scene, nodeName) as Object3D | undefined;
    if (!target || !['position', 'quaternion', 'scale'].includes(propertyName)) continue;
    // createInterpolant exists on every KeyframeTrack at runtime but is missing from the typings.
    const sampled = track as typeof track & { createInterpolant(): Interpolant };
    bound.push({ target, property: propertyName as Bound['property'], interpolant: sampled.createInterpolant() });
  }
  return bound;
}
function restore(source: GaitSource) {
  for (const [object, rest] of source.rest) { object.position.copy(rest.position); object.quaternion.copy(rest.quaternion); object.scale.copy(rest.scale); }
  source.scene.updateMatrixWorld(true);
}
function pose(source: GaitSource, bound: Bound[], time: number) {
  for (const { target, property, interpolant } of bound) {
    const value = interpolant.evaluate(time) as unknown as number[];
    if (property === 'quaternion') target.quaternion.fromArray(value).normalize();
    else target[property].fromArray(value);
  }
  source.scene.updateMatrixWorld(true);
}
function skinnedWorld(mesh: SkinnedMesh): Float64Array {
  const count = mesh.geometry.attributes.position.count, out = new Float64Array(count * 3), v = new Vector3();
  for (let i = 0; i < count; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
  return out;
}

interface Snapshot {
  position: Map<string, Vector3>; world: Map<string, Quaternion>; local: Map<string, Quaternion>;
  /** Per anatomical foot: sole vertices (or null), lowest height, index of the lowest vertex, contact reference point. */
  feet: { left: FootState; right: FootState };
}
interface FootState { vertices: Float64Array | null; height: number; lowest: number; point: Vector3; centroid: Vector3 }

const range = (values: number[]) => Math.max(...values) - Math.min(...values);
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Upward crossings of the upper band after dipping below the lower band, around a periodic curve. */
function countBobs(values: number[]): number {
  const lo = Math.min(...values), span = range(values);
  if (span < 1e-9) return 0;
  const start = values.indexOf(lo), high = lo + 0.625 * span, low = lo + 0.375 * span;
  let armed = true, count = 0;
  for (let i = 1; i <= values.length; i++) {
    const v = values[(start + i) % values.length];
    if (armed && v > high) { count++; armed = false; } else if (!armed && v < low) armed = true;
  }
  return count;
}

export function analyzeGait(source: GaitSource, options: GaitOptions): GaitReport {
  const clip = source.clips.find(c => c.name === options.clip);
  if (!clip) throw Object.assign(new Error(`No clip named ${options.clip}; clips: ${source.clips.map(c => c.name).join(', ')}`), { code: 'GAIT_CLIP' });
  const samples = options.samples ?? 64, fps = options.fps ?? 60, duration = clip.duration;
  const nodes = new Map<string, Object3D>();
  source.scene.traverse(object => { if (object.name && !nodes.has(object.name)) nodes.set(object.name, object); });
  const boneNames = [...nodes.values()].filter(o => (o as { isBone?: boolean }).isBone).map(o => o.name);
  const bones = resolveGaitBones(boneNames, name => { const p = nodes.get(name)?.parent; return p && (p as { isBone?: boolean }).isBone ? p.name : null; });
  const node = (name: string) => nodes.get(name)!;
  restore(source);
  const skins: SkinnedMesh[] = [];
  source.scene.traverse(object => { if ((object as SkinnedMesh).isSkinnedMesh) skins.push(object as SkinnedMesh); });

  // Rest pose: height, anatomical sides, sole assignment and reference world rotations.
  const at = (name: string) => node(name).getWorldPosition(new Vector3());
  let height = options.height ?? source.declared?.height;
  if (height === undefined) {
    let top = -Infinity, bottom = Infinity;
    for (const mesh of skins) { const v = skinnedWorld(mesh); for (let i = 1; i < v.length; i += 3) { top = Math.max(top, v[i]); bottom = Math.min(bottom, v[i]); } }
    if (!Number.isFinite(top)) throw Object.assign(new Error('Pass --height: the GLB has no skinned mesh to measure'), { code: 'GAIT_HEIGHT' });
    height = top - Math.min(0, bottom);
  }
  const restWorld = new Map<string, Quaternion>();
  for (const name of [bones.pelvis, ...bones.spine, bones.head, ...(bones.neck ? [bones.neck] : []), bones.legs.a.calf, bones.legs.b.calf, bones.legs.a.foot, bones.legs.b.foot]) restWorld.set(name, node(name).getWorldQuaternion(new Quaternion()));
  const bound = bindClip(source, clip);
  const frames = Math.max(2, Math.round(duration * fps));
  const legOf = { a: bones.legs.a, b: bones.legs.b };
  // Anatomical left: decided after forward is known; start with named sides.
  let leftKey: 'a' | 'b' = 'a';
  const legFor = (side: 'left' | 'right') => legOf[side === 'left' ? leftKey : (leftKey === 'a' ? 'b' : 'a')];
  // A foot is every skinned vertex whose strongest influence is the foot bone or a bone below it (toes).
  const footVertices = (leg: Leg) => {
    const below = new Set<Object3D>(); node(leg.foot).traverse(o => below.add(o));
    return skins.map(mesh => {
      const index = mesh.geometry.attributes.skinIndex, weight = mesh.geometry.attributes.skinWeight, picked: number[] = [];
      for (let i = 0; i < index.count; i++) {
        let strongest = 0; for (let j = 1; j < 4; j++) if (weight.getComponent(i, j) > weight.getComponent(i, strongest)) strongest = j;
        if (below.has(mesh.skeleton.bones[index.getComponent(i, strongest)])) picked.push(i);
      }
      return { mesh, picked };
    }).filter(set => set.picked.length);
  };
  let soles: { left: ReturnType<typeof footVertices>; right: ReturnType<typeof footVertices> } | null = null;
  const posed = (sets: ReturnType<typeof footVertices>) => {
    const out = new Float64Array(sets.reduce((n, set) => n + set.picked.length, 0) * 3), v = new Vector3(); let k = 0;
    for (const { mesh, picked } of sets) for (const i of picked) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); out[k++] = v.x; out[k++] = v.y; out[k++] = v.z; }
    return out;
  };
  const tracked = [bones.pelvis, ...bones.spine, ...(bones.neck ? [bones.neck] : []), bones.head,
    ...(['a', 'b'] as const).flatMap(s => [legOf[s].thigh, legOf[s].calf, legOf[s].foot, ...(legOf[s].toe ? [legOf[s].toe!] : []), bones.arms[s].upper, bones.arms[s].lower])];
  const footState = (side: 'left' | 'right'): FootState => {
    const sole = soles?.[side];
    if (sole) {
      const v = posed(sole); let lowest = 0; const centroid = new Vector3();
      for (let i = 0; i < v.length / 3; i++) { if (v[i * 3 + 1] < v[lowest * 3 + 1]) lowest = i; centroid.x += v[i * 3]; centroid.y += v[i * 3 + 1]; centroid.z += v[i * 3 + 2]; }
      centroid.multiplyScalar(3 / v.length);
      return { vertices: v, height: v[lowest * 3 + 1], lowest, point: new Vector3(v[lowest * 3], v[lowest * 3 + 1], v[lowest * 3 + 2]), centroid };
    }
    const leg = legFor(side), ankle = at(leg.foot), toe = leg.toe ? at(leg.toe) : null;
    const point = toe && toe.y < ankle.y ? toe : ankle;
    return { vertices: null, height: point.y, lowest: -1, point, centroid: ankle };
  };
  const snapshot = (time: number): Snapshot => {
    pose(source, bound, time);
    const position = new Map<string, Vector3>(), world = new Map<string, Quaternion>(), local = new Map<string, Quaternion>();
    for (const name of tracked) { const o = node(name); position.set(name, o.getWorldPosition(new Vector3())); world.set(name, o.getWorldQuaternion(new Quaternion())); local.set(name, o.quaternion.clone()); }
    return { position, world, local, feet: { left: footState('left'), right: footState('right') } };
  };

  // Pass 1: forward from planted feet sliding backward (named sides are fine here).
  let forward: Vector3;
  if (options.forward) forward = new Vector3(...options.forward).setY(0).normalize();
  else {
    const sum = new Vector3();
    for (const s of ['a', 'b'] as const) {
      const heights: number[] = [], points: Vector3[] = [];
      for (let k = 0; k <= frames; k++) { pose(source, bound, duration * k / frames); const p = at(legOf[s].foot); heights.push(p.y); points.push(p); }
      const lo = Math.min(...heights), tol = 0.2 * range(heights);
      for (let k = 0; k < frames; k++) if (heights[k] < lo + tol && heights[k + 1] < lo + tol) sum.add(points[k + 1].clone().sub(points[k]).setY(0));
    }
    forward = sum.lengthSq() > 1e-12 ? sum.negate().normalize() : new Vector3(0, 0, 1);
  }
  const lateral = new Vector3().crossVectors(UP, forward).normalize();
  restore(source);
  leftKey = at(bones.legs.a.thigh).dot(lateral) >= at(bones.legs.b.thigh).dot(lateral) ? 'a' : 'b';
  const armLeftKey: 'a' | 'b' = at(bones.arms.a.upper).dot(lateral) >= at(bones.arms.b.upper).dot(lateral) ? 'a' : 'b';
  const armFor = (side: 'left' | 'right') => bones.arms[side === 'left' ? armLeftKey : (armLeftKey === 'a' ? 'b' : 'a')];
  { const left = footVertices(legFor('left')), right = footVertices(legFor('right')); if (left.length && right.length) soles = { left, right }; }

  // Pass 2: frames at the analysis rate, including the closing frame.
  const shots = Array.from({ length: frames + 1 }, (_, k) => snapshot(duration * k / frames));
  const sides = ['left', 'right'] as const;
  const declaredClip = source.declared?.clips?.[clip.name];
  const contactSource: 'declared' | 'auto' = declaredClip?.stance !== undefined && declaredClip.contactPhase ? 'declared' : 'auto';
  const planted: Record<'left' | 'right', boolean[]> = { left: [], right: [] };
  for (const side of sides) {
    if (contactSource === 'declared') {
      const foot = legFor(side).foot, phase = declaredClip!.contactPhase![foot];
      if (phase === undefined) throw Object.assign(new Error(`Declared gait for ${clip.name} has no contact phase for ${foot}`), { code: 'GAIT_EXTRAS' });
      planted[side] = shots.map((_, k) => (((k / frames - phase) % 1) + 1) % 1 < declaredClip!.stance! - 1e-9);
    } else {
      // Floor at the 10th percentile, so a heel strike that dips through the ground does not
      // lift the threshold off the rest of the stance; any duty factor above 0.1 has it in stance.
      const heights = shots.map(s => s.feet[side].height), floor = [...heights].sort((a, b) => a - b)[Math.floor(0.1 * heights.length)];
      const tol = 0.1 * (Math.max(...heights) - floor);
      planted[side] = heights.map(h => h < floor + tol);
    }
  }
  const axis = (v: Vector3) => ({ f: v.dot(forward), l: v.dot(lateral), u: v.dot(UP) });

  // Contact-point speeds: the material point that is lowest, followed to the next frame.
  const stanceSpeeds: number[] = [], skates: number[] = [];
  const contactVelocity = (side: 'left' | 'right', k: number) => {
    const a = shots[k].feet[side], b = shots[k + 1].feet[side];
    if (a.vertices && b.vertices) { const i = a.lowest * 3; return new Vector3(b.vertices[i] - a.vertices[i], b.vertices[i + 1] - a.vertices[i + 1], b.vertices[i + 2] - a.vertices[i + 2]).multiplyScalar(frames / duration); }
    return b.point.clone().sub(a.point).multiplyScalar(frames / duration);
  };
  for (const side of sides) for (let k = 0; k < frames; k++) if (planted[side][k] && planted[side][k + 1]) stanceSpeeds.push(-contactVelocity(side, k).dot(forward));
  const travelSpeed = options.travelSpeed ?? declaredClip?.travelSpeed ?? median(stanceSpeeds);
  for (const side of sides) for (let k = 0; k < frames; k++) if (planted[side][k] && planted[side][k + 1]) {
    const v = contactVelocity(side, k).setY(0).addScaledVector(forward, travelSpeed);
    skates.push(v.length() / travelSpeed);
  }
  const groundError = soles ? Math.max(0, ...sides.flatMap(side => shots.filter((_, k) => planted[side][k]).map(s => Math.abs(s.feet[side].height)))) : null;
  const airborne = shots.slice(0, frames).filter((s, k) => soles ? sides.every(side => s.feet[side].height > 0.005) : sides.every(side => !planted[side][k]));

  // Loop seam over every skinned vertex.
  pose(source, bound, 0); const first = skins.map(skinnedWorld);
  pose(source, bound, duration); const last = skins.map(skinnedWorld);
  let seam = 0;
  first.forEach((v, m) => { for (let i = 0; i < v.length; i += 3) seam = Math.max(seam, Math.hypot(v[i] - last[m][i], v[i + 1] - last[m][i + 1], v[i + 2] - last[m][i + 2])); });
  if (!skins.length) for (const name of tracked) seam = Math.max(seam, shots[0].position.get(name)!.distanceTo(shots[frames].position.get(name)!));

  // Velocity pops near contact changes: centroid velocity per frame, circular over the loop.
  const velocity = (side: 'left' | 'right', k: number) => { const j = ((k % frames) + frames) % frames; return shots[j + 1].feet[side].centroid.clone().sub(shots[j].feet[side].centroid).multiplyScalar(frames / duration); };
  let contactVelocityJump = 0;
  for (const side of sides) for (let k = 0; k < frames; k++) if (planted[side][k] !== planted[side][(k + frames - 1) % frames] || (k === 0 && planted[side][0] !== planted[side][frames - 1])) {
    // Change of velocity beyond the steady acceleration of the previous frame: smooth motion leaves
    // only jerk * dt^2, while a velocity discontinuity leaves the whole jump.
    for (let j = k - 2; j <= k + 2; j++) {
      const a = velocity(side, j), b = velocity(side, j - 1), c = velocity(side, j - 2);
      contactVelocityJump = Math.max(contactVelocityJump, a.sub(b).sub(b.clone().sub(c)).length());
    }
  }

  // Knees.
  const knees = { left: [] as number[], right: [] as number[] };
  const fv = forward.toArray() as Vec3;
  for (const s of shots) for (const side of sides) {
    const leg = legFor(side);
    knees[side].push(kneeInterior(s.position.get(leg.thigh)!.toArray() as Vec3, s.position.get(leg.calf)!.toArray() as Vec3, s.position.get(leg.foot)!.toArray() as Vec3, fv));
  }
  let kneePop = 0;
  for (const side of sides) for (let k = 0; k < frames; k++) kneePop = Math.max(kneePop, Math.abs(knees[side][k + 1] - knees[side][k]));

  // Body angles.
  const tilt = (s: Snapshot, name: string) => s.world.get(name)!.clone().multiply(restWorld.get(name)!.clone().invert());
  const pitchOf = (v: Vector3) => Math.atan2(v.dot(forward), v.dot(UP)) * DEG;
  const segmentPitch = (s: Snapshot, name: string) => pitchOf(UP.clone().applyQuaternion(tilt(s, name)));
  const elevation = (v: Vector3) => Math.atan2(v.dot(UP), v.dot(forward)) * DEG;
  const lineYaw = (v: Vector3) => { const a = axis(v); return Math.atan2(-a.f, a.l) * DEG; };
  const lineRoll = (v: Vector3) => { const a = axis(v); return Math.atan2(a.u, a.l) * DEG; };
  const hipLine = (s: Snapshot) => s.position.get(legFor('left').thigh)!.clone().sub(s.position.get(legFor('right').thigh)!);
  const shoulderLine = (s: Snapshot) => s.position.get(armFor('left').upper)!.clone().sub(s.position.get(armFor('right').upper)!);
  const chest = bones.spine[bones.spine.length - 1], neckBase = bones.neck ?? bones.head;
  const swing = (v: Vector3) => Math.atan2(v.dot(forward), -v.dot(UP)) * DEG;
  const measures = (s: Snapshot) => {
    const out: Record<string, number> = {
      pelvisHeight: s.position.get(bones.pelvis)!.y, headHeight: s.position.get(bones.head)!.y,
      pelvisRoll: lineRoll(hipLine(s)), pelvisYaw: lineYaw(hipLine(s)), shoulderYaw: lineYaw(shoulderLine(s)),
      trunkPitch: pitchOf(s.position.get(neckBase)!.clone().sub(s.position.get(bones.pelvis)!)),
      chestPitch: segmentPitch(s, chest), headPitch: segmentPitch(s, bones.head),
    };
    for (const side of sides) {
      const leg = legFor(side), arm = armFor(side), Side = side === 'left' ? 'Left' : 'Right';
      out[`knee${Side}`] = 180 - kneeInterior(s.position.get(leg.thigh)!.toArray() as Vec3, s.position.get(leg.calf)!.toArray() as Vec3, s.position.get(leg.foot)!.toArray() as Vec3, fv);
      out[`ankle${Side}`] = elevation(forward.clone().applyQuaternion(tilt(s, leg.foot))) - elevation(forward.clone().applyQuaternion(tilt(s, leg.calf)));
      out[`footHeight${Side}`] = s.feet[side].height;
      out[`armSwing${Side}`] = swing(s.position.get(arm.lower)!.clone().sub(s.position.get(arm.upper)!));
      out[`legSwing${Side}`] = swing(s.position.get(leg.calf)!.clone().sub(s.position.get(leg.thigh)!));
    }
    return out;
  };
  const series = shots.slice(0, frames).map(measures);
  const column = (key: string) => series.map(row => row[key]);
  const headPitchRange = range(column('headPitch')), chestPitchRange = range(column('chestPitch'));
  const relYaw = series.map(row => row.shoulderYaw - row.pelvisYaw);
  const spineJointRangeDeg: Record<string, number> = {};
  for (const name of bones.spine) {
    const qs = shots.slice(0, frames).map(s => s.local.get(name)!);
    let widest = 0;
    for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) widest = Math.max(widest, qs[i].angleTo(qs[j]));
    spineJointRangeDeg[name] = widest * DEG;
  }
  const drop = { left: -Infinity, right: -Infinity };
  series.forEach((row, k) => {
    if (planted.left[k] && !planted.right[k]) drop.left = Math.max(drop.left, row.pelvisRoll);
    if (planted.right[k] && !planted.left[k]) drop.right = Math.max(drop.right, -row.pelvisRoll);
  });
  const drops = [drop.left, drop.right].filter(Number.isFinite);

  // Phase zero: the anatomical-left touchdown.
  let touchdown = planted.left.findIndex((p, k) => p && !planted.left[(k + frames - 1) % frames]);
  if (touchdown < 0) touchdown = 0;
  const phaseZero = touchdown / frames;
  const phased = Array.from({ length: samples }, (_, i) => measures(snapshot(duration * ((phaseZero + i / samples) % 1))));
  const scale = 1.75 / height;
  const curve = (key: string, centered = false, scaled = false) => {
    const values = phased.map(row => row[key]), m = centered ? mean(values) : 0;
    return values.map(v => (v - m) * (scaled ? scale : 1));
  };
  const curves: Record<string, number[]> = {
    pelvisHeight: curve('pelvisHeight', true, true), pelvisRoll: curve('pelvisRoll'), pelvisYaw: curve('pelvisYaw'),
    shoulderYaw: curve('shoulderYaw'), trunkPitch: curve('trunkPitch'), chestPitch: curve('chestPitch'), headPitch: curve('headPitch'),
    headHeight: curve('headHeight', true, true),
    kneeLeft: curve('kneeLeft'), kneeRight: curve('kneeRight'), ankleLeft: curve('ankleLeft'), ankleRight: curve('ankleRight'),
  };
  for (const Side of ['Left', 'Right']) {
    const values = phased.map(row => row[`footHeight${Side}`]), floor = soles ? 0 : Math.min(...column(`footHeight${Side}`));
    curves[`footHeight${Side}`] = values.map(v => (v - floor) * scale);
  }
  const headBobM = range(column('headHeight'));
  const metrics: GaitMetrics = {
    groundError, skate: skates.length ? Math.max(...skates) : NaN,
    stanceSpeedRatio: { min: Math.min(...stanceSpeeds) / travelSpeed, max: Math.max(...stanceSpeeds) / travelSpeed },
    seam, contactVelocityJump, contactVelocityJumpRatio: contactVelocityJump / travelSpeed,
    flightFraction: airborne.length / frames,
    kneeMaxInteriorDeg: Math.max(...knees.left, ...knees.right), kneeMinInteriorDeg: Math.min(...knees.left, ...knees.right), kneePopDeg: kneePop,
    headBob: headBobM * scale, headBobM, headBobPeaks: countBobs(curves.headHeight),
    headPitchRangeDeg: headPitchRange, chestPitchRangeDeg: chestPitchRange, headPitchRatio: headPitchRange / chestPitchRange,
    torsoLeanDeg: mean(column('trunkPitch')), spineJointRangeDeg,
    counterRotationDeg: range(relYaw), counterRotationCorrelation: pearson(column('shoulderYaw'), column('pelvisYaw')),
    pelvisDropDeg: drops.length ? mean(drops) : NaN, pelvisDropBySideDeg: { left: drop.left, right: drop.right },
    armCounterswing: Math.max(pearson(column('armSwingLeft'), column('legSwingLeft')), pearson(column('armSwingRight'), column('legSwingRight'))),
    pelvisBob: range(column('pelvisHeight')) * scale,
  };
  restore(source);
  const report: GaitReport = {
    format: GAIT_CURVES_FORMAT, clip: clip.name, duration, samples, fps: frames / duration, height, travelSpeed,
    forward: forward.toArray() as Vec3, contactSource, phaseZero,
    bones: { ...bones, left: { leg: legFor('left').thigh, arm: armFor('left').upper } },
    feet: soles ? { left: soles.left.reduce((n, set) => n + set.picked.length, 0), right: soles.right.reduce((n, set) => n + set.picked.length, 0) } : null, metrics, curves,
  };
  if (options.references?.length) report.comparisons = options.references.map((reference, i) => {
    const scored = Object.fromEntries(SCORED_CURVES.map(key => [key, curves[key]]));
    const score = (ours: Record<string, number[]>, theirs: Record<string, number[]>): CurveScore => {
      const aligned = alignCurves(ours, theirs);
      return { shift: aligned.shift, r: aligned.r, minR: Math.min(...Object.values(aligned.r)), meanR: aligned.mean };
    };
    const n = curves.pelvisHeight.length, resampled = Object.fromEntries(Object.entries(reference.curves).map(([key, values]) => [key, resample(values, n)]));
    return { reference: options.referenceLabels?.[i] ?? reference.clip, clip: reference.clip, ...score(scored, reference.curves),
      symmetric: score(symmetrizeCurves(scored), symmetrizeCurves(resampled)) };
  });
  return report;
}

export type GaitKind = 'walk' | 'jog';
export interface GaitCheck { id: string; label: string; value: unknown; limit: string; pass: boolean }
export interface GaitEvaluation { gait: GaitKind; ok: boolean; checks: GaitCheck[] }
/** Natural human locomotion ranges; bob is scaled to a 1.75 m body, angles are degrees. */
export const NATURAL_GAIT = {
  groundError: 0.005, stanceSpeedTolerance: 0.1, seam: 0.002, contactPopRatio: 0.5, kneeMaxInteriorDeg: 180, kneePopDeg: 25,
  armCounterswing: -0.5, headPitchRatio: [0.3, 0.7], pelvisDropDeg: [3, 7], minCurveR: 0.8,
  walk: { headBob: [0.025, 0.06], torsoLeanDeg: [3, 8], spineJointDeg: 2, counterRotationDeg: 8 },
  jog: { headBob: [0.05, 0.10], torsoLeanDeg: [8, 15], spineJointDeg: 4, counterRotationDeg: 12 },
} as const;

/**
 * Score a gait report against natural-gait ranges. `curveScore` picks raw or symmetric reference
 * scores; every scored curve must reach `minCurveR` against every reference in the report.
 */
export function evaluateGait(report: GaitReport, gait: GaitKind, options: { curveScore?: 'raw' | 'symmetric' } = {}): GaitEvaluation {
  const m = report.metrics, n = NATURAL_GAIT, g = n[gait];
  const within = (v: number, [lo, hi]: readonly [number, number]) => Number.isFinite(v) && v >= lo && v <= hi;
  const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;
  const checks: GaitCheck[] = [];
  const check = (id: string, label: string, value: unknown, limit: string, pass: boolean) => checks.push({ id, label, value, limit, pass });
  check('groundError', 'stance ground error (m)', m.groundError === null ? null : round(m.groundError, 5), `< ${n.groundError}`, m.groundError !== null && m.groundError < n.groundError);
  const t = n.stanceSpeedTolerance;
  check('stanceSpeed', 'planted foot backward speed / travel speed', { min: round(m.stanceSpeedRatio.min), max: round(m.stanceSpeedRatio.max) }, `${1 - t}..${1 + t}`,
    m.stanceSpeedRatio.min >= 1 - t && m.stanceSpeedRatio.max <= 1 + t);
  check('skate', 'planted foot world speed / travel speed', round(m.skate), `<= ${t}`, m.skate <= t);
  check('seam', 'loop seam (m)', round(m.seam, 6), `< ${n.seam}`, m.seam < n.seam);
  check('contactPop', 'foot velocity jump at contact / travel speed', round(m.contactVelocityJumpRatio), `< ${n.contactPopRatio}`, m.contactVelocityJumpRatio < n.contactPopRatio);
  check('kneeHyperextension', 'largest knee interior angle (deg)', round(m.kneeMaxInteriorDeg, 2), `<= ${n.kneeMaxInteriorDeg}`, m.kneeMaxInteriorDeg <= n.kneeMaxInteriorDeg);
  check('kneePop', 'largest knee change per frame (deg)', round(m.kneePopDeg, 2), `<= ${n.kneePopDeg} at ${Math.round(report.fps)} fps`, m.kneePopDeg <= n.kneePopDeg);
  check('flight', 'fraction of the cycle with both feet off the ground', round(m.flightFraction), gait === 'jog' ? '> 0' : '= 0', gait === 'jog' ? m.flightFraction > 0 : m.flightFraction === 0);
  check('armCounterswing', 'arm swing vs same-side leg swing correlation', round(m.armCounterswing), `<= ${n.armCounterswing}`, m.armCounterswing <= n.armCounterswing);
  check('headBob', 'head vertical travel scaled to 1.75 m (m)', round(m.headBob), `${g.headBob[0]}..${g.headBob[1]}`, within(m.headBob, g.headBob));
  check('headBobCount', 'head bobs per cycle', m.headBobPeaks, '= 2', m.headBobPeaks === 2);
  check('headPitchRatio', 'head pitch range / chest pitch range', round(m.headPitchRatio), `${n.headPitchRatio[0]}..${n.headPitchRatio[1]}`, within(m.headPitchRatio, n.headPitchRatio));
  check('torsoLean', 'mean forward trunk lean (deg)', round(m.torsoLeanDeg, 2), `${g.torsoLeanDeg[0]}..${g.torsoLeanDeg[1]}`, within(m.torsoLeanDeg, g.torsoLeanDeg));
  const flexing = Object.values(m.spineJointRangeDeg).filter(v => v >= g.spineJointDeg).length;
  check('spineFlex', 'spine joint ranges (deg)', Object.fromEntries(Object.entries(m.spineJointRangeDeg).map(([k, v]) => [k, round(v, 2)])), `>= 2 joints >= ${g.spineJointDeg}`, flexing >= 2);
  check('counterRotation', 'shoulder vs pelvis yaw range (deg) and correlation', { range: round(m.counterRotationDeg, 2), correlation: round(m.counterRotationCorrelation) },
    `>= ${g.counterRotationDeg}, correlation < 0`, m.counterRotationDeg >= g.counterRotationDeg && m.counterRotationCorrelation < 0);
  const drops = [m.pelvisDropBySideDeg.left, m.pelvisDropBySideDeg.right];
  check('pelvisDrop', 'swing-side pelvis drop per side (deg)', { left: round(drops[0], 2), right: round(drops[1], 2) }, `${n.pelvisDropDeg[0]}..${n.pelvisDropDeg[1]}`, drops.every(v => within(v, n.pelvisDropDeg)));
  if (report.comparisons?.length) {
    const scores = report.comparisons.map(c => ({ reference: c.reference, ...(options.curveScore === 'symmetric' ? c.symmetric : c) }));
    check('curveCorrelation', `${options.curveScore ?? 'raw'} curve correlation per reference`,
      Object.fromEntries(scores.map(s => [s.reference, Object.fromEntries(Object.entries(s.r).map(([k, v]) => [k, round(v, 3)]))])),
      `every curve >= ${n.minCurveR}`, scores.every(s => Object.values(s.r).every(v => v >= n.minCurveR)));
  }
  return { gait, ok: checks.every(c => c.pass), checks };
}
