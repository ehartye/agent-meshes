# Optional arkit-face/1 implementation profile

Use this profile when the consumer explicitly needs `arkit-face/1`. It is one supported
Blender implementation; custom expressions, rigid faces and existing sculpts can use
selected helpers without adopting the full profile. Its contract requires: one skin with
`head`, `eye_L` and `eye_R` (left is the character's left, +X), the 21 required ARKit morphs at
zero rest weight, and `extras.arkitFace` on the root. Read the "Face-rig helpers" section of
`<plugin-root>/scripts/blender_lib/README.md` for the API, and copy the working heads in
`<plugin-root>/tests/fixtures/face-rig/` (`test_head.py` with lids and a puppet jaw,
`test_robot.py`, a tin-can robot with recessed shutters, brow plates, a thick-edged skull and chin
plate and a rubber mouth edge, `test_frog.py` with lid domes, brow ridges and
exposed fangs). The rules that are easy to get wrong:

- Morphs are linear: a lid swept across a round eye as one morph cuts into the eyeball
  mid-blink. Use `build_eye(..., style='lid')` (the lid radius is solved for 0.5 mm clearance at
  every weight) or `style='shutter'`; use another construction only after checking its full deformation range. Morphs also add up: blink 1 +
  squint 1 or + wide 1 must still hide the eyeball, so the helpers size lids and blades for every
  weight in [0, 1]^3 and reject settings that cannot. Flat shutters need a flat face with the eyes
  recessed behind it; pass `surface=front_surface(...)` so blades that would poke out are rejected.
- Robot faces made of plates (a tin-can robot): `split_plates` splits a closed head into a skull and a chin
  plate with thick, closed edges (pass `gum_z` so the plate's rim stays below the gums),
  `brow_plate_geometry` makes rigid brow bars with the brow morphs, and `rubber_mouth_geometry`
  makes the rubber mouth edge that carries smile, frown, stretch and funnel while the plates stay
  rigid. These are reusable implementations for that construction. Keep rigid plates rigid;
  another mechanical design can use its own hinges and expression controls.
- A puppet jaw drops the chin, not only the lips. Hinge it at the back of the head, level with
  the mouth line (by the ears): `jaw = JawHinge.ear(head_vertices, mouth_z, half_width)`. A pivot
  in the middle of the head swings the chin back and up and only opens a hole at the lips. Drive
  `jawOpen` on every jaw-carried part from that one jaw: `add_jaw_open(skin, jaw, min_chin_drop=.1)`
  (rejects a chin that drops less than 10% of the head), and `rigid=True` for the lower teeth,
  tongue or a robot chin plate.
- Cut the lip seam with `slit_mouth` (it tags the upper and lower lip, so float rounding of the
  mouth line never hangs the upper lip on the jaw, and it slides near vertices onto the line so no
  sliver row shades as a seam). Skin faces get soft lips and a lip line from `sculpt_lips` first. Add a dark `mouth_cavity_geometry` bag fitted
  to the face with `surface=front_surface(skin_vertices, skin_faces)` so it never pokes through the
  cheeks, and make fangs or buck teeth with `exposed_teeth_geometry(..., skin=head)` (declared in `exposedTeeth`; they lie against the
  outside of the lips and ride the lips' morphs, because a tooth tucked behind a one-surface skin pierces it).
- Open lid eyes with `eye_hole(vertices, faces, center, radius, **lid_options)` (`eye_holes(vertices, faces,
  eye_left, radius, ...)` on a symmetric head: exact mirror images, and each eye's patch may reach the
  other's) and pass it to `build_eye(..., hole=..., skin=head)`: the skin itself becomes the lids (one
  surface with a rounded margin, a lining behind it, one soft crease above and a closed corner), and
  `build_eye` adds the eye's blink, squint and wide shape keys to the head and paints the lash line
  (`lash=True`). Separate lid shells in a skin hole (`style='shells'`) read as stacked bands round the eye
  and fail the verifier's `eye-crease` check, and lids that stand in each other's path fail `lid-penetration` (the
  continuous lids are nested at every blink, squint and wide mix, at the price of a taller upper lid; a larger
  `squint_upper_share`, or a smaller `wide` or `overlap`, shrinks that hood). A sphere cut (`cut_hole`) leaves a black hole beside the lids
  in 3/4 view. Robot shutter eyes take `shutter_hole` (a sealed tube back from the face plate, with the
  blades checked against it) and `build_eye(style='shutter', hole=...)`. Mask brow and cheek offsets near
  the eyes with `mask=eye_hole_mask(*holes)`, and lay brow ridges above the upper lid's crease.
- Teeth that show at rest get their own material, `teeth_exposed`, listed in `exposed_teeth`.
- Brows on a round skin face: `skin_brow_geometry(head, side, inner, outer, hole=holes[side])`
  with the head object after its shape keys: it lays the brow on the skin along its normal in
  every pose (browDown also knits it toward the nose). Noses: `nose_geometry(vertices, faces,
  tip, size)` fuses a smooth button nose with nostril dimples into the skin and returns the
  noseSneer wing lift; `sculpt_skin` grows cheeks or a chin. Never sculpt with `soft_offset` on a
  blank (a spike). The helpers write `lidFollow.up` .8 so looking up visibly lifts the lids (E2).
- Skin paint (blush, lips, lash lines, socket shading, mottling): `paint_vertices(part,
  skin_tints(rest, base, patches, mottle))` and `use_vertex_colors(material)` before
  `join_face_parts`, which keeps color attributes; it exports as COLOR_0 and Unreal's glTF
  material applies it.
- Cut other holes with `cut_hole` (a smooth rim), not `cut_faces` (stair steps). Brows on eye domes
  (a frog) are `brow_ridge_geometry(..., skin=..., hole=...)` ridges that lie on the skin itself
  and slide over it; a ridge on the dome's sphere floats over the skin.
- Small parts joined to the face (nostrils, freckles, warts, horns) go through
  `attach_to_skin(part, head, depth=...)` after the head's shape keys are added: it seats the
  part and gives it the skin's own morph deltas at its footprint, so `noseSneer` lifts nostrils
  with the snout instead of burying them. A part may sit on another attached part (nostrils on
  a nose ball: `attach_to_skin(bead, ball)`). Nothing may float off the skin or sink under a morph
  (the verifier's `attached-parts` check).
- Put every morph-bearing part in one mesh with `join_face_parts`: Unreal discards all morph
  names when a name repeats across glTF meshes. Keep only the eyeballs separate. The morph-name audit
  rejects these layouts with the codes below (`verify-unreal` lists them in `preflight.morphNames.issues[].code`; the
  `morph-names` check of `verify --contract arkit-face/1` prints the same messages): `MORPH_NAME_SHARED_ACROSS_MESHES` (a name on more than one glTF mesh),
  `MORPH_NAME_DUPLICATE_IN_MESH`, `MORPH_NAMES_MISSING` (no `extras.targetNames`), `MORPH_NAMES_COUNT_MISMATCH`
  (names differ in number from targets) and `MORPH_TARGET_COUNT_VARIES` (primitives of one mesh carry different target counts).
- Name teeth materials `teeth_upper` and `teeth_lower`, and write the extras with
  `face_contract(rig, objects, yaw_max, pitch_max, exposed_teeth=[...])`.
- Gaze is eye-bone rotation, not morphs: yaw about the eye bone's local Y, pitch about local X.

For builds declaring this profile, check the exported asset with `mesh verify <head>.glb --contract arkit-face/1` ([mesh-build](../../mesh-build/SKILL.md)). Its `lid-penetration` check
fails any blink, squint and wide pose in which a lid passes through the other lid or the skin (the message names the
eye, the poses and the triangles; a head built before the lids were nested rebuilds green). Its `mouth-skin-intersection`
check fails teeth, gums, tongue or cavity that cross the skin at rest, at quarter jaw openings or in any mouth, cheek
or emotion morph (the message names the state, the part and both triangle indices); repair the geometry or make it
follow the skin, never loosen the check. Then look at
blink, squint, jaw and emotion renders (front and three-quarter, jawOpen 0, .5 and 1) before calling
the head done.
