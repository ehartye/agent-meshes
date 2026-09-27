/**
 * Synthetic helmets for the enclosure verifier: a glass bubble around a head, encoded to GLB with three's
 * GLTFExporter, optionally with a clip that moves the head and a morph target that swells it.
 * glTF coordinates: Y up, meters.
 */
import { AnimationClip, Bone, Float32BufferAttribute, Mesh, MeshStandardMaterial, Scene, Skeleton, SkinnedMesh, SphereGeometry, Uint16BufferAttribute, VectorKeyframeTrack } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ensureFileReader } from '../../src/node-file-reader.ts';

export interface SynthHelmet {
  bubble?: number; head?: number; headAt?: [number, number, number];
  /** Extra parts inside (or poking out of) the bubble, as small spheres. */
  extras?: { name: string; radius: number; at: [number, number, number] }[];
  encloses?: Record<string, unknown> | null;
  /** A clip named `bob` that moves the head bone by this offset at its midpoint (1 s long). */
  clipOffset?: [number, number, number];
  /** A morph target named `swell` that scales the head by this factor. */
  swell?: number;
}

export async function helmetGLB(options: SynthHelmet = {}): Promise<Uint8Array> {
  const { bubble = 0.2, head = 0.1, headAt = [0, 0, 0], extras = [], clipOffset, swell } = options;
  const encloses = options.encloses === undefined ? { parts: ['head', ...extras.map(e => e.name)], clearance: 0.015 } : options.encloses;
  const scene = new Scene();
  const glass = new Mesh(new SphereGeometry(bubble, 48, 32), new MeshStandardMaterial({ color: '#dff4ff', transparent: true, opacity: 0.2 }));
  glass.name = 'bubble';
  if (encloses) glass.userData = { encloses };
  scene.add(glass);
  const bone = new Bone(); bone.name = 'neck'; scene.add(bone);
  const geometry = new SphereGeometry(head, 32, 24); geometry.translate(...headAt);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
  if (swell !== undefined) {
    const position = geometry.getAttribute('position'), swollen: number[] = [];
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) swollen.push(headAt[k] + (position.getComponent(i, k) - headAt[k]) * swell);
    geometry.morphAttributes.position = [new Float32BufferAttribute(swollen, 3)];
  }
  const skinned = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: '#c08060' }));
  skinned.name = 'head';
  if (swell !== undefined) { skinned.updateMorphTargets(); skinned.morphTargetDictionary = { swell: 0 }; }
  scene.add(skinned);
  scene.updateMatrixWorld(true);
  skinned.bind(new Skeleton([bone]));
  for (const extra of extras) {
    const part = new Mesh(new SphereGeometry(extra.radius, 16, 12), new MeshStandardMaterial({ color: '#c08060' }));
    part.name = extra.name; part.position.set(...extra.at); bone.add(part);
  }
  scene.updateMatrixWorld(true);
  const clips = clipOffset ? [new AnimationClip('bob', 1, [new VectorKeyframeTrack('neck.position', [0, 0.5, 1], [0, 0, 0, ...clipOffset, 0, 0, 0])])] : [];
  ensureFileReader();
  const output = await new GLTFExporter().parseAsync(scene, { binary: true, animations: clips });
  if (!(output instanceof ArrayBuffer)) throw new Error('Exporter did not produce a binary GLB');
  return new Uint8Array(output);
}
