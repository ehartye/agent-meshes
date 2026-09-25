import { Matrix3, Matrix4, Vector3 } from 'three';
import { ARKIT_FACE_BONE_PARENTS, ARKIT_FACE_CONTRACT, ARKIT_FACE_OPTIONAL_MORPHS, ARKIT_FACE_REQUIRED_BONES, ARKIT_FACE_REQUIRED_MORPHS } from './arkit-face.ts';
import { morphNameAudit } from './gltf-morphs.ts';
import { auditSkins } from './gltf-skins.ts';
import { verifyGLB } from './export.ts';
import { readAccessor, readGLB, sceneGraph, triangles, type GLTFDocument } from './gltf-read.ts';

/**
 * `arkit-face/1` verifier: every clause of the face-rig contract that can be computed from a GLB.
 * Rendered clauses (iris hidden at blink = 1, dark mouth, gaze coverage) belong to render checks.
 *
 * Conventions it relies on (documented in the README):
 * - The eyeball is every primitive whose vertices are all weighted >= 0.999 to `eye_L` / `eye_R`;
 *   its center is the eye bone's world position and its radius the farthest eyeball vertex.
 * - Lid vertices are the vertices `eyeBlinkLeft` / `eyeBlinkRight` move by more than 0.01 mm.
 * - All morph-bearing parts share one glTF mesh (one primitive per material): Unreal discards
 *   every morph name in a file when a name repeats across glTF meshes.
 * - Teeth are primitives whose material (or mesh/node) name contains `teeth` or `tooth` together
 *   with `upper` or `lower` (for example the materials `teeth_upper` and `teeth_lower`). Names
 *   containing `tongue`, or `cavity`, `throat` or `mouth_interior`, mark the mouth parts `jawOpen`
 *   must carry.
 */
export const ARKIT_GAZE_CURVES = Object.freeze(['Left', 'Right'].flatMap(side => ['Up', 'Down', 'In', 'Out'].map(d => `eyeLook${d}${side}`)));
export const ARKIT_CURVES = Object.freeze([...new Set([...ARKIT_FACE_REQUIRED_MORPHS, ...ARKIT_FACE_OPTIONAL_MORPHS, ...ARKIT_GAZE_CURVES,
  'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'mouthLeft', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower',
  'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft',
  'mouthUpperUpRight', 'mouthDimpleLeft', 'mouthDimpleRight'])].sort());
export const FACE_EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'surprised', 'scared'] as const);
/** Canonical concept-sheet presets, used for the combination checks when a file's own presets are unusable. */
export const CANONICAL_EMOTIONS: Record<string, Record<string, number>> = {
  neutral: {},
  happy: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, jawOpen: 0.25, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, browOuterUpLeft: 0.3, browOuterUpRight: 0.3 },
  sad: { browInnerUp: 0.9, mouthFrownLeft: 0.85, mouthFrownRight: 0.85, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25, eyeLookDownLeft: 0.4, eyeLookDownRight: 0.4 },
  angry: { browDownLeft: 1, browDownRight: 1, eyeSquintLeft: 0.45, eyeSquintRight: 0.45, noseSneerLeft: 0.7, noseSneerRight: 0.7, mouthFrownLeft: 0.35, mouthFrownRight: 0.35, mouthStretchLeft: 0.5, mouthStretchRight: 0.5, jawOpen: 0.12 },
  surprised: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 0.9, browOuterUpLeft: 1, browOuterUpRight: 1, jawOpen: 0.6, mouthFunnel: 0.85 },
  scared: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 1, browDownLeft: 0.25, browDownRight: 0.25, mouthStretchLeft: 0.9, mouthStretchRight: 0.9, mouthFrownLeft: 0.3, mouthFrownRight: 0.3, jawOpen: 0.3 },
};
export const LID_CLEARANCE = 0.0005;
export const MIN_MORPH_MOTION = 0.001;
/** E3: at jawOpen = 1 the chin's lowest point drops by at least this fraction of the face height. */
export const MIN_CHIN_DROP_RATIO = 0.1;
/** The upper lip and the face above it may move at most this much under jawOpen = 1. */
export const UPPER_LIP_TOLERANCE = 0.0005;
/** Rays per eyeball width for the eye-coverage check (about 0.5 mm apart on a 12 mm eye). */
export const COVERAGE_GRID = 48;
/**
 * Rig-contract invariant 1: blink .25/.5/.75/1, alone and with squint 1, plus squint and wide alone and a full blink
 * with wide (surprised plus an idle blink). A closed state must hide the whole eyeball; a closing one may show only
 * rays the neutral opening shows (no eyeball over a lid). Wide is measured, not judged: it opens the eye by design.
 */
export const EYE_COVERAGE_STATES: readonly { kind: 'closed' | 'narrow' | 'wide'; blink: number; squint: number; wide: number }[] = [
  ...[0.25, 0.5, 0.75].flatMap(blink => [{ kind: 'narrow' as const, blink, squint: 0, wide: 0 }, { kind: 'narrow' as const, blink, squint: 1, wide: 0 }]),
  { kind: 'narrow', blink: 0, squint: 1, wide: 0 }, { kind: 'wide', blink: 0, squint: 0, wide: 1 },
  { kind: 'closed', blink: 1, squint: 0, wide: 0 }, { kind: 'closed', blink: 1, squint: 1, wide: 0 },
  { kind: 'closed', blink: 1, squint: 0, wide: 1 }, { kind: 'closed', blink: 1, squint: 1, wide: 1 },
];
const LID_MOTION = 0.00001, UPPER_TEETH_TOLERANCE = 0.0001, BOUND = 0.999, PIVOT_TOLERANCE = 0.001;

export interface FaceCheck { id: string; ok: boolean; message: string; problems: string[] }
/** Front rays cast across one eyeball: how many reach it, at neutral and in each coverage state (keyed by its weights). */
export interface EyeCoverage { samples: number; neutral: number; visible: Record<string, number> }
interface EyeMeasure { center: number[]; radius: number; minLidClearance: number | null; eyeballs: string[]; lidVertices: number; coverage: EyeCoverage | null }
export interface FaceContractReport {
  contract: typeof ARKIT_FACE_CONTRACT; ok: boolean; failures: string[]; warnings: string[]; checks: FaceCheck[];
  validator: { errors: number; warnings: number };
  measurements: {
    height: number; morphs: string[]; morphMotion: Record<string, number>; inversionCombos: number;
    /** Drop of the face's lowest point (the chin) at jawOpen = 1, the face height it is measured against, and their ratio. */
    chinDrop: number | null; faceHeight: number | null; chinDropRatio: number | null;
    /** Largest jawOpen motion of face skin above the upper teeth's gum line (the upper lip and everything above it). */
    upperLipMove: number | null;
    /** What a front view hits first between the teeth rows at jawOpen = 1, at the mouth center and to each side. */
    mouthOpen: { height: number; xs: number[]; hits: string[] } | null;
    /** Front rays over the teeth rows at rest: how many land on teeth before anything else (declared exposedTeeth may show). */
    restTeeth: { samples: number; visible: number } | null;
    eyes: Partial<Record<'L' | 'R', EyeMeasure>>; teeth: { upperMove: number | null; lowerDrop: number | null };
  };
}

interface Instance {
  label: string; names: string[]; skinned: boolean; skin?: number; count: number;
  rest: Float64Array; targets: Map<string, Float64Array>; triangles: Uint32Array;
  influence: (vertex: number, joint: number) => number;
}

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const mm = (value: number) => `${(value * 1000).toFixed(2)} mm`;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const union = (...values: number[]) => 1 - values.reduce((product, value) => product * (1 - Math.min(1, Math.max(0, value))), 1);
const upperTeeth = (names: string[]) => names.some(n => /teeth|tooth/i.test(n) && /upper/i.test(n));
const lowerTeeth = (names: string[]) => names.some(n => /teeth|tooth/i.test(n) && /lower/i.test(n));
const tongue = (names: string[]) => names.some(n => /tongue/i.test(n));
const cavity = (names: string[]) => names.some(n => /cavity|throat|mouth[_ -]?interior/i.test(n));
const socket = (names: string[]) => names.some(n => /socket/i.test(n));
/** Parts below the head that the chin measurement ignores (a neck, collar or body does not open with the jaw). */
const body = (names: string[]) => names.some(n => /neck|collar|body|torso|shoulder/i.test(n));
const mouthPart = (names: string[]) => upperTeeth(names) || lowerTeeth(names) || tongue(names) || cavity(names);

function instances(doc: GLTFDocument, graph: ReturnType<typeof sceneGraph>): Instance[] {
  const { json } = doc, result: Instance[] = [];
  const nodes = json.nodes ?? [];
  const jointMatrices = new Map<number, { joints: number[]; matrices: Matrix4[] }>();
  const skinData = (index: number) => {
    let cached = jointMatrices.get(index);
    if (cached) return cached;
    const skin = json.skins![index];
    const inverse = skin.inverseBindMatrices === undefined ? undefined : readAccessor(doc, skin.inverseBindMatrices).data;
    cached = { joints: skin.joints, matrices: skin.joints.map((joint, i) => (graph.world.get(joint) ?? new Matrix4()).clone().multiply(inverse ? new Matrix4().fromArray(inverse, i * 16) : new Matrix4())) };
    jointMatrices.set(index, cached);
    return cached;
  };
  for (const [nodeIndex, world] of graph.world) {
    const node = nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const mesh = json.meshes?.[node.mesh];
    if (!mesh) continue;
    const targetNames = Array.isArray(mesh.extras?.targetNames) ? mesh.extras!.targetNames as unknown[] : [];
    mesh.primitives.forEach((primitive, p) => {
      if (primitive.attributes.POSITION === undefined) return;
      const position = readAccessor(doc, primitive.attributes.POSITION), count = position.count;
      const material = primitive.material === undefined ? '' : json.materials?.[primitive.material]?.name ?? '';
      const names = [mesh.name ?? '', node.name ?? '', material].filter(Boolean);
      const label = `${node.name || mesh.name || `node ${nodeIndex}`}${mesh.primitives.length > 1 ? `[${material || p}]` : ''}`;
      const matrices: Matrix4[] = new Array(count);
      const joints: Float64Array[] = [], weights: Float64Array[] = [];
      const skinned = node.skin !== undefined && !!json.skins?.[node.skin];
      if (skinned) {
        const data = skinData(node.skin!);
        for (let set = 0; primitive.attributes[`JOINTS_${set}`] !== undefined && primitive.attributes[`WEIGHTS_${set}`] !== undefined; set++) {
          joints.push(readAccessor(doc, primitive.attributes[`JOINTS_${set}`]).data.map(j => data.joints[j] ?? -1));
          weights.push(readAccessor(doc, primitive.attributes[`WEIGHTS_${set}`]).data);
        }
        for (let v = 0; v < count; v++) {
          const blended = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
          let total = 0;
          joints.forEach((set, s) => {
            for (let k = 0; k < 4; k++) {
              const w = weights[s][v * 4 + k]; if (!w) continue;
              const slot = data.joints.indexOf(set[v * 4 + k]); if (slot < 0) continue;
              total += w;
              const m = data.matrices[slot].elements;
              for (let e = 0; e < 16; e++) blended.elements[e] += w * m[e];
            }
          });
          if (total > 0) for (let e = 0; e < 16; e++) blended.elements[e] /= total;
          matrices[v] = total > 0 ? blended : world;
        }
      } else matrices.fill(world);
      const rest = new Float64Array(count * 3), vector = new Vector3();
      for (let v = 0; v < count; v++) {
        vector.set(position.data[v * 3], position.data[v * 3 + 1], position.data[v * 3 + 2]).applyMatrix4(matrices[v]);
        rest[v * 3] = vector.x; rest[v * 3 + 1] = vector.y; rest[v * 3 + 2] = vector.z;
      }
      const targets = new Map<string, Float64Array>();
      (primitive.targets ?? []).forEach((target, t) => {
        const name = typeof targetNames[t] === 'string' ? targetNames[t] as string : `(unnamed target ${t})`;
        const deltas = new Float64Array(count * 3);
        if (target.POSITION !== undefined) {
          // A displacement transforms by the linear part of the vertex's (skinned) matrix.
          const delta = readAccessor(doc, target.POSITION).data, linear = new Matrix3();
          for (let v = 0; v < count; v++) {
            vector.set(delta[v * 3], delta[v * 3 + 1], delta[v * 3 + 2]).applyMatrix3(linear.setFromMatrix4(matrices[v]));
            deltas[v * 3] = vector.x; deltas[v * 3 + 1] = vector.y; deltas[v * 3 + 2] = vector.z;
          }
        }
        targets.set(name, deltas);
      });
      const influence = (vertex: number, joint: number) => {
        let total = 0, on = 0;
        joints.forEach((set, s) => { for (let k = 0; k < 4; k++) { const w = weights[s][vertex * 4 + k]; total += w; if (set[vertex * 4 + k] === joint) on += w; } });
        return total > 0 ? on / total : 0;
      };
      result.push({ label, names, skinned, skin: node.skin, count, rest, targets, triangles: triangles(doc, primitive, count), influence });
    });
  }
  return result;
}

function positions(instance: Instance, weights: Record<string, number>): Float64Array {
  const out = Float64Array.from(instance.rest);
  for (const [name, weight] of Object.entries(weights)) {
    const deltas = instance.targets.get(name);
    if (!deltas || !weight) continue;
    for (let i = 0; i < out.length; i++) out[i] += weight * deltas[i];
  }
  return out;
}

function normals(points: Float64Array, tris: Uint32Array): Float64Array {
  const out = new Float64Array(tris.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = points[b] - points[a], uy = points[b + 1] - points[a + 1], uz = points[b + 2] - points[a + 2];
    const vx = points[c] - points[a], vy = points[c + 1] - points[a + 1], vz = points[c + 2] - points[a + 2];
    out[t] = uy * vz - uz * vy; out[t + 1] = uz * vx - ux * vz; out[t + 2] = ux * vy - uy * vx;
  }
  return out;
}

/** Height (z) where the front-view ray at (x, y) meets triangle abc, or null when it misses (glTF: the face looks down +Z). */
function rayZ(points: Float64Array, a: number, b: number, c: number, x: number, y: number): number | null {
  const ax = points[a * 3], ay = points[a * 3 + 1], bx = points[b * 3], by = points[b * 3 + 1], cx = points[c * 3], cy = points[c * 3 + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-18) return null;
  const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w = 1 - u - v;
  if (u < -1e-9 || v < -1e-9 || w < -1e-9) return null;
  return u * points[a * 3 + 2] + v * points[b * 3 + 2] + w * points[c * 3 + 2];
}

/** A front-view depth buffer over a grid of (x, y) rays: the frontmost z and which part owns it. */
interface Raster { x0: number; y0: number; step: number; nx: number; ny: number; depth: Float64Array; owner: Int32Array }

function raster(x0: number, x1: number, y0: number, y1: number, columns: number): Raster {
  const step = Math.max(x1 - x0, 1e-9) / (columns - 1), nx = columns, ny = Math.max(2, Math.ceil((y1 - y0) / step) + 1);
  return { x0, y0, step, nx, ny, depth: new Float64Array(nx * ny).fill(-Infinity), owner: new Int32Array(nx * ny).fill(-1) };
}

/** Rasterize triangles into the buffer, keeping the frontmost (largest z) surface per ray. */
function draw(target: Raster, points: Float64Array, tris: Uint32Array, owner: number): void {
  const { x0, y0, step, nx, ny, depth } = target;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ax = points[a], ay = points[a + 1], bx = points[b], by = points[b + 1], cx = points[c], cy = points[c + 1];
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / step - 1e-9)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / step + 1e-9));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / step - 1e-9)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / step + 1e-9));
    if (i0 > i1 || j0 > j1) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-18) continue;
    for (let j = j0; j <= j1; j++) {
      const y = y0 + j * step;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * step;
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w = 1 - u - v;
        if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
        const z = u * points[a + 2] + v * points[b + 2] + w * points[c + 2], k = j * nx + i;
        if (z > depth[k]) { depth[k] = z; target.owner[k] = owner; }
      }
    }
  }
}

/** Problems with a root node's `extras` against the `arkit-face/1` schema; `exposedTeeth` is checked separately. */
export function faceExtrasProblems(extras: unknown, fileMorphs?: string[]): string[] {
  const problems: string[] = [];
  const face = isRecord(extras) ? extras.arkitFace : undefined;
  if (!isRecord(face)) return ['extras.arkitFace is missing or not an object'];
  if (face.contract !== ARKIT_FACE_CONTRACT) problems.push(`extras.arkitFace.contract must be "${ARKIT_FACE_CONTRACT}", got ${JSON.stringify(face.contract)}`);
  const listed = face.morphs;
  if (!Array.isArray(listed) || !listed.every(n => typeof n === 'string')) problems.push('extras.arkitFace.morphs must be a list of morph names');
  else {
    const missing = ARKIT_FACE_REQUIRED_MORPHS.filter(n => !listed.includes(n));
    if (missing.length) problems.push(`extras.arkitFace.morphs lacks required morphs: ${missing.join(', ')}`);
    if (fileMorphs) {
      const extra = listed.filter(n => !fileMorphs.includes(n)), absent = fileMorphs.filter(n => !listed.includes(n));
      if (extra.length || absent.length) problems.push(`extras.arkitFace.morphs does not match the file's morph targets: listed but absent [${extra.join(', ')}], present but unlisted [${absent.join(', ')}]`);
    }
  }
  for (const key of ['yawMax', 'pitchMax']) {
    const value = isRecord(face.gaze) ? face.gaze[key] : undefined;
    if (!isNumber(value) || value <= 0 || value > 90) problems.push(`extras.arkitFace.gaze.${key} must be a number of degrees in (0, 90]`);
  }
  for (const key of ['down', 'up']) {
    const value = isRecord(face.lidFollow) ? face.lidFollow[key] : undefined;
    if (!isNumber(value) || value < 0 || value > 1) problems.push(`extras.arkitFace.lidFollow.${key} must be a number in [0, 1]`);
  }
  if (!isRecord(face.emotions)) problems.push('extras.arkitFace.emotions must be an object of presets');
  else {
    for (const name of FACE_EMOTIONS) if (!isRecord(face.emotions[name])) problems.push(`extras.arkitFace.emotions.${name} is missing`);
    for (const [name, curves] of Object.entries(face.emotions)) {
      if (!isRecord(curves)) { problems.push(`extras.arkitFace.emotions.${name} must be an object of curve weights`); continue; }
      for (const [curve, value] of Object.entries(curves)) {
        if (!ARKIT_CURVES.includes(curve)) problems.push(`extras.arkitFace.emotions.${name}.${curve} is not an ARKit curve`);
        else if (!isNumber(value) || value < 0 || value > 1) problems.push(`extras.arkitFace.emotions.${name}.${curve} must be in [0, 1]`);
      }
    }
  }
  return problems;
}

const nearMiss = (name: string) => {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '').replace(/(left|l)$/, 'left').replace(/(right|r)$/, 'right');
  return ARKIT_CURVES.find(curve => curve !== name && key(curve) === key(name));
};

/** Verify a GLB against `arkit-face/1`. Never throws for contract failures; throws only for unreadable bytes. */
export async function verifyFaceContract(bytes: Uint8Array): Promise<FaceContractReport> {
  const doc = readGLB(bytes);
  const { json } = doc;
  const nodes = json.nodes ?? [];
  const checks: FaceCheck[] = [], warnings: string[] = [];
  const check = (id: string, problems: string[], message: string, skippedBecause?: string) => {
    if (skippedBecause) checks.push({ id, ok: false, message: `skipped: ${skippedBecause}`, problems: [`skipped because ${skippedBecause}`] });
    else checks.push({ id, ok: problems.length === 0, message: problems.length ? problems[0] : message, problems });
  };
  const measurements: FaceContractReport['measurements'] = { height: 0, morphs: [], morphMotion: {}, inversionCombos: 0, chinDrop: null, faceHeight: null, chinDropRatio: null, upperLipMove: null, mouthOpen: null, restTeeth: null, eyes: {}, teeth: { upperMove: null, lowerDrop: null } };

  // 1. glTF validator
  const validation = await verifyGLB(bytes);
  const messages = (validation.issues.messages as { severity?: number; code?: string; message?: string; pointer?: string }[]).filter(m => m.severity === 0);
  check('validator', validation.errors ? [`glTF validator reports ${validation.errors} error(s): ${messages.slice(0, 5).map(m => `${m.code} ${m.message ?? ''}${m.pointer ? ` at ${m.pointer}` : ''}`.trim()).join('; ')}`] : [], `0 errors, ${validation.warnings} warning(s)`);
  if (validation.warnings) {
    const codes = [...new Set((validation.issues.messages as { severity?: number; code?: string }[]).filter(m => m.severity === 1).map(m => m.code))];
    warnings.push(`glTF validator reports ${validation.warnings} warning(s): ${codes.join(', ')}`);
  }

  const graph = sceneGraph(json);
  const all = instances(doc, graph);
  const worldPosition = (node: number) => new Vector3().setFromMatrixPosition(graph.world.get(node) ?? new Matrix4());

  // 2. skeleton: the skin audit verify-unreal shares (one skin, the contract bones, head -> eye_L/eye_R)
  const skinFacts = auditSkins(bytes);
  const skins = json.skins ?? [];
  const skeletonProblems: string[] = [];
  if (skinFacts.skins.length !== 1) skeletonProblems.push(`found ${skinFacts.skins.length} skins; the contract needs a single skin (Unreal builds one SkeletalMesh per skin)`);
  const jointSet = skins[0]?.joints ?? [];
  const facts = skinFacts.skins[0];
  const bone = (name: string) => jointSet.find(j => nodes[j]?.name === name);
  const bones = Object.fromEntries(ARKIT_FACE_REQUIRED_BONES.map(name => [name, bone(name)])) as Record<string, number | undefined>;
  const missingBones = ARKIT_FACE_REQUIRED_BONES.filter(name => bones[name] === undefined);
  if (missingBones.length) skeletonProblems.push(`the skin lacks bone(s) ${missingBones.join(', ')}`);
  if (facts) for (const [name, parent] of Object.entries(ARKIT_FACE_BONE_PARENTS)) {
    if (bones[name] === undefined) continue;
    if (parent === null) { if (!facts.roots.includes(name) || facts.roots.length !== 1) skeletonProblems.push(`${name} is not the root bone of the skin (roots: ${facts.roots.join(', ') || 'none'})`); }
    else if (facts.jointParents[name] !== parent) skeletonProblems.push(`${name} is not a child of ${parent} (its parent is ${facts.jointParents[name] ?? 'the scene root'})`);
  }
  if (bones.eye_L !== undefined && bones.eye_R !== undefined && worldPosition(bones.eye_L).x <= worldPosition(bones.eye_R).x) skeletonProblems.push("eye_L must be the character's left eye, on the +X side of eye_R");
  check('skeleton', skeletonProblems, 'one skin with head, eye_L and eye_R');

  // 3. skinning
  const unskinned = skinFacts.meshNodes.filter(n => n.skin === null).map(n => n.name ?? n.meshName ?? `node ${n.node}`);
  check('skinning', unskinned.length ? [`mesh node(s) not bound to the skin: ${unskinned.join(', ')}`] : [], 'every mesh is bound to the skin');

  // 4. eyes
  const eyes: Partial<Record<'L' | 'R', { center: Vector3; radius: number; balls: Instance[] }>> = {};
  const eyeProblems: string[] = [];
  const eyeballInstances = new Set<Instance>();
  for (const side of ['L', 'R'] as const) {
    const joint = bones[`eye_${side}`];
    if (joint === undefined) { eyeProblems.push(`eye_${side} bone is missing`); continue; }
    const center = worldPosition(joint);
    const candidates = all.filter(i => i.skinned && i.count > 0 && Array.from({ length: i.count }, (_, v) => i.influence(v, joint)).every(w => w >= BOUND));
    // An eyeball is small: it cannot reach past half the distance between the eyes. Anything larger bound to an
    // eye bone is a mis-bound part (a skull, a lid), and is named as such rather than as an off-center eyeball.
    const other = bones[`eye_${side === 'L' ? 'R' : 'L'}`];
    const limit = other === undefined ? Infinity : worldPosition(other).distanceTo(center) / 2;
    const reach = (i: Instance) => { let far = 0; for (let v = 0; v < i.count; v++) far = Math.max(far, Math.hypot(i.rest[v * 3] - center.x, i.rest[v * 3 + 1] - center.y, i.rest[v * 3 + 2] - center.z)); return far; };
    const balls = candidates.filter(i => reach(i) <= limit);
    for (const wrong of candidates.filter(i => !balls.includes(i))) eyeProblems.push(`${wrong.label} is bound 100% to eye_${side} but reaches ${mm(reach(wrong))} from the eye center, too far for an eyeball: only the eyeball belongs to eye_${side}; bind the ${wrong.label} to head`);
    for (const ball of balls) eyeballInstances.add(ball);
    if (!balls.length) { eyeProblems.push(`no mesh is bound 100% to eye_${side} (the eyeball)`); continue; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let radius = 0;
    for (const ball of balls) for (let v = 0; v < ball.count; v++) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], ball.rest[v * 3 + k]); max[k] = Math.max(max[k], ball.rest[v * 3 + k]); }
      radius = Math.max(radius, Math.hypot(ball.rest[v * 3] - center.x, ball.rest[v * 3 + 1] - center.y, ball.rest[v * 3 + 2] - center.z));
    }
    const offset = Math.hypot((min[0] + max[0]) / 2 - center.x, (min[1] + max[1]) / 2 - center.y, (min[2] + max[2]) / 2 - center.z);
    if (offset > PIVOT_TOLERANCE) eyeProblems.push(`eye_${side} pivots ${mm(offset)} from its eyeball's center (allowed ${mm(PIVOT_TOLERANCE)})`);
    eyes[side] = { center, radius, balls };
    measurements.eyes[side] = { center: center.toArray().map(v => round(v)), radius: round(radius), minLidClearance: null, eyeballs: balls.map(b => b.label), lidVertices: 0, coverage: null };
  }
  check('eyes', eyeProblems, 'each eyeball is bound 100% to its eye bone, which pivots at its center');

  // 5. orientation and scale
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const instance of all) for (let v = 0; v < instance.count; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], instance.rest[v * 3 + k]); hi[k] = Math.max(hi[k], instance.rest[v * 3 + k]); }
  measurements.height = all.length ? round(hi[1] - lo[1]) : 0;
  if (measurements.height < 0.2 || measurements.height > 0.3) warnings.push(`model height is ${measurements.height.toFixed(3)} m; heads are 0.20-0.30 m chin to crown (a neck or shoulders add to this)`);
  if (eyes.L && eyes.R) {
    const eyeZ = (eyes.L.center.z + eyes.R.center.z) / 2, eyeY = (eyes.L.center.y + eyes.R.center.y) / 2;
    const problems: string[] = [];
    if (eyeZ <= (lo[2] + hi[2]) / 2) problems.push(`the eyes (z ${eyeZ.toFixed(3)}) are not on the front (+Z) half of the model (center z ${((lo[2] + hi[2]) / 2).toFixed(3)}): the face must look down +Z`);
    if (eyeY <= lo[1] || eyeY >= hi[1]) problems.push('the eyes lie outside the model height: the model must be Y-up');
    check('orientation', problems, 'Y-up with the face looking down +Z');
  } else check('orientation', [], '', 'the eyes were not found');

  // 6. morph names: the layout audit verify-unreal shares, plus exact ARKit spelling
  const audit = morphNameAudit(json as Parameters<typeof morphNameAudit>[0]);
  const namingProblems: string[] = audit.issues.map(issue => issue.code === 'MORPH_NAME_SHARED_ACROSS_MESHES' ? `${issue.message} In Blender, join_face_parts does this.` : issue.message);
  const fileMorphs = audit.names;
  for (const entry of audit.meshes) for (const name of new Set(entry.targetNames ?? [])) {
    const label = entry.name ?? `mesh ${entry.mesh}`;
    const like = ARKIT_CURVES.includes(name) ? undefined : nearMiss(name);
    if (like) namingProblems.push(`${label} has "${name}", which looks like the ARKit name "${like}" (names must match exactly)`);
    if ((ARKIT_GAZE_CURVES as readonly string[]).includes(name)) warnings.push(`${label} has a ${name} morph; gaze curves drive the eye bones, not morphs`);
  }
  const missingMorphs = ARKIT_FACE_REQUIRED_MORPHS.filter(name => !fileMorphs.includes(name));
  if (missingMorphs.length) namingProblems.unshift(`missing required morph(s): ${missingMorphs.join(', ')}`);
  measurements.morphs = fileMorphs;
  check('morph-names', namingProblems, `all ${ARKIT_FACE_REQUIRED_MORPHS.length} required morphs present with exact names`);

  // 7. rest weights
  const restProblems: string[] = [];
  (json.meshes ?? []).forEach((mesh, m) => { if ((mesh.weights ?? []).some(w => w !== 0)) restProblems.push(`${mesh.name ?? `mesh ${m}`} has nonzero default morph weights [${mesh.weights!.join(', ')}]`); });
  nodes.forEach((node, n) => { if ((node.weights ?? []).some(w => w !== 0)) restProblems.push(`node ${node.name ?? n} has nonzero morph weights [${node.weights!.join(', ')}]`); });
  check('rest-weights', restProblems, 'all morph rest weights are 0');

  // 8. morph motion
  const motion = (name: string, filter: (i: Instance) => boolean = () => true) => {
    let largest = 0;
    for (const instance of all) {
      const deltas = instance.targets.get(name);
      if (!deltas || !filter(instance)) continue;
      for (let v = 0; v < instance.count; v++) largest = Math.max(largest, Math.hypot(deltas[v * 3], deltas[v * 3 + 1], deltas[v * 3 + 2]));
    }
    return largest;
  };
  const motionProblems: string[] = [];
  for (const name of fileMorphs) {
    const largest = motion(name);
    measurements.morphMotion[name] = round(largest);
    if (largest < MIN_MORPH_MOTION) {
      if ((ARKIT_FACE_REQUIRED_MORPHS as readonly string[]).includes(name)) motionProblems.push(`${name} moves at most ${mm(largest)} (needs >= ${mm(MIN_MORPH_MOTION)})`);
      else warnings.push(`${name} moves at most ${mm(largest)}; engines such as Unreal drop morphs that move nothing`);
    }
  }
  check('morph-motion', motionProblems, `every required morph moves a vertex by >= ${mm(MIN_MORPH_MOTION)}`);

  // 9. triangle inversion
  const rootFace = graph.roots.map(r => nodes[r]?.extras).find(e => isRecord(e) && isRecord(e.arkitFace));
  const extrasProblems = rootFace ? faceExtrasProblems(rootFace, fileMorphs) : undefined;
  const face = isRecord(rootFace) && isRecord(rootFace.arkitFace) ? rootFace.arkitFace : undefined;
  const presetsUsable = face && isRecord(face.emotions) && FACE_EMOTIONS.every(n => isRecord((face.emotions as Record<string, unknown>)[n]));
  const presets = (presetsUsable ? face!.emotions : CANONICAL_EMOTIONS) as Record<string, Record<string, unknown>>;
  const follow = face && isRecord(face.lidFollow) && isNumber(face.lidFollow.down) && isNumber(face.lidFollow.up) ? face.lidFollow as { down: number; up: number } : { down: 0.35, up: 0.25 };
  const combos: { label: string; weights: Record<string, number> }[] = [];
  for (const name of fileMorphs) for (const w of [0.5, 1]) combos.push({ label: `${name}=${w}`, weights: { [name]: w } });
  for (const [emotion, curves] of Object.entries(presets)) {
    const weights: Record<string, number> = {};
    for (const [curve, value] of Object.entries(curves)) if (isNumber(value) && fileMorphs.includes(curve)) weights[curve] = value;
    for (const side of ['Left', 'Right']) {
      const down = Number(curves[`eyeLookDown${side}`] ?? 0), up = Number(curves[`eyeLookUp${side}`] ?? 0);
      if (down) weights[`eyeBlink${side}`] = union(weights[`eyeBlink${side}`] ?? 0, follow.down * down);
      if (up) weights[`eyeWide${side}`] = union(weights[`eyeWide${side}`] ?? 0, follow.up * up);
    }
    combos.push({ label: `${emotion} preset`, weights: { ...weights } });
    combos.push({ label: `${emotion} preset + jawOpen=1`, weights: { ...weights, jawOpen: union(weights.jawOpen ?? 0, 1) } });
  }
  measurements.inversionCombos = combos.length;
  const inversionProblems: string[] = [];
  for (const instance of all) {
    if (!instance.targets.size || !instance.triangles.length) continue;
    const before = normals(instance.rest, instance.triangles);
    for (const combo of combos) {
      if (!Object.keys(combo.weights).some(name => instance.targets.has(name))) continue;
      const after = normals(positions(instance, combo.weights), instance.triangles);
      let flipped = 0, collapsed = 0;
      for (let t = 0; t < before.length; t += 3) {
        const area = Math.hypot(before[t], before[t + 1], before[t + 2]);
        if (area < 1e-14) continue;
        const dot = before[t] * after[t] + before[t + 1] * after[t + 1] + before[t + 2] * after[t + 2];
        if (dot <= 0) flipped++;
        else if (Math.hypot(after[t], after[t + 1], after[t + 2]) < 1e-3 * area) collapsed++;
      }
      if (flipped || collapsed) inversionProblems.push(`${combo.label} ${[flipped ? `flips ${flipped}` : '', collapsed ? `collapses ${collapsed}` : ''].filter(Boolean).join(' and ')} triangle(s) on ${instance.label}`);
    }
  }
  check('inversion', inversionProblems, `no inverted or collapsed triangles across ${combos.length} weight combinations`);

  // 10. mid-blink lid clearance
  if (eyes.L && eyes.R) {
    const lidProblems: string[] = [];
    for (const side of ['L', 'R'] as const) {
      const suffix = side === 'L' ? 'Left' : 'Right', { center, radius } = eyes[side]!;
      const required = radius + LID_CLEARANCE;
      let worst = Infinity, worstLabel = '', lidVertices = 0;
      for (const instance of all) {
        const blink = instance.targets.get(`eyeBlink${suffix}`);
        if (!blink) continue;
        const squint = instance.targets.get(`eyeSquint${suffix}`);
        for (let v = 0; v < instance.count; v++) {
          if (Math.hypot(blink[v * 3], blink[v * 3 + 1], blink[v * 3 + 2]) <= LID_MOTION) continue;
          lidVertices++;
          for (const b of [0, 0.25, 0.5, 0.75, 1]) for (const s of squint ? [0, 1] : [0]) {
            const x = instance.rest[v * 3] + b * blink[v * 3] + s * (squint?.[v * 3] ?? 0) - center.x;
            const y = instance.rest[v * 3 + 1] + b * blink[v * 3 + 1] + s * (squint?.[v * 3 + 1] ?? 0) - center.y;
            const z = instance.rest[v * 3 + 2] + b * blink[v * 3 + 2] + s * (squint?.[v * 3 + 2] ?? 0) - center.z;
            const distance = Math.hypot(x, y, z);
            if (distance < worst) { worst = distance; worstLabel = `eyeBlink${suffix}=${b}${s ? ` with eyeSquint${suffix}=1` : ''} on ${instance.label}`; }
          }
        }
      }
      measurements.eyes[side]!.lidVertices = lidVertices;
      if (!lidVertices) { lidProblems.push(`eyeBlink${suffix} moves no lid vertex`); continue; }
      measurements.eyes[side]!.minLidClearance = round(worst - radius);
      if (worst < required - 1e-9) lidProblems.push(`${worstLabel}: a lid vertex comes within ${mm(worst)} of the eye center, inside ${mm(required)} (eyeball radius ${mm(radius)} + ${mm(LID_CLEARANCE)})`);
    }
    check('lid-clearance', lidProblems, `lid vertices stay >= eyeball radius + ${mm(LID_CLEARANCE)} from the eye center at blink .25/.5/.75/1, alone and with squint`);
  } else check('lid-clearance', [], '', 'the eyes were not found');

  // 10b. eye coverage: front rays across each eyeball, lids, skin and everything else in front of it
  if (eyes.L && eyes.R) {
    const coverageProblems: string[] = [];
    const occluders = all.filter(i => !eyeballInstances.has(i));
    for (const side of ['L', 'R'] as const) {
      const suffix = side === 'L' ? 'Left' : 'Right', { center, radius, balls } = eyes[side]!;
      const names = { blink: `eyeBlink${suffix}`, squint: `eyeSquint${suffix}`, wide: `eyeWide${suffix}` };
      const eyeLabel = [...new Set(balls.map(b => b.label.replace(/\[.*\]$/, '')))].join(', ');
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const ball of balls) for (let v = 0; v < ball.count; v++) { x0 = Math.min(x0, ball.rest[v * 3]); x1 = Math.max(x1, ball.rest[v * 3]); y0 = Math.min(y0, ball.rest[v * 3 + 1]); y1 = Math.max(y1, ball.rest[v * 3 + 1]); }
      const eyeball = raster(x0, x1, y0, y1, COVERAGE_GRID);
      for (const ball of balls) draw(eyeball, ball.rest, ball.triangles, 0);
      const samples = eyeball.depth.reduce((n, z) => n + (z > -Infinity ? 1 : 0), 0);
      const look = (weights: Record<string, number>) => {
        const front = raster(x0, x1, y0, y1, COVERAGE_GRID);
        occluders.forEach((instance, k) => draw(front, Object.values(weights).some(Boolean) ? positions(instance, weights) : instance.rest, instance.triangles, k));
        const visible: number[] = [];
        for (let k = 0; k < eyeball.depth.length; k++) if (eyeball.depth[k] > -Infinity && eyeball.depth[k] > front.depth[k]) visible.push(k);
        return visible;
      };
      const neutral = new Set(look({}));
      const coverage: EyeCoverage = { samples, neutral: neutral.size, visible: {} };
      for (const state of EYE_COVERAGE_STATES) {
        const weights = Object.fromEntries((['blink', 'squint', 'wide'] as const).filter(k => state[k]).map(k => [names[k], state[k]]));
        const label = Object.entries(weights).map(([name, w]) => `${name}=${w}`).join(' + ');
        const visible = look(weights);
        coverage.visible[label] = visible.length;
        if (state.kind === 'closed' && visible.length) {
          const heights = visible.map(k => (eyeball.y0 + Math.floor(k / eyeball.nx) * eyeball.step - center.y) / radius);
          coverageProblems.push(`${label}: ${visible.length} of ${samples} front rays reach ${eyeLabel} (heights ${Math.min(...heights).toFixed(2)} to ${Math.max(...heights).toFixed(2)} eyeball radii about its center): a full blink must cover the whole eyeball, whatever squint and wide add (shutter_geometry and lid_geometry size the lids for this)`);
        } else if (state.kind === 'narrow') {
          const extra = visible.filter(k => !neutral.has(k)).length;
          if (extra) coverageProblems.push(`${label}: ${extra} front rays see ${eyeLabel} where the neutral lid opening hides it (eyeball over a lid)`);
        }
      }
      measurements.eyes[side]!.coverage = coverage;
    }
    check('eye-coverage', coverageProblems, `front rays across each eyeball: every full blink (alone, with squint 1, with wide 1) covers it, and blink .25/.5/.75 and squint show nothing outside the neutral opening`);
  } else check('eye-coverage', [], '', 'the eyes were not found');

  // 11-12. extras
  const carriers = [...graph.world.keys()].filter(n => isRecord(nodes[n]?.extras) && isRecord((nodes[n].extras as Record<string, unknown>).arkitFace));
  const rootCarriers = carriers.filter(n => graph.roots.includes(n));
  const extrasList = !carriers.length ? ['no node carries extras.arkitFace; write it on the scene root node']
    : !rootCarriers.length ? [`extras.arkitFace is on ${carriers.map(n => nodes[n].name ?? n).join(', ')}, not on a scene root node`]
      : rootCarriers.length > 1 ? [`${rootCarriers.length} root nodes carry extras.arkitFace; exactly one must`]
        : extrasProblems ?? [];
  check('extras', extrasList, 'root extras.arkitFace matches the arkit-face/1 schema and the file');
  const teeth = face?.exposedTeeth;
  const teethProblemsAtRest: string[] = [];
  const toothParts = all.filter(i => upperTeeth(i.names) || lowerTeeth(i.names));
  if (toothParts.length) {
    // Front rays over the teeth rows at rest: a closed face shows no teeth unless exposedTeeth declares them.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const part of toothParts) for (let v = 0; v < part.count; v++) { x0 = Math.min(x0, part.rest[v * 3]); x1 = Math.max(x1, part.rest[v * 3]); y0 = Math.min(y0, part.rest[v * 3 + 1]); y1 = Math.max(y1, part.rest[v * 3 + 1]); }
    const scene = all.filter(i => !eyeballInstances.has(i)), front = raster(x0, x1, y0, y1, 96), mask = raster(x0, x1, y0, y1, 96);
    scene.forEach((instance, k) => draw(front, instance.rest, instance.triangles, k));
    for (const part of toothParts) draw(mask, part.rest, part.triangles, 0);
    let samples = 0, visible = 0;
    const shown = new Set<string>();
    for (let k = 0; k < mask.depth.length; k++) {
      if (mask.depth[k] === -Infinity) continue;
      samples++;
      const owner = front.owner[k] >= 0 ? scene[front.owner[k]] : undefined;
      if (owner && toothParts.includes(owner)) { visible++; shown.add(owner.label); }
    }
    measurements.restTeeth = { samples, visible };
    if (visible && Array.isArray(teeth) && teeth.length === 0) teethProblemsAtRest.push(`at rest ${visible} of ${samples} front rays over the teeth land on ${[...shown].join(', ')} before the lips or jaw plate, but extras.arkitFace.exposedTeeth is empty: tuck the teeth behind the closed mouth or declare them`);
  }
  check('exposed-teeth', !face ? ['extras.arkitFace is missing, so exposedTeeth is undeclared']
    : Array.isArray(teeth) && teeth.every(t => typeof t === 'string' && t) ? teethProblemsAtRest : ['extras.arkitFace.exposedTeeth must declare the teeth visible at rest as a list of names (empty when none show)'],
  `exposedTeeth declared: ${Array.isArray(teeth) ? JSON.stringify(teeth) : 'none'}${measurements.restTeeth ? `; ${measurements.restTeeth.visible} of ${measurements.restTeeth.samples} front rays see teeth at rest` : ''}`);

  // 13. head binding: the skull, gums, upper teeth and every morph-bearing part ride `head`
  const bindingProblems: string[] = [];
  if (bones.head !== undefined) {
    const jointName = (joint: number) => nodes[joint]?.name ?? `node ${joint}`;
    for (const instance of all) {
      if (!instance.skinned || eyeballInstances.has(instance)) continue;
      const required = instance.targets.size > 0 || instance.names.some(n => /skull|gum|teeth|tooth|head|skin|face|lid/i.test(n));
      if (!required) continue;
      const off = new Set<string>();
      for (let v = 0; v < instance.count; v++) if (instance.influence(v, bones.head) < BOUND) for (const joint of jointSet) if (joint !== bones.head && instance.influence(v, joint) > 1 - BOUND) off.add(jointName(joint));
      if (off.size) bindingProblems.push(`${instance.label} is bound to ${[...off].join(', ')}, not head: the skull, gums, upper teeth and every morph-bearing part must be bound 100% to head (bind_rigid(obj, rig, 'head'))`);
    }
    check('head-binding', bindingProblems, 'the skull, teeth, gums and morph-bearing parts are bound 100% to head');
  } else check('head-binding', [], '', 'the head bone is missing');

  // 14. teeth
  const uppers = all.filter(i => upperTeeth(i.names)), lowers = all.filter(i => lowerTeeth(i.names));
  const teethProblems: string[] = [];
  if (!uppers.length) teethProblems.push('no upper teeth found: name the mesh or material with "teeth" and "upper" (for example teeth_upper)');
  if (!lowers.length) teethProblems.push('no lower teeth found: name the mesh or material with "teeth" and "lower" (for example teeth_lower)');
  if (uppers.length) {
    const upperMove = motion('jawOpen', i => uppers.includes(i));
    measurements.teeth.upperMove = round(upperMove);
    if (upperMove >= UPPER_TEETH_TOLERANCE) teethProblems.push(`jawOpen moves the upper teeth by ${mm(upperMove)}; they must stay on the skull`);
  }
  if (lowers.length) {
    let before = 0, after = 0, count = 0;
    for (const lower of lowers) {
      const open = positions(lower, { jawOpen: 1 });
      for (let v = 0; v < lower.count; v++) { before += lower.rest[v * 3 + 1]; after += open[v * 3 + 1]; count++; }
    }
    const drop = count ? (before - after) / count : 0;
    measurements.teeth.lowerDrop = round(drop);
    if (drop < MIN_MORPH_MOTION) teethProblems.push(`jawOpen lowers the lower teeth by ${mm(drop)} (needs >= ${mm(MIN_MORPH_MOTION)} down)`);
  }
  check('teeth', teethProblems, 'upper teeth stay on the skull; jawOpen carries the lower teeth down');

  // 15. mouth parts carried by the jaw
  const parts = all.filter(i => tongue(i.names) || cavity(i.names));
  const partProblems = parts.filter(i => motion('jawOpen', x => x === i) < MIN_MORPH_MOTION).map(i => `jawOpen does not carry ${i.label} (moves < ${mm(MIN_MORPH_MOTION)})`);
  check('mouth-parts', partProblems, parts.length ? `jawOpen carries ${parts.map(i => i.label).join(', ')}` : 'no tongue or mouth-cavity meshes named by convention');

  // 16. puppet jaw: the chin, the face's lowest point, drops with the jaw (E3), not only the lips
  const skin = all.filter(i => !mouthPart(i.names) && !socket(i.names) && !body(i.names) && !eyeballInstances.has(i));
  let restLow = Infinity, openLow = Infinity, top = -Infinity;
  for (const instance of skin) {
    const open = positions(instance, { jawOpen: 1 });
    for (let v = 0; v < instance.count; v++) { restLow = Math.min(restLow, instance.rest[v * 3 + 1]); openLow = Math.min(openLow, open[v * 3 + 1]); top = Math.max(top, instance.rest[v * 3 + 1]); }
  }
  if (skin.length && Number.isFinite(restLow)) {
    const chinDrop = restLow - openLow, faceHeight = top - restLow, ratio = faceHeight > 0 ? chinDrop / faceHeight : 0;
    Object.assign(measurements, { chinDrop: round(chinDrop), faceHeight: round(faceHeight), chinDropRatio: round(ratio) });
    check('puppet-jaw', ratio < MIN_CHIN_DROP_RATIO - 1e-9 ? [`jawOpen=1 ${chinDrop < 0 ? `raises the face's lowest point (the chin) by ${mm(-chinDrop)}` : `drops the face's lowest point (the chin) by only ${mm(chinDrop)}, ${(ratio * 100).toFixed(1)}% of the ${mm(faceHeight)} face height`} (needs a drop of >= ${MIN_CHIN_DROP_RATIO * 100}%, ${mm(MIN_CHIN_DROP_RATIO * faceHeight)}): the chin and lower face outline must drop with the jaw, not only the lips; hinge the jaw by the ears (JawHinge.ear)`] : [],
      `jawOpen=1 drops the chin (the face's lowest point) by ${mm(chinDrop)}, ${(ratio * 100).toFixed(1)}% of the ${mm(faceHeight)} face height`);
  } else check('puppet-jaw', [], '', 'no face skin was found');

  // 17. the upper lip and the face above it stay put
  if (uppers.length) {
    let gum = -Infinity;
    for (const upper of uppers) for (let v = 0; v < upper.count; v++) gum = Math.max(gum, upper.rest[v * 3 + 1]);
    let worst = 0, worstLabel = '';
    for (const instance of skin) {
      const deltas = instance.targets.get('jawOpen'); if (!deltas) continue;
      for (let v = 0; v < instance.count; v++) {
        if (instance.rest[v * 3 + 1] <= gum) continue;
        const move = Math.hypot(deltas[v * 3], deltas[v * 3 + 1], deltas[v * 3 + 2]);
        if (move > worst) { worst = move; worstLabel = instance.label; }
      }
    }
    measurements.upperLipMove = round(worst);
    check('upper-lip', worst > UPPER_LIP_TOLERANCE ? [`jawOpen moves ${worstLabel} above the upper teeth's gum line by ${mm(worst)} (allowed ${mm(UPPER_LIP_TOLERANCE)}): the upper lip and the face above the mouth must stay on the skull`] : [],
      `the face above the upper teeth's gum line stays put under jawOpen (at most ${mm(worst)})`);
  } else check('upper-lip', [], '', 'no upper teeth mark the gum line');

  // 18. the mouth opens: between the teeth rows, a front view sees teeth, tongue or cavity, not skin
  if (uppers.length && lowers.length) {
    let bite = Infinity, lowTop = -Infinity, left = Infinity, right = -Infinity;
    for (const upper of uppers) for (let v = 0; v < upper.count; v++) { bite = Math.min(bite, upper.rest[v * 3 + 1]); left = Math.min(left, upper.rest[v * 3]); right = Math.max(right, upper.rest[v * 3]); }
    for (const lower of lowers) { const open = positions(lower, { jawOpen: 1 }); for (let v = 0; v < lower.count; v++) lowTop = Math.max(lowTop, open[v * 3 + 1]); }
    if (lowTop >= bite) check('mouth-open', [`at jawOpen=1 the lower teeth's top still sits ${mm(lowTop - bite)} above the upper teeth's bite edge: the mouth does not open between the rows`], '');
    else {
      const height = (bite + lowTop) / 2, middle = (left + right) / 2, span = (right - left) / 2;
      const xs = [middle, middle - span / 3, middle + span / 3];
      const scene = all.map(instance => ({ instance, points: positions(instance, { jawOpen: 1 }) }));
      // The back of the teeth rows: skin hit behind it is the inside of the head seen through the mouth.
      let teethBack = Infinity;
      for (const { instance, points } of scene) if (upperTeeth(instance.names) || lowerTeeth(instance.names)) for (let v = 0; v < instance.count; v++) teethBack = Math.min(teethBack, points[v * 3 + 2]);
      const depths: number[] = [];
      const hits = xs.map(x => {
        let best = -Infinity, hit: Instance | undefined;
        for (const { instance, points } of scene) {
          const t = instance.triangles;
          for (let k = 0; k < t.length; k += 3) {
            const z = rayZ(points, t[k], t[k + 1], t[k + 2], x, height);
            if (z !== null && z > best) { best = z; hit = instance; }
          }
        }
        depths.push(best);
        return hit;
      });
      measurements.mouthOpen = { height: round(height), xs: xs.map(x => round(x)), hits: hits.map(h => h?.label ?? '(nothing)') };
      const problems = hits.flatMap((hit, k) => hit && mouthPart(hit.names) ? [] : [!hit
        ? `jawOpen=1 opens a see-through mouth: a front view at x ${mm(xs[k])}, halfway between the teeth rows, hits nothing (add a dark mouth cavity behind the lips)`
        : depths[k] < teethBack
          ? `jawOpen=1 opens a see-through mouth: a front view at x ${mm(xs[k])}, halfway between the teeth rows, passes the teeth and hits the inside of ${hit.label} ${mm(teethBack - depths[k])} behind them (add a dark mouth cavity behind the lips)`
          : `jawOpen=1 does not open the mouth: a front view at x ${mm(xs[k])}, halfway between the teeth rows, hits ${hit.label} before any teeth, tongue or mouth cavity (skin such as the upper lip covers the opening)`]);
      check('mouth-open', problems, `jawOpen=1 shows ${[...new Set(hits.map(h => h?.label ?? '(nothing)'))].join(', ')} between the lips`);
    }
  } else check('mouth-open', [], '', 'the upper or lower teeth were not found');

  const failures = checks.flatMap(c => c.problems.map(p => `${c.id}: ${p}`));
  return {
    contract: ARKIT_FACE_CONTRACT, ok: failures.length === 0, failures, warnings, checks,
    validator: { errors: validation.errors, warnings: validation.warnings }, measurements,
  };
}
