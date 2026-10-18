---
name: mesh-tool-selection
description: Choose how to author a mesh (agent-meshes named-part workspace, Blender headless script, bpy module, hand-authored Blender, Unreal editor Python or Geometry Script, Unreal C++ procedural meshes, code-driven CAD) and how to engage an existing project's asset pipeline before authoring anything.
when_to_use: Use before the first modelling command on a new asset or project; when asked "which tool should I use" for a prop, vehicle, scenery piece or runtime-generated mesh; when a project already has meshes, an importer, naming or collision conventions; or when a chosen route fails (collider ignored, Nanite unsupported, exporter dropped data, geometry vanished on import).
---

# Choosing a mesh authoring tool

Do not pick a route by habit. A wrong first choice costs a full round trip (author, export, import, collide,
verify) before anyone notices. Work in this order:

1. **Engage the project first.** Read what already exists and write down the contract the engine imposes.
   [Existing-project engagement](references/existing-project-engagement.md) has the checklist and a contract card.
2. **Decide with the questions below**, using the [tool profiles](references/tool-profiles.md) for capabilities,
   costs and failure modes.
3. **Prove with one small asset** through the project's real import, look at the result in the engine, and say
   exactly what you verified. Only then build the batch.

## The routes

| Route | Reach for it when | In this plugin |
|---|---|---|
| Named-part workspace | A rigged or animated low-poly model, a creature recipe, quick looked-at iteration | `mesh-authoring`, `mesh-rigging` |
| Blender headless script (`build()` to GLB) | Booleans, bevels, UVs, vertex colors, a hard-surface or static prop, repeatable batch export | `mesh-build` (Blender-authored static props, `mesh preview`) |
| `bpy` as a module | The project's pipeline is already ordinary Python and wants Blender in-process | `mesh-setup` finds Blender; the module is not managed here |
| Hand-authored Blender | A hero asset judged by eye, organic form | the person; use scripts for the repeatable parts |
| Unreal editor Python / Interchange pipelines | Importing and configuring many assets the same way, batch commandlets | `mesh verify-unreal` for the import check |
| Unreal Geometry Script | Editor-time procedural assets that must become real StaticMeshes, or runtime variation | outside this plugin |
| Unreal C++ procedural meshes | Geometry that depends on game state at run time | outside this plugin |
| Code-driven CAD (build123d, CadQuery, OpenSCAD) | Exact dimensions, robust Booleans, mechanical parts, analytic measurements | export a GLB, then `mesh verify` here (importing a CAD GLB for rigging is not built yet) |

## Decision questions (stop at the first that decides it)

1. **Does the project already have an authoring pipeline or source of truth for this kind of asset?** Use it.
   Adding a second importer, a new engine plugin or a new tool for one asset is the owner's decision, not yours.
2. **Does the mesh depend on run-time state or on the route?** Then it is generated in the engine and the real
   questions are collision, LOD and Shipping behaviour. Otherwise author it offline.
3. **Offline, what is it?** Rigged or character-like: workspace or Blender plus a rig library. A mechanical
   part with exact dimensions: code CAD. A hard-surface prop with bevels and UVs: Blender script. A hero piece
   judged by eye: hand-authored Blender with a script for what repeats.
4. **Does it need Nanite, instancing or authored LODs?** The deliverable must be a real StaticMesh (an imported
   file, or a Geometry Script asset created with Nanite and collision requested explicitly), not a runtime
   component.
5. **Can an agent verify the result without a person?** Prefer the route with an exit code, a validator, budgets,
   an engine import check and a render of the exported file. If you cannot verify, say so and ask.

## Rules that save a round trip

- Authoring scripts own their own supervision: pass `--python-exit-code 1` to `blender -b`, pin every exporter
  parameter, apply modifiers before export, and keep your own references to Blender data.
- Geometry Nodes and material node graphs do not travel in glTF; apply them to real mesh data and bake materials.
- Never assume a collision convention from another importer. `UBX_/UCX_` name prefixes are documented for
  Unreal's FBX path; test glTF directly.
- Nanite belongs to a StaticMesh asset, not to generated geometry, and has unsupported features (morph targets,
  forward rendering, MSAA). Treat "faster" as unmeasured until you measure it.
- Code-CAD output reaches an engine only through tessellation. Set tolerances on purpose, check watertightness
  and size, and run an execute-measure-retry loop rather than trusting a first script.
- Validation proves format, not behaviour. Run `mesh verify`, a glTF validator and, for Unreal, `mesh verify-unreal`;
  then look at it in the engine and report which of those you did.

## Never

- Switch the project's tool or pipeline without surfacing the trade-offs (time, risk, complexity, best practice,
  maintainability) and getting a decision.
- Commit a binary mesh without the script, parameters and command that rebuild and verify it.
- Claim "works in Unreal" or "works in Unity" from a validator or an import check; say what was checked.
