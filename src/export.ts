import type { Project } from './core/types.ts';
import { Group, Matrix4, Scene, SkinnedMesh } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { validateBytes } from 'gltf-validator';
import type { ValidationReport } from 'gltf-validator';
import { validateProject } from './core/model.ts';
import { buildScene, disposeScene } from './render/scene.ts';
import { ensureFileReader } from './node-file-reader.ts';

export async function exportGLB(project: Project): Promise<Uint8Array> {
  const clean = validateProject(structuredClone(project));
  for (const bone of clean.bones) bone.pose = [0, 0, 0, 1];
  const built = buildScene(clean);
  const scene = new Scene(); scene.name = clean.name; scene.add(built.root);
  try {
    scene.updateMatrixWorld(true);
    const skins: SkinnedMesh[] = [];
    scene.traverse(object => { if (object instanceof SkinnedMesh) skins.push(object); });
    for (const mesh of skins) {
      // glTF skinning uses joint world transforms: bake each part's rest transform into
      // geometry and export its skin node at the scene root with identity transforms.
      mesh.geometry.applyMatrix4(mesh.matrixWorld);
      if (mesh.children.length) {
        // Keep the original local transform for descendants. An attachment group preserves
        // rotated children under nonuniform scaling, where Object3D.attach loses shear.
        const attachments = new Group();
        attachments.position.copy(mesh.position); attachments.quaternion.copy(mesh.quaternion); attachments.scale.copy(mesh.scale);
        mesh.parent!.add(attachments);
        attachments.add(...mesh.children.slice());
      }
      scene.add(mesh);
      mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1);
      mesh.updateMatrix(); mesh.bind(mesh.skeleton, new Matrix4());
      const indices = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
      for (let vertex = 0; vertex < indices.count; vertex++) {
        for (let influence = 0; influence < 4; influence++) {
          if (weights.getComponent(vertex, influence) === 0) indices.setComponent(vertex, influence, 0);
        }
      }
    }
    scene.updateMatrixWorld(true);
    ensureFileReader();
    const output = await new GLTFExporter().parseAsync(scene, { binary: true, animations: built.clips });
    if (!(output instanceof ArrayBuffer)) throw new Error('Exporter did not produce a binary GLB');
    return new Uint8Array(output);
  } finally { built.dispose(); disposeScene(scene); }
}

export type GLBVerification = ValidationReport & { ok: boolean; errors: number; warnings: number };
export async function verifyGLB(bytes: Uint8Array): Promise<GLBVerification> {
  const report = await validateBytes(bytes, { format: 'glb', uri: 'model.glb', writeTimestamp: false, maxIssues: 0 });
  return { ...report, ok: report.issues.numErrors === 0, errors: report.issues.numErrors, warnings: report.issues.numWarnings };
}
