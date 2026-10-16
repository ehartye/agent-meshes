# hm08 head data (CC0)

These files are data only. No MakeHuman or MPFB program code is used or vendored.

- `hm08_head.npz` holds the head and upper neck of the MakeHuman hm08 base mesh: vertices, quads and helper
  geometry (eyes, teeth, tongue and lashes). It also holds the joint helpers' centers, the mirror table and 316
  targets restricted to those vertices. Those targets are:
  - the race, gender and age macros;
  - the head, face-feature and neck modifiers;
  - faceunits01, the 52 ARKit face units by Mika Suominen.

  `python scripts/hm08-vendor.py` rebuilds the file from the pinned sources in `SOURCES.json`, checking each
  file's SHA-256. The sources are the makehumancommunity `mpfb2` assets (CC0 1.0, LICENSE.ASSETS.md) and
  `extra-targets` (CC0 1.0).
- `stylize01.target` is our own stylize delta, derived by `python scripts/hm08-stylize.py`. It fits hm08 onto
  Blender Studio's stylized head from the Human Base Meshes bundle v1.4.1 (CC0 1.0), which is pinned by SHA-256.
  `stylize01.json` records the source, the landmark pairs and the fit report.

Units are MakeHuman's: decimeters, Y up, and the face looks down +Z. `agent_meshes_hm08.to_blender` maps them to
Blender meters, with Z up and the face looking down -Y.

## Original skin UVs

The NPZ also retains compact original atlas coordinates (`uv`), a separate UV index per face corner (`face_uv`),
and each retained face's zero-based index in pinned `base.obj` (`source_faces`). `head.kind_face_uv('body')`
matches `head.kind_faces('body')` in face and corner order. A geometry vertex can have several texture corners
at a seam: never replace these with one UV per vertex. `-1` marks triangle padding or absent source UVs.
Every retained skin face has all four original corners. UVs survive changes to the additive shape targets;
large shape changes can still stretch the texture and need visual inspection.

After constructing the body-kind head mesh in that same face/corner order in Blender:

```python
atlas = obj.data.uv_layers.new(name='SkinUV')
for polygon, corners in zip(obj.data.polygons, head.kind_face_uv('body')):
    for loop_index, uv_index in zip(polygon.loop_indices, corners):
        if uv_index < 0:
            raise ValueError('Skin face has no source UV')
        atlas.data[loop_index].uv = head.uv[uv_index]
```

Assign UVs before modifiers that change topology. Cropping, booleans and subdivision need their own UV/export
inspection. This data does not include a skin photograph or automatically wire materials: verify each image's
license and connect exporter-supported image nodes, with color maps in sRGB and normal/roughness maps as data.
Reload the delivered GLB to inspect skin seams, normals and actual embedded images.

The UV addition preserves all 641 pre-existing arrays byte-for-byte at the array-value level, including topology,
indices, targets, joints and mirror. `tests/hm08_head.py` checks that original payload identity, UV corner seams and
the OBJ parser independently of Blender.
