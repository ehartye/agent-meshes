/**
 * A synthetic dressed figure encoded to GLB in Node, whose garment intrusions are known.
 * glTF coordinates: Y up, meters, the figure faces +Z. A `thigh` bone pivots at y = 1 under a
 * `pelvis` bone and flexes forward in the `jog` clip, peaking at mid-clip.
 */
import { AnimationClip, Bone, BoxGeometry, BufferGeometry, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, PlaneGeometry, Quaternion, SphereGeometry, QuaternionKeyframeTrack, Scene, Skeleton, Shape, SkinnedMesh, Uint16BufferAttribute, Vector2, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ensureFileReader } from '../../src/node-file-reader.ts';

export interface DressedOptions {
  /** Peak forward thigh flexion, degrees. */
  flex?: number;
  /** Bottom and top of the belt plate worn on the pelvis; its back face is embedded in the leg at rest. */
  belt?: [number, number];
  /** Add a tall garment whose lower half follows the thigh, so a deep flex folds it into itself. */
  fold?: boolean;
  /** Add an open (non-closed) sheet that cannot contain anything. */
  sheet?: boolean;
  /** Add one part of small separate beads (like boot eyelets) riding the thigh, which never fold. */
  beads?: boolean;
  /** Add a closed garment of two prongs a centimetre apart, joined at the top; the back prong swings into the front one. */
  prongs?: boolean;
  /** Add a thin flap hinged at the pivot, which a flex past 180 degrees folds shut on itself. */
  flap?: boolean;
  /** Add a closed boot shaft of this radius round the leg's lower end, riding the thigh with it. */
  shaft?: number;
}

export async function dressedGLB(options: DressedOptions = {}): Promise<Uint8Array> {
  ensureFileReader();
  const { flex = 80, belt = [1.01, 1.06], fold = false, sheet = false, beads = false, prongs = false, flap = false, shaft } = options;
  const root = new Bone(); root.name = 'root';
  const pelvis = new Bone(); pelvis.name = 'pelvis'; pelvis.position.set(0, 1, 0); root.add(pelvis);
  const thigh = new Bone(); thigh.name = 'thigh'; pelvis.add(thigh);
  const bones = [root, pelvis, thigh];
  const scene = new Scene(), rig = new Group(); rig.name = 'figure'; scene.add(rig); rig.add(root);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones), material = new MeshStandardMaterial();
  const skinned = (name: string, source: BufferGeometry, weight: (p: Vector3) => number) => {
    // Weld the box's split faces so every part is one closed surface, as Blender exports it.
    const geometry = mergeVertices(source.deleteAttribute('normal').deleteAttribute('uv'));
    const position = geometry.attributes.position, count = position.count, index: number[] = [], weights: number[] = [];
    for (let i = 0; i < count; i++) {
      const w = weight(new Vector3().fromBufferAttribute(position, i));
      index.push(1, 2, 0, 0); weights.push(1 - w, w, 0, 0);
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
    geometry.computeVertexNormals();
    const mesh = new SkinnedMesh(geometry, material); mesh.name = name; rig.add(mesh); mesh.bind(skeleton, new Matrix4());
  };
  skinned('layer-bottom', new BoxGeometry(0.2, 0.52, 0.2, 2, 8, 2).translate(0, 0.76, 0), () => 1);
  skinned('layer-belt', new BoxGeometry(0.2, belt[1] - belt[0], 0.05, 2, 2, 1).translate(0, (belt[0] + belt[1]) / 2, 0.105), () => 0);
  if (fold) skinned('layer-apron', new BoxGeometry(0.2, 1, 0.4, 2, 20, 2).translate(1, 1, 0), p => (p.y < 1 ? 1 : 0));
  if (beads) {
    const pieces = [0, 1, 2, 3].map(k => new SphereGeometry(0.0055, 32, 24).translate(-0.02 + k * 0.015, 0.6, 0.11));
    skinned('boot-eyelets', mergeGeometries(pieces.map(g => g.deleteAttribute('normal').deleteAttribute('uv'))), () => 1);
  }
  // The leg box's faces sit 0.1 m off its axis and its corners 0.141 m: a narrower shaft crosses it.
  if (shaft) skinned('left-boot-shaft', new CylinderGeometry(shaft, shaft, 0.25, 32, 4).translate(0, 0.575, 0), () => 1);
  // A 1 cm flap hinged across the thigh's pivot: its front half rides the thigh and a flex past 180
  // degrees shuts it like a book, pressing the halves into each other right at the hinge.
  if (flap) skinned('layer-flap', new BoxGeometry(0.2, 0.01, 0.2, 4, 1, 40).translate(-1, 1, 0), p => Math.min(1, Math.max(0, p.z / 0.01)));
  if (prongs) {
    // Prongs 4 cm thick from y 0.7 to 1, 1 cm apart along Z, bridged above: their facing sides are
    // near in space but far along the cloth, so a prong pressed into the other is a shallow intrusion.
    const outline = [[-0.045, 0.7], [-0.005, 0.7], [-0.005, 0.8], [-0.005, 1], [0.005, 1], [0.005, 0.8], [0.005, 0.7], [0.045, 0.7], [0.045, 1.04], [-0.045, 1.04], [-0.045, 0.8]];
    const shape = new Shape(outline.map(([u, v]) => new Vector2(u, v)));
    const geometry = new ExtrudeGeometry(shape, { depth: 0.1, steps: 4, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(-0.95, 0, 0);
    skinned('layer-prongs', geometry, p => (p.z < 0 ? Math.min(1, Math.max(0, (0.98 - p.y) / 0.18)) : 0));
  }
  if (sheet) {
    const plane = new PlaneGeometry(0.3, 0.3).translate(-1, 1, 0.3);
    const mesh = new SkinnedMesh(plane, material); mesh.name = 'hair-card';
    plane.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(plane.attributes.position.count * 4).fill(0), 4));
    plane.setAttribute('skinWeight', new Float32BufferAttribute(new Array(plane.attributes.position.count).fill([1, 0, 0, 0]).flat(), 4));
    rig.add(mesh); mesh.bind(skeleton, new Matrix4());
  }
  const times: number[] = [], values: number[] = [], frames = 24;
  for (let frame = 0; frame <= frames; frame++) {
    const phase = frame / frames; times.push(phase);
    // Forward flexion swings the thigh's lower end toward +Z: a negative turn about +X.
    values.push(...new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.sin(Math.PI * phase) * flex * Math.PI / 180).toArray());
  }
  const clip = new AnimationClip('jog', 1, [new QuaternionKeyframeTrack('thigh.quaternion', times, values)]);
  const output = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] });
  if (!(output instanceof ArrayBuffer)) throw new Error('Exporter did not produce a binary GLB');
  return new Uint8Array(output);
}
