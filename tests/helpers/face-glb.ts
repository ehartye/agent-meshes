/**
 * A small synthetic `arkit-face/1` head, described as plain data and encoded to GLB in Node,
 * so the contract verifier's checks can be proven to pass and to fail one at a time.
 * glTF coordinates: Y up, meters, the face looks down +Z, the character's left is +X.
 */
export type Vec3 = [number, number, number];
export interface SynthMesh {
  name: string; material: string;
  positions: Vec3[]; indices: number[];
  /** Morph targets as absolute positions (converted to deltas when encoded). */
  targets: { name: string; positions: Vec3[] }[];
  /** One bone per vertex (single influence), or undefined for an unskinned mesh. */
  bones?: string[];
  weights?: number[];
  unskinnedNode?: boolean;
}
export interface SynthNode { name: string; translation: Vec3; children: string[] }
export interface SynthHead {
  rootName: string; rootExtras?: Record<string, unknown>;
  joints: SynthNode[]; meshes: SynthMesh[];
  extraSkin?: boolean; dropBounds?: boolean;
  /** glTF mesh name -> part names encoded as its primitives (one morph-name list per glTF mesh). */
  groups?: Record<string, string[]>;
  /** Extra glTF material fields by material name (alphaMode, extensions, ...). */
  materialProps?: Record<string, Record<string, unknown>>;
}

export const REQUIRED = ['eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawOpen',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthFunnel',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekSquintLeft', 'cheekSquintRight'];

const EYE_RADIUS = 0.012;
export const EYES: Record<'L' | 'R', Vec3> = { L: [0.03, 0.05, 0.07], R: [-0.03, 0.05, 0.07] };
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function rotateX(point: Vec3, pivot: Vec3, degrees: number): Vec3 {
  const t = degrees * Math.PI / 180, y = point[1] - pivot[1], z = point[2] - pivot[2];
  return [point[0], pivot[1] + y * Math.cos(t) - z * Math.sin(t), pivot[2] + y * Math.sin(t) + z * Math.cos(t)];
}

export function sphere(center: Vec3, radius: number, rings = 8, segments = 12): { positions: Vec3[]; indices: number[] } {
  const positions: Vec3[] = [add(center, [0, radius, 0])];
  for (let k = 1; k < rings; k++) {
    const polar = Math.PI * k / rings;
    for (let j = 0; j < segments; j++) {
      const a = 2 * Math.PI * j / segments;
      positions.push(add(center, [radius * Math.sin(polar) * Math.cos(a), radius * Math.cos(polar), radius * Math.sin(polar) * Math.sin(a)]));
    }
  }
  positions.push(add(center, [0, -radius, 0]));
  const ring = (k: number, j: number) => 1 + k * segments + (j % segments), last = positions.length - 1, indices: number[] = [];
  for (let j = 0; j < segments; j++) indices.push(0, ring(0, j + 1), ring(0, j));
  for (let k = 0; k < rings - 2; k++) for (let j = 0; j < segments; j++) indices.push(ring(k, j), ring(k, j + 1), ring(k + 1, j + 1), ring(k, j), ring(k + 1, j + 1), ring(k + 1, j));
  for (let j = 0; j < segments; j++) indices.push(ring(rings - 2, j), ring(rings - 2, j + 1), last);
  return { positions, indices };
}

function grid(columns: number, rows: number, at: (u: number, v: number) => Vec3, flip = false): { positions: Vec3[]; indices: number[] } {
  const positions: Vec3[] = [], indices: number[] = [];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) positions.push(at(j / columns, i / rows));
  const index = (i: number, j: number) => i * (columns + 1) + j;
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
    const quad = [index(i, j), index(i, j + 1), index(i + 1, j + 1), index(i, j), index(i + 1, j + 1), index(i + 1, j)];
    indices.push(...(flip ? quad.reverse() : quad));
  }
  return { positions, indices };
}

/** A closed slab between two (u, v) sheets, `at(u, v, 0)` and `at(u, v, 1)`, wound outward. */
function slab(columns: number, rows: number, at: (u: number, v: number, layer: number) => Vec3): { positions: Vec3[]; indices: number[] } {
  const positions: Vec3[] = [], indices: number[] = [];
  for (let layer = 0; layer < 2; layer++) for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) positions.push(at(j / columns, i / rows, layer));
  const index = (layer: number, i: number, j: number) => layer * (rows + 1) * (columns + 1) + i * (columns + 1) + j;
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) {
    quad(index(1, i, j), index(1, i, j + 1), index(1, i + 1, j + 1), index(1, i + 1, j));
    quad(index(0, i, j), index(0, i + 1, j), index(0, i + 1, j + 1), index(0, i, j + 1));
  }
  const rim: [number, number][][] = [];
  for (let j = 0; j < columns; j++) rim.push([[0, j], [0, j + 1]], [[rows, j + 1], [rows, j]]);
  for (let i = 0; i < rows; i++) rim.push([[i + 1, 0], [i, 0]], [[i, columns], [i + 1, columns]]);
  for (const [[ai, aj], [bi, bj]] of rim) quad(index(1, bi, bj), index(1, ai, aj), index(0, ai, aj), index(0, bi, bj));
  // Signed volume: flip every face if the slab came out inside-out.
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [positions[indices[t]], positions[indices[t + 1]], positions[indices[t + 2]]];
    volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (volume < 0) for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  return { positions, indices };
}

function box(center: Vec3, size: Vec3) {
  return grid(1, 1, (u, v) => add(center, [(u - 0.5) * size[0], (v - 0.5) * size[1], size[2] / 2]));
}

/**
 * Rotations (degrees, + raises the lid) of each lid for each morph: blink overshoots the meet line so blink + wide still
 * closes. Wide lifts the upper lid 10 degrees, so lid follow (eyeWide = lidFollow.up at eyeLookUp = 1) lifts its edge 2 mm.
 */
export const LID_SWEEPS = { upper: { blink: -56, squint: -10, wide: 10 }, lower: { blink: 32, squint: 8, wide: -5 } };

/**
 * Upper and lower lids: spherical patches around the eye, wide enough to cover the whole eyeball, each turned about
 * the eye's X axis for each morph. At rest the opening runs from 30 degrees below the gaze axis to 35 above.
 */
function lids(side: 'L' | 'R', radius: number, sweeps = LID_SWEEPS, span = 84): SynthMesh {
  const center = EYES[side], suffix = side === 'L' ? 'Left' : 'Right';
  // Latitude bands about the eye's X axis (the blink axis): `turn` degrees up from the gaze axis, `side` toward +X.
  const at = (r: number, across: number, turn: number): Vec3 => {
    const b = across * Math.PI / 180, a = turn * Math.PI / 180;
    return add(center, [r * Math.sin(b), r * Math.cos(b) * Math.sin(a), r * Math.cos(b) * Math.cos(a)]);
  };
  // Closed 0.4 mm shells, as the helpers' lids are, reaching almost to the X axis on each side, so turning them for a
  // blink never uncovers the eye's flanks.
  const upper = slab(32, 24, (u, v, layer) => at(radius - 0.0004 + 0.0004 * layer, -span + 2 * span * u, 150 - 115 * v));
  const lower = slab(32, 24, (u, v, layer) => at(radius - 0.001 + 0.0004 * layer, -span + 2 * span * u, -30 - 120 * v));
  const positions = [...upper.positions, ...lower.positions];
  const indices = [...upper.indices, ...lower.indices.map(i => i + upper.positions.length)];
  const turn = (state: 'blink' | 'squint' | 'wide') => [
    ...upper.positions.map(p => rotateX(p, center, -sweeps.upper[state])),
    ...lower.positions.map(p => rotateX(p, center, -sweeps.lower[state])),
  ];
  return {
    name: `lids_${side}`, material: 'lid', positions, indices,
    targets: [
      { name: `eyeBlink${suffix}`, positions: turn('blink') },
      { name: `eyeSquint${suffix}`, positions: turn('squint') },
      { name: `eyeWide${suffix}`, positions: turn('wide') },
    ],
    bones: positions.map(() => 'head'),
  };
}

/**
 * Skin in front of the lids with a hole for the opening, as a head's socket rim does: turning lid patches never meet
 * at the far corners of the eye, so the skin hides the corners and the lids close the hole.
 */
function eyeMask(side: 'L' | 'R', hole = { x: 0.0065, low: -0.006, high: 0.011 }): SynthMesh {
  // The hole's top clears the upper lid's edge (8.6 mm above the eye center) so a strip of lid shows at rest. The mask
  // reaches 35 mm round the eye, so the verifier counts it as skin (a third of the largest part), not a small attached part.
  const [cx, cy] = EYES[side], z = EYES[side][2] + 0.016, reach = 0.035;
  const positions: Vec3[] = [], indices: number[] = [];
  const quad = (x0: number, x1: number, y0: number, y1: number) => {
    const base = positions.length;
    positions.push([cx + x0, cy + y0, z], [cx + x1, cy + y0, z], [cx + x1, cy + y1, z], [cx + x0, cy + y1, z]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad(-reach, reach, hole.high, reach); quad(-reach, reach, -reach, hole.low);
  quad(-reach, -hole.x, hole.low, hole.high); quad(hole.x, reach, hole.low, hole.high);
  return { name: `eye_mask_${side}`, material: 'skin', positions, indices, targets: [], bones: positions.map(() => 'head') };
}

/**
 * The skin wall at the eye's flanks: past 50 degrees of yaw, where the lids' opening band runs on around the eye, a
 * static skin band just outside both lids closes it, so no oblique view looks between the lids into the head.
 */
function eyeCorners(side: 'L' | 'R'): SynthMesh {
  const center = EYES[side];
  const at = (yaw: number, elevation: number, r: number): Vec3 => {
    const y = yaw * Math.PI / 180, e = elevation * Math.PI / 180;
    return add(center, [r * Math.cos(e) * Math.sin(y), r * Math.sin(e), r * Math.cos(e) * Math.cos(y)]);
  };
  const outer = slab(8, 8, (u, v, layer) => at(50 + 80 * u, 50 - 95 * v, 0.0156 + 0.0004 * layer));
  const inner = slab(8, 8, (u, v, layer) => at(-50 - 80 * u, 50 - 95 * v, 0.0156 + 0.0004 * layer));
  const positions = [...outer.positions, ...inner.positions], indices = [...outer.indices, ...inner.indices.map(i => i + outer.positions.length)];
  return { name: `eye_corners_${side}`, material: 'skin', positions, indices, targets: [], bones: positions.map(() => 'head') };
}

/**
 * Robot shutters in front of an eye with no skin rim (the skin hole is wider than the eye): two flat blades that
 * translate, sized like `shutter_geometry`'s opening (.7, .55), meet 0 and squint .45. `blade` is the blade height in
 * eyeball radii and `overlap` how far the closed upper blade passes the meet line; round 2 used 1.3 and 0.08, which
 * leaves the bottom of the eye bare at blink 1 + squint 1 (and blink 1 + wide 1 open).
 */
export function shutterEye(head: SynthHead, side: 'L' | 'R', blade: number, overlap = 0.38): void {
  const [cx, cy, cz] = EYES[side], r = EYE_RADIUS, suffix = side === 'L' ? 'Left' : 'Right';
  const travel = (1 - 0.45) * (0.7 + 0.55) * r;
  const edges = {
    upper: { rest: 0.7 * r, blink: -overlap * r, squint: 0.7 * r - 0.35 * travel, wide: 0.9 * r },
    lower: { rest: -0.55 * r, blink: 0, squint: -0.55 * r + 0.65 * travel, wide: -0.65 * r },
  };
  const box = (key: 'upper' | 'lower', state: 'rest' | 'blink' | 'squint' | 'wide'): Vec3[] => {
    const edge = edges[key][state], z = cz + r + (key === 'upper' ? 0.0015 : 0.0008);
    const [y0, y1] = key === 'upper' ? [edge, edge + blade * r] : [edge - blade * r, edge];
    return [[cx - 1.1 * r, cy + y0, z], [cx + 1.1 * r, cy + y0, z], [cx + 1.1 * r, cy + y1, z], [cx - 1.1 * r, cy + y1, z]];
  };
  const at = (state: 'rest' | 'blink' | 'squint' | 'wide') => [...box('upper', state), ...box('lower', state)];
  const positions = at('rest');
  const index = head.meshes.findIndex(m => m.name === `lids_${side}`);
  head.meshes[index] = {
    name: `lids_${side}`, material: 'lid', positions, indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    targets: [{ name: `eyeBlink${suffix}`, positions: at('blink') }, { name: `eyeSquint${suffix}`, positions: at('squint') }, { name: `eyeWide${suffix}`, positions: at('wide') }],
    bones: positions.map(() => 'head'),
  };
  head.meshes = head.meshes.filter(m => m.name !== `eye_mask_${side}`);
}

/**
 * The round-3 critic's black hole beside the eye: a dark socket cup around the lids with nothing joining the skin's
 * eye-hole rim to the lids. The skin (the eye mask) stands 1 mm in front of the lids, so a front view sees only lids
 * and eyeball; from 3/4, rays slip under the rim, past the lids' flanks, into the socket.
 */
export function socketGap(head: SynthHead, side: 'L' | 'R'): void {
  const center = EYES[side], radius = 0.0175, cup = sphere(center, radius, 16, 24), indices: number[] = [];
  // Keep the triangles more than 60 degrees from the gaze axis (+Z), wound to face the eye.
  for (let t = 0; t < cup.indices.length; t += 3) {
    const tri = cup.indices.slice(t, t + 3), z = tri.reduce((sum, i) => sum + cup.positions[i][2] - center[2], 0) / 3;
    if (z < radius * Math.cos(Math.PI / 3)) indices.push(tri[0], tri[2], tri[1]);
  }
  head.meshes.push({ name: `eye_socket_${side}`, material: 'eye_socket', positions: cup.positions, indices, targets: [], bones: cup.positions.map(() => 'head') });
}

/** Rebuild one eye's lids with other sweeps (for negative fixtures). */
export function relid(head: SynthHead, side: 'L' | 'R', sweeps: typeof LID_SWEEPS): void {
  const index = head.meshes.findIndex(m => m.name === `lids_${side}`);
  head.meshes[index] = lids(side, 0.015, sweeps);
}

export const JAW_DROP = 0.03;
/** The mouth line (glTF y) and the slit's columns: the lips part for |x| <= MOUTH_HALF_WIDTH. */
export const MOUTH_Y = -0.03, MOUTH_HALF_WIDTH = 0.02;
const COLUMNS = 16, ROWS = 22, MOUTH_ROW = 9;
const dropped = (p: Vec3): Vec3 => [p[0], p[1] - JAW_DROP, p[2]];

/**
 * The face: a plane at z = 0.06 with a slit along the mouth row. The slit's lower-lip vertices are duplicates
 * appended after the grid (`lowerLip` lists them), so the lips part when `jawOpen` drops everything below the line.
 */
function slitFace(): { positions: Vec3[]; indices: number[]; below: boolean[]; upperSeam: number[] } {
  const at = (i: number, j: number): Vec3 => [-0.08 + 0.16 * j / COLUMNS, -0.12 + 0.22 * i / ROWS, 0.06];
  const positions: Vec3[] = [], below: boolean[] = [];
  for (let i = 0; i <= ROWS; i++) for (let j = 0; j <= COLUMNS; j++) { positions.push(at(i, j)); below.push(i < MOUTH_ROW); }
  const index = (i: number, j: number) => i * (COLUMNS + 1) + j;
  const slit = (j: number) => Math.abs(at(MOUTH_ROW, j)[0]) < MOUTH_HALF_WIDTH + 1e-9;
  const lower = new Map<number, number>(), upperSeam: number[] = [];
  for (let j = 0; j <= COLUMNS; j++) if (slit(j)) { upperSeam.push(index(MOUTH_ROW, j)); lower.set(j, positions.length); positions.push(at(MOUTH_ROW, j)); below.push(true); }
  const indices: number[] = [];
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLUMNS; j++) {
    const top = (jj: number) => i + 1 === MOUTH_ROW && lower.has(jj) ? lower.get(jj)! : index(i + 1, jj);
    indices.push(index(i, j), index(i, j + 1), top(j + 1), index(i, j), top(j + 1), top(j));
  }
  return { positions, indices, below, upperSeam };
}

/** A head that satisfies every computable clause of `arkit-face/1`. Mutate it to build negative fixtures. */
export function passingHead(): SynthHead {
  const face = slitFace();
  const bump = (center: [number, number], dz = 0.003) => face.positions.map(p => {
    const d = Math.hypot(p[0] - center[0], p[1] - center[1]) / 0.025;
    const w = d >= 1 ? 0 : 1 - d * d * (3 - 2 * d);
    return [p[0], p[1], p[2] + dz * w] as Vec3;
  });
  const regions: Record<string, [number, number]> = {
    mouthSmileLeft: [0.03, -0.04], mouthSmileRight: [-0.03, -0.04], mouthFrownLeft: [0.035, -0.06], mouthFrownRight: [-0.035, -0.06],
    mouthStretchLeft: [0.045, -0.05], mouthStretchRight: [-0.045, -0.05], mouthFunnel: [0, -0.045],
    browDownLeft: [0.03, 0.08], browDownRight: [-0.03, 0.08], browInnerUp: [0, 0.08], browOuterUpLeft: [0.055, 0.08], browOuterUpRight: [-0.055, 0.08],
    cheekSquintLeft: [0.05, 0.0], cheekSquintRight: [-0.05, 0.0],
  };
  // A puppet jaw: everything below the mouth line (and the lower lip) drops, the chin outline with it.
  const faceMesh: SynthMesh = {
    name: 'face', material: 'skin', positions: face.positions, indices: face.indices,
    targets: [{ name: 'jawOpen', positions: face.positions.map((p, i) => face.below[i] ? dropped(p) : p) }, ...Object.entries(regions).map(([name, c]) => ({ name, positions: bump(c) }))],
    bones: face.positions.map(() => 'head'),
  };
  const eye = (side: 'L' | 'R'): SynthMesh => {
    const ball = sphere(EYES[side], EYE_RADIUS);
    return { name: `eyeball_${side}`, material: 'eye_white', ...ball, targets: [], bones: ball.positions.map(() => `eye_${side}`) };
  };
  // Teeth, tongue and cavity sit behind the face plane; the lower ones ride the jaw.
  const upperTeeth = box([0, -0.03, 0.05], [0.03, 0.008, 0.004]);
  const lowerTeeth = box([0, -0.036, 0.048], [0.028, 0.008, 0.004]);
  const tongue = box([0, -0.045, 0.044], [0.02, 0.01, 0.004]);
  const cavity = grid(1, 1, (u, v) => [-0.03 + 0.06 * u, -0.08 + 0.06 * v, 0.04]);
  const skull = sphere([0, 0, -0.04], 0.08, 10, 16);
  const jaw = (points: Vec3[]) => points.map(dropped);
  return {
    rootName: 'Face rig',
    rootExtras: { arkitFace: extras() },
    groups: { face: ['face', 'lids_L', 'lids_R', 'teeth_upper', 'teeth_lower', 'tongue', 'mouth_cavity'] },
    joints: [
      { name: 'head', translation: [0, 0, 0], children: ['eye_L', 'eye_R'] },
      { name: 'eye_L', translation: EYES.L, children: [] },
      { name: 'eye_R', translation: EYES.R, children: [] },
    ],
    meshes: [
      { name: 'skull', material: 'skin', ...skull, targets: [], bones: skull.positions.map(() => 'head') },
      faceMesh, eye('L'), eye('R'), lids('L', 0.015), lids('R', 0.015), eyeMask('L'), eyeMask('R'), eyeCorners('L'), eyeCorners('R'),
      { name: 'teeth_upper', material: 'teeth_upper', ...upperTeeth, targets: [], bones: upperTeeth.positions.map(() => 'head') },
      { name: 'teeth_lower', material: 'teeth_lower', ...lowerTeeth, targets: [{ name: 'jawOpen', positions: jaw(lowerTeeth.positions) }], bones: lowerTeeth.positions.map(() => 'head') },
      { name: 'tongue', material: 'tongue', ...tongue, targets: [{ name: 'jawOpen', positions: jaw(tongue.positions) }], bones: tongue.positions.map(() => 'head') },
      { name: 'mouth_cavity', material: 'mouth_cavity', ...cavity, targets: [{ name: 'jawOpen', positions: cavity.positions.map(p => p[1] < MOUTH_Y ? dropped(p) : p) }], bones: cavity.positions.map(() => 'head') },
    ],
  };
}

/** Vertex indices of the face's upper-lip seam (on the mouth line, inside the slit). */
export function upperSeam(): number[] { return slitFace().upperSeam; }

export function extras(morphs: string[] = REQUIRED): Record<string, unknown> {
  return {
    contract: 'arkit-face/1', morphs: [...morphs],
    gaze: { yawMax: 25, pitchMax: 18 }, lidFollow: { down: 0.35, up: 1 },
    emotions: {
      neutral: {},
      happy: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, jawOpen: 0.25, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, browOuterUpLeft: 0.3, browOuterUpRight: 0.3 },
      sad: { browInnerUp: 0.9, mouthFrownLeft: 0.85, mouthFrownRight: 0.85, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25, eyeLookDownLeft: 0.4, eyeLookDownRight: 0.4 },
      angry: { browDownLeft: 1, browDownRight: 1, eyeSquintLeft: 0.45, eyeSquintRight: 0.45, noseSneerLeft: 0.7, noseSneerRight: 0.7, mouthFrownLeft: 0.35, mouthFrownRight: 0.35, mouthStretchLeft: 0.5, mouthStretchRight: 0.5, jawOpen: 0.12 },
      surprised: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 0.9, browOuterUpLeft: 1, browOuterUpRight: 1, jawOpen: 0.6, mouthFunnel: 0.85 },
      scared: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 1, browDownLeft: 0.25, browDownRight: 0.25, mouthStretchLeft: 0.9, mouthStretchRight: 0.9, mouthFrownLeft: 0.3, mouthFrownRight: 0.3, jawOpen: 0.3 },
    },
    exposedTeeth: [],
  };
}

export function mesh(head: SynthHead, name: string): SynthMesh {
  const found = head.meshes.find(m => m.name === name);
  if (!found) throw new Error(`No synthetic mesh ${name}`);
  return found;
}

/** Encode the description as a GLB with one skin, named morph targets and zero default weights. */
export function encodeHead(head: SynthHead): Uint8Array {
  const chunks: Buffer[] = [];
  let length = 0;
  const bufferViews: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [];
  const view = (bytes: Buffer, target?: number) => {
    const pad = (4 - (length % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes); length += bytes.length; return bufferViews.length - 1;
  };
  const floats = (values: number[][], type: string, bounds: boolean) => {
    const flat = new Float32Array(values.flat());
    const accessor: Record<string, unknown> = { bufferView: view(Buffer.from(flat.buffer), type === 'MAT4' ? undefined : 34962), componentType: 5126, count: values.length, type };
    if (bounds && !head.dropBounds) {
      const size = values[0].length;
      accessor.min = Array.from({ length: size }, (_, k) => Math.min(...values.map(v => Math.fround(v[k]))));
      accessor.max = Array.from({ length: size }, (_, k) => Math.max(...values.map(v => Math.fround(v[k]))));
    }
    accessors.push(accessor); return accessors.length - 1;
  };
  const jointNames = head.joints.map(j => j.name);
  const nodes: Record<string, unknown>[] = [];
  const nodeIndex = new Map<string, number>();
  nodes.push({ name: head.rootName, children: [] as number[], ...(head.rootExtras ? { extras: head.rootExtras } : {}) });
  for (const joint of head.joints) { nodeIndex.set(joint.name, nodes.length); nodes.push({ name: joint.name, translation: joint.translation }); }
  for (const joint of head.joints) if (joint.children.length) nodes[nodeIndex.get(joint.name)!].children = joint.children.map(c => nodeIndex.get(c)!);
  const childJoints = new Set(head.joints.flatMap(j => j.children));
  (nodes[0].children as number[]).push(...head.joints.filter(j => !childJoints.has(j.name)).map(j => nodeIndex.get(j.name)!));
  // Inverse bind matrices: joints are pure translations, so each inverse is the negated world translation.
  const world = new Map<string, Vec3>();
  const walk = (name: string, parent: Vec3) => { const j = head.joints.find(x => x.name === name)!; const w = add(parent, j.translation); world.set(name, w); for (const c of j.children) walk(c, w); };
  for (const j of head.joints) if (!childJoints.has(j.name)) walk(j.name, [0, 0, 0]);
  const ibm = floats(jointNames.map(n => { const t = world.get(n)!; return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0], -t[1], -t[2], 1]; }), 'MAT4', false);
  const skins = [{ joints: jointNames.map(n => nodeIndex.get(n)!), skeleton: nodeIndex.get(jointNames[0])!, inverseBindMatrices: ibm }];
  if (head.extraSkin) skins.push({ ...skins[0] });
  const materials = [...new Set(head.meshes.map(m => m.material))];
  // Parts listed in a group become primitives of one glTF mesh sharing one morph-name list.
  const grouped = new Set(Object.values(head.groups ?? {}).flat());
  const layout: [string, SynthMesh[]][] = [
    ...Object.entries(head.groups ?? {}).map(([name, parts]) => [name, parts.map(part => mesh(head, part))] as [string, SynthMesh[]]),
    ...head.meshes.filter(m => !grouped.has(m.name)).map(m => [m.name, [m]] as [string, SynthMesh[]]),
  ];
  const meshes = layout.map(([name, parts], meshIndex) => {
    const names = [...new Set(parts.flatMap(p => p.targets.map(t => t.name)))];
    const primitives = parts.map(m => {
      const attributes: Record<string, number> = { POSITION: floats(m.positions, 'VEC3', true) };
      if (m.bones) {
        const joints = new Uint8Array(m.bones.flatMap(b => { const i = jointNames.indexOf(b); if (i < 0) throw new Error(`Unknown bone ${b}`); return [i, 0, 0, 0]; }));
        attributes.JOINTS_0 = accessors.push({ bufferView: view(Buffer.from(joints.buffer), 34962), componentType: 5121, count: m.positions.length, type: 'VEC4' }) - 1;
        attributes.WEIGHTS_0 = floats(m.positions.map(() => [1, 0, 0, 0]), 'VEC4', false);
      }
      const indices = new Uint16Array(m.indices);
      const indexAccessor = accessors.push({ bufferView: view(Buffer.from(indices.buffer), 34963), componentType: 5123, count: indices.length, type: 'SCALAR' }) - 1;
      const targets = names.map(targetName => {
        const target = m.targets.find(t => t.name === targetName);
        return { POSITION: floats(m.positions.map((p, i) => target ? [target.positions[i][0] - p[0], target.positions[i][1] - p[1], target.positions[i][2] - p[2]] : [0, 0, 0]), 'VEC3', true) };
      });
      return { attributes, indices: indexAccessor, material: materials.indexOf(m.material), ...(targets.length ? { targets } : {}) };
    });
    const nodeFields: Record<string, unknown> = { name, mesh: meshIndex };
    if (parts[0].bones && !parts[0].unskinnedNode) nodeFields.skin = head.extraSkin && meshIndex === 1 ? 1 : 0;
    (nodes[0].children as number[]).push(nodes.length); nodes.push(nodeFields);
    const weights = parts.find(p => p.weights)?.weights;
    return { name, primitives, ...(names.length ? { weights: weights ?? names.map(() => 0), extras: { targetNames: names } } : {}) };
  });
  const binary = Buffer.concat(chunks);
  const document = {
    asset: { version: '2.0', generator: 'agent-meshes synthetic face' }, scene: 0, scenes: [{ nodes: [0] }], nodes, meshes, skins,
    materials: materials.map(name => ({ name, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.5 }, ...head.materialProps?.[name] })),
    accessors, bufferViews, buffers: [{ byteLength: binary.length + ((4 - binary.length % 4) % 4) }],
  };
  let json = Buffer.from(JSON.stringify(document));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (data: Buffer, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]); };
  return new Uint8Array(Buffer.concat([header, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]));
}

/** The eye masks' plane (glTF z): the skin around the eyes that brows and fringes lie on. */
export const MASK_Z = EYES.L[2] + 0.016;

/**
 * A brow bar on the left eye mask, above the eye hole: `back` is how far its back face stands in front of the mask
 * (negative sinks it in), and `lift` pushes it off the skin in browInnerUp. browDownLeft slides it down the mask.
 */
export function browBar(head: SynthHead, back = -0.0002, lift = 0): void {
  const [cx, cy] = EYES.L;
  const bar = slab(12, 2, (u, v, layer) => [cx - 0.012 + 0.024 * u, cy + 0.013 + 0.006 * v, MASK_Z + back + 0.003 * layer]);
  const shift = (d: Vec3) => bar.positions.map(p => add(p, d));
  head.meshes.push({
    name: 'brow_L', material: 'brow', ...bar, bones: bar.positions.map(() => 'head'),
    targets: [{ name: 'browDownLeft', positions: shift([0, -0.003, 0]) }, { name: 'browInnerUp', positions: shift([0, 0.002, lift]) }],
  });
  head.groups!.face.push('brow_L');
}

/**
 * A nostril (a 3 mm ball half sunk in the face plane) and a noseSneerLeft skin shape that swells the face under it
 * by `swell`. `carried` gives the nostril the skin's own noseSneerLeft deltas, as attach_to_skin does.
 */
export function nostril(head: SynthHead, carried: boolean, swell = 0.003): void {
  const center: Vec3 = [0.012, 0, 0.06], face = mesh(head, 'face');
  const lift = (p: Vec3) => { const d = Math.hypot(p[0] - center[0], p[1] - center[1]) / 0.02; return d >= 1 ? 0 : swell * (1 - d * d * (3 - 2 * d)); };
  face.targets.push({ name: 'noseSneerLeft', positions: face.positions.map(p => [p[0], p[1], p[2] + lift(p)] as Vec3) });
  const ball = sphere(center, 0.003, 8, 12);
  head.meshes.push({
    name: 'nostril_L', material: 'nostril', ...ball, bones: ball.positions.map(() => 'head'),
    targets: carried ? [{ name: 'noseSneerLeft', positions: ball.positions.map(p => [p[0], p[1], p[2] + lift(p)] as Vec3) }] : [],
  });
  head.groups!.face.push('nostril_L');
  head.rootExtras = { arkitFace: { ...(head.rootExtras!.arkitFace as Record<string, unknown>), morphs: [...REQUIRED, 'noseSneerLeft'] } };
}

/** A static hair fringe lying on both eye masks whose lower edge sits `edge` above the eye centers. */
export function fringe(head: SynthHead, edge: number): void {
  const [, cy] = EYES.L;
  const hair = slab(16, 2, (u, v, layer) => [-0.06 + 0.12 * u, cy + edge + (0.025 - edge) * v, MASK_Z - 0.0002 + 0.002 * layer]);
  head.meshes.push({ name: 'hair', material: 'hair', ...hair, targets: [], bones: hair.positions.map(() => 'head') });
}

/**
 * The round-4 critic's pinhole: a 3 mm hole in the left eye mask 20 mm below the eye (1.7 eyeball radii), with the inside of the head
 * (a back face) behind it, beside an eye whose lids meet the skin all round.
 */
export function pinhole(head: SynthHead): void {
  const [cx, cy] = EYES.L, reach = 0.035, hole = { x: 0.0065, low: -0.006, high: 0.011 };
  const pin = { x0: cx - 0.0015, x1: cx + 0.0015, y0: cy - 0.022, y1: cy - 0.019 };
  const positions: Vec3[] = [], indices: number[] = [];
  const quad = (x0: number, x1: number, y0: number, y1: number) => {
    const base = positions.length;
    positions.push([x0, y0, MASK_Z], [x1, y0, MASK_Z], [x1, y1, MASK_Z], [x0, y1, MASK_Z]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // The eye mask as eyeMask builds it, with its bottom quad split round the pinhole.
  quad(cx - reach, cx + reach, cy + hole.high, cy + reach);
  quad(cx - reach, cx - hole.x, cy + hole.low, cy + hole.high); quad(cx + hole.x, cx + reach, cy + hole.low, cy + hole.high);
  quad(cx - reach, cx + reach, cy - reach, pin.y0); quad(cx - reach, cx + reach, pin.y1, cy + hole.low);
  quad(cx - reach, pin.x0, pin.y0, pin.y1); quad(pin.x1, cx + reach, pin.y0, pin.y1);
  const index = head.meshes.findIndex(m => m.name === 'eye_mask_L');
  head.meshes[index] = { ...head.meshes[index], positions, indices, bones: positions.map(() => 'head') };
  // The inside of the head behind it: a patch facing into the head, behind the eye's center.
  const inside = grid(1, 1, (u, v) => [cx - 0.004 + 0.008 * u, cy - 0.0245 + 0.008 * v, EYES.L[2] - 0.004], true);
  head.meshes.push({ name: 'head_inside', material: 'skin', ...inside, targets: [], bones: inside.positions.map(() => 'head') });
}

/** An ear sticking out of the skull's side, behind the eyes: its root sinks 2 mm in, or stands `gap` off the skull. */
export function ear(head: SynthHead, gap = 0): void {
  const e = slab(4, 4, (u, v, layer) => [0.078 + gap + 0.03 * u, -0.015 + 0.03 * v, -0.045 + 0.01 * layer]);
  head.meshes.push({ name: 'ear_L', material: 'ear', ...e, targets: [], bones: e.positions.map(() => 'head') });
}

/**
 * A nose ball (5 mm, half sunk in the face) that rides the skin's noseSneerLeft, with two nostril beads seated on its
 * lower slope, clear of the face itself: parts attached to an attached part (attach_to_skin(bead, ball)).
 * `gap` moves the beads out from the ball (1.2 mm beads: a gap over 1.2 mm leaves air between them).
 */
export function ballNose(head: SynthHead, gap = 0, swell = 0.003): void {
  const center: Vec3 = [0, 0, 0.06], face = mesh(head, 'face');
  const lift = (p: Vec3) => { const d = Math.hypot(p[0] - center[0], p[1] - center[1]) / 0.02; return d >= 1 ? 0 : swell * (1 - d * d * (3 - 2 * d)); };
  face.targets.push({ name: 'noseSneerLeft', positions: face.positions.map(p => [p[0], p[1], p[2] + lift(p)] as Vec3) });
  const ride = (points: Vec3[]) => [{ name: 'noseSneerLeft', positions: points.map(p => [p[0], p[1], p[2] + lift(p)] as Vec3) }];
  const ball = sphere(center, 0.005, 12, 16);
  head.meshes.push({ name: 'nose_ball', material: 'skin', ...ball, bones: ball.positions.map(() => 'head'), targets: ride(ball.positions) });
  head.groups!.face.push('nose_ball');
  for (const [side, x] of [['L', 0.45], ['R', -0.45]] as const) {
    const length = Math.hypot(x, 0.75, 0.5), direction: Vec3 = [x / length, -0.75 / length, 0.5 / length];
    // The bead is half sunk in the ball (plus `gap` out), so it touches the ball, not the face.
    const at = 0.005 + gap;
    const bead = sphere(add(center, [direction[0] * at, direction[1] * at, direction[2] * at]), 0.0012, 8, 12);
    head.meshes.push({ name: `nostril_${side}`, material: 'nostril', ...bead, bones: bead.positions.map(() => 'head'), targets: ride(bead.positions) });
    head.groups!.face.push(`nostril_${side}`);
  }
  head.rootExtras = { arkitFace: { ...(head.rootExtras!.arkitFace as Record<string, unknown>), morphs: [...REQUIRED, 'noseSneerLeft'] } };
}

/**
 * A heavy brow ridge lying along a skin dome (Mossjaw's brow): a 30 mm dome beside the head with a ridge wrapped 120
 * degrees round it, `lift` proud. The ridge's top lies farther out than its base, so at its ends the top reaches past
 * the base along the ridge's chord. `gap` lifts the whole ridge off the dome.
 */
export function domeRidge(head: SynthHead, lift = 0.006, gap = 0): void {
  const center: Vec3 = [0.16, 0.02, 0.035], radius = 0.03;
  const dome = sphere(center, radius, 16, 24);
  head.meshes.push({ name: 'dome', material: 'skin', ...dome, bones: dome.positions.map(() => 'head'), targets: [] });
  const at = (u: number, v: number, layer: number): Vec3 => {
    const yaw = (-60 + 120 * u) * Math.PI / 180, elevation = (20 + 16 * (v - 0.5)) * Math.PI / 180;
    const r = layer ? radius + gap + 0.0002 + lift * Math.sin(Math.PI * v) : radius + gap - 0.0003;
    return [center[0] + r * Math.cos(elevation) * Math.sin(yaw), center[1] + r * Math.sin(elevation), center[2] + r * Math.cos(elevation) * Math.cos(yaw)];
  };
  const ridge = slab(24, 6, at);
  head.meshes.push({ name: 'ridge', material: 'ridge', ...ridge, bones: ridge.positions.map(() => 'head'), targets: [] });
}

/** A horn at the outer end of the left brow: a 3 mm cone whose root sinks 1 mm into the eye mask, pointing out and up. */
export function horn(head: SynthHead, gap = 0): void {
  const root: Vec3 = [0.052, EYES.L[1] + 0.02, MASK_Z - 0.001 + gap], axis: Vec3 = [0.35, 0.45, 0.82];
  const length = Math.hypot(...axis), dir = axis.map(a => a / length) as Vec3;
  const u: Vec3 = [dir[2], 0, -dir[0]], ul = Math.hypot(...u), uu = u.map(a => a / ul) as Vec3;
  const w: Vec3 = [dir[1] * uu[2] - dir[2] * uu[1], dir[2] * uu[0] - dir[0] * uu[2], dir[0] * uu[1] - dir[1] * uu[0]];
  const positions: Vec3[] = [], indices: number[] = [], segments = 12, rings = 6;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, r = 0.003 * (1 - t) + 0.0003 * t, c = add(root, dir.map(a => a * 0.016 * t) as Vec3);
    for (let j = 0; j < segments; j++) {
      const a = 2 * Math.PI * j / segments;
      positions.push(add(c, [0, 1, 2].map(i => r * (Math.cos(a) * uu[i] + Math.sin(a) * w[i])) as Vec3));
    }
  }
  const tip = positions.length; positions.push(add(root, dir.map(a => a * 0.0165) as Vec3));
  const base = positions.length; positions.push(root);
  for (let k = 0; k < rings; k++) for (let j = 0; j < segments; j++) {
    const a = k * segments + j, b = k * segments + (j + 1) % segments;
    indices.push(a, b, b + segments, a, b + segments, a + segments);
  }
  for (let j = 0; j < segments; j++) {
    indices.push(rings * segments + j, rings * segments + (j + 1) % segments, tip);
    indices.push((j + 1) % segments, j, base);
  }
  head.meshes.push({ name: 'horn_L', material: 'horn', positions, indices, bones: positions.map(() => 'head'), targets: [] });
}
