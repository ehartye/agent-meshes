import { ARKIT_FACE_REQUIRED_BONES, ARKIT_FACE_REQUIRED_MORPHS } from '../../src/arkit-face.ts';

/**
 * A tiny skinned sphere "head" with named morph targets, written as raw glTF so tests
 * need neither Blender nor a browser. The first bone is the root; the others are its
 * children placed where eyes would sit. Every morph pushes its own band of vertices
 * outward by 2 mm, so none is a dead shape.
 */
export function arkitFaceFixtureGLB(options: { morphs?: readonly string[]; bones?: readonly string[] } = {}): Uint8Array {
  const morphs = options.morphs ?? ARKIT_FACE_REQUIRED_MORPHS;
  const bones = options.bones ?? ARKIT_FACE_REQUIRED_BONES;
  const radius = .1, rings = 10, segments = 16;
  const positions: number[][] = [], normals: number[][] = [], indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= segments; s++) {
      const theta = 2 * Math.PI * s / segments;
      const n = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)];
      normals.push(n); positions.push(n.map(v => v * radius));
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * row + s, b = a + row;
    if (r > 0) indices.push(a, b, a + 1);
    if (r < rings - 1) indices.push(a + 1, b, b + 1);
  }
  const eyeOffsets = [[0, 0, 0], [.035, .03, .08], [-.035, .03, .08]];
  const offset = (i: number) => i === 0 ? [0, 0, 0] : eyeOffsets[1 + ((i - 1) % 2)];
  const joints = positions.map(([x, y, z]) => {
    const eye = bones.length > 1 && y > .01 && z > .06 ? (x > .02 ? 1 : x < -.02 && bones.length > 2 ? 2 : 0) : 0;
    return [eye, 0, 0, 0];
  });
  const weights = joints.map(() => [1, 0, 0, 0]);
  const targets = morphs.map((_, m) => positions.map((_, v) => {
    const band = Math.floor(v / row) === 1 + m % (rings - 1) && (v % row) % 3 === m % 3; // skip the unused pole rows
    return band ? normals[v].map(c => c * .002) : [0, 0, 0];
  }));

  const chunks: Uint8Array[] = []; const bufferViews: object[] = []; const accessors: object[] = [];
  let byteLength = 0;
  const add = (bytes: Uint8Array, accessor: Record<string, unknown>, target?: number) => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    chunks.push(bytes); byteLength += bytes.byteLength;
    const pad = (4 - byteLength % 4) % 4; if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const vec3 = (rows: number[][], bounds: boolean) => add(new Uint8Array(new Float32Array(rows.flat()).buffer), {
    componentType: 5126, count: rows.length, type: 'VEC3',
    ...(bounds ? { min: [0, 1, 2].map(i => Math.min(...rows.map(r => Math.fround(r[i])))), max: [0, 1, 2].map(i => Math.max(...rows.map(r => Math.fround(r[i])))) } : {}),
  }, 34962);
  const POSITION = vec3(positions, true), NORMAL = vec3(normals, false);
  const JOINTS_0 = add(new Uint8Array(joints.flat()), { componentType: 5121, count: joints.length, type: 'VEC4' }, 34962);
  const WEIGHTS_0 = add(new Uint8Array(new Float32Array(weights.flat()).buffer), { componentType: 5126, count: weights.length, type: 'VEC4' }, 34962);
  const index = add(new Uint8Array(new Uint16Array(indices).buffer), { componentType: 5123, count: indices.length, type: 'SCALAR' }, 34963);
  const targetAccessors = targets.map(rows => ({ POSITION: vec3(rows, true) }));
  const inverseBind = bones.map((_, i) => { const [x, y, z] = offset(i); return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]; });
  const ibm = add(new Uint8Array(new Float32Array(inverseBind.flat()).buffer), { componentType: 5126, count: bones.length, type: 'MAT4' });

  const nodes: Record<string, unknown>[] = bones.map((name, i) => ({ name, ...(i ? { translation: offset(i) } : {}) }));
  nodes[0].children = bones.slice(1).map((_, i) => i + 1);
  nodes.push({ name: 'Face', mesh: 0, skin: 0 });
  const json = {
    asset: { version: '2.0', generator: 'agent-meshes test fixture' },
    scene: 0, scenes: [{ nodes: [0, bones.length] }], nodes,
    skins: [{ joints: bones.map((_, i) => i), skeleton: 0, inverseBindMatrices: ibm }],
    materials: [{ name: 'Skin', pbrMetallicRoughness: { baseColorFactor: [.8, .6, .5, 1], metallicFactor: 0, roughnessFactor: .6 } }],
    meshes: [{
      name: 'Face', weights: morphs.map(() => 0), extras: { targetNames: [...morphs] },
      primitives: [{ attributes: { POSITION, NORMAL, JOINTS_0, WEIGHTS_0 }, indices: index, material: 0, targets: targetAccessors }],
    }],
    accessors, bufferViews, buffers: [{ byteLength }],
  };
  let text = JSON.stringify(json); while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + byteLength;
  const out = new Uint8Array(total); const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true); view.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  let at = 20 + jsonBytes.byteLength;
  view.setUint32(at, byteLength, true); view.setUint32(at + 4, 0x004e4942, true); at += 8;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
