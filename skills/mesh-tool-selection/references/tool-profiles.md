# Tool profiles

One profile per route: what it is, how to run it, what it is good for, what breaks, how to verify it, and what it
costs. Claims cite the [evidence list](evidence.md) by topic; statements marked *(inference)* are judgement from that
evidence and from agent-meshes use, not tested end to end. Version-specific claims name the version.

Cost lines answer: **Time** (now and later), **Risk**, **Complexity**, **Best practice** (distance from the
standard way), **Maintainability**.

## Named-part workspace (agent-meshes)

- **What:** JSON operations over named parts, bones and clips in a durable workspace; exports a GLB with node names,
  skins and clips. Recipes build creatures and gaits.
- **Run:** `mesh --workspace <dir> new|batch|recipe|inspect|undo ...`, then `mesh build` / `mesh verify`.
- **Good for:** rigged or animated low-poly models, quick iteration with fixed-view renders and contact sheets,
  verifiable budgets (`verify.maxTriangles`, pivots, heights, detached parts).
- **Breaks:** it is not a bevel/Boolean/UV modeller *(inference)*; when a prop needs real Booleans, use the Blender
  route inside the same plugin.
- **Verify:** `mesh verify`, renders, `mesh stats` / `mesh diff`; `mesh verify-unreal` for the engine import.
- **Costs:** Time low per asset. Risk low. Complexity low. Best practice: a purpose-built tool, not an engine-standard
  one. Maintainability good: the workspace and operations are text.

## Blender headless script

- **What:** a source defining `build()` that returns bpy objects, run through `blender -b --python-exit-code 1 --python ...`;
  `scripts/blender-author.py` exports the GLB. `mesh preview` renders fast looks of the same source.
- **Run:** `build.json` with `{"blender":{"script":"x.py"}}`, or call Blender directly from a Node build script and
  read stdout/stderr on failure.
- **Good for:** exact Boolean cuts with a clean order (decimate first, local subdivide, Exact solver, weld,
  triangulate; cut first and join last), vertex colors, one named material, static props for engines, CI export.
- **Breaks:** a script failure exits 0 unless `--python-exit-code` is passed; `bpy.ops` depend on context and may
  raise "context is incorrect"; Edit-Mode data is not in `obj.data`; held references crash after mode switches or
  container changes; Geometry Nodes and material graphs do not export; unset exporter parameters fall back to the
  current Blender settings; only active or NLA-stashed actions export.
- **Verify:** exit code, `mesh verify` budgets, a glTF validator, render of the exported GLB (not Blender's studio
  render), then an engine import check.
- **Costs:** Time medium (script once, rebuild free). Risk medium (API state, exporter drift between Blender
  versions). Complexity medium. Best practice: standard for DCC-authored static meshes. Maintainability good if the
  source, parameters and build command are committed.

## `bpy` as a Python module

- **What:** `pip install bpy` gives the API in an ordinary Python process (5.2.2 published 2026-09-15).
- **Good for:** pipelines already in Python, unit-testing geometry code, no subprocess.
- **Breaks:** each Blender release supports exactly one Python version; versions outside the LTS window leave PyPI
  (older ones are at download.blender.org/pypi/bpy/); an older Blender scripting note says the module needs a special build, while the PyPI package now ships a prebuilt one; pin and test it.
- **Costs:** Time low once pinned. Risk medium (version coupling). Complexity medium. Best practice: supported but
  secondary. Maintainability needs a pinned version and a documented install.

## Hand-authored Blender

- **What:** a person models in the UI; the agent supplies scripts for repeatable parts (rigs, exports, checks).
- **Good for:** hero assets and organic form, anything judged by eye.
- **Breaks:** not regenerable by an agent; binary assets are hard to review or diff.
- **Costs:** Time slow, Risk low for quality, Complexity low for the agent, Best practice standard studio practice,
  Maintainability poor unless the source `.blend` and an export script are kept together.

## Unreal editor Python and Interchange pipelines

- **What:** the `unreal` module and Interchange pipelines (translators, pipeline stack, factories) for import and
  asset operations; `BatchProcessCommandlet` / `-run=pythonscript` for parallel batches (UE 5.8).
- **Good for:** importing and configuring many assets identically (Nanite, collision, LODs, lightmap UVs through
  `InterchangeGenericMeshPipeline`).
- **Breaks:** editor-only; Interchange FBX is experimental behind a feature flag in 5.8 while USD is production-ready
  for assets and glTF got minor fixes; Import Into Level supports FBX, glTF, GLB and MaterialX with a subset of
  options; runtime Blueprint import does not support skeletal meshes or animation; a UE 5.5 regression renamed meshes
  in same-named FBX groups and broke name-matched collision (fixed for 5.6).
- **Verify:** `mesh verify-unreal` proves import, names and vertex survival headlessly through Interchange; it does
  not render or animate.
- **Costs:** Time medium. Risk medium (version-specific). Complexity medium. Best practice: Epic's supported path.
  Maintainability good when the pipeline settings live in the repository.

## Unreal Geometry Script

- **What:** a `UDynamicMesh` function library (generate, Boolean, simplify, repair, collision, bake) usable in
  Blueprint, Python and C++, in the editor and at run time.
- **Good for:** editor-time procedural assets that become real StaticMeshes; run-time variation.
- **Breaks:** labelled Beta with a caution about shipping; `UDynamicMeshComponent` supports ray tracing but not
  Nanite, Lumen, mesh distance fields, LODs or instanced rendering; some functions are editor-only; when creating a
  StaticMesh asset, Nanite, collision and normal/tangent recompute default to False.
- **Costs:** Time medium. Risk medium-high (Beta). Complexity medium. Best practice: Epic's procedural route.
  Maintainability moderate; API churn per release.

## Unreal C++ procedural meshes

- **What:** `UProceduralMeshComponent` (experimental), RealtimeMeshComponent (third-party; free Core, paid Pro), or a
  StaticMesh built from `UStaticMeshDescription` / `BuildFromStaticMeshDescriptions`.
- **Good for:** geometry that depends on game state (a track ribbon, a crater).
- **Breaks:** no Nanite or instancing for runtime components; physics cooking cost (async cooking helps);
  `CollisionTraceFlag` must be `CTF_UseSimpleAsComplex` or complex traces fail in Shipping (single-author report);
  one draw call per component; Epic describes the component as subject to substantial change.
- **Costs:** Time high per asset. Risk medium. Complexity high. Best practice: acceptable for runtime-only geometry,
  weak for static scenery. Maintainability good (diffable) but the quality ceiling is low.

## Code-driven CAD (build123d, CadQuery, OpenSCAD)

- **What:** parametric B-rep or CSG in code, tessellated to glTF/STL. OpenSCAD's default backend became Manifold
  (August 2025 development snapshots).
- **Good for:** exact dimensions, robust Booleans, analytic volume/area/centroid straight from the B-rep.
- **Breaks:** tessellation tolerance decides size and validity (build123d `export_gltf` defaults 1e-3 linear /
  0.1 angular; a 77 MB STEP became a ~1 GB GLB until tolerances were raised); CadQuery exports glTF only for
  assemblies; no UVs worth the name, no organic form, no rigging; agent reliability is measured on mechanical parts
  only (closed execute-measure-retry loops reported 95% to 100% execution success; untuned models fail often).
- **Verify:** execute, measure analytically, tessellate, validate watertightness and size, import check.
- **Costs:** Time medium. Risk medium. Complexity medium. Best practice: standard for engineering parts. Maintainability
  good (text source), but outputs need a re-tessellation step per target.

## Other DCCs and procedural tools (Houdini, Maya, Datasmith)

Use them only when the project already does. Known gaps from the evidence: Houdini's glTF 2.0 ROP does not export
morph targets and skins go through KineFX nodes only; Datasmith CAD import exposes chord/normal tolerance and
stitching, and its triangle counts swing widely with those settings (one sample: 37,500 vs 13,500 triangles across a
chord-tolerance change). Treat each as its own pipeline to engage with, not a default.
