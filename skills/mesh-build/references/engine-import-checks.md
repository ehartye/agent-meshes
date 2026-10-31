# Engine import checks: Unity and Unreal

Entry: [mesh-build](../SKILL.md).

## Importing into Unity (glTFast)

Checked with glTFast 6.20.0; the agent-engine plugin's `engine-asset-import` skill has the full import detail.
agent-meshes exports each part as its own node with a `matrix` (not translation/rotation/scale), and glTFast
handles those nodes correctly; other importers may warn. glTF +Z forward stays +Z forward in Unity (glTFast
flips handedness for you). Verified with an orthographic top-down render of the imported pieces: a knight authored
facing +Z faces +Z in the scene. Every part is a node, so a prop of 15 parts becomes 15 child GameObjects; for a
static prop prefer one mesh with one material (the Blender route above) when the engine will instance many copies.

## Unreal import check

For rigid props, read [static-prop checks](unreal-static-props.md) for full-size bounds in
centimetres, render-resource versus Nanite triangles, Nanite/UV build settings and signed-axis calibration.
Declare expectations from the project contract; the verifier reports settings rather than changing them.
Its scratch import does not prove production-project configuration, vertex-channel values, rendering,
collision, cooked behavior or performance. Character-specific checks follow below.

```text
mesh verify-unreal head.glb --contract arkit-face/1
mesh verify-unreal prop.glb --expect-morphs open,close --expect-bones lid --json
```

Imports the GLB headlessly into a cached scratch UE project through Interchange and prints a JSON
report: the assets by class, and per SkeletalMesh its morph target names, bone names and bone
parents, LOD and vertex counts, plus the import errors and warnings from the Unreal log (whose path
is in the report). `--contract arkit-face/1` requires ONE SkeletalMesh that has the 21 ARKit morph
names verbatim and whose own skeleton has `head` as its root with `eye_L`/`eye_R` as children of
`head`, only one SkeletalMesh and Skeleton in the import, and zero import errors. Every run, with or
without a contract, also fails when geometry vanished: fewer vertices reached Unreal than the GLB
renders (`geometry` in the report). It exits 1 and lists `failures` otherwise, naming the cause.
Unreal comes from `AGENT_MESHES_UNREAL` (the engine directory), the Epic launcher manifest or the
usual install roots. Without one the command fails with `UNREAL_NOT_FOUND`: say so rather than
claiming Unreal support. The scratch project lives in a per-engine cache folder (under the user's local cache directory by
default); `AGENT_MESHES_UNREAL_CACHE` names another folder. Two runs share one cache through a lock: a run waits for the
other, and after about ten minutes fails with `UNREAL_BUSY`, naming the process that holds it; a lock left by a dead
process is replaced. Later runs take seconds. A first run on a new engine can compile
shaders for minutes, so the default `--timeout` is 1800 s.

This proves the **import only**. Nothing is rendered or animated in Unreal. When you report it,
say "imports into UE <version> via Interchange with names intact" (the version is in the report),
not "works in Unreal". A missing morph often means a dead shape: Unreal drops morphs that move no
triangle vertex.

**Combine Skeletal Meshes depends on the engine.** Checked on UE 5.8.2, with the head checks first
recorded on 5.7.3. Interchange's `CombineSkeletalMeshesBehavior` is `BySkeleton` in code, one
SkeletalMesh per skeleton, but the 5.8.2 `DefaultGLTFAssetsPipeline` asset stores `DoNotCombine`. A
default glTF import then makes one SkeletalMesh per skinned mesh node: a head, its teeth and both
eyeballs on one skin become three SkeletalMeshes on one Skeleton, and the contract rejects that.
`BySkeleton` and `BySkeletonVisibleOnly` both give one SkeletalMesh (3360 vertices, 21 morphs) for
those heads, which have no hidden nodes. For a skinned GLB or a SkeletalMesh check,
`verify-unreal` sets `BySkeleton` on a scratch copy of that pipeline and reports the value it found
and the value it applied as `skeletalMeshGrouping` (`engineDefault`, `applied`). A project that
imports with the engine's default glTF pipeline needs the same setting (Combine Skeletal Meshes:
Combine All That Use Same Skeleton), or the model arrives as several SkeletalMeshes.

**Never put one morph name on two glTF meshes.** If `jawOpen` is on a Face mesh and on a separate
Teeth mesh, UE 5.7's glTF parser (`GLTFAsset.cpp`) throws away *every* morph name in the file
and renames them all `<file>_mesh_<m>_<i>_MorphTarget`. Three.js is fine with this, but Unreal is
not, and no Interchange option (`bMergeMorphTargetsWithSameName` included) prevents it. Build all
morph-bearing geometry (face, lids, lips, teeth, tongue, mouth cavity) as **one glTF mesh with one
primitive per material**. In Blender, join those parts into one object with several materials,
and give every part every target (zero deltas where a part does not move). Morph-free parts such
as eyeballs can stay separate meshes. `verify-unreal` checks the GLB first, with no engine needed,
and reports this as one failure naming the shared morphs and meshes. A name repeated inside one
mesh, or an `extras.targetNames` count that differs from the target count, loses that mesh's names
the same way. The check lives in `src/gltf-morphs.ts` (`auditMorphNames`), exported for reuse.

**Bind every mesh to one skin.** Unreal makes one SkeletalMesh and Skeleton per glTF skin. A
morph-bearing mesh node with no `skin` becomes its own SkeletalMesh on a made-up one-bone
skeleton (`Head_<hash>`), apart from the eye rig, so the face cannot be moved by `head`/`eye_*`.
A GLB with no skin at all gets only that made-up bone. `verify-unreal` reads the GLB's skins
(`preflight.skins`, `src/gltf-skins.ts`) and names which of these it is. In Blender, parent every
mesh (face and eyeballs) to the one armature with an Armature modifier before exporting.

**Unbound meshes do not join the rig.** In a GLB that has a skin, a mesh node with no `skin` and no
morphs is not part of the rig's SkeletalMesh. UE 5.7.3 dropped it with no warning and no StaticMesh,
unless it sat under a joint, when it merged into the SkeletalMesh. UE 5.8.2 imports it as a separate
StaticMesh in both cases (1100 of an eyeball's 1104 vertices after welding). For a node under a joint
it also adds a bone named after the node, but the geometry stays in the StaticMesh, so a parent joint
does not bind a mesh. The easy mistake is building eyeballs with a `blender_lib` source and not
passing them to `bind_skin`: the eyes are missing (5.7) or never gaze (5.8). `verify-unreal` fails a
rig check with the node names and the fix, on 5.7 from the missing vertices and on 5.8 from the
StaticMeshes Unreal made; without a rig check, 5.8 only warns. Bind the eyeballs to the skin, 100% to
`eye_L`/`eye_R`. Eye bones must be children of `head` (a flat armature fails the hierarchy check),
and a GLB with two skins that Unreal happened to merge only warns.

## UEFN skeletal import and vertex colours

- [tested] On 2026-10-28 a skinned model whose colour lived only in vertex colours arrived in UEFN
  without them, while the same model coloured per material kept its colours. `verify --target uefn`
  warns `VERTEX_COLOUR_ONLY` for that shape (a skinned primitive with `COLOR_0`, no base-colour
  texture and a white base-colour factor); use per-material colours or a baked texture instead.
- A UEFN delivery sets `"target":"uefn"` in `build.json` (the only target), or passes `verify --target uefn`. The
  report then carries `geometryBudget`: per mesh the exported render vertices, position vertices and triangles, with
  the warning `RENDER_VERTEX_BUDGET_EXCEEDED` for a mesh over 30000 render vertices. `"renderVertexBudget":N` in
  `build.json` (it requires the target) or `--render-vertex-budget N` (a positive integer; the flag needs `--target uefn`) sets another budget. The
  excess is a warning, not a failure, and nothing is checked against a native LOD. A mesh whose counts cannot be read
  (Draco or meshopt data) warns `GEOMETRY_COUNT_UNKNOWN`.
