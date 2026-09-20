import type { Project } from './core/types.ts';
import { Bone, Group, Matrix4, Object3D, Scene, Skeleton, SkinnedMesh } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { validateBytes } from 'gltf-validator';
import type { ValidationReport } from 'gltf-validator';
import { validateProject } from './core/model.ts';
import { buildScene, disposeScene } from './render/scene.ts';
import { ensureFileReader } from './node-file-reader.ts';

/** The parts of three's GLTFWriter that its type declaration leaves out but plugins may reach. */
interface GLTFWriterInternals {
  json: { nodes: { skin?: number }[] };
  nodeMap: Map<Object3D, number>;
  processSkin(object: SkinnedMesh): number | null;
}

export async function exportGLB(project: Project): Promise<Uint8Array> {
  const clean = validateProject(structuredClone(project));
  for (const bone of clean.bones) bone.pose = [0, 0, 0, 1];
  const built = buildScene(clean);
  const scene = new Scene(); scene.name = clean.name; scene.add(built.root);
  try {
    // glTF skins need one common skeleton root. A project may have several root bones (a chair
    // whose every rod has its own bone), so gather them under one identity bone for the export.
    const rootBones = [...built.bones.values()].filter(bone => !(bone.parent instanceof Bone));
    if (rootBones.length > 1) {
      const taken = new Set([...clean.bones.map(b => b.name), ...clean.parts.map(p => p.name)]);
      let name = 'rig'; for (let i = 2; taken.has(name); i++) name = `rig_${i}`;
      const common = new Bone(); common.name = name; built.root.add(common);
      for (const bone of rootBones) common.attach(bone);
      // GLTFExporter uses joint 0 as the skeleton root, so the common bone must lead every skin.
      built.root.updateMatrixWorld(true);
      const skeleton = new Skeleton([common, ...built.skeleton.bones]);
      built.root.traverse(object => {
        if (!(object instanceof SkinnedMesh)) return;
        const indices = object.geometry.getAttribute('skinIndex');
        for (let vertex = 0; vertex < indices.count; vertex++) for (let influence = 0; influence < 4; influence++) indices.setComponent(vertex, influence, indices.getComponent(vertex, influence) + 1);
        object.bind(skeleton, object.matrixWorld);
      });
    }
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
    const exporter = new GLTFExporter();
    exporter.register(plugin => {
      // GLTFExporter writes one skin per skinned mesh, each with an inverse bind matrix for every
      // joint. Every part here binds the same skeleton at identity, so a rig of a hundred rods would
      // repeat the same block a hundred times; identical skins (same joints, same matrices) share one.
      const writer = plugin as unknown as GLTFWriterInternals;
      const original = writer.processSkin.bind(writer), shared = new Map<string, number>(), inverse = new Matrix4();
      writer.processSkin = object => {
        const skeleton = object.skeleton;
        if (!skeleton?.bones.length) return original(object);
        const joints = skeleton.bones.map(bone => writer.nodeMap.get(bone));
        const matrices = skeleton.boneInverses.flatMap(boneInverse => inverse.copy(boneInverse).multiply(object.bindMatrix).toArray());
        const key = JSON.stringify([joints, matrices]);
        const first = shared.get(key);
        if (first === undefined) { const index = original(object); if (index !== null) shared.set(key, index); return index; }
        writer.json.nodes[writer.nodeMap.get(object)!].skin = first;
        return first;
      };
      return {};
    });
    const output = await exporter.parseAsync(scene, { binary: true, animations: built.clips });
    if (!(output instanceof ArrayBuffer)) throw new Error('Exporter did not produce a binary GLB');
    return new Uint8Array(output);
  } finally { built.dispose(); disposeScene(scene); }
}

export type GLBVerification = ValidationReport & { ok: boolean; errors: number; warnings: number };
export async function verifyGLB(bytes: Uint8Array): Promise<GLBVerification> {
  const report = await validateBytes(bytes, { format: 'glb', uri: 'model.glb', writeTimestamp: false, maxIssues: 0 });
  return { ...report, ok: report.issues.numErrors === 0, errors: report.issues.numErrors, warnings: report.issues.numWarnings };
}
