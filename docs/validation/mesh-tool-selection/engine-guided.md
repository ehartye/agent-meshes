Read-only planning based on the supplied candidate skill/references and general expertise. Every trial below is proposed. No target project, installed package version, engine/player run, material, collision, LOD or performance result was verified. Source documentation has rolling/version-specific limits and is not executed project evidence.

## H

Keep the GLB/useGLTF authoring route. One scene object cannot have 100 parents: extract shared geometry/materials into InstancedMesh, or clone nodes for independent mounting; cloning alone does not instance rendering. Cached loading is not batching.

For one dent, give that rock private geometry outside the shared instance batch; editing shared geometry dents every copy. Update attributes, necessary normals and bounds, and invalidate demand rendering. Use InstancedRigidBodies if the repeated rocks are simulated. Rapier collision is separate: explicitly update/rebuild the chosen collider; visual edits do not establish automatic synchronization.

Proposed smallest proof: load the real material/decoder setup, repeat 100 rocks, detach and dent one, confirm only it changes, inspect demand-loop refresh/culling and physical contact at the dent, then unmount/remount. Measure target-device rendering and collider-update cost. Record actual renderer/package versions, body type and required collision fidelity first.

- **Time:** preserves existing assets; the dent path adds implementation now and GPU-upload/collider-refresh latency later.
- **Risk:** shared-buffer edits predictably affect all copies; stale bounds or colliders can hide rocks or block movement.
- **Complexity:** separate instance transforms, unique deformation, scheduling, resource lifetime and physics ownership.
- **Best practice:** instance eligible repeats, isolate unique edits, and measure actual draw/frame costs.
- **Maintainability:** retain editable GLB sources and pin loaders/physics packages; document disposal and collider-refresh rules.

## I

Keep the ArrayMesh generator and reuse its Mesh resource through spatially clustered MultiMeshes. Blender files are unnecessary for instancing. Supply ArrayMesh LOD index arrays deliberately; runtime meshes do not inherit imported-scene automatic LOD preprocessing. Verify the installed version's MultiMesh/LOD behavior.

MultiMesh batches rendering, not physics. Use separate bodies and CollisionShape3D nodes; share Shape3D resources where appropriate while bodies carry transforms. Use concave trimesh collision for static arches. Freely simulated falling arches need convex shapes or convex compounds; one convex hull can close the archway, so preserve the opening with several pieces. Confirm the actual Godot release and physics backend.

Proposed smallest proof: generate one arch with LODs, repeat across two distant clusters, traverse near/far boundaries, verify culling and silhouette, then compare walking through a static arch with dropping a compound-collider arch. Regenerate and run the exported target game; measure rendering, generation and physics separately before 2,000 instances.

- **Time:** avoids DCC conversion; LOD generation/collider preparation take setup and can add startup work.
- **Risk:** one world-sized MultiMesh weakens culling; wrong collision can seal openings or break falling simulation.
- **Complexity:** own cluster bounds, LOD resources and separate physics transforms.
- **Best practice:** reuse generated resources, cluster spatially and match collision to body behavior.
- **Maintainability:** retain generator parameters, LOD/collision recipes and versioned exported-game checks.

## J

Keep glTFast for GLBs and Unity Mesh generation for roads that change during play. Confirm engine, URP and glTFast versions, importer ownership, material compatibility and mesh readability.

Do not enable static batching universally: changing road geometry conflicts with a static representation. Choose eligible SRP Batcher/GPU Resident Drawer or instancing paths using the actual URP configuration and profiler; a material checkbox is insufficient.

A simulated dynamic Rigidbody requires convex/compound collision, not the proposed concave MeshCollider. Unity 6.0 documents concave use for static/kinematic bodies with restrictions, and a 255-triangle convex limit. Explicitly prepare/update collision after visual changes and schedule cooking; physics synchronization and acceptable latency require proof.

Proposed first trial: one imported prop plus one generated road segment in the target player. Verify intended materials and repeated rendering, edit road vertices, refresh normals/bounds and collider, drive/contact across the edit, and drop the representative dynamic body. Profile generation/uploads, rendering and collision cooking separately; check repeated updates and cleanup.

- **Time:** reuses import work; live generation and collider cooking add implementation and possible frame stalls.
- **Risk:** importer/material mismatches can affect batches; invalid dynamic collision can break gameplay.
- **Complexity:** separate import, mesh ownership, URP rendering and physics preparation.
- **Best practice:** select optimizations by eligibility and measured player behavior.
- **Maintainability:** pin package versions; retain source/generator, import settings and repeatable player checks.
