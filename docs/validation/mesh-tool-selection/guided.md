## A

Use a Blender headless `build()` script through agent-meshes' managed wrapper for the authorized hybrid trial; retain existing C++ placement and use Unreal editor Python/Interchange for import/configuration. Named-part authoring suits primitive assemblies, but Blender supplies bevels, Booleans and UV work when needed.

Known: scenery is generated during editor construction, so it can be baked; GLB cars prove an import route exists, not the scenery contract. Forward shading/MSAA rules out Nanite here. Target saved UStaticMeshes, authored LODs and ISM/HISM where repetition warrants them.

Before modeling, read project instructions, generators, car imports and material code. Record unknown units/axes/pivots, naming, slot counts, ink vertex-color semantics, collision ownership, importer settings and budgets. Preserve required COLOR_0 data; do not copy the chess recipe's color stripping or one-material policy blindly.

First slice: one representative tank with the required hard-surface detail and ink colors, imported through the real project and placed repeatedly by its existing generator. Pin exporter settings and fail on script errors. Propose format/budget validation, verify-unreal, exported-GLB renders, engine inspection of scale/pivot/colors/materials/LODs, and packaged collision plus measured repeated-instance cost. Expand only after these pass.

- **Time:** script/import setup now; variants reuse it, with export and engine-compilation lag.
- **Risk:** exporter/importer drift can corrupt colors or collision across the batch; the slice limits exposure.
- **Complexity:** adds a DCC/export boundary alongside existing placement.
- **Best practice:** extend the supported importer and bake fixed scenery.
- **Maintainability:** retain scripts, parameters, versions, contract and verification commands.

No checks have run.

## B

No. Those checks establish format/import facts, not runtime gameplay behavior. verify-unreal does not render, animate or prove collision updates, packaged execution or performance.

Choose a runtime-supported Geometry Script path for the live crater geometry and collision, subject to a packaged proof. Unreal editor Python handles editor asset operations; it cannot run as shipped gameplay. UDynamicMeshComponent does not supply Nanite or instanced rendering. Repeated fixed scenery can remain baked StaticMeshes with ISM/HISM; that does not make independently deforming crater components instances.

Known: topology and collision change during play. Unknown: installed engine version, exact Geometry Script functions/component, renderer, collision/query policy, vehicle contacts, crater/update counts and frame/memory budgets. Inspect the existing runtime generator and these contracts first; Geometry Script has editor-only functions and shipping cautions.

Next, implement one reversible crater using the exact intended runtime functions and package a Shipping build. Test vehicle traces and simulation before/after deformation, collision cooking delay, repeated/overlapping updates, cleanup and target-load game/render/GPU timing. Inspect the visual result in-engine. Set acceptance thresholds before measuring; do not label it faster without comparison.

- **Time:** runtime wiring and packaging cost setup time; Boolean operations and collision cooking may add gameplay latency.
- **Risk:** unavailable packaged functions or stale collision can break driving; severity warrants native gameplay checks.
- **Complexity:** owns dynamic geometry, collision refresh and update scheduling.
- **Best practice:** reserve runtime topology changes for actual live edits; use runtime-supported APIs.
- **Maintainability:** keep generator parameters and engine-version packaged tests.

This trial has not run.

## C

Choose code CAD, such as build123d, as the dimensioned source; generate a tessellated game mesh and fabrication drawing from that source. Assumption: these are rigid mechanical brackets whose dimensions and holes matter more than sculpted form.

An existing Python project does not justify adding in-process bpy. That route couples Python and Blender versions without supplying CAD's analytic engineering model. Headless Blender is useful for a later UV/shading pass if the game trial shows one is needed; keep CAD dimensions authoritative.

Inspect existing Python packaging, asset conventions and drawing examples first. Unknowns: target engine/importer, unit system, dimensional tolerances, drawing requirements, material/UV/collision expectations and triangle/file-size budgets. Check the chosen CAD tool's supported mesh and drawing outputs rather than assuming a GLB is a fabrication deliverable.

Smallest trial: one bracket family at nominal and most demanding dimensions. Execute and measure hole diameters, spacing, thickness and volume against parameters; produce the drawing and inspect dimensions, units and annotations. Tessellate with explicit tolerances; check watertightness, silhouette, bounds and file size, then validate, import and inspect shading/collision in the target engine. Retry tolerances before generating 24 variants.

- **Time:** parameterization and two export targets cost setup; later variants reuse dimensions and checks.
- **Risk:** kernel failures or tessellation extremes can invalidate parts or bloat meshes; measure both representations.
- **Complexity:** adds a CAD kernel and separate engineering/game exports.
- **Best practice:** retain analytic dimensions and verify each deliverable independently.
- **Maintainability:** pin kernel versions, parameters and target-specific export settings.

No trial has run.

## D

Route directly to mesh-build for fixed front/back renders of the approved exported GLB.

## E

Route directly to mesh-rigging to inspect and repair elbow weights in the existing named-part workspace, then review representative bent poses.

## F

Route directly to mesh-setup to install or repair the managed runtime and run its setup check.

## G

Use mesh-tool-selection: inspect the GLB importer's collision contract and probe one collider. UCX naming is documented for Unreal's FBX path; it is not a glTF guarantee. Resolve importer-side collision handling before batching.
