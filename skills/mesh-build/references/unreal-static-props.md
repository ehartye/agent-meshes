# Static props in Unreal

`verify-unreal` imports into its own locked scratch project through Interchange. It checks the imported asset; it does not render, run physics, cook, or modify the consuming game project. Use Agent Engine's guarded import helper to import into an owned destination in a real project.

```text
mesh verify-unreal barrel.glb --expect-bounds-cm 80,80,120 --bounds-tolerance-cm 0.1 --json
mesh verify-unreal kit.glb --static-mesh Barrel --expect-nanite off --expect-full-precision-uvs on --json
mesh verify-unreal rubble.glb --expect-collision complex-as-simple --expect-double-sided on --json
mesh verify-unreal rubble.glb --import-options import-options.json --expect-nanite off --expect-full-precision-uvs on --json
mesh verify-unreal --axis-calibration --json
```

## Measurements and expectations

Each `staticMeshes` entry retains `path`, `lods`, `vertices` and `materials`, and adds:

| Field | Meaning |
| --- | --- |
| `triangles[lod]` | Triangles in the LOD's render resource through `StaticMesh.get_num_triangles`. For a Nanite asset this describes fallback render data, not the Nanite representation. |
| `naniteTriangles` | Triangles in the Nanite representation through `get_num_nanite_triangles`, kept separate from LOD counts. |
| `boundsCm` | Asset-local Unreal XYZ **centimetres**: `min`, `max`, `center`, and `size`. Size is `max - min`, the full span, never the half extent. `get_bounding_box()` includes configured bounds extensions. These are asset bounds, not an actor/component's world bounds. |
| `naniteEnabled` | The asset's Nanite enable setting. This does not prove the target platform supports it or that the Nanite path rendered. |
| `fullPrecisionUVs[lod]` | Each source model's `use_full_precision_u_vs` build setting. This does not inspect the GPU buffer or prove UV accuracy at runtime. |
| `collisionTraceFlag` | The BodySetup's stored `CTF_USE_DEFAULT`, `CTF_USE_SIMPLE_AND_COMPLEX`, `CTF_USE_SIMPLE_AS_COMPLEX` or `CTF_USE_COMPLEX_AS_SIMPLE` enum. `DEFAULT` delegates to project physics settings; this readback does not resolve the consuming project's defaults. |
| `doubleSidedGeometry` | The BodySetup's double-sided triangle-mesh scene-query setting. This is separate from a two-sided material. It does not establish cooked collision, actual ray coverage or runtime simulation. |
| `measurementErrors` | Reasons why measurements could not be read. Unavailable measurements are `null`, never fabricated `false` or zero. |

`--expect-bounds-cm X,Y,Z` requires positive finite **full sizes** in Unreal axis order. Each axis must be within `--bounds-tolerance-cm` (default 0.1 cm). `--expect-nanite on|off` checks the enable setting. `--expect-full-precision-uvs on|off` checks every reported LOD's build setting. An unavailable required measurement fails. The tool reports settings without changing them.

These expectations require exactly one StaticMesh. For multiple imported meshes, select an exact basename or full asset path with `--static-mesh`; an ambiguous or missing selection fails. Existing character contracts and geometry-loss checks still apply.

`--expect-collision default|simple-and-complex|simple-as-complex|complex-as-simple`
checks the stored trace flag, and `--expect-double-sided on|off` checks the
BodySetup boolean. Both follow that same selection rule and fail if the required
measurement is unavailable. A trace flag alone does not prove there are suitable
collision shapes or that gameplay traces hit them; retain the project's ray and
packaged-physics checks where those outcomes matter.

## Match explicit project import settings

Use a strict JSON file with `--import-options` when the project's importer sets
different values from Unreal's defaults:

```json
{
  "schema": 1,
  "interchange": {
    "buildNanite": false,
    "useFullPrecisionUVs": true,
    "collision": true,
    "importCollisionAccordingToMeshName": true,
    "generateLightmapUVs": false
  },
  "postImport": {
    "collisionTraceFlag": "complex-as-simple",
    "doubleSidedGeometry": true
  }
}
```

Each setting is optional, but the file must request at least one. Unknown fields,
invalid types/enums and unsupported native properties fail. Omission preserves
default import behavior. Expectations are readback assertions; they never set
these options implicitly.

The `interchange` booleans configure a scratch copy of the default glTF assets
pipeline before import, preserving the glTF-specific second pipeline.
`postImport` explicitly changes the imported StaticMeshes' BodySetup settings
before measurement. These stages are reported separately in
`importConfiguration.requested` and `.applied`, including affected mesh paths.
Post-import settings apply to every imported StaticMesh, while `--static-mesh`
selects which mesh the expectations inspect. Requested post-import settings
with no StaticMesh targets fail.

Copy the supported settings from the real project's import contract and check
the measured result. This does not execute an arbitrary project pipeline asset,
its scripts or plugins; reproduce those behaviors in a real-project acceptance
check. The verifier still modifies only its own scratch assets. It does not
reimport into or change the consuming game project. A configured calibration
can use `--axis-calibration --import-options import-options.json` without a file
or other expectation flags.

## Axis and scale calibration

`--axis-calibration` uses a built-in self-contained GLB; it takes no input file. Four meshes are labeled `CalibrationOrigin`, `GltfPositiveX`, `GltfPositiveY`, and `GltfPositiveZ`. Their vertex positions are deliberately off-origin, with different positive distances on each glTF axis and unequal box dimensions. The expected mapping is glTF metres/Y-up/right-handed to Unreal centimetres/Z-up/left-handed:

```text
(x, y, z) metres -> (100*x, 100*z, 100*y) centimetres
```

The contract checks the signed center and size of each labeled imported mesh. A mirrored axis fails even when the bounding sizes remain unchanged. Changing mesh names, combining the probes, losing one marker, or measuring in the wrong units fails. The mapping is explicitly the Interchange glTF asset import mapping, not a promise that a game's vehicle forward axis, Blender axis, actor transform or custom import pipeline uses the same convention.

The fixture is generated by `src/unreal-calibration.ts` without Blender, written only to a temporary directory, and imported through the normal verifier. It is diagnostic content and is never placed in a game or cooked.

## Native scope

The 0.25.0 collision/options path was exercised on Windows UE5.8.2
installation. Default calibration read back stored collision default and
double-sided off. A configured import of all four probes read back Nanite off,
full-precision UVs on, complex-as-simple collision and double-sided on; configured
signed-axis calibration also passed. Requested/applied pipeline properties and
final asset expectations were checked separately. A portable one-mesh character
contract also passed. This does not establish every historical character fixture
or production-project pipeline behavior.

The static-prop getters and asymmetric calibration were exercised on Windows with Unreal **5.8.2, CL56702186**. The four probes imported as four StaticMeshes with 24 vertices and 12 render-resource triangles each. The native report exposed the importer defaults: Nanite enabled and full-precision UVs disabled. These are observations of this installed engine/import configuration, not cross-version defaults. The commandlet lacks a registered `StaticMeshEditorSubsystem`, so read-only asset getters use its class-default query object when necessary; no subsystem is constructed or modified. A missing/unsupported API stays unavailable with a reason.

Primary API references (version 5.8): [StaticMesh](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/StaticMesh?application_version=5.8), [StaticMeshEditorSubsystem](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/StaticMeshEditorSubsystem?application_version=5.8), [MeshBuildSettings](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/MeshBuildSettings?application_version=5.8), [MeshNaniteSettings](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/MeshNaniteSettings?application_version=5.8). The installed UE5.8 source `GLTF/ConversionUtilities.h` defines the coordinate conversion; native labeled probes verify its result. Other engine versions, platforms, runtime rendering, custom production import settings, and collision behavior remain unverified by this check.
