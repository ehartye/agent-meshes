---
name: mesh-tool-selection
description: "Choose mesh authoring and engine integration tools before a new asset or pipeline: agent-meshes, Blender scripts or bpy, Unreal, R3F, Godot or Unity mesh APIs, code CAD, or whether a 2D engine such as Phaser needs a mesh at all. Use when asked which tool to use, how to engage an existing asset pipeline, whether a pixel game should model its characters, or which route to take when an importer drops geometry, ignores colliders or rejects Nanite (checking a built GLB against the import contract is mesh-build). Skip routine rendering, rig edits and runtime setup when the route is already settled."
---

# Choosing a mesh authoring tool

Choose separately **where geometry is authored**, **how the engine imports/configures it**, and **what changes
during play**. A Blender generator plus Unreal import automation is one pipeline, not competing choices.
For routine work on an approved route, go straight to `mesh-build`, `mesh-rigging` or `mesh-setup`.
For a new or failing route, work in this order:

For Unreal's editor-baking versus live-geometry branches, use the [Unreal decision tree](references/unreal-decision-tree.md);
what to do inside Unreal is the `unreal-procedural` skill (or another unreal-* domain skill) in agent-unreal.
For R3F/three.js, Godot and Unity, read [engine implications](references/engine-implications.md) and
[engine evidence](references/engine-evidence.md). The authoring tool does not choose the runtime representation.

Once a Blender route is approved, use [mesh-build's task routes](../mesh-build/SKILL.md#find-the-relevant-build-guidance)
for shared defaults, batch/incremental generation, environment-driven misses, shared libraries and receipts.
For semantic RGB/alpha channels, read [vertex-colour controls](../../scripts/blender_lib/README.md#vertex-colors-in-glb-exports)
before adopting a uniform-material prop recipe. For Unreal static props, read
[import measurements and axis calibration](../mesh-build/references/unreal-static-props.md) before the trial.
These checks complement the real-project acceptance below; they do not establish rendering or gameplay.

1. **Engage the project first.** Read what already exists and write down the contract the engine imposes.
   [Existing-project engagement](references/existing-project-engagement.md) has the checklist and a contract card.
2. **Decide with the questions below**, using the [tool profiles](references/tool-profiles.md) for capabilities,
   costs and failure modes. The [evidence list](references/evidence.md) records sources and their limits.
3. **Prove with one small asset** through the project's real import, look at the result in the engine, and say
   exactly what you verified. Only then build the batch.

## The routes

| Route | Reach for it when | In this plugin |
|---|---|---|
| Named-part workspace | A rigged or animated low-poly model, a creature recipe, quick looked-at iteration | `mesh-authoring`, `mesh-rigging` |
| Blender headless script (`build()` to GLB) | Booleans, bevels, UVs, vertex colors, a hard-surface or static prop, repeatable batch export | `mesh-build` (Blender-authored static props, `mesh preview`) |
| `bpy` as a module | The project's pipeline is already ordinary Python and wants Blender in-process | `mesh-setup` finds Blender; the module is not managed here |
| Hand-authored Blender | A hero asset judged by eye, organic form | the person; use scripts for the repeatable parts |
| Unreal editor Python / Interchange pipelines | Importing and configuring many assets the same way, batch commandlets | `mesh verify-unreal` for the import check; the project import is `unreal-import` (agent-unreal) |
| Unreal Geometry Script | Editor-time procedural assets that must become real StaticMeshes, or runtime variation | `unreal-procedural` skill, agent-unreal |
| Unreal C++ procedural meshes | Geometry that depends on game state at run time | `unreal-procedural` skill, agent-unreal |
| R3F/three.js, Godot or Unity mesh APIs | The project needs native generation or live vertex/topology updates | engine-specific responsibilities in the references above; outside this plugin's authoring runtime |
| Code-driven CAD (build123d, CadQuery, OpenSCAD) | Exact dimensions, robust Booleans, mechanical parts, analytic measurements | export a GLB, then `mesh verify` here |
| 2D engine (Phaser, Canvas, Pixi) | The target draws sprites, tiles or UI on a 2D canvas | A GLB is not a runtime asset in Phaser, so author no GLB for it. Use the agent-sprites `character` and `creature` recipes (`sprite-character`, `sprite-editing`, `game-integration`) for casts and `sprite-verification` for the atlas. Pre-rendering a rigged model to frames suits many facings of a rigid object or a cast too large to draw; no shipped command exports sprite frames (capture paths such as `mesh preview --clip` and `scripts/review-model.mjs` are review tools), so it is a custom script. Evidence: [2D engines](references/two-d-engines.md) |

## Decision questions (check every applicable constraint)

1. **What pipeline already owns this asset class, and what change did the user authorize?** Extend the existing
   route by default; an authorized hybrid trial is permission to test that change. Inspect conventions before
   replacing anything, but do not ask again for authorization already given.
2. **When must geometry change?** Seeded tracks and construction-time generators can be baked offline or in the
   editor. Only geometry that must change during play needs a runtime generation/update path. Separate it from
   repeated static props and from rigid motion or animation of an existing mesh.
3. **Offline, what is it?** Rigged or character-like: workspace or Blender plus a rig library. A mechanical
   part with exact dimensions: code CAD. A hard-surface prop with bevels and UVs: Blender script. A hero piece
   judged by eye: hand-authored Blender with a script for what repeats.
4. **What representation and renderer does the target support?** For repeated static props, import or bake a
   `UStaticMesh` for ISM/HISM and authored LODs. Instances may be placed during play. A `UDynamicMeshComponent`
   does not gain those features merely by being procedural. Check the installed engine's Nanite asset types,
   materials and renderer: UE 5.8 documents skeletal support too, but forward rendering and MSAA are unsupported.
   A 2D engine does not draw 3D models; see the 2D row.
5. **Can an agent verify the result without a person?** Prefer the route with an exit code, a validator, budgets,
   an engine import check and a render of the exported file. Separate format validity, import facts, visual
   acceptance, collision/playback in a packaged build, and measured performance. Report missing proof precisely.

Return the chosen authoring route plus integration/runtime responsibilities, the contract's material unknowns,
and the smallest representative trial with acceptance checks. For each option presented, explain **Time, Risk,
Complexity, Best practice and Maintainability** using the profiles; do not substitute low/medium/high labels.

## Blender or Unreal

Author in Blender (this plugin) when the geometry is fixed once the game is built and any of these hold: it is
authored art (named parts, a rig, morph targets, vertex colours, a form judged by eye); it needs UV, bevel or Boolean
quality, or exact CAD dimensions; many assets must come out identically and pass a validator; or the asset must also
load in another engine.

Stay in Unreal (`unreal-procedural`, agent-unreal) when the geometry depends on level data, gameplay state or player
edits at run time; is parametric variation that exists only in the engine (Geometry Scripting, PCG, Water, Landmass);
or is post-processing of an imported mesh (remesh, simplify, collision, LODs, Nanite settings).

Build-time generation from a seed can go either way: pick Blender when it must be verified outside the editor or shared
with another engine, Unreal when it needs engine data. Either way the result is a StaticMesh asset, and its Nanite,
collision and LOD settings are Unreal's. Editor-only versus runtime functions, the C++ component choice and Unreal's
Python limits are in agent-unreal.

## Rules that save a round trip

- Use the managed Blender build wrapper when applicable. For direct CLI runs, pass `--python-exit-code 1`, pin
  relevant exporter options, and reacquire Blender data after mode changes, undo or topology/container edits.
- Geometry Nodes graphs and arbitrary shader graphs do not travel in glTF. Export evaluated mesh geometry and
  supported material properties or bake what is needed; check modifier, skin and morph interactions first.
- Never assume a collision convention from another importer. `UBX_/UCX_` name prefixes are documented for
  Unreal's FBX path; test glTF directly.
- Code-CAD output reaches an engine only through tessellation. Set tolerances on purpose, check watertightness
  and size, and run an execute-measure-retry loop rather than trusting a first script.
- Validation proves format, not behaviour. Run `mesh verify`, a glTF validator and, for Unreal, `mesh verify-unreal`;
  then look at it in the engine and report which of those you did. A GLB validator or a render of an exported GLB
  proves nothing about a sprite atlas; verify atlases with `sprite-verification` (agent-sprites).

## Never

- Switch the project's tool or pipeline beyond the user's authorized scope. Explain the five trade-offs before
  seeking any genuinely missing decision; keep independent inspection and reversible trials moving.
- Commit an authored binary mesh without its editable source (`.blend`, CAD or script), parameters and export /
  verification commands. A hand-authored asset need not be regenerable from code.
- Claim "works in Unreal" or "works in Unity" from a validator or an import check; say what was checked.
