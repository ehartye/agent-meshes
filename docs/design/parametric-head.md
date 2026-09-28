# Parametric head: the MakeHuman hm08 head for living faces

**Status:** implemented, 2026-09-27. **Replaces:** the SDF/surface-nets head blank (`sdf_blank` + `eye_holes` +
`sculpt_lips` + `nose_geometry`) in `recipes/stylized_face.py` (`FACE_VERSION = 2`).

## Why

The surface-nets blank puts vertices on a voxel grid, so every sculpt reads through as terraces: ripples across the
nose bridge, and hollow pockets under the eyes when the lids move. Its features are added on top, so the nose floats
as a ball and the eyes sit as discs with no brow or cheek. Its morphs are radial blobs with no loops to follow. Tuning
it stalled for two rounds.

The owner chose (2026-09-27) to stop authoring topology and start from a sculpted, loop-modelled head: MakeHuman's
**hm08** base mesh. Its data (mesh, targets, face units) is CC0. We load it as plain data. No MPFB add-on and no
GPL/AGPL code runs or ships. Research: wiki "Parametric Human Base Mesh", "MPFB2", "The basemesh and its helpers",
"MPFB2 Face Operations".

## Data: vendored by pinned hash

- `scripts/hm08-vendor.py` fetches the CC0 files from MPFB2 (commit `3edf9df0…`) and makefacestudio's extra targets
  (commit `7eaba345…`). It checks each file against the SHA-256 in `scripts/blender_lib/data/hm08/SOURCES.json`,
  crops the head region and writes `hm08_head.npz` (1.3 MB). The npz holds:
  - the rest positions, the faces and their group (`face_kind`: body skin, eye, teeth, tongue and other helpers);
  - the left/right mirror table and the joint helpers;
  - 316 targets as sparse int16 deltas: age/gender/race macros, feature targets and the 52 `faceunits01` ARKit shapes.
- The head crop keeps 5084 vertices, 4328 of them body skin, all quads.
- The module `scripts/blender_lib/agent_meshes_hm08.py` is pure numpy (no Blender). hm08 units are decimeters, Y up and
  facing +Z; `to_blender` maps them to meters, Z up and facing -Y.

## Shape: `head_shape(years, gender, stylize, shape)`

1. **Macros.** `macro_weights` blends hm08's race, gender and age targets. Children use hm08's own baby, child and
   young ages (`age_parameter`), so a 5-year-old gets a child's skull, eyes and short lower face.
2. **Features.** `feature_weights` maps a character's `face_shape` to hm08 feature targets:
   - `eye_size`, `eye_spacing`, `eye_tilt`;
   - `nose`, `nose_length`, `nose_width`, `nose_bridge`;
   - `mouth_width`, `lips`, `smile`;
   - `jaw_width` (head-square out, inverted triangle in; hm08's `chin-bones` drops the jawline instead);
   - `chin`, `chin_width`, `cheeks`, `brow`.
3. **Stylize.** `stylize01.target` is our one authored target. `scripts/hm08-stylize.py` derives it once from Blender
   Studio's CC0 stylized head (pinned bundle hash in `stylize01.json`) and commits the result:
   - landmarks from front and profile depth maps (the eye opening, profile extremes, mouth corners);
   - a similarity fit, then a 3D thin-plate spline over the landmarks;
   - closest-point projection onto the stylized surface, weighted by distance and normal agreement. The eyes,
     nostrils and lips are excluded, so they keep hm08's loops;
   - a screened-Laplacian relax of the displacement, then delta smoothing.

4. **Cartoon.** `cartoon` (a `face_shape` value, 0 to 1.5) goes past the stylize target toward the boards:
   - `CARTOON_TARGETS`: no eye bags, a smaller nose, a rounder head and a shorter, softer chin;
   - in the fitted head, `lens` grows each eye by `CARTOON_EYES` (1.4 times at 1), scaling about a point in front of
     the eye so it grows into its socket, then `relax_surround` (Taubin, so nothing shrinks) smooths the ring round
     the eye and the nose into a button. The nose relax backs off when it would flatten the crease the lip landmarks
     read;
   - a little of the stylized smile at rest, and the lids resting `REST_LIDS` of the way to closed (every other morph
     moves with the rest, so the blink still closes to the same line);
   - in `stylized_face`, level, thicker, arched brows and wider irises.

## Fitting and graft: `character_face`

- `fit_to_envelope` scales the head into the character's head envelope, which is what the hair, ears and helmet fit to.
  The cranium is clamped inside the envelope above the brows and behind.
- The crop sits just under the chin (`neck_z='chin'`, menton less 3 mm). The mouth bag hangs 2.5 cm below. The rows
  behind the chin are grafted onto the body's neck ellipse, so the stylized body, its garments, the gait rig and the
  helmet fitting are untouched. The neck vertex groups blend the seam: the neck inside the head rides the head bone,
  and its base rides the spine.
- The eyes are hm08's eye helpers, scaled a little (`eye_scale`). The eye bones sit at their centres. The head bone
  comes from the joint helpers.

## Morphs

The 52 `faceunits01` shapes load as ARKit shape keys. The eye and jaw morphs are then rebuilt for the stylized head:

- **Blink, squint and wide** (`lid_morphs`) are rolling curtains:
  - The lid margins come from hm08 topology indices (`margin_vertices`).
  - Each lid vertex turns about the eye's horizontal axis by its margin's angle times a share: 1 on the rim, easing to
    0 at the crease or cheek.
  - The meet line and the handover from upper to lower lid are smooth. Motion tapers into the corners, and the rest
    shape gets an almond corner.
  - The lids are pushed radially, so no straight-line morph chord dips into the eyeball.
  - A candidate search (`LID_CANDIDATES`) picks the reach, overlap and corner settings that close every eye with no
    folds and no crease. The checks use a finer ray grid and more pitches than the contract. A relax-only unfold then
    runs with the margins pinned.
  - The right eye mirrors the left through hm08's mirror table.
- **Smile and frown** are our own (`stylized_mouth`), not the face units' (theirs crease the cheeks and pinch the
  corners). Smooth ellipsoidal fields lift the corner up and back, widen the mouth and raise a round cheek below the
  eye (the frown turns the corner down). Both lips at a corner move alike, so the lips stay closed.
- **jawOpen:**
  - The face unit's jaw is scaled so the chin drops 11% of the head height (gain .6 to 1.5).
  - The skin above the mouth line holds. The upper lip is the face unit's own rows (full lips dip its middle under
    the mouth line), and below the gum line (`UPPER_GUM`) it lifts `LIP_LIFT` so the upper teeth show.
  - The mouth bag swings rigidly with the jaw (`RigidJaw`, a Kabsch fit on the chin). The lower teeth follow it.
  - A relax-only unfold keeps the jaw core pinned, so the lips part in a rounded D with no V-chin.
- `unfold_morphs` relaxes any morph, or any emotion preset mix, that turns a triangle over. It checks the triangles
  the GLB will actually carry (`flat_triangles` splits each quad along its flatter diagonal). The stylized smile and
  frown are never calmed (halved): what still turns over with them is fixed by the coherent pass.
- **The mouth's inside** is the whole pocket: every face hidden at rest from the front and from behind that connects
  to the mouth's middle, palate and throat included. It gets the near-black `mouth_cavity` material. A dark cap closes
  the throat where the crop cut the bag. With the jaw open, the pocket below the mouth is squashed to end short of the
  body's neck, and `add_face` gives the part of the neck inside the head the cavity material. So the open mouth shows
  only teeth, tongue and dark (arkit-face/1's mouth-open check now fails any light surface there, luminance over
  0.03).

## Integration

- `stylized_face.add_face` builds `head_skin` (materials: skin and mouth cavity) and paints blush, lips, the lip line,
  lash tint and stubble. It adds:
  - teeth rows, a tongue and eyeballs bound to the eye bones;
  - brows placed from the eye landmarks;
  - the face contract (`skeleton='body'`).

  It also removes the body recipe's ears, because hm08 has its own.
- **Beard.** `beard='beard'` adds `beard_shell`: a sculpted shell over the jaw and chin, weighted by `beard_weight`.
  Its edge tucks into the skin. It rides the skin's morph deltas and is unfolded like the skin. The paint only colours
  it.
- **The SDF head path.** `sdf_blank`, `eye_holes`, `sculpt_lips` and `nose_geometry` stay in the library for other
  heads (talking-heads' bespoke heads use them). `stylized_face` no longer uses them.
- **Preview.** `agent-meshes preview` (Workbench matcap, wire, cavity and zebra, with head presets `eyes`, `mouth`
  and `mouth-q34`) is the iteration loop for head work. See `skills/mesh-build/SKILL.md`.

## Tests

- `tests/hm08_head.py`: the vendored data, macros, the target round trip, landmarks and the stylize target.
- `tests/stylized_face.py`:
  - **Parameters move features measurably:** eye size and spacing, nose length and bridge, mouth width, jaw width,
    chin, cheeks and lips. Children get larger eyes and shorter lower faces.
  - **Smoothness:** the normal turn between neighbouring faces across the bridge and under the eyes is under 45° at
    rest. It grows no more than 12° at blink .5 and 1, squint 1, smile 1 and jawOpen 1. The bridge profile has no
    terraces.
  - **Under-eye volume:** blink and squint move no under-eye skin inward.
  - **Closure:** a full blink hides the eyeball, and no morph turns a face over.
  - **No V-chin:** at jawOpen 1 the lower lip drops at half-width by at least 80% of its drop at the centre, the chin
    drops at least 8% of the head height, and the chin's outline stays round.
  - **Closed-lip smile:** the corner rises and the seam does not open.
  - **Beard:** it covers the jaw and chin but not the lips, eyes or brow.
- `verify --contract arkit-face/1` on every built character.
