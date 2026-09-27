# Parametric head: a loop-topology base head for living faces

**Status:** design, 2026-09-27. **Replaces:** the SDF/surface-nets head blank (`sdf_blank` + `eye_holes` + `sculpt_lips` +
`nose_geometry`) in `recipes/stylized_face.py`.

## Why

The surface-nets blank puts vertices on a voxel grid, so every sculpt reads through as terraces: ripples across the
nose bridge, and hollow pockets under the eyes when the lids move. Its features are added on top, so the nose floats
as a ball and the eyes sit as discs with no brow or cheek. Its morphs are radial blobs with no loops to follow. Tuning
it stalled for two rounds. The fix is to separate **shape** from **topology**. The shape is a smooth parametric field
evaluated exactly. The topology is built from loops, and the morphs follow those loops.

## Shape: `head_shape(params)`, a smooth field

The shape is a vectorised (numpy) signed-distance field. It combines these parts with smooth unions:

- the cranium, which is the character's head envelope that the hair and ears are fitted to;
- a lower-face mass whose width profile runs from the cheekbones to the jaw and chin (`jaw_width`, `jaw_round`,
  `chin`, `chin_width`);
- a brow ridge bar (`brow_ridge`);
- cheek pads (`cheeks`, child cheek fat);
- a nose made of a bridge capsule from the nasion to the tip, a tip ball and alae (`nose`, `nose_length`,
  `nose_width`, `nose_bridge`), with shallow nostrils cut in;
- two lip rolls and a lip-line groove (`lips`, `mouth_width`);
- an eye socket cut under the brow. Inside it sits the **lid globe**: a sphere round each eyeball whose radius is the
  lid radius, so the lids are part of the skin surface and the lid crease is the fillet where the globe meets the
  socket.

Every vertex is placed on this field by an exact ray march (outermost crossing, then bisection), with no grid. That
removes the terraces by construction.

## Topology: loops

1. **Mouth-centred rings for the whole head.** The rings are confocal ellipses round the lip slit, using elliptic
   coordinates with foci at the mouth corners: ring 0 is the lip line and the spokes are hyperbolas. They are mapped
   stereographically from a point behind the mouth, so they become the lip loops, then the cheek and jaw loops, and
   finally wrap the head to a pole on the crown behind (under the hair). The lip seam is ring 0, with its upper and
   lower halves as separate vertices. Each lip rolls inward for a few rows behind the seam, so an open mouth shows
   lip thickness and then the dark mouth bag, never a paper edge. Around the mouth, 160 spokes give about 1 mm lip
   spacing.
2. **Concentric eye rings.** Around each eye, ring 0 is the lid margin: upper, corner, lower and corner, with the
   margin elevations from `continuous_lid_edges`. The rings run out along spokes from the margin lens to an outer
   ellipse. The first rings are the lash row, the lid rows, the crease anchor and then the skin rows. Behind the
   margin, the proven lid "bag" (roll, inner lid, fornix and lining to a pole) is kept from the continuous eye hole.
   The mouth rings are cut away over each eye's outer ring and joined to it by one zipped strip. Both loops lie
   exactly on the field, so the strip shades smoothly.

## Morphs, authored on the loops (pure Python)

- **Blink, squint and wide:** each ring vertex turns in elevation about the eye centre at its rest radius. The margin
  rows move all the way, the lid rows move less and less up to the anchor ring, and the skin rows stay. Because the
  vertices slide on spheres, the skin under the eye keeps its volume. The check helpers are reused unchanged:
  clearance, folding and coverage.
- **jawOpen:** uses `JawHinge.ear` with a flat-bottomed lower-lip profile (`lip_power`), so the lips part in a
  rounded D. The whole jaw below the mouth drops as one piece, so the chin never pulls into a V.
- **Smile:** the corners curl up, out and back, with the upper and lower seam moving together (closed lips), plus a
  cheek lift that fades before the lower lid. Frown, stretch, funnel, the brows, cheekSquint and noseSneer are
  falloffs centred on the named loops.

## Integration

- The pure module is `scripts/blender_lib/agent_meshes_head.py`. It exposes `head_parameters` (validation and
  defaults), `head_shape` (the field), `build_head` (vertices, faces, named loops and regions, morph targets) and
  `hole_for_eye`. That last one returns the same `hole` dict that `eye_holes` returns (`style='continuous'`), so
  `build_eye`, `eye_hole_mask` and `skin_brow_geometry` keep working unchanged. `agent_meshes_author` re-exports it.
  Blender carries numpy, and the Python CI installs it.
- `stylized_face.add_face` maps the character's `face_shape`, together with its age and presentation, to the head
  parameters. It builds the skin from `build_head`, adds its morphs, and keeps the existing eyes, teeth, tongue,
  mouth bag, brows, paint and face contract. The skin keeps its name, `head_skin`, and is still joined into `face`,
  so the helmet can find the head envelope the same way. The `skeleton='body'` contract is unchanged.
- **Beard:** `beard='beard'` adds a sculpted volume to the field. It is a shell that follows the jaw loops, with a
  moustache, and its edge tapers into the skin. The paint only colours it; it no longer fakes volume with noise.
- **The SDF head path:** `sdf_blank`, `eye_holes`, `sculpt_lips` and `nose_geometry` stay in the library for other
  heads (talking-heads' bespoke heads use them). `stylized_face` no longer uses them, and `head_field` is retired.

## Tests

- **Parameters move features measurably:** eye spacing and size, nose length, width and bridge, mouth width, jaw
  and chin width, cheek fullness, brow ridge, and adult vs child.
- **Topology:** the mesh is manifold. The rings round each eye and round the mouth are closed loops.
- **Smoothness:** the normal turn between neighbouring faces across the bridge and under the eyes stays small at
  rest, at blink 0.5 and 1, at squint 1, at smile 1 and at jawOpen 1. The bridge midline profile has no terraces.
- **Under-eye volume:** blink and squint move no under-eye skin inward.
- **No V-chin:** at jawOpen 1 the lower lip drops at half-width by at least 85% of its drop at the centre, and the
  chin's lowest outline stays round.
- **Closed-lip smile:** the corners rise and draw back, and the upper and lower seam stay together.
