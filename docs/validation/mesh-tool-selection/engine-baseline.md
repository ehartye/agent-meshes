# Engine planning baseline

## H

Keep the GLB. Extract its geometry/materials into `InstancedMesh` batches or Drei instancing helpers; procedural BufferGeometry is unnecessary. One Object3D cannot have 100 parents. Cloning fixes ownership but does not itself reduce draw calls. Multiple mesh/material combinations need separate batches.

For a unique dent, remove that rock from its batch and use a separate mesh with cloned geometry. Editing shared vertices changes every instance. Update attributes, normals and bounds as needed; call R3F `invalidate()` after imperative changes under demand rendering. Instance transforms cannot provide unique vertex positions.

Visual edits do not automatically rebuild react-three-rapier colliders. Explicitly replace/update the affected collision proxy, respecting transforms and physics timing. Prefer simple/compound convex shapes for dynamic rocks; detailed collision rebuilds are expensive.

Smallest proof: 100 visible rocks with measured draw calls; dent one while others stay unchanged; demonstrate demand-frame refresh and changed collision/raycast results after explicit collider replacement.

- **Time:** Roughly half a day for a spike; collision rebuilds add runtime latency.
- **Risk:** Shared-buffer edits deform every rock; stale colliders produce incorrect contacts.
- **Complexity:** Moderate: instance bookkeeping and one editable exception.
- **Best practice:** Reuse imported geometry; manage rendering and physics explicitly.
- **Maintainability:** Separate asset loading, deformation and collision generation.

## I

Keep generating the ArrayMesh. MultiMesh accepts mesh resources regardless of authoring source. Supply generated LOD index data through ArrayMesh's LOD facilities, or generate simplified meshes and manage distance tiers. Blender is optional.

Partition the 2,000 arches into spatial MultiMeshes: one giant batch has coarse visibility bounds and may render many offscreen instances. Do not assume independent LOD selection per instance; prove the selected Godot version's group behavior and use spatial/distance groups where needed.

MultiMesh supplies rendering, not per-instance physics bodies. Create separate StaticBody3D collision shapes for relevant fixed arches, sharing shape resources where appropriate. ConcavePolygonShape3D suits static collision, not freely simulated falling rigid bodies. Use convex decomposition or compound convex/primitives for falling arches; a single convex hull fills the opening.

Smallest proof: one generated arch with an open passage, a chunked repeated field viewed across boundaries, visible LOD transitions with measured rendering cost, and one falling arch with compound collision. Profile collider count separately from draw calls.

- **Time:** About a day for a focused spike; decomposition adds preparation.
- **Risk:** Coarse culling wastes GPU time; incorrect convex proxies close archways.
- **Complexity:** Moderate: chunks and separate collision placement.
- **Best practice:** Separate rendering from physics and static from dynamic collision.
- **Maintainability:** Generate visual and collision variants from one parametric source.

## J

Use glTFast for authored GLBs and Unity Mesh generation for roads that change during play. Share mesh/material resources for unchanged repeats. URP shaders and rendering paths determine batching; the GPU-instancing checkbox alone does not prove reduced draws. The SRP Batcher and GPU instancing are different mechanisms; profile the intended route.

Do not enable static batching everywhere. It suits geometry fixed after batching and duplicates geometry into combined buffers. Batch stable sections selectively; keep mutable roads separate and update normals, tangents and bounds as required.

A freely simulated Rigidbody needs convex MeshColliders or compound primitives/convex pieces. Reserve concave triangle MeshColliders for static geometry. Visual edits require an explicit collider update/reassignment and cooking strategy; keep render and physics representations separately owned.

First trial: import one GLB and generate one editable road section. Check URP materials, units and orientation; measure actual draw calls for repeated objects; edit the road and prove collision follows the intended update. Measure cooking spikes and test one falling convex compound.

- **Time:** Approximately one day for a spike; collider cooking can stall play.
- **Risk:** Stale collision causes incorrect contacts; batching may increase memory.
- **Complexity:** Moderate: section ownership and rebuild scheduling.
- **Best practice:** Profile batching and choose suitable collision proxies.
- **Maintainability:** Centralize mesh changes and collision rebuild policy.
