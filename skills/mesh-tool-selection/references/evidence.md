# Evidence behind the tool-selection guidance

Sources captured on 2026-10-18 for the question "which mesh authoring tool, and how to engage an existing project". Each row says what the source is and what it does NOT establish. Official documentation is version-specific (Blender 4.2-5.2, Unreal 5.8); preprints, vendor posts, forum threads and mailing lists are anecdotal. Re-check a version-sensitive claim against the live page before relying on it.

## Blender Headless Scripting

- **Blender Python API Gotchas - Internal Data and Python Objects** <https://raw.githubusercontent.com/blender/blender/main/doc/python_api/rst/info_gotchas_internal_data_and_python_objects.rst>
  - Python wrappers of Blender data have limited lifetime and holding them persistently can cause invalid memory access, so keep your own references.
  - Requested names are not guaranteed (length limit, duplicates, empty string), so keep a name-to-datablock dict instead of looking up bpy.data by name.
  - Not established: Official main-branch docs; no headless-specific or performance guidance.
- **Validating glTF with the Khronos glTF-Validator (Vulkan Docs)** <https://docs.vulkan.org/tutorial/latest/Advanced_glTF/Tooling_Production_Pipeline/03_validation.html>
  - The validator reports four levels (Error, Warning, Info, Hint) and exits non-zero on errors, so it can gate CI after a headless Blender export (blender -b ... --python export script, then gltf_validator).
  - It catches misaligned accessor offsets, out-of-range buffer views, non-monotonic animation sampler inputs, morph target count mismatches and missing inverseBindMatrices; unnormalized skin weights and duplicate vertices are warnings.
  - Not established: Tutorial prose, not the validator's own spec; verify install commands against the validator repo; it checks spec conformance, not visual or engine-specific correctness.
- **Blender Python API Gotchas - Modes and Mesh Access** <https://raw.githubusercontent.com/blender/blender/main/doc/python_api/rst/info_gotchas_meshes.rst>
  - Edit-Mode data is out of sync with obj.data until exit, so scripts should exit Edit-Mode, call BMesh.to_mesh, use bmesh.from_edit_mesh, or refuse to run there.
  - For creating and editing geometry, bmesh faces are rated best, MeshPolygon poor (rigid, all data created at once) and MeshLoopTriangle unusable (read-only).
  - Not established: Official API structure docs, no performance measurements; nothing on glTF exporter triangulation.
- **Blender Python API Gotchas - Using Operators** <https://raw.githubusercontent.com/blender/blender/main/doc/python_api/rst/info_gotchas_operators.rst>
  - bpy.ops operators take no object arguments (they use context) and return only finished/cancelled, not results.
  - A failing poll() raises RuntimeError 'context is incorrect' and the reliable diagnosis is reading the poll function source; Context.temp_override helps supply context.
  - Not established: Short official page; no list of operators safe in background mode.
- **bpy - Blender as a Python Module (PyPI)** <https://pypi.org/project/bpy>
  - bpy 5.2.2 (published 2026-09-15) installs with pip install bpy and provides Blender as a Python module.
  - Each Blender release supports exactly one Python version and the package is compatible only with that version.
  - Not established: Thin landing page: no Python version number, size or headless/GPU limits stated.
- **Blender CLI Arguments - creator_args.cc Source** <https://raw.githubusercontent.com/blender/blender/main/source/creator/creator_args.cc>
  - `--python-exit-code <code>` (0..255) makes Blender exit with that code if a command-line Python script raises, so an agent must pass it to detect script failure; zero disables it.
  - Arguments execute in the order given, so `blender --background test.blend --render-output /tmp --render-frame 1` works but loading the blend file after `--render-output` overwrites the output path.
  - Not established: Partial read of a 116 KB source file; version is main-branch, not a pinned release.
- **StraySpark - Blender Collision Meshes for Game Engines** <https://www.strayspark.studio/blog/blender-collision-meshes-game-engines-ucx>
  - Unreal's FBX importer reads collider intent from name prefixes UBX_ (box), USP_ (sphere), UCP_ (capsule), UCX_ (convex hull) in the form <PREFIX>_<RenderMeshName>_##, and the mesh segment must exactly match the render object or the collider is ignored or imported as a visible mesh.
  - A UCX collider is reduced to its convex hull on import, so concave shapes (e.g. an archway) must be split into several convex pieces (three in the example) with 'One Convex Hull Per UCX' enabled; the post suggests 8-24 vertices per hull.
  - Not established: Vendor blog post promoting a Blender MCP product (anecdotal); the ~32-vertex hull cap and 8-24 range are unverified rules of thumb, and it covers FBX not glTF.
- **Blender Python API - Tips and Tricks** <https://raw.githubusercontent.com/blender/blender/main/doc/python_api/rst/info_tips_and_tricks.rst>
  - Non-interactive scripts run with `blender --background --python myscript.py` (add a .blend path first to give the script data), and results should be checked by rendering an image, saving a blend file, exporting, or writing text.
  - Blender from blender.org bundles its own Python, so system-Python packages are not found; workarounds are falling back to system Python via --python-use-system-env (major/minor versions must match) or copying packages into Blender's Python directory.
  - Not established: Official doc but short and partly dated (Python 3.7 examples); does not cover exit codes or exporters.
- **Infinigen-Articulated - Procedural Articulated Simulation-Ready Assets** <https://arxiv.org/abs/2505.10755>
  - Infinigen-Articulated provides procedural generators for 18 articulated object categories, built as Blender utilities.
  - It includes an export pipeline carrying physical properties into common robotics simulators.
  - Not established: Stub: arXiv abstract page only (v3, preprint), robotics focus rather than game engines; no methods or numbers beyond the 18 categories.
- **Blender 5.2 LTS Release Notes (Blender Foundation)** <https://www.blender.org/download/releases/5-2>
  - Blender 5.2 LTS (14 July 2026) glTF adds Meshopt compression (EXT/KHR_meshopt_compression), point clouds, iridescence and dispersion materials; glTF hook errors now stop the export.
  - Geometry Nodes modifier inputs/outputs are now RNA properties instead of modifier['...'] custom keys, so old scripts require updates.
  - Not established: Changelog summary only; features untested; full API change list is linked, not included.
- **Blender Python API Troubleshooting Errors and Crashes** <https://raw.githubusercontent.com/blender/blender/main/doc/python_api/rst/info_gotchas_crashes.rst>
  - Never hold direct references to Blender data across container modification, mode switches or undo; store indices or names and re-fetch.
  - Switching bpy.ops.object.mode_set EDIT/OBJECT reallocates mesh data, so held polygons/vertices crash; adding items to a collection or mesh reallocates arrays, so add all points at once.
  - Not established: Hazard documentation from main branch, not exhaustive and not headless-specific.
- **Blender Fast Mesh IO Forum Thread** <https://devtalk.blender.org/t/fast-mesh-io-for-addon-development/19962>
  - foreach_set accepts numpy arrays/buffer objects rather than needing Python lists, but the asker found numpy not much faster than lists.
  - A replier notes that for large meshes the time is often Blender's internal post-processing after the data copy, not the copy itself.
  - Not established: Anecdotal 2021 forum thread, truncated, no benchmarks or resolution.
- **Khronos Blender Glt Converter Script Tutorial** <https://github.khronos.org/glTF-Tutorials/BlenderGltfConverter>
  - Headless conversion command is blender -b -P script.py -- -mp <file>, where -- separates Blender args from script args.
  - The example imports OBJ with bpy.ops.import_scene.obj and exports with bpy.ops.export_scene.gltf; unset export parameters use the current Blender settings, so pin them for reproducibility.
  - Not established: Short template page; no error handling, version differences or output validation.
- **ProcFunc Procedural 3D Generation in Python** <https://arxiv.org/abs/2604.26943>
  - ProcFunc is a Python library for Blender-based procedural 3D generation that composes semantic components combinatorially for large-scale diverse synthetic data.
  - The authors report VLMs using it write new procedural code with significantly fewer coding errors (no numbers in the abstract).
  - Not established: Abstract only; synthetic-data focus, indirect relevance to game-ready asset export.
- **Blender Manual — glTF 2.0 Import and Export Add-on** <https://raw.githubusercontent.com/KhronosGroup/glTF-Blender-IO/main/docs/blender_docs/scene_gltf2.rst>
  - Quads and n-gons are triangulated on glTF export, and curves/non-mesh data must be converted to meshes first; discontinuous UVs and flat-shaded edges can raise vertex count.
  - Exporter supports KHR_draco_mesh_compression, EXT/KHR_meshopt_compression, EXT_mesh_gpu_instancing and KHR_materials_* extensions, but area lights and World lighting are ignored and transmission support is not widespread.
  - Not established: Option reference only; no headless bpy operator usage and tied to the captured Blender release (4.4+ behaviour).
- **BlenderKit asset_tasks Repository README** <https://github.com/BlenderKit/blenderkit_asset_tasks>
  - Production headless Blender pipeline: standalone scripts launch Blender with scripts from blender_bg_scripts/, e.g. generate_gltf.py --target_format gltf_godot.
  - Blender is found via BLENDER_PATH (single latest version, used for glTF/render tasks) or BLENDERS_PATH (X.Y-named directories, closest version used for tasks whose output re-enters users' Blenders).
  - Not established: README only; no actual Blender CLI flags, bpy export calls or glTF settings shown.

## Blender Python API Pitfalls

- **three.js Discourse - Blender Geometry Nodes Model to three.js** <https://discourse.threejs.org/t/how-can-we-use-blenders-3d-model-with-geometry-nodes-in-three-js/40116>
  - The vast majority of Blender nodes (geometry or material) cannot be exported to other software.
  - The workaround is to apply geometry-nodes modifiers so they become real mesh data before glTF export.
  - Not established: Single 2022 forum answer; anecdotal and Blender-version dependent.

## glTF Export from Blender to Game Engines

- **Importing Assets Using Interchange in Unreal Engine 5.8** <https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-assets-using-interchange-in-unreal-engine>
  - Interchange translates imports into a node structure, runs an ordered pipeline stack, then uses factories to create assets, falling back to the legacy framework for unsupported formats; pipelines are customisable in C++, Blueprint or Python.
  - File > Import Into Level works only with glTF and MaterialX, while FBX through Interchange is still Experimental behind Interchange.FeatureFlags.Import.FBX.
  - Not established: Clipping is truncated mid Python pipeline example; UE 5.8 only; no glTF-specific option details.
- **gltfpack README (meshoptimizer)** <https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md>
  - gltfpack quantizes, merges meshes, resamples animations and prunes nodes by default, simplifying only on request via -si R (ratio 0 to 1, default 1).
  - Compressed output (-c/-cc) needs EXT_meshopt_compression (three.js r122+, Babylon.js 5.0+) and default quantization needs KHR_mesh_quantization (three.js r111+, Babylon.js 4.1+).
  - Not established: Maintainer README for master branch; no benchmarks and no statement of Unreal/Unity compatibility with its extensions.
- **mcp-build123d - build123d MCP Server README** <https://github.com/Casys-AI/mcp-build123d>
  - The agent's script must leave its final Part, Solid, Compound or BuildPart in a top-level variable named `result`; build123d_execute returns volume, area, centroid, bounding box and topology counts (a 60x40x5 mm bracket example reports 11717.2567 mm3 and 8 faces).
  - Metrics come analytically from the BREP kernel, not from STL or GLB tessellation; STEP keeps exact BREP while STL and GLB are tessellated delivery formats.
  - Not established: Project README; qualified only for build123d==0.11.1 / OCP 7.9.3.1, and immutable export promotion is documented for macOS and Linux only (not Windows).
- **Unreal Interchange Import Reference 5.8** <https://dev.epicgames.com/documentation/en-us/unreal-engine/interchange-import-reference-in-unreal-engine>
  - Import Into Level supports FBX, glTF, GLB and MaterialX with only a subset of the full Interchange options.
  - Custom collision imports by mesh-name prefix: UBX_ (box), UCP_ (capsule), USP_ (sphere), UCX_ (convex), with an option for one convex hull per UCX.
  - Not established: Version 5.8 options list only; some table cells truncated; no recommendations.
- **SideFX Houdini 21 Engine APIs and Plug-ins News** <https://www.sidefx.com/docs/houdini/news/21/engine.html>
  - Houdini 21's Unreal plug-in adds PCG Graph integration for HDAs and a Houdini Asset Editor, supporting Unreal 5.5 and 5.6.
  - Houdini adds KineFX glTF import nodes (animation, character, skin) and an Adobe USD file-format plugin for FBX/glTF/SBSAR import and FBX/glTF export.
  - Not established: Short vendor feature list; no performance, headless, or licensing information.
- **CadQuery Importing and Exporting Files** <https://cadquery.readthedocs.io/en/latest/importexport.html>
  - CadQuery exports glTF/GLB only for assemblies (extension picks .glb vs .gltf), and no supported format carries parametric data; only CadQuery Python is fully parametric.
  - STL export tolerance defaults to 1e-3 (linear) and angularTolerance 0.1; too low gives huge meshes, too high gives coarse detail, and relative=True scales tolerance by edge size and can facet large features.
  - Not established: Documents the API only; no game-engine import, scale/axis, or material verification.
- **Castle Game Engine Blender Game Data Guide** <https://castle-engine.io/blender>
  - Recommended Blender glTF export: check Geometry > Apply Modifiers and use glTF Separate (.gltf + .bin + textures) with Keep Original textures so files share textures by relative path.
  - Actions must be Stashed in the Action Editor to export reliably, and Blender custom properties on materials, cameras, meshes and objects export to glTF as engine metadata.
  - Not established: Engine-specific (CastleCollision property), interactive-Blender oriented, Blender 4.2 only.
- **Khronos glTF Validator Repository** <https://github.com/KhronosGroup/glTF-Validator>
  - The validator checks glTF 2.0 spec conformance (JSON, GLB container, schema, references, NaN/invalid accessor values, quaternions, matrices, accessor min/max) and writes a JSON report.
  - CLI is gltf_validator <input>, writes <asset>.report.json, validates directories recursively, and returns a non-zero exit code if any error is found, making it CI-friendly.
  - Not established: README only; conformance checking, not efficiency or engine import success.
- **SideFX Houdini — Import and Export glTF** <https://www.sidefx.com/docs/houdini/io/gltf.html>
  - Houdini 22.0 glTF support is mid-migration to a new library, so GLTF 1.0 and 2.0 nodes coexist with different feature coverage.
  - Per the support matrix, skins are supported only by the KineFX character exporter/importer nodes, and ROP GLTF 2.0 does not export morph targets.
  - Not established: Feature matrix was captured as icon images and inferred from icon file names; material support table cells were empty; recheck against live page.

## Mesh Boolean Robustness

- **Interactive and Robust Mesh Booleans** <https://arxiv.org/abs/2205.14151>
  - Floating-point mesh Booleans are notoriously unreliable because numerical approximation makes intersection detection inconsistent, exposing them to degeneracy and failure.
  - Exact-predicate or rational methods are robust but have been restricted to offline use because of computation time.
  - Not established: Stub: arXiv abstract only; the speedup is the authors' own claim and no production tool (Blender, build123d, Unreal) is evaluated.
- **Manifold GitHub README (elalish)** <https://github.com/elalish/manifold>
  - Manifold provides a Boolean claimed by its maintainer to be the first guaranteed-manifold mesh Boolean; inputs must already be manifold or an error status is returned.
  - Used by OpenSCAD, Blender, Godot, Babylon.js, trimesh and PyVista, with bindings for C++, JS/WASM, Python, Rust and more.
  - Not established: Maintainer README with no independent benchmarks; robustness claim is self-reported.
- **GrandpaCAD - OpenSCAD vs CadQuery vs Build123d** <https://grandpacad.com/en/blog/openscad-vs-cadquery-vs-build123d>
  - OpenSCAD averaged about 0.4 LLM code errors per generation versus roughly 1.4 to 1.7 for Build123d on the same model tier.
  - Build123d had 40 code errors on a run, 33 with a generated exact-signature API reference, so documentation narrows but does not close the gap.
  - Not established: Single-vendor anecdotal benchmark with one cheap model tier; measures code errors, not geometry quality.
- **OpenSCAD Mailing List - Manifold Backend Default** <https://lists.openscad.org/empathy/thread/TMJEJCZINIJNYJX2YF7IDNBAPQY66KIF>
  - On 17 August 2025 the OpenSCAD maintainer made the Manifold backend the default in development snapshots from the next nightly build.
  - The maintainer says this gives significantly faster rendering, with CGAL still selectable via preferences or openscad --backend=cgal.
  - Not established: Short mailing-list announcement; anecdotal, no speed numbers, dev snapshots only.
- **Attene et al - Polygon Mesh Repairing Survey (2013)** <https://www.graphics.rwth-aachen.de/publication/0314>
  - Peer-reviewed survey (ACM Computing Surveys vol. 45 no. 2, Feb 2013) classifying mesh defects by upstream application and quality requirements by downstream application.
  - It classifies repair methods by capabilities, properties and guarantees to guide choosing a repair algorithm.
  - Not established: Abstract-only clipping, page set to status: stub; 2013 survey predates current tools.
- **trimesh 5.1.1 Documentation** <https://trimesh.org>
  - trimesh needs only numpy (Python 3.10+), loads and exports GLB/GLTF 2.0 among many formats, and provides is_watertight, euler_number, volume and repair of simple winding/normal/hole problems.
  - Default load merges vertices sharing a position and removes NaNs (process=False disables), and load_mesh on a multi-mesh GLB concatenates irreversibly, so use load_scene to keep instances.
  - Not established: Landing page only; no benchmarks or glTF spec-validity claims.

## Unreal Geometry Scripting

- **Unreal Engine 5.8 Release Notes** <https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-8-release-notes>
  - Geometry Script/Core in UE 5.8 adds QEM simplification regularization, an edge-constraint tolerance, weight-map-driven simplify and Remesh, and OpenSubdiv now interpolates UVs, skin weights and colors.
  - USD via Interchange is production ready for asset import (experimental for level import) in 5.8, while FBX stays the main import format (experimental uFBX speeds up heavy imports) and glTF gets only minor exporter/reader fixes.
  - Not established: Partial read of a ~750 KB changelog; only mesh-relevant sections were read, vendor-primary, version-specific to UE 5.8.
- **Unreal Python API - GeometryScriptCreateNewStaticMeshAssetOptions** <https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/GeometryScriptCreateNewStaticMeshAssetOptions>
  - Geometry Script's create-new-static-mesh-asset options default enable_nanite, enable_collision, enable_recompute_normals and enable_recompute_tangents to False, so Nanite and collision must be requested explicitly (collision paired with a CollisionTraceFlag in collision_mode).
  - nanite_settings (an engine MeshNaniteSettings) replaces the deprecated nanite_proxy_triangle_percent property.
  - Not established: Official but terse, Experimental-marked property listing; the editor-only availability is inferred from the module name GeometryScriptingEditor.
- **Unreal Geometry Scripting Function Reference** <https://dev.epicgames.com/documentation/unreal-engine/geometry-scripting-reference-in-unreal-engine>
  - Most Geometry Scripting functions work in the editor and at runtime, but some (e.g. Create New Static Mesh Asset From Mesh) are editor-only.
  - Apply Mesh Boolean does Union/Intersect/Subtract and Apply Mesh Self Union repairs self-intersections; Simplify offers Triangle Count, Vertex Count, Tolerance, Planar and PolyGroup Topology modes.
  - Not established: Function catalogue only; partial read of UV/polygroup/sampling tables.
- **Unreal Geometry Scripting Users Guide** <https://dev.epicgames.com/documentation/unreal-engine/geometry-scripting-users-guide-in-unreal-engine>
  - Geometry Scripting is labelled Beta with a caution about shipping.
  - UDynamicMeshComponent supports raytracing but not Nanite, Lumen, Mesh Distance Field, LODs or instanced rendering, and a UDynamicMesh is not an asset (stored in the level, copied on duplicate).
  - Not established: UE 5.8 guide; no performance numbers.
- **zomg - Runtime Static Meshes via UStaticMeshDescription** <https://zomgmoz.tv/unreal/Generating-static-meshes-at-runtime-using-UStaticMeshDescription>
  - UStaticMeshDescription-based runtime mesh generation reportedly works in Shipping packaged builds, with BuildFromStaticMeshDescriptions optionally generating simple collision.
  - CollisionTraceFlag must be set to CTF_UseSimpleAsComplex or complex line traces fail in shipping, and CreateNavCollision() must be called for navmesh to update.
  - Not established: Anecdotal single-author note, UE 5.4-era, snippets not run.
- **RealtimeMeshComponent for Unreal Engine 5 (TriAxis Games)** <https://github.com/TriAxis-Games/RealtimeMeshComponent>
  - RMC (free MIT Core edition) is a replacement for ProceduralMeshComponent and DynamicMeshComponent with stream-based mesh data, LODs, sections, collision and Blueprint plus C++ APIs; supports UE 5.5 to 5.8.
  - The paid Pro edition adds UDynamicMesh integration, static-mesh/OBJ conversion, mesh-to-SDF with Lumen cards, compute-shader generation, spatial streaming, a runtime Nanite builder and meshoptimizer-based optimization.
  - Not established: Vendor README with no benchmarks or comparison against ProceduralMeshComponent; runtime Nanite is Pro-only and undetailed.

## Unreal Procedural Mesh Approaches

- **UProceduralMeshComponent - Unreal Engine 5.8 API Reference** <https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/ProceduralMeshComponent/UProceduralMeshComponent>
  - Epic's own description warns the component is experimental and may be substantially changed in future releases.
  - CreateMeshSection takes per-section vertices, triangles, normals, UV0-UV3 (four channels), vertex colors, tangents and a bCreateCollision flag; the FColor variant is deprecated for Blueprints in favor of CreateMeshSection_LinearColor.
  - Not established: Official reference listing only; no comparison with Geometry Script, no Nanite/LOD discussion, no performance numbers.
- **Instanced Static Mesh Component - Unreal Engine 5.8 Documentation** <https://dev.epicgames.com/documentation/unreal-engine/instanced-static-mesh-component-in-unreal-engine>
  - Epic states a GPU primitive uses roughly ten times the memory of a basic instance (672 bytes vs 64 bytes), illustrated with 200 non-Nanite books as separate actors vs one ISM actor.
  - HISM uses a static hierarchy to accelerate culling/LOD and suits thousands of non-moving instances; plain ISM culls and LODs each instance on the GPU, which can be expensive on lower-powered platforms.
  - Not established: Official doc about placement/instancing performance, only tangential to mesh authoring; memory figures are Epic's illustrative numbers.

## Unreal Mesh Import Pipeline (Interchange)

- **Nanite Virtualized Geometry in Unreal Engine 5.8** <https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine>
  - Epic recommends enabling Nanite wherever supported (many triangles, many instances, major occluders, VSM casters); supported materials are Opaque and Masked only, and morph targets are not supported while WPO is limited.
  - Nanite instance count is hard-capped at 16 million streamed-in instances, and it requires DirectX 12 Shader Model 6 hardware; unsupported rendering features include Forward Rendering, MSAA, stereo VR and Lighting Channels.
  - Not established: UE 5.8 specific; no triangle thresholds or guidance on runtime-generated meshes.
- **Simple versus Complex Collision in Unreal Engine 5.8** <https://dev.epicgames.com/documentation/unreal-engine/simple-versus-complex-collision-in-unreal-engine>
  - Unreal creates both simple (primitives/convex hulls) and complex (trimesh) collision by default and the solver chooses by query type.
  - Collision Complexity has four options; Use Simple Collision As Complex saves memory by not baking the trimesh.
  - Not established: Very short; nothing on authoring collision in Blender, naming conventions or convex decomposition.
- **Mondlicht Studios - Engineering Data to CGI** <https://digitalproduction.com/2023/11/11/engineering-data-to-cgi-what-could-possibly-go-wrong>
  - CAD is NURBS and must be tessellated to polygons; chord length and angle deviation are the key settings (lower means more detail), so near-zero values bloat polycount.
  - Request STEP/IGES parts exports with transforms applied and avoid tessellating huge files (e.g. a 10 GB part); deleting clutter like 400 weld spheres can save millions of polygons.
  - Not established: Anecdotal studio practitioner article from 2023; commercial tool names and prices dated.
- **Unreal Issue UE-248981 - Interchange FBX Collision Naming** <https://issues.unrealengine.com/issue/UE-248981>
  - In UE 5.5 Interchange renames a mesh inside a same-named FBX group node to MyAsset1, breaking name-matched collision that worked with the legacy importer in 5.4.
  - The reporter traced it to FFbxParser::EnsureNodeNameAreValid and worked around it by appending _Group to group node names.
  - Not established: One FBX/Maya regression; says nothing about glTF import.
- **Unreal InterchangeGenericMeshPipeline Python API 5.8** <https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/InterchangeGenericMeshPipeline>
  - build_nanite plus nanite_triangle_threshold control Nanite on import; a threshold of 0 enables Nanite for every imported mesh.
  - Collision prefixes UBX_, UCP_, USP_ and UCX_ import box, capsule, sphere and convex collision when import_collision_according_to_mesh_name is on; with collision on and none supplied, generic collision is auto-generated.
  - Not established: 5.8 Experimental property reference only; no defaults guidance or glTF-specific behavior.
- **Working with Nanite-Enabled Content UE 5.8** <https://dev.epicgames.com/documentation/en-us/unreal-engine/working-with-naniteenabled-content>
  - Vertex-to-triangle ratio of 2:1 or higher signals faceted normals and slow paths; 3:1 means every triangle has unshared vertices, so smooth normals before Nanite import.
  - Aggregate geometry (leaves, grass, hair) and closely stacked surfaces defeat Nanite's LOD and occlusion culling; use the Overdraw visualization, and use Preserve Area plus real geometry over masked cards for foliage.
  - Not established: Vendor guidance for 5.8 with no measured frame times; several features are experimental or Beta.
- **Unreal Engine 5.8 Docs — Importing CAD with Datasmith** <https://dev.epicgames.com/documentation/unreal-engine/importing-cad-files-into-unreal-engine-using-datasmith>
  - Chord tolerance example: 0.5 mm gives 37,500 triangles versus 10 mm giving 13,500.
  - Normal tolerance example: 5 degrees gives 295,000 triangles, 10 degrees 100,000, 40 degrees 21,500; max edge length 10/20/40 mm gives 128,000/43,700/21,000, and 0 means unlimited.
  - Not established: Triangle counts are from one illustrative sample; covers Datasmith CAD import only, not Interchange glTF, scripting or Nanite.

## Nanite Eligibility and Trade-offs

- **Nanite - A Deep Dive (SIGGRAPH 2021)** <https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf>
  - Nanite splits meshes into 128-triangle clusters and builds a LOD DAG by grouping, simplifying to 50% of triangles and re-splitting, with LOD chosen per cluster to stay under 1 pixel of screen error.
  - Clusters with triangles under 32 pixels long are software rasterized and larger ones use hardware; in the Lumen in the Land of Nanite demo 433M input triangles became 882M Nanite triangles and 25.9GB raw compressed to 4.61GB on disk (about 11.4 bytes per input triangle).
  - Not established: 2021 early-access view, unsupported-feature list outdated; transcript is about 1,866 lines and was read partially via targeted search.
- **Nanite vs Overdraw-Focused LODs Forum Thread** <https://forums.unrealengine.com/t/nanite-performance-is-not-better-than-overdraw-focused-lods-test-results-epics-documentation-is-dangering-optimization/1263218>
  - The author reports a 10,000+ instance scene with hand-made LODs (over 1,000,000 triangles) still ran faster than Nanite (4,000-6,000 triangles), by about 1.5 ms.
  - In a Lyra test the author reports Nanite adding 9-11% GPU overhead at lowest settings and about 20% at the high preset; a user reports City Sample vehicles at 40 fps with Nanite versus 80+ fps without.
  - Not established: Anecdotal, partisan forum thread with unverifiable screenshots and mixed engine versions; critics note unrealistic test scenes.
- **meshoptimizer v1.0 Release Post** <https://meshoptimizer.org/v1.html>
  - Vertex codec v1 gives about 10% smaller output and decodes up to 30% faster than v0 on Apple M4 (over 5 GB/s), but glTF EXT_meshopt_compression supports only v0.
  - gltfpack supports only core glTF plus Khronos extensions, uses attribute-aware simplification with pruning by default, and offers KHR_meshopt_compression via -cz though loader support is not yet widespread.
  - Not established: Maintainer's own release announcement with author-run benchmarks; no gltfpack command recipes or triangle-count results.

## Collision Authoring for Imported Meshes

- **Approximate Convex Decomposition with Collision-Aware Concavity and Tree Search** <https://arxiv.org/abs/2205.02961>
  - Approximate convex decomposition splits a mesh into near-convex parts whose hulls represent it, and the abstract notes wide use in game engines, physics simulation and animation.
  - The method cuts the mesh directly with 3D planes, which the authors say yields intersection-free convex hulls and avoids voxelization errors.
  - Not established: Stub: arXiv abstract only (2022, related ACM DOI); no numbers, and not tied to Blender or Unreal tooling.

## Mesh Simplification and LOD

- **Garland and Heckbert — Surface Simplification Using Quadric Error Metrics** <https://www.cs.princeton.edu/courses/archive/fall06/cos526/papers/garland97.pdf>
  - Quadric error metric stores 10 floats per vertex and simplified a 70,000-face model to 100 faces in 15 seconds on 195 MHz-era hardware.
  - Optimal contraction placement cut approximation error by as much as about 50% (47.6% at 500 faces) versus choosing endpoints or midpoint.
  - Not established: 1990s timings and no attribute/colour handling; venue not stated in clipped text; PDF extraction garbled some equations.
- **Unity — How to Choose a CAD-to-Real-Time-3D Pipeline** <https://unity.com/resources/cad-to-real-time-3d-pipeline>
  - Tessellation presets span 0.01 mm to 3 mm max sag, and the guide says tessellating well beats tessellating densely then decimating; pair sag with a max-angle setting.
  - Cited budgets: Quest 3/3S 1.3m-1.8m triangles and 200-1,000 draw calls, visionOS Shared Space 250k triangles/250 draw calls, web and mobile AR 100,000 triangles and 10 MB; no vendor publishes an LOD count.
  - Not established: Vendor-primary (Unity Asset Transformer marketing); budget figures are second-hand and XR/industrial-CAD oriented.

## Code-Driven CAD for Agents

- **CAD-Coder Text-to-CAD with CadQuery (arXiv)** <https://arxiv.org/abs/2505.19713>
  - CAD-Coder frames text-to-CAD as generating CadQuery (Python parametric CAD) scripts, which the authors say allows direct geometric validation.
  - It trains with supervised fine-tuning then GRPO reinforcement learning using Chamfer Distance and format rewards, on a dataset of 110K text-CadQuery-3D triplets plus 1.5K chain-of-thought samples.
  - Not established: Stub: abstract only, concerns a fine-tuned model not a prompted agent, no reliability numbers.
- **CADSmith Multi-Agent CadQuery Generation (arXiv 2603.26512)** <https://arxiv.org/abs/2603.26512>
  - Closed-loop CadQuery generation raised execution success from 95% to 100% on 100 prompts and cut mean Chamfer Distance from 28.37 to 0.74 (median IoU 0.8085 to 0.9629).
  - 88 of 100 prompts converged on the first iteration (0.13 refinement iterations on average); loops are capped at 3 execution retries and 5 geometric refinements.
  - Not established: Non-peer-reviewed preprint, small author-built benchmark, manufacturing B-rep rather than game meshes.
- **Text-to-CadQuery LLM CAD Generation** <https://arxiv.org/html/2505.06507v1>
  - Fine-tuned Qwen2.5-3B reached 69.30% on a Gemini visual same-object judgement versus 58.80% for the Text2CAD baseline, with median Chamfer Distance 0.191 vs 0.370 (x10^3).
  - Without fine-tuning, most open-source models failed to produce valid CadQuery, while GPT-4o was over 90% executable first try; fine-tuned invalid rates ran from 9.4% (124M) down to 1.32% (LoRA Mistral-7B).
  - Not established: Preprint; DeepCAD sketch-extrude mechanical parts only, partly VLM-judged, about fine-tuned small models.
- **Text2CAD-Bench LLM Text-to-Parametric CAD Benchmark** <https://arxiv.org/abs/2605.18430>
  - The benchmark has 600 human-curated examples across four levels, from standard features (L1-L2) to complex topology and freeform surfaces (L3) and real-world domains beyond mechanical parts (L4).
  - Each example has dual prompts: non-expert geometric description and expert procedural sequence.
  - Not established: Abstract only; no scores or named libraries, preprint.
- **build123d Docs — Import and Export** <https://build123d.readthedocs.io/en/latest/import_export.html>
  - export_gltf defaults to linear_deflection=0.001 and angular_deflection=0.1, writes text .gltf unless binary=True, and includes UVs as TEXCOORD_0.
  - export_stl and export_obj use the same 1e-3 / 0.1 deflection defaults; OBJ export packs UVs into one atlas and writes no .mtl or texture files.
  - Not established: API reference from a dev build; says nothing about glTF output size, materials, rigging or engine import.
- **CadQuery Discussion 1625 — Exported GLB Is Too Large** <https://github.com/CadQuery/cadquery/discussions/1625>
  - A 77.2 MB STEP exported through CadQuery Assembly.save as GLB came out around 1 GB.
  - Maintainer advice was to raise the tolerance and angularTolerance export parameters.
  - Not established: Anecdotal forum thread (2024); no sizes after tuning given and may not reflect current CadQuery.
- **Zhou et al — Topology-First B-Rep Meshing** <https://arxiv.org/abs/2604.02141>
  - Authors say B-Rep to mesh conversion remains fragile and existing pipelines use heuristic repair with no topological guarantees.
  - Method treats B-Rep topology as invariant, with one user-set tolerance controlling only geometric deviation, claimed topologically correct for any admissible tolerance.
  - Not established: Stub: abstract only of a non-peer-reviewed arXiv preprint (Apr 2026); no algorithm details, timings or code availability.

## glTF Validation and Optimization Tooling

- **Three.js Docs — GLTFExporter** <https://threejs.org/docs/pages/GLTFExporter.html>
  - GLTFExporter defaults to binary=false (glTF JSON output), onlyVisible=true, trs=false, and maxTextureSize=Infinity (no texture downscaling).
  - Exports a Scene or array of Scenes via parse() or parseAsync(); multi-scene animation export needs a nested clip array matched by index.
  - Not established: Short API reference with no version stated; no guidance on compression, validation or engine import.
