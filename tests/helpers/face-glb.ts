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

function grid(columns: number, rows: number, at: (u: number, v: number) => Vec3): { positions: Vec3[]; indices: number[] } {
  const positions: Vec3[] = [], indices: number[] = [];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) positions.push(at(j / columns, i / rows));
  const index = (i: number, j: number) => i * (columns + 1) + j;
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) indices.push(index(i, j), index(i, j + 1), index(i + 1, j + 1), index(i, j), index(i + 1, j + 1), index(i + 1, j));
  return { positions, indices };
}

function box(center: Vec3, size: Vec3) {
  return grid(1, 1, (u, v) => add(center, [(u - 0.5) * size[0], (v - 0.5) * size[1], size[2] / 2]));
}

/** Lid patch on a sphere around the eye, turned about the eye's X axis for each morph. */
function lids(side: 'L' | 'R', radius: number, sweeps = { blink: -30, squint: -10, wide: 5 }): SynthMesh {
  const center = EYES[side], suffix = side === 'L' ? 'Left' : 'Right';
  const at = (yaw: number, elevation: number): Vec3 => {
    const y = yaw * Math.PI / 180, e = elevation * Math.PI / 180;
    return add(center, [radius * Math.cos(e) * Math.sin(y), radius * Math.sin(e), radius * Math.cos(e) * Math.cos(y)]);
  };
  const upper = grid(4, 3, (u, v) => at(-40 + 80 * u, 70 - 30 * v));
  const turn = (degrees: number) => upper.positions.map(p => rotateX(p, center, -degrees));
  return {
    name: `lids_${side}`, material: 'lid', positions: upper.positions, indices: upper.indices,
    targets: [
      { name: `eyeBlink${suffix}`, positions: turn(sweeps.blink) },
      { name: `eyeSquint${suffix}`, positions: turn(sweeps.squint) },
      { name: `eyeWide${suffix}`, positions: turn(sweeps.wide) },
    ],
    bones: upper.positions.map(() => 'head'),
  };
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
      faceMesh, eye('L'), eye('R'), lids('L', 0.015), lids('R', 0.015),
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
    gaze: { yawMax: 25, pitchMax: 18 }, lidFollow: { down: 0.35, up: 0.25 },
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
    materials: materials.map(name => ({ name, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.5 } })),
    accessors, bufferViews, buffers: [{ byteLength: binary.length + ((4 - binary.length % 4) % 4) }],
  };
  let json = Buffer.from(JSON.stringify(document));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (data: Buffer, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]); };
  return new Uint8Array(Buffer.concat([header, chunk(json, 'JSON'), chunk(bin, 'BIN\0')]));
}
