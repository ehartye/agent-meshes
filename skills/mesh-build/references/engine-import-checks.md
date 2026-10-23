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
claiming Unreal support. Later runs take seconds. A first run on a new engine can compile
shaders for minutes, so the default `--timeout` is 1800 s.

This proves the **import only**. Nothing is rendered or animated in Unreal. When you report it,
say "imports into UE 5.7 via Interchange with names intact", not "works in Unreal". A missing
morph often means a dead shape: Unreal drops morphs that move no triangle vertex.

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

**Unbound meshes vanish from the import.** In a GLB that has a skin, Interchange silently drops
every mesh node with no `skin`, no morphs and no joint above it: no StaticMesh, no warning. The
easy mistake is building eyeballs with a `blender_lib` source and not passing them to `bind_skin`:
the head imports with no eyes. `verify-unreal` compares the GLB's welded vertex count with what
Unreal imported and fails naming the dropped nodes. Bind the eyeballs to the skin, 100% to
`eye_L`/`eye_R`. Eye bones must be children of `head` (a flat armature fails the hierarchy check),
and a GLB with two skins that Unreal happened to merge only warns.
