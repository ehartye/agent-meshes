# Static props for a game engine: names, merge and budgets

Naming, merging and budgets for static props, and the contact sheet and stats for a set. Entry: [mesh-build](../SKILL.md).

## Static props for a game engine: names, merge, budgets

For a static prop or a set of them, use `build.json` only; no workspace is needed.

- `material.name` (for example `PieceWhite`) becomes the glTF material name, and parts or shells with the same
  name, colour and finish share one exported material.
- `"merge":"byMaterial"` fuses every part into one mesh with one primitive per material. Part names are lost in
  the GLB, so use it only for deliverables nobody addresses part by part. Skinned or animated models are refused
  (`MERGE_NOT_STATIC`).
- An asset with no clips can still expose wheel, glow or visibility groups controlled by its consuming app.
  Preserve those named controls; the static check alone does not establish that merging is safe.
- A `shell.set` colour that looks tan or glossy next to lathe parts is the baked tint and occlusion multiplying the
  base colour; set `"vertexColors":false` (one member colour, no pattern) so it matches.
- State the numbers in the build: `"verify":{"maxTriangles":2500,"maxMaterials":2,"expectPivot":"bottom-center",
  "expectHeight":0.58}` or `mesh verify model.glb --max-triangles N --max-materials N --expect-pivot bottom-center
  --expect-height H [--tolerance m]`. Bounds are world-space from the final vertices, so rotated parts are measured
  correctly; do not read accessor min/max.
- `"maxGap":0.01` (or `--max-gap 0.01`) fails the build when a part floats more than that from every other part
  (`DETACHED_PART`); `"allowDetached":["halo"]` exempts intended floaters. Without it the lint still runs and warns.
- `mesh silhouette model.glb --axis y --bins 80 --json` charts radius against height. `--lint` flags notches (a
  radius minimum with larger radii above and below; exit 1) and `--allow y0:y1` exempts intended collars. State the
  invariant first ("radius never grows above the plinth"), then lint it.
- Before a revert, `mesh stats model.glb` records triangles, materials, bounds and a profile hash; afterwards
  `mesh diff before.glb after.glb` proves nothing changed.

## Static sets: contact sheet and stats

Two recipes in `recipes/` check a SET of GLBs together. Run them with the plugin's Node; they need no build step.

```text
node "<plugin-root>/recipes/set-stats.mjs" --budget 'knight=6500' --max-tris 3700 --max-materials 1 \
  --require-named-materials --pivot bottom-centre *.glb
node "<plugin-root>/recipes/set-sheet.mjs" --out renders/sheet.png --views front,side,q34,top --cell-scale 0.5 *.glb
node "<plugin-root>/recipes/set-sheet.mjs" --out renders/bases.png --views front,side --crop-bottom 0.3 white_*.glb
```

`set-stats` prints real triangles, world size and bounds with every node matrix applied (a part exported as a
`matrix` node or rotated makes accessor min/max useless), the base centre (the pivot check), material names and
unused materials, and exits 1 with a `FLAG` line per violation. `set-sheet` draws one row per model and one column
per view from ONE camera shared by every cell (target and distance from the union bounds, or `--target` and
`--dist`), so a tall piece looks tall next to a short one, which per-model auto-framing hides. `--crop-bottom F`
keeps the lower fraction of each frame (bases, plinth junctions); `--camera name=px,py,pz>tx,ty,tz` adds a close-up
view. Both fail with a clear message when the managed runtime is missing; run `mesh-setup` first.
