# Face-rig contract check

Entry: [mesh-build](../SKILL.md).

## Face-rig contract check

```text
mesh verify head.glb --contract arkit-face/1
```

Checks everything computable in the `arkit-face/1` face-rig contract and prints a JSON report
(`checks`, `failures`, `warnings`, `measurements`): validator errors, the single skin with
`head`/`eye_L`/`eye_R`, eyeballs bound 100% to eye bones that pivot at their centers, the 21
required morph names (exact spelling, one glTF mesh per name), zero rest weights, every morph
moving at least 1 mm, no flipped triangles at 0.5/1 or across the emotion presets with
`jawOpen` = 1, lid clearance of eyeball radius + 0.5 mm at blink .25/.5/.75/1 alone and with
squint, eye coverage (front rays across each eyeball must all hit a lid or skin at blink 1 alone,
with squint 1 and with wide 1, and show nothing outside the neutral opening mid-blink or at
squint), oblique eye views (rays from the front, 3/4 at 35-45 degrees of yaw and 20 degrees above
and below, in every lid and emotion state, must never reach the socket or the inside of the head:
the lids must meet the skin all the way round, which `eye_hole` builds), no terraced socket
(`eye-crease`: at most one fold above each lid eye, its crease, and one below along radial lines out to
1.3 eyeball radii), lids that never pass through each other or the skin round them at any blink, squint and wide
mix (`lid-penetration`; `--lid-grid` poses the whole 324-pose grid; `eye_hole`'s continuous lids are nested to
pass it, shell lids and blades must be built to the same rule), lid follow (the upper
lid's edge moves at least 1.5 mm up at eyeLookUp = 1 and down at eyeLookDown = 1), opaque face
materials (an alpha-blended or masked lid, skin or tooth fails, and hides nothing in any ray
check), the `extras.arkitFace` schema and `exposedTeeth` (teeth that show at rest must be in
their own `teeth_exposed` material and declared; a row poking through the lips fails), the skull, teeth and every
morph-bearing part bound to `head` (a skull bound to an eye bone is named as such), upper teeth
fixed and lower teeth, tongue and cavity carried by `jawOpen`, the chin (the face's lowest point)
dropping by at least 10% of the face height at `jawOpen` = 1, the face above the upper teeth's
gum line staying put, and a mouth that opens (between the teeth rows the front view meets teeth,
tongue or cavity, not skin; a ray that passes the teeth into the head is see-through), and every
small part joined to the face (brows, ridges, nostrils) sitting on the skin at rest and at each
morph (`attached-parts`: no air gap along its length, not buried by a skin shape; a nostril on a nose
ball is judged against the ball). It exits 1 and prints
`FAIL <check>: <problem>` lines on stderr. Teeth are found by the materials `teeth_upper` and
`teeth_lower`. It does not render: a dark open mouth, gaze and shading still need looking at. `node <plugin-root>/scripts/check-face-rig-browser.mjs [test_head|test_robot|test_frog|test_kid]`
renders the helper-built test heads, including a jaw sheet (jawOpen 0, .5, 1 from the front,
three-quarter and close up) captioned with the measured chin drop.

File size: Blender's exporter writes a float-noise normal delta (about 1e-7) for every vertex of
every shape key, about 1.2 MB on a talking head. The Blender authoring stage (`export_glb`)
drops deltas under 1e-6 m (positions) and 1e-4 (normals) and stores the rest as sparse
accessors (`prune_glb_morphs`), so a head's morph data grows only with the vertices each shape
really moves. Keep each face GLB under 3 MB (E8).
