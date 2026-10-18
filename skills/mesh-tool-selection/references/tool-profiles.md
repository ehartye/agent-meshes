# Tool profiles

One profile per route: what it is, how to run it, what it is good for, what breaks, how to verify it, and what it
costs. Claims cite the [evidence list](evidence.md) by topic; statements marked *(inference)* are judgement from that
evidence and from agent-meshes use, not tested end to end. Version-specific claims name the version.

The cost assessments are qualitative planning guidance, not measured durations or failure rates. Re-estimate
them against the project's existing tools and one representative asset. Authoring, engine import and runtime
representation are separate choices: several profiles can form one pipeline.

## Named-part workspace (agent-meshes)

- **What:** JSON operations over named parts, bones and clips in a durable workspace; exports a GLB with node names,
  skins and clips. Recipes build creatures and gaits.
- **Run:** `mesh --workspace <dir> new|batch|recipe|inspect|undo ...`, then `mesh build` / `mesh verify`.
- **Good for:** rigged or animated low-poly models, quick iteration with fixed-view renders and contact sheets,
  verifiable budgets (`verify.maxTriangles`, pivots, heights, detached parts).
- **Breaks:** it is not a bevel/Boolean/UV modeller *(inference)*; when a prop needs real Booleans, use the Blender
  route inside the same plugin.
- **Verify:** `mesh verify`, renders, `mesh stats` / `mesh diff`; `mesh verify-unreal` for the engine import.
- **Time:** quick for supported primitives and recipes; custom forms can require repeated render/edit rounds.
- **Risk:** assembly, skin or export mistakes can require rework; budgets and exported-file checks catch some,
  but not visual quality. Likelihood depends on the asset, not on the text format.
- **Complexity:** one named-part model covers geometry, rig and clips; unfamiliar shapes need custom construction.
- **Best practice:** useful for reproducible low-poly assemblies; check native engine contracts separately.
- **Maintainability:** text sources are diffable; retain operation inputs, recipes and verification configuration.

## Blender headless script

- **What:** a source defining `build()` that returns bpy objects, run through `blender -b --python-exit-code 1 --python ...`;
  `scripts/blender-author.py` exports the GLB. `mesh preview` renders fast looks of the same source.
- **Run:** `build.json` with `{"blender":{"script":"x.py"}}`, or call Blender directly from a Node build script and
  read stdout/stderr on failure.
- **Good for:** bevels, Boolean cuts, UVs, vertex colors, static props and CI export. The plugin's chess-prop recipe
  uses decimation, local subdivision, Exact booleans, welding and triangulation; that order and its one-material
  policy are a tested local recipe, not a universal asset contract.
- **Breaks:** a script failure exits 0 unless `--python-exit-code` is passed; `bpy.ops` depend on context and may
  raise "context is incorrect"; Edit-Mode data is not in `obj.data`; held references crash after mode switches or
  container changes; node graphs themselves do not export (evaluated geometry and supported material properties
  can); unset exporter parameters fall back to the
  current Blender settings; only active or NLA-stashed actions export.
- **Verify:** exit code, `mesh verify` budgets, a glTF validator, render of the exported GLB (not Blender's studio
  render), then an engine import check.
- **Time:** initial script and import calibration take work; later variants reuse them, but each rebuild/export
  still takes time and needs checks.
- **Risk:** context errors and exporter drift can produce wrong or incomplete output; version pinning and fresh
  output checks reduce exposure. A successful process alone does not prove correct geometry.
- **Complexity:** adds Blender and an export boundary; use the existing wrapper instead of another launcher.
- **Best practice:** a conventional DCC-to-engine route with explicit export settings and native validation.
- **Maintainability:** retain scripts, parameters, Blender version and verification commands; recheck on upgrades.

## `bpy` as a Python module

- **What:** the `bpy` package gives the API in an ordinary Python process (the captured PyPI release was 5.2.2,
  published 2026-09-15; check the available package and Python version before installing).
- **Good for:** pipelines already in Python, unit-testing geometry code, no subprocess.
- **Breaks:** each Blender release supports exactly one Python version; versions outside the LTS window leave PyPI
  (older ones are at download.blender.org/pypi/bpy/); an older Blender scripting note says the module needs a special build, while the PyPI package now ships a prebuilt one; pin and test it.
- **Verify:** clean-environment install, a minimal create/export run, output validation and target import. The
  managed Blender executable's discovery does not install or certify this separate Python package.
- **Time:** packaging and version alignment come first; in-process calls avoid process startup on later jobs.
- **Risk:** Python/Blender incompatibility or native crashes can break the host process; an isolated environment
  limits damage, but the exact combination needs testing.
- **Complexity:** couples the application's Python environment to Blender rather than a subprocess boundary.
- **Best practice:** supported for Python pipelines with a tested version pair; Python use alone is no reason to
  replace a working headless Blender launcher.
- **Maintainability:** pin Python and bpy together and retain a clean install/export smoke check.

## Hand-authored Blender

- **What:** a person models in the UI; the agent supplies scripts for repeatable parts (rigs, exports, checks).
- **Good for:** hero assets and organic form, anything judged by eye.
- **Breaks:** manual sculpting/modeling decisions cannot be reconstructed from an export script alone; binary
  assets are harder to review or merge. Keep the editable `.blend` as source.
- **Verify:** open the source, export through repeatable settings, validate the GLB and inspect it in the engine.
- **Time:** costs artist time per substantial shape change; reusable kits and scripted exports reduce later work.
- **Risk:** visual iteration can improve quality but does not guarantee it; lost source or import mismatches can
  force expensive rework. Keep source versions and native review receipts.
- **Complexity:** introduces human editing and binary asset management alongside automated checks.
- **Best practice:** standard studio practice for artist-led assets; code regeneration is not required.
- **Maintainability:** editable sources and export recipes support future edits; record manual steps explicitly.

## Unreal editor Python and Interchange pipelines

- **What:** the `unreal` module and Interchange pipelines (translators, pipeline stack, factories) for import and
  asset operations; `BatchProcessCommandlet` / `-run=pythonscript` for parallel batches (UE 5.8).
- **Good for:** importing and configuring many assets identically (Nanite, collision, LODs, lightmap UVs through
  `InterchangeGenericMeshPipeline`).
- **Breaks:** editor-only; Interchange FBX is experimental behind a feature flag in 5.8 while USD is production-ready
  for assets and glTF got minor fixes. Captured Import Into Level pages disagree on supported format lists;
  test the installed importer and feature flags. Runtime Blueprint import does not support skeletal meshes or
  animation; a UE 5.5 regression renamed meshes
  in same-named FBX groups and broke name-matched collision (fixed for 5.6).
- **Verify:** `mesh verify-unreal` performs a scratch-project Interchange import, reports imported names/counts,
  checks requested rig expectations and uses an aggregate vertex-loss heuristic (1% welding tolerance when
  readable). It does not prove arbitrary mesh-name or vertex identity, render, animate or exercise collision.
- **Time:** one import script costs setup time but saves repeated editor configuration; engine startup and asset
  compilation still add lag to each batch.
- **Risk:** importer-version changes can alter names, materials or collision, with broad impact across a batch;
  calibrate one asset first. Editor Python is unavailable in packaged gameplay.
- **Complexity:** coordinates engine plugins, project settings and asset paths; it complements a modeler.
- **Best practice:** use the project's supported importer and saved pipeline settings, not UI defaults.
- **Maintainability:** keep scripts and import options with the project and rerun native checks on engine upgrades.

## Unreal Geometry Script

- **What:** a `UDynamicMesh` function library (generate, Boolean, simplify, repair, collision, bake) usable in
  Blueprint, Python and C++, in the editor and at run time.
- **Good for:** editor-time procedural assets that become real StaticMeshes; run-time variation.
- **Breaks:** labelled Beta with a caution about shipping; `UDynamicMeshComponent` supports ray tracing but not
  Nanite, Lumen, mesh distance fields, LODs or instanced rendering; some functions are editor-only; when creating a
  StaticMesh asset, Nanite, collision and normal/tangent recompute default to False.
- **Verify:** for editor baking, inspect the saved StaticMesh, reimport/rebuild and cook it. For runtime editing,
  test the specific functions and actor class in a packaged build, including collision updates and frame cost.
- **Time:** avoids a DCC round trip for engine-native generators; boolean work and collision cooking can introduce
  runtime latency that must be measured.
- **Risk:** editor-only calls can disappear in a packaged game; dynamic-component feature gaps can invalidate a
  rendering plan. Prove the exact route before adopting this Beta plugin across assets.
- **Complexity:** separates editable UDynamicMesh data, rendering components and optional baked assets.
- **Best practice:** use editor baking for fixed reusable scenery; use runtime-supported functions for live edits.
- **Maintainability:** retain generator parameters and engine version; test API and cook behavior on upgrades.

## Unreal C++ procedural meshes

- **What:** `UProceduralMeshComponent` (experimental), RealtimeMeshComponent (third-party; free Core, paid Pro), or a
  StaticMesh built from `UStaticMeshDescription` / `BuildFromStaticMeshDescriptions`.
- **Good for:** geometry that depends on game state (a track ribbon, a crater).
- **Breaks:** stock procedural/dynamic components do not provide the baked StaticMesh Nanite/ISM route; capabilities
  differ for third-party components and runtime-built UStaticMesh objects. RMC's vendor advertises runtime Nanite
  in its paid Pro edition; that is not a verified substitute. Physics cooking has a cost (async cooking can help).
  A single-author runtime-StaticMesh report recommends `CTF_UseSimpleAsComplex` for its Shipping trace failure;
  do not generalize that setting to every component or simulation body. Draw count depends on sections,
  materials, passes and batching, not simply component count. Epic marks ProceduralMeshComponent experimental.
- **Verify:** packaged generation, trace/simulation behavior, cleanup and measured game/render/GPU cost under load.
- **Time:** reuse an existing generator quickly; a new runtime system adds implementation and profiling work, and
  collision regeneration can cause visible hitches.
- **Risk:** topology/cooking errors can break driving or other gameplay, a more severe failure than a bad preview;
  test repeated updates and the actual collision/query policy in Shipping.
- **Complexity:** owns buffers, bounds, lifetime, collision and update scheduling; bake fixed geometry when useful.
- **Best practice:** suitable for actual runtime topology changes; editor-generated code can also bake reusable
  assets. Procedural authoring alone establishes neither poor visual quality nor poor performance.
- **Maintainability:** generators remain diffable, but their native behavior and costs require engine-version tests.

## Code-driven CAD (build123d, CadQuery, OpenSCAD)

- **What:** parametric B-rep or CSG in code, tessellated to glTF/STL. OpenSCAD's default backend became Manifold
  (August 2025 development snapshots).
- **Good for:** dimensioned mechanical variants and Booleans. B-rep tools such as build123d/CadQuery also provide
  analytic volume/area/centroid; do not assume those kernel measurements from OpenSCAD's CSG route.
- **Breaks:** tessellation tolerance decides size and validity (build123d `export_gltf` defaults 1e-3 linear /
  0.1 angular; a 77 MB STEP became a ~1 GB GLB until tolerances were raised); CadQuery exports glTF only for
  assemblies; build123d can emit UV coordinates, but game-ready texture layout and shading still need inspection.
  These are not character-rigging tools; agent reliability is measured on mechanical parts
  only (closed execute-measure-retry loops reported 95% to 100% execution success; untuned models fail often).
- **Verify:** execute, measure analytically, tessellate, validate watertightness and size, import check.
- **Time:** parameterize one bracket before generating variants; separate game tessellation and fabrication exports
  add build steps, but changes reuse the same dimensions.
- **Risk:** coarse tessellation loses shape while fine tessellation bloats assets; valid CAD does not prove game
  materials or collision. Check dimensions and each target representation separately.
- **Complexity:** adds a CAD kernel and a CAD-to-mesh boundary; fabrication drawings need their own output checks.
- **Best practice:** appropriate for dimensioned engineering sources; game-ready UVs, shading or rigs may still
  need a DCC pass. Keep analytic source and visual mesh responsibilities distinct.
- **Maintainability:** text parameters support variants; pin the kernel and tessellation/export settings per target.

## Other DCCs and procedural tools (Houdini, Maya, Datasmith)

Use them only when the project already does. Known gaps from the evidence: Houdini's glTF 2.0 ROP does not export
morph targets and skins go through KineFX nodes only; Datasmith CAD import exposes chord/normal tolerance and
stitching, and its triangle counts swing widely with those settings (one sample: 37,500 vs 13,500 triangles across a
chord-tolerance change). Treat each as its own pipeline to engage with, not a default.
