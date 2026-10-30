# Engine integration evidence

Primary documentation selected on 2026-10-18 to extend mesh-tool selection beyond Unreal. The project's notes
already contained import and general R3F guidance; the new discovery targeted live geometry, reuse/instancing,
collision and engine-specific verification gaps. Recommendations in the companion engine reference are
synthesis; none of these pages establishes an authoring-tool performance ranking.

## R3F / three.js

These are rolling three.js and main R3F/pmndrs documents, not a release pin. Check installed packages and the
actual WebGL/WebGPU renderer; do not mix experimental `/next` recipes with another installed version.

| Source | Establishes | Limits |
| --- | --- | --- |
| [BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html) | Attribute/index representation, normals, changed-vertex bounds, material groups and GPU resource disposal | API semantics, not timings; morph data replacement has separate constraints |
| [R3F objects](https://r3f.docs.pmnd.rs/api/objects) | Constructor-argument reconstruction, scene-object reuse, unmount/primitive disposal rules | Scene-node cloning does not prove correct skinned cloning or resource ownership |
| [R3F scaling performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance) | URL-keyed loader cache, geometry/material sharing, instancing, demand-loop invalidation | Suggested counts and demos are not device budgets; cached loading is not instancing |
| [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) | Shared geometry/materials, per-instance transforms/colors, upload flags and bounds | No universal draw total, frame rate or per-instance physics guarantee |
| [react-three-rapier](https://github.com/pmndrs/react-three-rapier) | Explicit/automatic collider choices, compound shapes and InstancedRigidBodies | Wrapper-specific; arbitrary visual-buffer edits are not documented as automatic collider rebuilds |

Reuse existing captures for [buffer updates](https://threejs.org/manual/en/how-to-update-things.html),
[R3F pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls),
[BufferAttribute](https://threejs.org/docs/pages/BufferAttribute.html),
[disposal](https://threejs.org/manual/en/how-to-dispose-of-objects.html) and
[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html). Decoder setup prose survives in the existing
GLTFLoader capture, but its introductory extension list is missing. Some captured API headings lose linked
method/property names. Do not cite missing text as captured evidence or silently repair immutable raw files;
the wiki-master backlog records the extraction defect. This guide avoids relying on that absent extension list.

## Godot

All five sources use the rolling `stable` documentation branch. They were accessed on the date above, but this
does not certify their applicability to a specific installed Godot release or physics backend.

| Source | Establishes | Limits |
| --- | --- | --- |
| [Procedural geometry](https://docs.godotengine.org/en/stable/tutorials/3d/procedural_geometry/index.html) | ArrayMesh/SurfaceTool, ImmediateMesh and MeshDataTool roles; reusable meshes versus ongoing generation | CPU guidance concerns these methods, not every custom GPU approach; no performance benchmark |
| [ArrayMesh](https://docs.godotengine.org/en/stable/classes/class_arraymesh.html) | Attribute-layout requirements, byte-region updates, custom bounds and caller-supplied LOD indices | Does not promise arbitrary topology edits or automatic bounds/normals/collision maintenance |
| [MultiMesh](https://docs.godotengine.org/en/stable/classes/class_multimesh.html) | Mesh-resource instancing, per-instance data, group-level spatial indexing and blend-shape limits | Does not create per-instance physics or guarantee a total draw count across passes/materials |
| [Collision shapes](https://docs.godotengine.org/en/stable/tutorials/physics/collision_shapes_3d.html) | Separate collision resources; primitive/convex versus concave/static use | Contains older body-mode wording; verify exact engine/backend rules; no runtime-cooking timings |
| [Mesh LOD](https://docs.godotengine.org/en/stable/tutorials/3d/mesh_lod.html) | Imported-scene automatic LOD preprocessing, artifacts and import costs | Does not establish equivalent automatic preprocessing for runtime ArrayMesh generation |

Reuse captured [formats](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/available_formats.html)
and [import configuration](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/import_configuration.html)
for glTF, `.blend` conversion, inherited scenes, reimport ownership and post-import scripts.

## Unity

The five new sources are versioned Unity **6.0 / 6000.0** documentation. Versioned URLs can still receive edits;
check the actual project and render-pipeline packages rather than generalizing every recommendation to Unity 6.x.

| Source | Establishes | Limits |
| --- | --- | --- |
| [Mesh API](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Mesh.html) | Simple validated setters, advanced buffer APIs, Jobs/Burst MeshData, attributes, bounds and update hints | Overview does not establish every read/write, snapshot or disposal ownership rule; use dedicated references for implementation |
| [Mesh collider introduction](https://docs.unity3d.com/6000.0/Documentation/Manual/mesh-colliders-introduction.html) | Concave static/kinematic eligibility, convex/compound choices and deformation-recalculation cost | No numeric cost or universal compound-versus-mesh speed claim; kinematic is distinct from simulated dynamic |
| [MeshCollider reference](https://docs.unity3d.com/6000.0/Documentation/Manual/class-MeshCollider.html) | Convex triangle limit and cooking/cleaning/welding preparation trade-offs | Does not certify generated mesh validity or runtime cooking scheduling |
| [Draw-call optimization chooser](https://docs.unity3d.com/6000.0/Documentation/Manual/optimizing-draw-calls-choose-method.html) | Different SRP/instancing/batching strategies and pipeline-specific recommendations | Eligibility and speed remain project/platform/shader dependent; do not copy one checkbox recipe universally |
| [Configure mesh LOD](https://docs.unity3d.com/6000.0/Documentation/Manual/configure-mesh-lod.html) | LODGroup configuration and authored/imported levels | Does not establish automatic simplification or glTFast recognition of importer-specific LOD conventions |

Reuse glTFast **6.17** [introduction](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.17/manual/index.html)
and [editor import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.17/manual/ImportEditor.html): package
installation, default-importer conflicts and native asset conversion. The introduction's stock Lit/Standard
benefit is footnoted as not yet supported. Keep these documented package-version limits distinct from the
existing agent-engine sample receipts on Unity 6000.3.25f1 with glTFast 6.20.0; those receipts cover that sample.

## What remains unproved

- None of these sources runs this project's representative assets through all engines.
- Material equivalence, importer extensions, runtime collider refresh and LOD recognition need target-project trials.
- API support, successful import, visible output, correct gameplay and measured performance are separate claims.
- Godot/three.js/R3F rolling documentation and Unity versioned documentation are evidence scopes, not installed-version detection.
