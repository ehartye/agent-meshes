# R3F, Godot and Unity implications

Choose the authoring source first, then the engine representation and update path. Blender, a named-part
workspace or CAD can produce a prepared asset for any of these engines. A generator can also run once and
produce reusable geometry. Live generation or vertex edits add runtime responsibilities; rigid transforms and
ordinary skeletal/morph animation keep their existing animation route.

The recommendations below are synthesis from primary documentation, not measured comparisons. Sources and
capture limits are in [engine evidence](engine-evidence.md). Check the project's actual engine, renderer,
importer, physics backend and package versions before applying rolling or differently versioned documentation.
The [project contract card](existing-project-engagement.md) applies to all three engines.

## React Three Fiber / three.js

R3F is the React integration layer; three.js owns mesh geometry and rendering. Do not add Blender merely to
obtain instancing, or choose procedural geometry merely because the application uses React.

- **Prepared assets:** use the project's GLTFLoader/useGLTF path and required decoders. `useLoader` caches by URL;
  cached loading shares resources but does not itself instance rendering. Reuse geometry/materials deliberately.
  A scene object has one parent; cloning scene nodes is distinct from duplicating shared resources, and rigged
  clones need their own deformation checks. ([R3F scaling](https://r3f.docs.pmnd.rs/advanced/scaling-performance),
  [objects](https://r3f.docs.pmnd.rs/api/objects))
- **Live geometry:** build/update `BufferGeometry` attributes and indices. Plan capacity, GPU upload flags,
  normals/tangents and bounds when edits invalidate them. Use frame-loop refs/mutation for hot updates rather
  than React state every frame; demand rendering needs invalidation after imperative edits. Changing constructor
  `args` can reconstruct an object. ([BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html),
  [update guide](https://threejs.org/manual/en/how-to-update-things.html),
  [R3F pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls))
- **Repeated geometry:** `InstancedMesh` shares geometry/materials across transforms whether the mesh was imported
  or generated. Update instance buffers and bounds explicitly. Material groups/passes still affect work; there
  is no universal one-draw-call or frame-rate guarantee.
  ([InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html))
- **Materials and lifetime:** glTF properties do not carry arbitrary Blender shader graphs. Preserve vertex-color
  semantics in the actual ink/toon material. Define cache/disposal ownership: R3F normally attempts disposal on
  unmount, while `primitive` does not dispose its carried object; shared resources need deliberate ownership.
  Keep renderer-specific WebGL/WebGPU assumptions separate.
  ([objects](https://r3f.docs.pmnd.rs/api/objects), [Blender exporter](https://raw.githubusercontent.com/KhronosGroup/glTF-Blender-IO/main/docs/blender_docs/scene_gltf2.rst))
- **Physics:** rendering buffers are not a physics contract. For react-three-rapier, automatic bounding shapes,
  hulls or trimeshes and explicit compound colliders are separate choices. Do not assume arbitrary visual-buffer
  edits automatically rebuild collision. Other physics libraries require their own contract.
  ([react-three-rapier](https://github.com/pmndrs/react-three-rapier))

Implications for the chosen route:

- **Time:** offline export/import checks trade against generator and update-system work; browser loading,
  decoding, GPU uploads and shader compilation still add startup or frame latency.
- **Risk:** stale bounds, incompatible decoders, disposed shared resources or stale colliders can hide geometry
  or break play; a small load/update/unmount trial limits the batch impact.
- **Complexity:** own geometry, React frame scheduling, cached resources and physics separately.
- **Best practice:** share repeated resources, instance when appropriate, and measure on the target renderer/device.
- **Maintainability:** keep editable sources/parameters, package and decoder versions, disposal ownership and
  repeatable browser checks together.

**Smallest proof:** load or generate one representative ink-colored prop, repeat it, exercise an update if
required, and unmount/remount it. Inspect final pixels, bounds/culling, draw/frame costs and physics behavior.
A successful loader promise alone is not rendered or gameplay evidence.

## Godot

Godot recommends glTF for scene interchange. Direct `.blend` import invokes Blender conversion, so it adds a
Blender installation requirement to the importing machine; exporting a GLB first moves that dependency to the
asset build. Keep engine additions in inherited scenes or post-import processing rather than editing generated
import output. ([formats](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/available_formats.html),
[import configuration](https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/import_configuration.html))

- **Generated meshes:** `ArrayMesh` constructs reusable Mesh resources from arrays; `SurfaceTool` offers mesh
  construction helpers. These can generate once rather than rebuild continuously. `ImmediateMesh` is intended
  for simple frequently changing/debug geometry, while `MeshDataTool` provides extra topology information at a
  cost. These documented methods run on CPU; that is not a claim about every custom GPU technique.
  ([procedural geometry](https://docs.godotengine.org/en/stable/tutorials/3d/procedural_geometry/index.html))
- **Live updates:** respect attribute layouts, byte-region update formats and bounds. ArrayMesh accepts
  caller-provided LOD index arrays; do not assume runtime-created meshes get the imported-scene automatic LOD
  preprocessing. Imported LODs can have artifacts and add import time, so inspect the style at every distance.
  ([ArrayMesh](https://docs.godotengine.org/en/stable/classes/class_arraymesh.html),
  [mesh LOD](https://docs.godotengine.org/en/stable/tutorials/3d/mesh_lod.html))
- **Repeated geometry:** MultiMesh instances a Mesh resource, including suitable generated geometry. Its instances
  are spatially indexed as one object; split widely dispersed groups to retain useful culling. Instance colors
  and custom data vary, but blend shapes are ignored. This is rendering reuse, not automatic per-instance physics.
  ([MultiMesh](https://docs.godotengine.org/en/stable/classes/class_multimesh.html))
- **Materials and collision:** verify imported vertex colors and effective material/shader settings in the target
  renderer. Collision uses separate Shape3D resources attached through CollisionShape3D. Use concave trimesh for
  static collision and primitives/convex compounds for moving simulated bodies; verify the selected physics
  backend/version. Rendering a generated mesh does not establish collision or its update schedule.
  ([collision shapes](https://docs.godotengine.org/en/stable/tutorials/physics/collision_shapes_3d.html))

Implications for the chosen route:

- **Time:** prepared scene import supplies useful preprocessing; runtime generators avoid a DCC export round trip
  but spend CPU work and require explicit geometry/physics updates during play.
- **Risk:** reimport can replace engine-local edits; stale bounds, LOD artifacts or unsuitable concave collision
  can produce missing visuals or wrong gameplay. Preserve import ownership and test one asset first.
- **Complexity:** keep Mesh resources, MeshInstance3D/MultiMesh rendering, inherited scene edits and physics shapes distinct.
- **Best practice:** reuse resources, group instances spatially, and choose procedural APIs by update needs.
- **Maintainability:** retain generators or editable DCC sources plus import/post-import settings and the tested
  Godot renderer/physics version; a rolling `stable` URL is not an engine version pin.

**Smallest proof:** import or generate one asymmetric, vertex-colored mesh with representative collision; repeat
it with the intended instancing route. Reimport/regenerate it and check that local scene additions survive.
Exercise any live edits in an exported game and inspect collision, LOD transitions and target-load frame cost.

## Unity

Keep geometry authoring separate from the import package, rendering pipeline and physics representation.
The captured glTFast 6.17 docs describe a package-installed GLB/glTF route, with editor import to native assets
and runtime loading as separate workflows. Competing default `.glb` importers can conflict. Broad URP/HDRP/Built-In
support is not proof of stock Lit/Standard or custom ink-material equivalence: the captured 6.17 introduction
footnotes stock-material use as not yet supported.
([glTFast introduction](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.17/manual/index.html),
[editor import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.17/manual/ImportEditor.html))

- **Live meshes:** Unity's `Mesh` API is a supported destination for generated geometry. Simple setters validate
  data; advanced buffer APIs and MeshData/Jobs/Burst give more control with more caller responsibility. Own
  attributes, indices, normals/tangents, bounds and CPU-readability needs. `MarkDynamic` is an update hint, not a
  measured speed guarantee. Read dedicated ownership/lifetime references before writing low-level MeshData code.
  ([Mesh API, Unity 6.0](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Mesh.html))
- **Repeated geometry and materials:** SRP Batcher, GPU instancing and mesh batching solve different problems.
  Use the actual pipeline's guidance: the captured 6000.0 chooser favors SRP Batcher/GPU Resident Drawer for
  eligible URP/HDRP projects and gives different Built-In advice. Do not prescribe a material instancing checkbox
  or static batching universally. Identical reusable mesh/material data matters independently of authoring tool.
  ([optimization chooser](https://docs.unity3d.com/6000.0/Documentation/Manual/optimizing-draw-calls-choose-method.html))
- **Collision:** visual Mesh edits do not establish the right collider. The 6000.0 manual allows concave mesh
  colliders on static or kinematic bodies, with collision restrictions; simulated dynamic rigidbodies need a
  suitable convex/compound representation. Convex MeshColliders have a 255-triangle limit. Deforming collision
  geometry causes physics recalculation; cooking settings trade preparation work against simulation cost.
  ([introduction](https://docs.unity3d.com/6000.0/Documentation/Manual/mesh-colliders-introduction.html),
  [component reference](https://docs.unity3d.com/6000.0/Documentation/Manual/class-MeshCollider.html))
- **LOD:** author/configure levels and LODGroup deliberately. General Unity LOD import conventions do not prove
  the selected glTFast version recognizes them, and LODGroup does not itself establish automatic simplification.
  ([LOD configuration](https://docs.unity3d.com/6000.0/Documentation/Manual/configure-mesh-lod.html))

Implications for the chosen route:

- **Time:** an imported route spends export/import time; live Mesh generation adds implementation, upload and
  potentially collision-cooking latency. Advanced APIs are justified by measured needs, not their existence.
- **Risk:** importer conflicts, pipeline-specific material differences, invalid buffers or collision recooking
  can affect a batch or gameplay; a render and physics trial is stronger than a successful prefab import.
- **Complexity:** own import settings, mesh data, the chosen render pipeline and collider preparation separately.
- **Best practice:** choose batching for the actual pipeline, keep visual/physics budgets distinct, and validate
  the target player rather than extrapolating from Editor success.
- **Maintainability:** pin engine, glTFast and render-pipeline versions; retain source/build/import settings and
  representative player checks. Existing sample receipts cover their assets/configurations only.

**Smallest proof:** bring one prepared mesh or runtime generator into the real project, assign the intended
material, test repeated rendering, required LODs and collision, then build/run the target player. Profile
generation, rendering and physics independently. Asset import and passing pure C# tests cannot establish all three.
