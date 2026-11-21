/**
 * A synthetic binary FBX 7.4 shaped like an Adobe Mixamo download, built in memory so no Mixamo file is ever
 * committed. It has a Mixamo-named skeleton (`mixamorig:Hips` ... toes) in centimetres, Y up, facing +Z, and one
 * animation take whose hips move `travel` metres along +Z while bobbing, with the legs and arms swinging. Options add a
 * skinned mesh and a one-frame rest take before the motion take, as "with skin" downloads have. Output is
 * deterministic: the same options give the same bytes. Both `scripts/mixamo-library.mjs` and three's `FBXLoader` read it.
 */

export interface AnimatedFbxOptions {
  /** Length of the motion take in seconds (default 2). */
  seconds?: number;
  /** Keys per second (default 30). */
  fps?: number;
  /** Metres the hips move along +Z over the take (default 0). */
  travel?: number;
  /** Amplitude in metres of the hips' vertical sway (default 0.02). */
  bob?: number;
  /** Add a mesh skinned to the hips (default false). */
  mesh?: boolean;
  /** Bone-name prefix before the colon (default 'mixamorig'); '' gives bare names such as `Hips`. */
  prefix?: string;
  /** Name of the motion take (default 'mixamo.com'). */
  takeName?: string;
  /** Also add a one-frame rest take before the motion take (default false). */
  restTake?: boolean;
}

/** Mixamo's bone names without the prefix, each after its parent. */
export const MIXAMO_BONES: string[] = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

/** Parent and local translation (cm) of each bone; the hips stand 100 cm up. */
const RIG: Record<string, [string | null, [number, number, number]]> = {
  Hips: [null, [0, 100, 0]], Spine: ['Hips', [0, 10, 0]], Spine1: ['Spine', [0, 12, 0]], Spine2: ['Spine1', [0, 13, 0]],
  Neck: ['Spine2', [0, 15, 0]], Head: ['Neck', [0, 10, 0]],
  LeftShoulder: ['Spine2', [6, 10, 0]], LeftArm: ['LeftShoulder', [12, 0, 0]], LeftForeArm: ['LeftArm', [27, 0, 0]], LeftHand: ['LeftForeArm', [25, 0, 0]],
  RightShoulder: ['Spine2', [-6, 10, 0]], RightArm: ['RightShoulder', [-12, 0, 0]], RightForeArm: ['RightArm', [-27, 0, 0]], RightHand: ['RightForeArm', [-25, 0, 0]],
  LeftUpLeg: ['Hips', [9, -6, 0]], LeftLeg: ['LeftUpLeg', [0, -42, 0]], LeftFoot: ['LeftLeg', [0, -40, 0]], LeftToeBase: ['LeftFoot', [0, -7, 12]],
  RightUpLeg: ['Hips', [-9, -6, 0]], RightLeg: ['RightUpLeg', [0, -42, 0]], RightFoot: ['RightLeg', [0, -40, 0]], RightToeBase: ['RightFoot', [0, -7, 12]],
};
/** Limbs that swing (degrees about X), with their phase: legs and arms in opposition. */
const SWINGS: [string, number][] = [['LeftUpLeg', 0], ['RightUpLeg', Math.PI], ['LeftArm', Math.PI], ['RightArm', 0]];
const KTIME_PER_SECOND = 46186158000n;

type Value =
  | { t: 'S'; v: string } | { t: 'L'; v: bigint } | { t: 'I'; v: number } | { t: 'D'; v: number } | { t: 'C'; v: boolean }
  | { t: 'f' | 'd' | 'i'; v: number[] } | { t: 'l'; v: bigint[] };
type Node = { name: string; props?: (Value | string | bigint)[]; children?: Node[] };
const I = (v: number): Value => ({ t: 'I', v }), D = (v: number): Value => ({ t: 'D', v });
const arr = (t: 'f' | 'd' | 'i', v: number[]): Value => ({ t, v });
const P = (name: string, type: string, label: string, flags: string, ...values: (Value | string | bigint)[]): Node => ({ name: 'P', props: [name, type, label, flags, ...values] });
const name2 = (title: string, kind: string) => `${title}\u0000\u0001${kind}`;

function encodeValue(raw: Value | string | bigint): Buffer {
  const value: Value = typeof raw === 'string' ? { t: 'S', v: raw } : typeof raw === 'bigint' ? { t: 'L', v: raw } : raw;
  switch (value.t) {
    case 'S': { const text = Buffer.from(value.v, 'utf8'), head = Buffer.alloc(5); head.write('S'); head.writeUInt32LE(text.length, 1); return Buffer.concat([head, text]); }
    case 'L': { const out = Buffer.alloc(9); out.write('L'); out.writeBigInt64LE(value.v, 1); return out; }
    case 'I': { const out = Buffer.alloc(5); out.write('I'); out.writeInt32LE(value.v, 1); return out; }
    case 'D': { const out = Buffer.alloc(9); out.write('D'); out.writeDoubleLE(value.v, 1); return out; }
    case 'C': { const out = Buffer.alloc(2); out.write('C'); out[1] = value.v ? 1 : 0; return out; }
    default: {
      // Arrays are stored uncompressed (encoding 0).
      const size = value.t === 'd' || value.t === 'l' ? 8 : 4, data = Buffer.alloc(value.v.length * size);
      value.v.forEach((item: number | bigint, i: number) => {
        if (value.t === 'f') data.writeFloatLE(item as number, i * 4);
        else if (value.t === 'd') data.writeDoubleLE(item as number, i * 8);
        else if (value.t === 'i') data.writeInt32LE(item as number, i * 4);
        else data.writeBigInt64LE(item as bigint, i * 8);
      });
      const head = Buffer.alloc(13); head.write(value.t); head.writeUInt32LE(value.v.length, 1); head.writeUInt32LE(0, 5); head.writeUInt32LE(data.length, 9);
      return Buffer.concat([head, data]);
    }
  }
}

function encodeNode(node: Node, offset: number): Buffer {
  const props = Buffer.concat((node.props ?? []).map(encodeValue)), name = Buffer.from(node.name, 'latin1');
  const head = Buffer.alloc(13); let at = offset + 13 + name.length + props.length; const children: Buffer[] = [];
  for (const child of node.children ?? []) { const bytes = encodeNode(child, at); children.push(bytes); at += bytes.length; }
  if (node.children) { children.push(Buffer.alloc(13)); at += 13; }
  head.writeUInt32LE(at, 0); head.writeUInt32LE((node.props ?? []).length, 4); head.writeUInt32LE(props.length, 8); head[12] = name.length;
  return Buffer.concat([head, name, props, ...children]);
}

function encodeFile(nodes: Node[]): Buffer {
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  ', 'latin1'); header[21] = 0x1a; header.writeUInt32LE(7400, 23);
  const parts: Buffer[] = [header]; let at = 27;
  for (const node of nodes) { const bytes = encodeNode(node, at); parts.push(bytes); at += bytes.length; }
  parts.push(Buffer.alloc(13)); at += 13;
  // The footer: an id, padding to a 16-byte boundary, the version, zeros and the closing magic.
  const id = Buffer.from([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
  at += id.length;
  const pad = Buffer.alloc(16 - (at % 16) || 16), tail = Buffer.alloc(144);
  tail.writeUInt32LE(7400, 4);
  Buffer.from([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]).copy(tail, 128);
  return Buffer.concat([...parts, id, pad, tail]);
}

/** A binary FBX 7.4 Mixamo-like download. See the file comment. */
export function animatedFbx(options: AnimatedFbxOptions = {}): Buffer {
  const { seconds = 2, fps = 30, travel = 0, bob = 0.02, mesh = false, prefix = 'mixamorig', takeName = 'mixamo.com', restTake = false } = options;
  let next = 1000n; const newId = () => next++;
  const objects: Node[] = [], links: Node[] = [];
  const OO = (child: bigint, parent: bigint) => links.push({ name: 'C', props: ['OO', child, parent] });
  const OP = (child: bigint, parent: bigint, property: string) => links.push({ name: 'C', props: ['OP', child, parent, property] });
  const boneName = (bone: string) => prefix ? `${prefix}:${bone}` : bone;

  const modelIds = new Map<string, bigint>();
  for (const bone of MIXAMO_BONES) {
    const [parent, [x, y, z]] = RIG[bone], id = newId(), attr = newId();
    modelIds.set(bone, id);
    objects.push({ name: 'NodeAttribute', props: [attr, name2(boneName(bone), 'NodeAttribute'), 'LimbNode'], children: [
      { name: 'Properties70', children: [P('Size', 'double', 'Number', '', D(33))] }, { name: 'TypeFlags', props: ['Skeleton'] }] });
    objects.push({ name: 'Model', props: [id, name2(boneName(bone), 'Model'), 'LimbNode'], children: [
      { name: 'Version', props: [I(232)] },
      { name: 'Properties70', children: [P('InheritType', 'enum', '', '', I(1)), P('Lcl Translation', 'Lcl Translation', '', 'A', D(x), D(y), D(z))] },
      { name: 'Shading', props: [{ t: 'C', v: true }] }, { name: 'Culling', props: ['CullingOff'] }] });
    OO(attr, id); OO(id, parent ? modelIds.get(parent)! : 0n);
  }

  if (mesh) {
    // A 20 x 160 x 20 cm box skinned wholly to the hips.
    const model = newId(), geometry = newId(), skin = newId(), cluster = newId();
    const vertices: number[] = [];
    for (const vx of [-10, 10]) for (const vy of [0, 160]) for (const vz of [-10, 10]) vertices.push(vx, vy, vz);
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    const polygons = quads.flatMap(quad => [quad[0], quad[1], quad[2], -quad[3] - 1]);
    objects.push({ name: 'Geometry', props: [geometry, name2('Body', 'Geometry'), 'Mesh'], children: [
      { name: 'Vertices', props: [arr('d', vertices)] }, { name: 'PolygonVertexIndex', props: [arr('i', polygons)] }, { name: 'GeometryVersion', props: [I(124)] }] });
    objects.push({ name: 'Model', props: [model, name2('Body', 'Model'), 'Mesh'], children: [
      { name: 'Version', props: [I(232)] }, { name: 'Properties70', children: [P('Lcl Translation', 'Lcl Translation', '', 'A', D(0), D(0), D(0))] }] });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], hips = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 100, 0, 1];
    objects.push({ name: 'Deformer', props: [skin, name2('Body', 'Deformer'), 'Skin'], children: [{ name: 'Version', props: [I(101)] }, { name: 'Link_DeformAcuracy', props: [D(50)] }] });
    objects.push({ name: 'Deformer', props: [cluster, name2(boneName('Hips'), 'SubDeformer'), 'Cluster'], children: [
      { name: 'Version', props: [I(100)] }, { name: 'Indexes', props: [arr('i', [0, 1, 2, 3, 4, 5, 6, 7])] }, { name: 'Weights', props: [arr('d', [1, 1, 1, 1, 1, 1, 1, 1])] },
      { name: 'Transform', props: [arr('d', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -100, 0, 1])] }, { name: 'TransformLink', props: [arr('d', hips)] },
      { name: 'TransformAssociateModel', props: [arr('d', identity)] }] });
    OO(model, 0n); OO(geometry, model); OO(skin, geometry); OO(cluster, skin); OO(modelIds.get('Hips')!, cluster);
  }

  const take = (title: string, frames: number, sample: (t: number) => { hips: [number, number, number]; swing: number }) => {
    const stack = newId(), layer = newId(), stop = BigInt(frames) * KTIME_PER_SECOND / BigInt(fps);
    objects.push({ name: 'AnimationStack', props: [stack, name2(title, 'AnimStack'), ''], children: [{ name: 'Properties70', children: [
      P('LocalStart', 'KTime', 'Time', '', 0n), P('LocalStop', 'KTime', 'Time', '', stop), P('ReferenceStart', 'KTime', 'Time', '', 0n), P('ReferenceStop', 'KTime', 'Time', '', stop)] }] });
    objects.push({ name: 'AnimationLayer', props: [layer, name2('BaseLayer', 'AnimLayer'), ''], children: [] });
    OO(layer, stack);
    const times: bigint[] = [], samples = [] as ReturnType<typeof sample>[];
    for (let frame = 0; frame <= frames; frame++) { times.push(BigInt(frame) * KTIME_PER_SECOND / BigInt(fps)); samples.push(sample(frame / fps)); }
    const curveNode = (target: bigint, kind: 'T' | 'R', axes: number[][]) => {
      const node = newId();
      objects.push({ name: 'AnimationCurveNode', props: [node, name2(kind, 'AnimCurveNode'), ''], children: [{ name: 'Properties70', children:
        ['X', 'Y', 'Z'].map((axis, i) => P(`d|${axis}`, 'Number', '', 'A', D(axes[i][0]))) }] });
      OO(node, layer); OP(node, target, kind === 'T' ? 'Lcl Translation' : 'Lcl Rotation');
      ['X', 'Y', 'Z'].forEach((axis, i) => {
        const curve = newId();
        objects.push({ name: 'AnimationCurve', props: [curve, name2('', 'AnimCurve'), ''], children: [
          { name: 'Default', props: [D(axes[i][0])] }, { name: 'KeyVer', props: [I(4009)] },
          { name: 'KeyTime', props: [{ t: 'l', v: times }] }, { name: 'KeyValueFloat', props: [arr('f', axes[i])] },
          { name: 'KeyAttrFlags', props: [arr('i', [24840])] }, { name: 'KeyAttrDataFloat', props: [arr('f', [0, 0, 0, 0])] },
          { name: 'KeyAttrRefCount', props: [arr('i', [times.length])] }] });
        OP(curve, node, `d|${axis}`);
      });
    };
    curveNode(modelIds.get('Hips')!, 'T', [0, 1, 2].map(axis => samples.map(item => item.hips[axis])));
    for (const [bone, phase] of SWINGS) {
      const swing = samples.map(item => Math.round(item.swing * Math.cos(phase) * 1000) / 1000);
      curveNode(modelIds.get(bone)!, 'R', [swing, swing.map(() => 0), swing.map(() => 0)]);
    }
  };
  const rest = () => ({ hips: [0, 100, 0] as [number, number, number], swing: 0 });
  if (restTake) take('Take 001', 1, rest);
  const frames = Math.max(1, Math.round(seconds * fps));
  take(takeName, frames, t => {
    const phase = 2 * Math.PI * t / (frames / fps);
    return { hips: [0, 100 + bob * 100 * Math.sin(2 * phase), travel * 100 * t / (frames / fps)], swing: 25 * Math.sin(phase) };
  });

  return encodeFile([
    { name: 'FBXHeaderExtension', children: [{ name: 'FBXHeaderVersion', props: [I(1003)] }, { name: 'FBXVersion', props: [I(7400)] }, { name: 'Creator', props: ['FBX SDK/FBX Plugins version 2020.2'] }] },
    { name: 'GlobalSettings', children: [{ name: 'Version', props: [I(1000)] }, { name: 'Properties70', children: [
      P('UpAxis', 'int', 'Integer', '', I(1)), P('UpAxisSign', 'int', 'Integer', '', I(1)), P('FrontAxis', 'int', 'Integer', '', I(2)), P('FrontAxisSign', 'int', 'Integer', '', I(1)),
      P('CoordAxis', 'int', 'Integer', '', I(0)), P('CoordAxisSign', 'int', 'Integer', '', I(1)), P('UnitScaleFactor', 'double', 'Number', '', D(1)),
      P('TimeMode', 'enum', '', '', I(6))] }] },
    { name: 'Objects', children: objects },
    { name: 'Connections', children: links },
  ]);
}
