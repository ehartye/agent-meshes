# Blender-authored static props

Entry: [mesh-build](../SKILL.md).

## Blender-authored static props

Whether a prop belongs in Blender at all (against the workspace, Unreal tools or code-CAD) is decided by
[mesh-tool-selection](../../mesh-tool-selection/SKILL.md); read it when establishing or changing the route.

For a prop that needs booleans, bevels or authored UVs, use a Blender source and retain the consumer's
named nodes, material slots and vertex channels. The uniform-material construction recipe below came
from a 12-piece chess set; it is not a requirement to merge every prop into one mesh or material.
Reusable helpers are in `scripts/blender_lib/agent_meshes_props.py` (see
[static-prop helpers](../../../scripts/blender_lib/README.md#static-props-agent_meshes_props));
`from agent_meshes_props import *` after adding `scripts/blender_lib` to `sys.path`.

**Vertex colours are part of the consumer contract.** For nonuniform RGB/alpha masks, normal `build()`
sources can set `EXPORT_VERTEX_COLOR = 'ACTIVE'` and `EXPORT_ALL_VERTEX_COLORS = False` and select
`mesh.color_attributes.render_color_index`. Read [vertex-colour export controls](../../../scripts/blender_lib/README.md#vertex-colors-in-glb-exports)
for defaults and validation. Keep an opaque material when alpha is data; a transparency graph is not
needed to preserve that channel. Check decoded exported RGBA values and the destination shader separately;
an import report's colour-presence flag does not prove channel values or shading survived.

**Axes and uniform-material export.** glTF is Y-up; the helper's convention faces +Z. Blender is Z-up;
for that convention author as (x, -z, y), that is glTF z = -Blender y (`P(x, y, z)`), and export with
`export_yup=True`. Preserve an existing project's forward-axis contract and verify the imported mapping.
For a uniform-material prop with no semantic vertex channels, one named material such as
`static_material('PieceWhite', '#e9ddc2', .55)` is sufficient. `finish_static` strips colour attributes and
`export_static_glb(path, objects)` omits them; use these only when those channels are intentionally absent.
For direct exports, that is `export_vertex_color='NONE'`, as `export_static_glb` passes it.
Disable cameras/lights, and omit texture coordinates only when the consumer does not need them.
Unwanted `COLOR_0` can multiply base colour in viewers; intentional masks must be preserved instead.

**Boolean order that avoids ragged edges.**
1. Build the clean body (screw lathe, or metaball converted to a mesh).
2. Decimate the body FIRST, if it needs it. Decimating after a boolean roughens every cut edge.
3. Locally subdivide the triangles around each planned cut (`refine_near`), so the cutter lands in small even
   triangles, not needle fans.
4. Boolean with the EXACT solver.
5. Weld at 0.5 mm, dissolve degenerate faces, triangulate with beauty (`clean_after_boolean`).
6. Never decimate after the boolean.

Cut first and JOIN LAST (a plain join, no boolean). An exact boolean union of many small shells into a body once
returned only the shells, and joining shells before the cuts let later cuts swallow them. Compare triangle counts
before and after a union.

**Count real triangles.** Booleans leave n-gons, so Blender's polygon count under-reports. Count
`sum(len(p.vertices) - 2 for p in mesh.polygons)` (`count_tris`), or read the exported GLB with
`recipes/set-stats.mjs`. A body reported as 6,162 faces had more triangles than that.

**Metaballs (smooth fusion of ellipsoids) have a unit trap.** An isolated element's surface lies at
0.558 x `radius` x `size`, so `radius = max(semi) / 0.558` and each `size = semi / (0.558 * radius)`; `meta_ellipsoid`
does this. Fields ADD, so overlapping elements bulge: shrink radii about 15% where they overlap, and elements spaced
closer than about 2 radii fuse into one lump (separate tufts need separate shells). A capsule's `size_x` is an
ABSOLUTE half-length in metres, not scaled by radius (`meta_capsule`). For an unrotated element `size_y` and `size_z`
are Blender Y and Z, so an ellipsoid authored in glTF axes comes out with depth and height swapped unless you swap
them (the helper does); the mistake is invisible while members are nearly round and makes a neck paper-thin when
they are not. Coarser metaball `resolution` (0.0095 for a 0.4 m piece) is the practical triangle lever.

**Join order for tufts and other add-ons:** cuts first, join last. Tuft roots must start outside the surface, or the
visible part is a needle.

**Dispatching a bpy script.** Either way the result is a GLB you then `verify` and render:
- From a Node build script, run Blender directly and keep exporter control, which is what lets one script take a
  colour or variant argument:
  ```js
  import { execFileSync, spawnSync } from 'node:child_process';
  // setup --check exits 1 before the first install, so read stdout with spawnSync; `blender` is a path, null when absent.
  const check = spawnSync(process.execPath, [`${pluginRoot}/scripts/setup.js`, '--check', '--json'], { encoding: 'utf8' });
  const blender = process.env.AGENT_MESHES_BLENDER ?? JSON.parse(check.stdout).blender;
  if (!blender) throw new Error('Blender not found; see mesh-setup');
  execFileSync(blender, ['-b', '--python-exit-code', '1', '--python', 'knight_blender.py', '--', 'white', 'white_knight.glb'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ```
  `execFileSync` throws on a nonzero Blender exit; print `err.stdout` and `err.stderr` on failure. Blender exits 0 after
  a Python error unless you pass `--python-exit-code 1`, as above.
- Through `build.json`: `{"version":1,"name":"knight","blender":{"script":"knight.py"},"output":"dist"}`, where the
  source defines `build()` returning the list of bpy objects. It takes no arguments; use declared parameter files
  or [declared environment inputs](native-build-identity.md#declare-blenders-environment-0240-and-later)
  for variants. It exports through the managed `export_glb`, then verifies and writes the native build output.
