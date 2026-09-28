/**
 * A synthetic dressed figure encoded to GLB in Node, whose garment intrusions are known.
 * glTF coordinates: Y up, meters, the figure faces +Z. A `thigh` bone pivots at y = 1 under a
 * `pelvis` bone and flexes forward in the `jog` clip, peaking at mid-clip.
 */
import { AnimationClip, Bone, BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, PlaneGeometry, Quaternion, SphereGeometry, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
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
}

export async function dressedGLB(options: DressedOptions = {}): Promise<Uint8Array> {
  ensureFileReader();
  const { flex = 80, belt = [1.01, 1.06], fold = false, sheet = false, beads = false } = options;
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
