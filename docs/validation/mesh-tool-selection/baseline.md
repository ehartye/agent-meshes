# Final baseline planning answers

## A

Use a Blender-authored hybrid: Blender Python creates the assets; agent-meshes handles repeatable builds, GLB validation and review; Unreal editor scripting imports, assigns the existing ink material and places assets. Keep gameplay behavior in Unreal. Assume these are fixed scenery; preserve named pivots if blades or other parts need independent control.

First slice: one windmill and one tank, chosen to exercise thin blades, curved surfaces, openings and collision. Retain their existing C++ versions for comparison. Record dimensions, pivots, axes, material roles, vertex-color channels and importer settings before modeling.

The baseline mesh-build guide's static-prop helper deliberately strips color attributes. That preset conflicts with your ink shader: explicitly retain the required colors and verify their imported values and rendered effect. Do not merge away addressed nodes. Keep forward shading/MSAA; this trial does not require Nanite.

Evidence needed: actual UE 5.8 import, correct scale/orientation, native material assignment/readback, representative game-camera renders, collision and packaged-game behavior. Compare placement iteration and measured runtime costs against the existing construction path. GLB validation and verify-unreal establish narrower facts.

Time: a small trial precedes the remaining 28 props. Risk: material/color and collision translation are the main uncertainties. Complexity: one reproducible asset boundary plus a small import adapter. Best practice: validate the destination contract before batch production. Maintainability: keep parameterized Python sources, build configs, input identities and import settings together.

Next step: define the two acceptance fixtures and their budgets, then author only those.

## B

No. The validator establishes GLB structural validity; verify-unreal establishes the reported import checks. The baseline mesh-build guide explicitly says it proves import only. Neither certifies runtime deformation, collision updates, cooking or performance.

Separate the proposal into supported responsibilities. Unreal editor Python can prepare assets and levels; it is not the execution layer for a shipped game. Implement live crater creation through runtime C++ or Blueprint APIs. Geometry Script has runtime-capable functionality, but individual operations can be editor-only: select and check the exact operations against the target engine.

A changing DynamicMeshComponent is not automatically a Nanite static mesh. Treat Nanite as a separate, demonstrated rendering choice, not a flag that makes arbitrary runtime topology work. Instancing shares geometry; independently deformed craters need explicit geometry ownership or a reusable, fixed crater representation. Collision generation and update timing require their own implementation.

Assume craters remove traversable ground and affect vehicles. The smallest trial is one impact on one representative ground patch in a packaged build: inspect the actual hole, query and drive across its collision, repeat impacts, reset, and measure mesh-update, collision-cook and frame costs.

Time: resolve this runtime boundary before asset production. Risk: stale collision or unsupported packaged APIs can break play. Complexity: keep rendering and collision ownership explicit. Best practice: test the shipped execution path. Maintainability: isolate crater generation behind one interface.

Next step: inventory the proposed Geometry Script calls and build that packaged trial.

## C

Choose Python code CAD as the dimensional source, using CadQuery or build123d. Assume the fabrication drawing needs authoritative dimensions and holes. Pin the library/kernel versions and confirm its drawing/export workflow.

The current Python project gains a CAD dependency, but a single dimension table can drive all 24 variants, exact solids and tessellated game exports. Retain a CAD exchange artifact, such as STEP, alongside the drawing. A tessellated GLB alone is not the fabrication authority.

Headless Blender is the natural later stage if game presentation needs mesh-specific materials, bevel control or GLB export; it can run as a separate process without adding bpy to the application's interpreter. In-process bpy would introduce Python/platform/package compatibility and process-state questions without solving the fabrication requirement. The frozen Blender guides document execution inside Blender and an external CLI path; they do not certify your interpreter's bpy compatibility.

Smallest trial: generate one bracket at the most demanding dimensions, with a through-hole and fillet, then a second variant changing thickness and hole spacing. Produce a dimensioned drawing and game mesh from the same parameters. Measure critical dimensions, inspect topology/normals, and check the game's imported scale and pivot.

Time: trial two variants before generating 24. Risk: drawing fidelity and tessellation/export gaps need evidence. Complexity: one CAD authority, optional separate Blender conversion. Best practice: separate exact design geometry from game tessellation. Maintainability: version the dimension table and source, regenerate outputs.

Next step: specify tolerances, required drawing format and export acceptance measurements.

## D

Route to mesh-build for fixed front/back renders of the approved GLB. Use the existing asset and explicit view selection; no modeling or reauthoring is needed.

## E

Route to mesh-rigging for the named-part workspace binding and weights. Inspect the elbow's existing rig and isolated bend before changing influences; export and check the posed result afterward.

## F

Route to mesh-setup: check the managed installation, install when missing, then check again. Use the resolved plugin launcher and managed release; do not install dependencies in the plugin cache.

## G

Route to the actual Unreal import/integration path. UCX naming is importer-specific, not a portable GLB collision contract. Retain the proven FBX collision route or explicitly generate/assign collision after GLB import, then test native collision.
