# Blender authoring helpers

The build runner adds this directory to Python's import path. Import the module
as `agent_meshes_author`. Blender is only needed when creating/exporting objects;
the sweep geometry function uses the Python standard library.

```python
from agent_meshes_author import make_mesh, material, shape_key, sweep_mesh

def build():
    centers = [(0, 0, 0), (0, 0, 1), (.2, 0, 2)]
    vertices, faces = sweep_mesh(centers, [(.2, .1)] * 3,
                                 radial_segments=32, initial_normal=(1, 0, 0))
    finish = material('Bronze', (.5, .25, .08), metalness=.9, roughness=.25)
    obj = make_mesh('Form', vertices, faces, finish)
    target, _ = sweep_mesh(centers, [(.3, .1)] * 3,
                           radial_segments=32, initial_normal=(1, 0, 0))
    shape_key(obj, 'Fullness', target)
    return [obj]
```

`sweep_mesh(centers, radii, radial_segments=48, twist=None,
initial_normal=None)` returns vertices and outward-wound faces with closed caps.
Centers are XYZ triples, radii are positive pairs, and twist is one angle in
radians per ring. Parallel transport minimizes frame rotation along the path.
Use the same explicit initial normal for every member of a morph family, so a
changing first tangent cannot select a different starting axis. The normal must
not be parallel to the first tangent. Avoid cusps and self-intersecting paths;
input validation cannot prove that an arbitrary sweep does not intersect itself.

`material(name, color, metalness=0, roughness=.4)` takes **linear** RGB components,
metalness and roughness in 0..1. `make_mesh(name, vertices, faces, material=None)`
creates a named mesh with smooth side faces and flat caps.

`shape_key(obj, name, vertices)` creates a named 0..1 morph at an explicit zero
rest weight. It checks finite coordinates and equal vertex count; authors must
also preserve vertex order and topology. Duplicate names and `Basis` are rejected.

`fuse_meshes(objects, name, voxel_size, smooth_passes=2, expected_components=1)`
joins overlapping mesh pieces and voxel-remeshes their union into a continuous
surface. It then applies a `.5`-factor Smooth modifier for the requested passes.
Use it **before** adding shape keys, animation, final materials or UVs:

```python
from agent_meshes_author import fuse_meshes

figure = fuse_meshes(pieces, 'Figure', voxel_size=.011, smooth_passes=3)
# Assign materials, create UVs and derive morph vertices from figure.data now.
```

Voxel size is a positive finite distance in the scene's world units. It controls
the smallest retained detail: narrow limbs, gaps, or separate pieces can disappear
or merge at coarse settings. Start with overlapping solid pieces. Parent, location,
rotation, scale and parent-induced shear are baked directly into vertices;
reflections reverse face winding. The result is unparented, has an identity
transform, and stores world-space coordinates. The result is globally smooth
shaded; authors may override individual faces afterward. Unrelated objects sharing
an input's mesh data retain their original geometry.

The helper accepts 1–256 distinct mesh objects and 0–50 smoothing passes. It rejects
shape keys, unresolved modifiers, constraints, animation, and children outside
the input list before consuming inputs. Resolve those deliberately in the source
first; external children must be detached while preserving their world transforms.
A conservative 32-million
bounding-grid-cell budget rejects accidentally tiny voxels; it is not a guarantee
of Blender memory usage. The helper owns selection and object mode and **consumes
input objects once joining starts**, including when a later topology check fails.
Rebuild from the source recipe after a failure. Materials and UVs should be authored
on the returned topology, since voxel remeshing does not preserve their layout.

By default, the result must contain exactly one connected component, have faces,
and have zero boundary or overused edges. `expected_components` accepts 1–256 or
`None` to omit the component-count requirement; the closed-edge checks still run.
`topology_report(vertices, faces)` exposes the same pure-Python counts:
`components`, `boundary_edges` (one incident face), and `nonmanifold_edges` (more
than two incident faces). Components follow vertex/edge connectivity and include
isolated vertices. An empty mesh reports zero components. These checks do **not**
prove non-self-intersection, consistent winding, valid vertex fans, positive volume,
or absence of zero-area faces; assess the resulting shape and its deformations too.

`export_glb(path, objects)` exports selected objects, preserving PBR materials,
skins, animations, named morphs and authored rest weights. It does not apply
geometry modifiers, which can discard morph topology. Resolve required modifiers
before creating shape keys. The build runner normally calls this function for you.
After Blender's exporter it runs `prune_glb_morphs(path)`: Blender writes a NORMAL
delta for every vertex of every shape key, and on a face nearly all are float
noise (at most 1.5e-7), about 1.2 MB a head, which also keeps Blender's own
sparse option from ever applying. Deltas at most `MORPH_POSITION_EPSILON` (1e-6 m)
or `MORPH_NORMAL_EPSILON` (1e-4) become zero; a target left all zero becomes a
data-less accessor (glTF zero-fills it) and one with few moving vertices a sparse
accessor, with POSITION min/max recomputed. Base attributes, indices, images and
animation are copied untouched. The four face fixtures shrink by 40-55% (the
talking-head test head from 1.64 to 0.98 MB).

`bind_skin(mesh, armature, weights)` binds an authored mesh to existing deform
bones and returns its new Armature modifier. Supply a dense list/tuple with one
mapping per mesh vertex, for example `{'hip': .7, 'knee': .3}`. Every row must
contain 1–4 entries naming existing bones with `use_deform=True`, finite
nonnegative values, and positive total weight. The helper normalizes each row;
it never silently truncates more than four entries. Supplied zeros count toward
that limit and their bone names are validated, then zero weights are omitted.
Normalization scales before summing to avoid overflow; tiny ratios may round to
zero in Python or Blender's float storage.

```python
from agent_meshes_author import bind_skin

# mesh and rig are authored objects; author weights in the rig's rest space.
bind_skin(mesh, rig, weights)
# build() must return both so selected-object export includes the skeleton.
return [mesh, rig]
```

Both objects must be local/editable, in Object mode and the active view layer.
The mesh must have single-user data and no parent, constraints, Armature modifier
or existing deform-bone vertex groups. Cyclic parenting and singular/nonfinite
armature world transforms reject. Unrelated groups and modifiers remain intact.
All validation precedes changes; the helper creates named groups, an explicitly
vertex-weighted linear-blend Armature modifier, and an armature parent with its
inverse world matrix. Mesh coordinates, current world transform, selection and
mode remain unchanged. It does not create bones, infer weights, change topology
or author animation. Existing poses deform the result immediately; keep the rig
in rest pose when checking initial appearance. Resolve topology-changing
modifiers deliberately before weighting if their output needs distinct weights.

`normalize_skin_weights(weights, bone_names, vertex_count)` exposes the same
validation/normalization without Blender and returns independent row dictionaries.
`bone_names` is a list, tuple, set or frozenset of unique nonempty names;
`vertex_count` must be a positive integer. Rebinding is deliberately rejected;
start from the reproducible source recipe rather than overwriting a live binding.

Run geometry checks without Blender:

```sh
python tests/blender_author_geometry.py
python tests/blender_author_skin.py
```

The optional real-Blender fixture `tests/blender_author_fusion.py` defines `build()`
for the authoring runner. It checks pre-morph rejection, disconnected outputs,
transformed overlapping meshes, shared-data isolation, and post-fusion morphs.
Run it through `authorGLB` and validate its temporary GLB with `verifyGLB`; Blender
is not required by the pure-Python CI checks.

`node scripts/check-authored-skin-browser.mjs` runs the optional real Blender skin
fixture, validates its exported GLB, and loads the public viewer offline. It checks
normalized exported weights, actual deformed vertices, pinned root vertices,
changed rendered pixels and return to rest. Screenshots and measurements are
written under ignored `.agent-meshes/skin-proof/`.

## Face-rig helpers (`arkit-face/1`)

`agent_meshes_face` holds the helpers every talking head needs, so no head source
repeats them. `agent_meshes_author` re-exports all of them, so one import works:

```python
from agent_meshes_author import (face_skeleton, build_eye, eye_hole, eye_hole_mask,
    JawHinge, add_jaw_open, slit_mouth, cut_hole, front_surface, teeth_row_geometry,
    exposed_teeth_geometry, mouth_cavity_geometry, tongue_geometry, brow_ridge_geometry,
    skin_brow_geometry, chin_drop, brow_plate_geometry, split_plates,
    rubber_mouth_geometry, eye_coverage_problems, mesh_from_geometry, soft_offset,
    symmetric_offsets, shape_key, join_face_parts, face_contract, recommended_gaze,
    attach_to_skin, skin_contact, nose_geometry, sculpt_skin, sculpt_lips)
```

They follow the face contract in `arkit-face/1` and Blender's axes: **Z up,
meters, the face looks down -Y, the character's left is +X** (glTF export turns
this into Y up with the face looking down +Z). Angles are degrees. Geometry
helpers are pure Python and return `{'vertices', 'faces', ...}` dicts in world
coordinates; the Blender wrappers build objects with identity transforms. The
pure-Python checks run with `python tests/blender_face_geometry.py`. The complete
worked examples are `tests/fixtures/face-rig/test_head.py` (round eyes in
`eye_hole` sockets, lids, an ear-hinged puppet jaw), `test_robot.py` (Bolt's tin
can: recessed shutter eyes in `shutter_hole` tubes, brow plates, a skull and chin plate with
thick edges, grille teeth, a rubber mouth edge) and `test_frog.py` (a wide frog:
eyes in mounded `eye_hole` domes with brow ridges lying on the skin, nostrils that
ride `noseSneer` through `attach_to_skin`, saw teeth, two exposed fangs in their own
`teeth_exposed` material, a cavity fitted to the curved face) and `test_kid.py` (a
round-faced kid: brows laid on the skin with `skin_brow_geometry`, a fused
`nose_geometry` button nose with nostril dimples riding `noseSneer`, freckles, buck
teeth and a hair cap).

### Skeleton, binding and one face mesh

`face_skeleton(head, eye_left, eye_right, name='Face rig')` creates the armature
with `head` (root) and `eye_L`/`eye_R` children pivoting at the eyeball centers.
`eye_left` must have the larger x. Bones point up with zero roll, so each exports
with an identity rest rotation: gaze yaw is a turn about the bone's local Y (up),
pitch about its local X. `bind_rigid(mesh, rig, bone='head')` binds every vertex
100% to one bone.

`join_face_parts(parts, name='face', rig=None, bone='head', sharp_angle=60)` joins
every morph-bearing part (skin, lids, teeth, tongue, mouth cavity) into **one**
mesh object, keeping each part's materials, smooth flags and shape keys; a part
without a key keeps its rest shape in it. `None` parts are skipped (a sealed eye
has no socket). Edges where the surface turns by more than `sharp_angle` degrees
(the fold from skin into an eye hole's wall, a lid's rim) are marked sharp, so
smooth shading does not smear across them. It is required: Unreal discards *every*
morph name in a file when a name repeats across glTF meshes, and the jaw, for
one, moves the skin, the lower teeth, the tongue and the cavity. The object
exports as one glTF mesh with one primitive per material, all carrying the same
morph names. The parts are consumed and UV maps are not carried. With `rig`, the
result is bound to `bone`. Eyeballs stay separate: they are bound to their eye
bones and carry no morphs. The pure `join_geometry(parts)` does the same for
geometry dicts.

### Eyes: eyeball, lids or shutters, and the skin's eye hole

`build_eye(rig, side, center, radius, style='lid', lid_material=None,
socket_material=None, eye_materials=None, iris=26, pupil=12, socket=True,
margin=6, hole=None, **options)` builds one eye (`side` is `'L'` or `'R'`, and
`center` must be the eye bone's head):

- `eyeball_<side>`: a sphere whose poles lie on the gaze axis, with rings on the
  iris and pupil borders and three material slots `eye_white`, `eye_iris`,
  `eye_pupil`, bound 100% to `eye_<side>` (`eyeball_geometry`). `eye_materials`
  overrides them and **must keep those three names in that order** (the ID render
  and the verifier find eyeballs by them); other names are rejected.
- `lids_<side>`: the lids with `eyeBlink<Side>`, `eyeSquint<Side>` and
  `eyeWide<Side>` shape keys, bound to `head`. `options` go to `lid_geometry`
  (`style='lid'`) or `shutter_geometry` (`style='shutter'`). With `hole` (an
  `eye_hole` result) the lids are the ones the hole was shaped around: pass the
  lid options to `eye_hole`, not here.
- The part behind the eye: a lid eye with `hole` gets none (`socket` is None): the
  hole's lining seals the eye. A shutter eye gets `eye_housing_<side>`, a cup in the
  blades' material, a bezel you may see around the lens when the blades open. A lid
  eye without `hole` gets `eye_socket_<side>`, a dark cup opening past
  `eye_window(lids, margin)` (the legacy `cut_hole` path: the verifier's
  `eye-oblique` check fails it wherever it shows).

It returns `{'eyeball', 'lids', 'socket', 'geometry'}`; `geometry` reports the lid
radii, `min_clearance` and the achieved `squint_ratio`.

**The eye hole: the skin must meet the lids all the way round.** Round 3 cut eye
holes with `cut_hole` at 1.32 eyeball radii and found a black hole beside each eye
in 3/4 view: the lids ended in a hard cut at their outer corners and lay well
inside the rim (the rim of a sphere cut sits near the eye center on a curved
head), so the view ran past them into the dark socket. No hole radius fixes that:
a smaller hole covers the eye's inner corner, a larger one opens more gap. So for
lid eyes the hole is shaped from the lids:

`eye_hole(vertices, faces, center, eye_radius, margin=6, clearance=.0005,
blend=None, max_edge=None, socket=25, lining_gap=.0001, lining_rings=5,
**lid_options)` takes the head blank and the same lid options as the eye
(`opening`, `meet`, `wide`, ...), builds that `lid_geometry`, and:

1. **Mound.** Skin nearer the eye center than the lids' outer surface plus
   `clearance` is pushed out along its direction from the center (blended over
   `blend`, default 0.2 eyeball radii), so the lids never poke out of the skin and
   their ends stay hidden. A skin that runs through the eye (the frog's) becomes a
   dome over it.
2. **Socket dip.** Skin much farther out is drawn in over `socket` degrees around
   the window (fading out by 3.2 eyeball radii), so the rim hugs the lids instead
   of opening a deep funnel where the face lies far in front of the eye (beside the
   nose).
3. **Window.** The skin is clipped along `eye_window(lids, margin)`: every
   direction from the eye center within `margin` degrees of the lids' opening
   envelope (between the lower lid's lowest edge and the upper lid's highest edge
   over every blink, squint and wide mix), with round ends. The lids cover every
   other direction inside it, in every state, and reach past it. At the corners,
   where the lids meet and barely move, the window reaches only `corner_margin`
   (2) degrees past them, so no pointed pocket of wall and lining opens beside the
   inner corner (round 4's "skin wedge").
4. **Wall and lining.** From every rim vertex a skin wall runs toward the eye
   center, through the lids (which slide through it), to just under the nearest
   any lid vertex comes; there it becomes a lining that wraps the eyeball to a pole
   behind it. A ray that enters the window meets only lids, eyeball, wall or
   lining, never the head's inside; and a front view still sees the eyeball up to
   the lid edges, however wide they open. The wall and lining share the rim's
   vertices, so the skin stays one closed surface and no morph can crack it. A
   `bevel` ring (0.5: half way down to the lids, at most 0.06 eyeball radii) leaves
   each rim vertex half way between the skin's slope and the wall's, so the skin
   turns into the hole over two gentle folds; `join_face_parts` marks edges that turn
   by more than 60 degrees sharp, and round 4's right-angled rim read as a hard seam
   round every eye (`bevel=0` gives it back).

Edges near the eye are split to `max_edge` (default 0.2 eyeball radii) first; each
vertex costs a delta in every morph target that moves it (only those, since
`export_glb` stores sparse morphs), so keep an eye on file size (E8: 3 MB).
Call `eye_hole` once per eye on the blank, before `slit_mouth` and any shape keys,
and pass the result to `build_eye(..., hole=...)`. It returns `{'vertices',
'faces', 'lids', 'window', 'rim', 'wall', 'pushed', 'rim_radius', 'lining',
'mound', 'socket', 'bevel'}`: `mound` is the rim's radius where the skin was
reshaped (where a brow ridge starts looking for the skin on a mounded eye).

**Skin shapes near an eye hole** (brows, cheeks) must leave its rim, wall and
lining still: a strong brow offset drags the rim over its wall and folds the skin
there. Pass `mask=eye_hole_mask(*holes)` to their `soft_offset` or
`symmetric_offsets`: 0 on the rim and everything inside the mound, rising smoothly
over the socket band and half an eyeball radius. The worked examples do this.

```python
holes = {}
for side, eye in (('L', EYE_L), ('R', EYE_R)):
    holes[side] = eye_hole(vertices, faces, eye, EYE_RADIUS, opening=OPENING)
    vertices, faces = holes[side]['vertices'], holes[side]['faces']
head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces}, [skin])
slit_mouth(head, MOUTH_Z, MOUTH_HALF_WIDTH)
still = eye_hole_mask(*holes.values())
left, right = symmetric_offsets(rest, brow_center, .02, (0, 0, -.004), mask=still)
...
eye = build_eye(rig, 'L', EYE_L, EYE_RADIUS, lid_material=skin, hole=holes['L'])
parts.append(eye['lids'])               # eye['socket'] is None: the lining seals the eye
```

**Shutter eyes** (a robot's flat face) take `shutter_hole(vertices, faces, center,
eye_radius, hole_radius=None, max_edge=None, cap_rings=5, **shutter_options)`: it
clips the face plate within `hole_radius` of the gaze axis (default: the blades'
half-width, at most 1.12 eyeball radii), runs the rim straight back along the gaze
axis to the eye center's depth (a tube the blades slide through) and caps it behind
the eyeball, then builds `shutter_geometry` against the holed plate (rejecting
blades that would slide out through it). A plain `cut_hole` in a single-layer tin
skin lets a view from below or the side look past the housing into the head (the
round-3 Bolt). Pass the result to `build_eye(..., style='shutter', hole=...)`,
which keeps the housing. The face plate must stand at least one eyeball radius in
front of the eye center. The `arkit-face/1` verifier's
`eye-oblique` check casts rays around each eye from the front, 3/4 (35 and 45
degrees of yaw) and 20 degrees above and below, in every lid and emotion state,
and fails any that reach the socket or the inside of the head.

**Why lids need solving.** glTF morphs are linear: a vertex travels a straight
chord between rest and target, which dips toward the eye center by
`R * (1 - cos(sweep / 2))`. A lid swept across a round eye as one chord cuts into
the eyeball mid-blink. `lid_geometry(center, eye_radius, opening=(45, 38, 30),
meet=-8, overlap=6, clearance=.0005, thickness=None, squint=.45,
squint_upper_share=.35, wide=(10, 4), span_margin=15, columns=24, rows=8,
gap=None, min_radius=None, corner=1.25, tuck=4)` makes upper and lower lids as thick
spherical shells whose rows keep their yaw (a meridian) and slide in elevation
between a fixed anchor and the lid edge, like a rolling curtain:

- `opening` = (half-width yaw, upper-edge elevation, lower-edge depth) of the
  neutral opening. The lower lid rises to `meet` and the upper lid passes
  `overlap` degrees beyond it, in front of the lower lid, so a blink closes with
  no gap. That is the "limited upper arc with the lower lid rising to meet it".
- The shell radius is **solved**: each lid sits proud of the eyeball far enough
  that every combination of blink, squint and wide weights in [0, 1] keeps every
  lid vertex at least `clearance` (0.5 mm) outside the eyeball, measured exactly
  over the whole weight cube (`lid_clearance`), not only at sampled weights. A
  bigger sweep gives a prouder lid; `min_radius` forces a larger one.
- `squint` is the open fraction left by `eyeSquint` (the contract needs 0.25-0.6
  as seen from the front; other values are rejected); `squint_upper_share` is how
  much of it the upper lid does. `wide` is the (upper lift, lower drop).
- Edges follow `(1 - (yaw / half-width)^2) ** corner`. Steep corners make the thin
  lid rim twist over where blink and squint add past the meet line, so the helper
  checks every morph and morph sum for folded faces (`folded_faces`) and rejects
  settings that fold: raise `corner` or widen the opening and let the skin hide
  the corners.
- Toward the corners the lower lid's edge rises up to `tuck` degrees past the meet
  line, behind the upper lid, so where the lids meet they overlap instead of
  abutting on different radii (an oblique view would find a slit between them).
- Each lid ends in a rounded rim: the outer layer turns down over a quarter round
  (three rows) onto the inner one, which runs on to the edge, so the lids read as
  skin folds wrapping the eyeball rather than square-ended slabs (round 4). The
  rounded rim projects a little higher than a square one, which is why `overlap`
  is 6 degrees: blink 1 + wide 1 stays closed even on a 321-ray grid.

`shutter_geometry(center, eye_radius, aperture=None, opening=(.7, .55), meet=0,
overlap=None, clearance=.0005, thickness=None, blade_height=None, squint=.45,
squint_upper_share=.35, wide=(.2, .1), gap=None, surface=None, skin_clearance=.0005)`
makes a robot's two flat blades in planes in front of the lens (heights are
fractions of the eyeball radius). The blades translate, so clearance holds
trivially at every weight, and the upper blade slides in front of the lower one.

**Coverage, not only clearance.** Morph deltas add: at blink 1 + squint 1 each
blade passes the meet line by its squint travel as well, so a blade sized for
blink alone (the old 1.3 radii) stops short of the eyeball's edge and bares a
crescent (-1.0 to -0.853 radii under the lower blade); blink 1 + wide 1 pulls the
closed blades apart by the wide travel. The edges are linear in the weights, so
the helper takes their extremes over the corners of [0, 1]^3: `blade_height`
defaults to the least that keeps the upper blade's top above the eyeball and the
lower blade's bottom below it (plus 5% of the radius), and `overlap` to the wide
travel plus 8% of the radius. Explicit values that cannot cover are rejected.
Blades that tall stick out past the eye: pass the skin's
`surface=front_surface(skin_vertices, skin_faces)` (eye holes cut) and the helper
rejects blades that would slide out through the face. Flat shutters need a flat
face with the eyes recessed behind it (`ellipsoid_geometry(..., exponent=6)`, a
tin can); on a round head they poke through the forehead.

`lid_geometry` has the same trap: blink 1 + wide 1 parts the closed lids. It
raises the closed lower lid behind the upper one past the meet line (in steps of
a quarter of the wide travel, less half the overlap) until blink + wide stays
closed, taking the least rise that does not fold the lid rim, and reports it as
`lower_rise`.

`eye_coverage(center, radius, geometry, weights)` casts front rays (along +Y) on
a grid over the eyeball's disk, within the lids' `aperture` and between their
anchors (`band`; the skin hides the rest), and returns the rays that reach the
eyeball. `eye_coverage_problems(center, radius, geometry)` runs the contract
states (`COVERAGE_STATES`: blink .25/.5/.75/1 alone and with squint 1, squint 1,
wide 1, blink 1 with wide 1 and with both): every full blink must hide the whole
eyeball and every closing state may show only what neutral shows. Both eye
helpers run it and reject settings that fail; the `arkit-face/1` verifier's
`eye-coverage` check casts the same rays through the whole exported head. `recommended_gaze(opening, iris=26,
margin=4)` gives `yawMax`/`pitchMax` that keep the iris center inside the opening.

### Jaw, mouth slit, teeth and interior

**A puppet jaw drops the chin.** The talking-heads bar wants the chin and the
lower face outline to drop with the teeth (at `jawOpen` = 1 the face's lowest
point drops by at least 10% of the head), not a hole opening in a fixed face. A
hinge only lowers what is well *in front of* it, so **the pivot goes at the back
of the head, level with the mouth line (by the ears)**. A pivot in the middle of
the head swings the chin back and up: the round-1 fixture's chin rose 2.7 mm.

`JawHinge.ear(vertices, mouth_z, half_width, center_x=0, angle=8, drop=None,
drop_reach=None, inset=None, lift=0, **options)` builds that jaw from the head's
vertices: the pivot sits 10% of the head's depth in front of the back of the
head at the mouth line, `drop` defaults to 9% of the head height and
`drop_reach` to half the way from the pivot to the face. On the fixtures this
drops the chin by 12-14% of the head and the lower lip by about 1.3 times that.
Start there and tune `angle` and `drop`.

`JawHinge(pivot, angle=8, mouth_z, half_width, lip_round=.75, band=.03,
back_band=0, drop=0, drop_reach=None, slit_back=None, axis=(1, 0, 0),
mask=None)` is the one jaw every jaw-carried mesh shares. A vertex's `jawOpen`
target is its position turned by `angle * weight` degrees about `axis` through
`pivot` (positive opens), then lowered by `drop * weight`. Morphs are linear, so
a turn alone opens the lips about twice as far as it drops the chin (the lips
are twice as far from an ear hinge); the straight `drop` lowers the chin as much
as the lips. It fades out over `drop_reach` in front of the pivot so the back of
the head stays near the hinge; rigid parts always take the full drop. Keep
`angle` at 30 or less. `weight(p)`:

- is 0 on and above the mouth line, and 1 a `band` below it: the whole lower
  face moves as one;
- on the lower lip follows the mouth's shape, `(1 - (x / half_width)^2) **
  lip_round` (1 in the middle, 0 at the corners), so the lips part in a rounded D;
- beyond the corners and behind `slit_back` (where the slit ends; `ear` puts it
  at the middle of the head, as `slit_mouth` does) fades in over `band`, so the
  cheeks and the back of the head stretch instead of creasing;
- counts a vertex within `SEAM_TOLERANCE` (1 micron) of the line as on it, and
  `weight(p, lower_lip=True)` as just below it: seam vertices are classified by
  tag, never by comparing float32 coordinates with `mouth_z`;
- fades out over `back_band` behind the pivot when that is non-zero, and is
  scaled by `mask(p)` when given (for a neck that must stay put).

`targets(vertices, weight=None, lower_lip=())` returns morph targets; a number
(1 for rigid parts), callable or per-vertex list overrides the weight.
`chin_drop(rest, targets)` reports `{'drop', 'height', 'ratio'}` of the lowest
point, the measurement the verifier's `puppet-jaw` check makes.

`add_jaw_open(obj, jaw, weight=None, name='jawOpen', rigid=False,
min_chin_drop=None)` adds the shape key to an object. It reads the lip-seam tags
`slit_mouth` wrote, so the lower lip opens and the upper lip stays. `rigid=True`
is the **rigid-plate mode**: the whole object moves as one body. Use it for the
lower teeth, the tongue and a robot's chin plate. `min_chin_drop=.1` on the head
skin (or chin plate) rejects a jaw whose lowest point drops by less than 10% of
the object's height, with the measured numbers. Every call rejects a morph that
folds faces.

`slit_mouth(obj, mouth_z, half_width, center_x=0, front_y=None)` bisects a skin
mesh at the mouth line and splits the edges along it on the front (y <
`front_y`, default the mean vertex y) so the lips can part; the corners stay
joined. It tags the seam in the `jaw_seam` point attribute (`SEAM_ATTRIBUTE`; 1
lower lip, 2 upper lip). Round 1 compared coordinates with `mouth_z` instead,
and a mouth line that float32 rounds down (.088, .087, .08) hung the upper lip
on the jaw like a curtain. Call it before shape keys. A vertex a hair off the
mouth line used to make the cut leave a sliver row beside it, which shaded as a
seam across the whole lower face and folded at the lip corners when the jaw
opened; now every vertex closer to the line than a quarter of its crossing edge
first slides along that edge onto the line (it stays on the old surface), so the
cut runs through vertices and no blank needs a row pre-snapped to the mouth.

`sculpt_lips(vertices, faces, mouth_z, half_width, center_x=0, fullness=None,
crease=None, height=None)` gives a skin face soft lips and a lip line at rest: an
upper and a fuller lower lip (each `fullness` proud, 9% of the half width;
`height` 45% of it) either side of a crease along the mouth line (60% of the
fullness deep), thinning to nothing just past the corners. It refines the skin
round the mouth first, so run it on the blank before `mesh_from_geometry` and
`slit_mouth`, then take `front_surface` of its result for the cavity and teeth.
`slit_mouth` then cuts along the crease.

`teeth_row_geometry(style, center, half_width, depth, count, height, row='upper',
width=None, thickness=None, sizes=None, span=150)` lays teeth along an elliptical
arch from `center` (front middle of the gum line), hanging down (`upper`) or
standing up (`lower`). Styles: `'rounded'` (human incisors), `'saw'` (pointed
fangs) and `'grille'` (a robot's rectangular blocks). `sizes` holds one
(width scale, height scale) per tooth, for buck teeth or two long fangs. **Name
the materials `teeth_upper` and `teeth_lower`**: the verifier finds teeth by that
convention.

**Exposed teeth get their own material.** Round 3's buck teeth shared
`teeth_upper` with the hidden upper row, so the verifier could not tell them from
a row poking through the lips. Name the material of teeth that show at rest
`teeth_exposed` (they ride the skull like the upper row; `teeth_exposed_lower`
rides the jaw) and declare that name: `face_contract(..., exposed_teeth=['teeth_exposed'])`.
The verifier fails any tooth that shows at rest unless its material is an
exposed-teeth material listed in `exposedTeeth`, and any listed name that is not
one.

`exposed_teeth_geometry(surface, xs, mouth_z, length, width, style='saw',
root=None, thickness=None, clearance=.0005, sizes=None)` makes upper teeth that
show with the mouth closed: Mossjaw's fangs, Pip's buck teeth. One tooth hangs
at each x, `length` below the mouth line, its root tucked `root` (default 0.35 *
length) under the upper lip. Each stands at least `clearance` in front of the
skin below the line (measured on its vertices, reported as `clearance`), so the
closed lower lip never cuts it and drops away behind it when the jaw opens.
`surface` is the skin's front: `front_surface(vertices, faces)` returns a
function (x, z) -> y of the frontmost skin point (None beside the head). Name
the material `teeth_exposed` (`EXPOSED_TEETH_MATERIAL`), bind it to `head` and
list it in `exposedTeeth`.

`mouth_cavity_geometry(center, width, height, depth, rings=8, segments=32,
surface=None, inset=.004)` is a dark bag behind the lips, open to the front, so
an open mouth never sees through the head. Give it a dark, double-sided material
named `mouth_cavity` and carry it with `add_jaw_open(cavity, jaw)`: the weight
drops its floor with the lower lip. On a curved face a flat rim behind the middle
of the mouth pokes out through the cheeks at the corners, so pass `surface`
(`front_surface(...)`): the rim then follows the skin `inset` behind it, every
other vertex stays at least `inset` behind the skin, and `depth` is measured from
`center`. Near the rim the walls lean forward rather than running edge-on to the
view, which keeps renderers from leaking multisampled pixels of the dark bag
through the skin.
`tongue_geometry(center, length, width, thickness)` is a flat-bottomed dome; name
its material `tongue` and carry it rigidly.

### Skin shapes and head blanks

`soft_offset(vertices, center, radius, offset, mask=None)` returns targets that
push the skin near `center` by `offset`, fading smoothly to zero at `radius` (one
distance, or an (x, y, z) triple for an ellipsoid). `symmetric_offsets(...)`
returns the (Left, Right) pair, mirrored across x = 0; `mirror_x(point)` mirrors
one point. Brows, cheeks and mouth shapes are usually one or two of these per
side. `ellipsoid_geometry(center, radii)` is a closed head blank, and
`cut_faces(vertices, faces, remove)` drops the faces whose centroid
`remove(centroid)` accepts (a hair cap's front, a chin plate) and reindexes the
rest. **It returns a 3-tuple** `(vertices, faces, mapping)`, where `mapping[old]`
is the new index or None. Its rim follows the mesh's faces, so a round hole comes
out stair-stepped.

`cut_hole(vertices, faces, center, radius)` cuts a smooth round (or elliptical,
when `radius` is (rx, ry, rz)) hole: every face the sphere crosses is clipped
exactly at it, so the rim lies on the circle, stays on the original surface and no
vertex moves. **It returns a dict** `{'vertices', 'faces', 'mapping'` (old index ->
new or None)`, 'source'` (new index -> old, None for a rim vertex)`, 'origin'` (the
source face of each face)`, 'boundary'` (the rim vertices)`}`. Use it for mouths
and other openings; **eyes take `eye_hole` (lids) or `shutter_hole` (shutters)**,
which seal the hole (above).

**Brows.** Pick by the head:

- A skin-faced head (a kid): `skin_brow_geometry(skin, side, inner, outer,
  height=.004, thickness=.0016, arch=.002, down=.004, inner_up=.004,
  outer_up=.004, pinch=.002, sink=None, hole=None)` lays a tapered brow **on the
  skin itself**, the way `brow_ridge_geometry` lays a ridge. `skin` is the head
  skin with its eye holes cut: a geometry dict (`vertices`, `faces`, optional
  `morphs`) or, best, **the head mesh object after its shape keys are added**.
  `inner` and `outer` are the (x, z) of the left brow's ends (side 'R' mirrors
  them); pass the eye's `hole`. The centre line is found on the skin, and each
  cross-section is a bump in the plane of the skin's normal, `height` wide and
  `thickness` proud at the middle (tapering to the ends), every point settled on
  the skin along its normal, so the brow follows the forehead's curve, the socket
  dip over the eye and the turn of the temple, with its edges and underside sunk
  `sink` into the skin (15% of the thickness). Each morph moves the brow over the
  face and lays it back on the skin at its new place: `browDown<Side>` lowers the
  inner end by `down` (the outer a third as much) and knits it `pinch` toward the
  nose (angry), `browInnerUp` and `browOuterUp<Side>` lift the ends (meters). When
  the skin has shape keys, every pose is laid on the skin in that pose, so the
  brow rides the head's own brow shapes; those names are listed in the result's
  `laid`, and `attach_to_skin` skips them, so there is nothing to add. Every pose
  is checked with `skin_contact` against the skin and the lids (a deeper sink is
  tried before a brow that cannot lie on the skin is rejected). Give it a hair
  material; a hair cap must clear the brows. Round 5's brow sat `standoff` in
  front of the frontmost of five `front_surface` samples with a vertical
  cross-section, so it stood 0.53-0.92 mm off the skin and its ends stuck out as
  tabs past the forehead; it now takes the skin, not `front_surface(...)`.

  ```python
  brows = [skin_brow_geometry(head, side, inner=(.013, .178), outer=(.05, .181), hole=holes[side]) for side in 'LR']
  joined = join_geometry(brows)
  brow = mesh_from_geometry('brows', joined, [hair])
  for name, targets in joined['morphs'].items(): shape_key(brow, name, targets)
  ```
- Eyes in domes (a frog, a creature): `brow_ridge_geometry` below, lying on the
  skin over the mound.
- A robot: `brow_plate_geometry` (robot plates, below).

`brow_ridge_geometry(center, radius, side, inner=20, outer=55, elevation=50,
height=12, thickness=None, arch=4, down=12, inner_up=10, outer_up=10, skin=...,
hole=..., sink=None, clearance=.0002)` builds a heavy brow ridge for eyes that sit
in domes (Mossjaw's ridge is his brow). It runs round the eye from `inner` degrees
toward the nose to `outer` degrees away, centered `elevation` degrees above the
gaze axis, `height` degrees tall and `thickness` meters proud (18% of `radius`),
and it **lies on the actual skin**: `skin` is the head skin with its eye holes cut
(`{'vertices': vertices, 'faces': faces}`, as for `front_surface`), and every point
of the ridge's base is found on it along its direction from the eye center
(`radius`, the hole's `mound`, is where that search starts). Its cross-section is
a bump whose edges and underside sink `sink` into the skin (12% of the thickness),
so it reads as a fold of the skin and no view sees background under it. Pass the
eye's `hole` so the base never enters the lids: where a lowered brow crosses the
window it rests on the upper lid. The morphs slide the ridge over the skin and lay
it back on at its new place: `browDown<Side>` lowers the inner end most (angry),
`browInnerUp` lifts the inner end (sad, surprised), `browOuterUp<Side>` the outer
end. Every pose is checked with `skin_contact` (against the skin and the lids, as
the verifier does) and a ridge that cannot lie on the skin is rejected. Round 4
laid it on the mound's sphere instead: above the lid window the skin falls away
inside that sphere, so the ridge hung 2.5-9 mm in the air.

```python
skin_surface = {'vertices': vertices, 'faces': faces}   # after every eye_hole
ridge = brow_ridge_geometry(EYE_L, holes['L']['mound'], 'L', elevation=OPENING[1] + 20,
                            skin=skin_surface, hole=holes['L'])
brow = mesh_from_geometry('brow_L', ridge, [skin])
for name, targets in ridge['morphs'].items(): shape_key(brow, name, targets)
```

### Noses and soft forms: `nose_geometry` and `sculpt_skin`

A `soft_offset` sculpt on a head blank's 6-8 mm faces pulls one vertex out into a
spike (the "weird pointy thing" on round 1's Pip). Grow forms with these instead;
both refine the skin where the form is first, so it comes out smooth, and keep
every other vertex's position and index.

`nose_geometry(vertices, faces, tip, size, nostrils=True, nostril_radius=None,
nostril_depth=None, nostril_spacing=None, max_edge=None)` sculpts a round button
nose into the skin: `tip` is the (x, z) of its middle, `size` its (half width,
half height, projection) in meters. The bulb is a ball `projection` proud of the
skin, joined to it by a smooth union with a rounded fillet, so there is no seam and
no part to attach. Two soft nostril dimples are pressed up into its lower slope;
their faces get material index 1 (give the mesh a dark nostril material second).
It returns vertices, faces, `material_indices`, `tip`, `nostrils` and `sneer`, the
left wing's (center, radius, offset) for `symmetric_offsets`: noseSneer lifts and
flares each wing about 3.5 mm on a kid's 21 mm nose.

```python
nose = nose_geometry(vertices, faces, (0, .118), (.0105, .0095, .009))   # after the eye holes
vertices, faces = nose['vertices'], nose['faces']
head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces,
                          'material_indices': nose['material_indices']}, [skin, nostril])
slit_mouth(head, MOUTH_Z, MOUTH_HW)
rest = [tuple(v.co) for v in head.data.vertices]
left, right = symmetric_offsets(rest, *nose['sneer'])
shape_key(head, 'noseSneerLeft', left); shape_key(head, 'noseSneerRight', right)
```

`sculpt_skin(vertices, faces, shapes, max_edge=None)` is the general tool: the
smooth union of the skin and ellipsoids, `shapes` a list of `(center, radii)` or
`(center, radii, blend)` (or dicts with those keys; `blend` is the fillet width,
default half the smallest radius). Cheeks, a chin, a brow bump, a snout: every
vertex near a shape moves out along the skin's normal onto the union's surface,
after the skin there is refined to edges of at most `max_edge` (a sixth of the
smallest radius). Run it on the blank before `eye_hole`, `slit_mouth` and the
shape keys.

### Small parts on the skin: `attach_to_skin` and `skin_contact`

Every small part joined to the face (brows, ridges, nostrils, freckles, warts,
horns, fins) must sit on the skin, not hover over it, and must **follow the skin's
morphs**: a nostril that ignores `noseSneer` is swallowed as the snout swells, and
one the skin pulls away from floats. The verifier's `attached-parts` check fails
both (see the main README).

`attach_to_skin(part, skin, depth=None)` does it for any part. `part` is a
geometry dict (vertices, faces, optional morphs); `skin` is the head skin, either a
geometry dict with its `morphs` or **the Blender mesh object after its shape keys
are added** (it reads them). With `depth`, the part first moves along the skin's
normal so its center sits `depth` meters inside the skin (0 half-sinks a ball).
Then each vertex takes the skin point nearest it as its footprint, and for every
skin morph that moves the skin there the part gets a target that moves each vertex
by the skin's own delta at its footprint (interpolated across the skin triangle, as
the renderer does), added to the part's own morph of that name. The result has
`morphs` and `contact`:

```python
add_jaw_open(head, jaw, min_chin_drop=.1)      # the head's shape keys first
beads = [attach_to_skin(ellipsoid_geometry((x, front(x, .135), .135), (.003, .0018, .002)), head, depth=.0006)
         for x in (.012, -.012)]
nose = mesh_from_geometry('nostrils', join_geometry(beads), [nostril_material])
for name, targets in join_geometry(beads)['morphs'].items(): shape_key(nose, name, targets)
parts.append(nose)                             # then join_face_parts as usual
```

A chin wart rides `jawOpen` the same way. A part can sit on another attached part:
`attach_to_skin(bead, ball)` seats a nostril on a nose ball that was itself
attached to the head (`ball` is the ball's geometry dict with its morphs), and the
verifier judges the bead against the ball it touches. Parts that lie along the
skin and have their own morphs are laid on it by their helpers
(`brow_ridge_geometry`, `skin_brow_geometry`, `rubber_mouth_geometry` all slide
over the skin and lay each pose back on it). `skin_brow_geometry` given the head
object already lays every pose on the posed skin; pass the others through
`attach_to_skin(part, head)` when the skin under them has its own shapes, so they
ride those as well.

`skin_contact(part, skin, tolerance=.0005)` measures a part the way the verifier
does: its vertices and face centers are cut into slices across its longest axis
(one per 1.5 mm, at most 32); a slice touches when its nearest point comes within
`tolerance` of the skin or dips into it, and `gap` is the worst slice's. `visible`
is the share of its points outside the skin. It reports rest and every pose (the
part's own morphs and each skin morph that moves the skin near it) under `poses`.

### Robot plates: brows, skull and chin plate, rubber mouth edge

For a robot like Bolt, whose face is rigid metal plates:

- `ellipsoid_geometry(center, radii, exponent=6)` is a tin-can blank (a
  superellipsoid with rounded edges).
- `split_plates(vertices, faces, split_z, thickness, gap=0, gum_z=None)` cuts a
  closed head exactly at the plane z = `split_z` (no stair steps) into
  `{'skull', 'plate'}`. Each is a closed shell: the outer surface, an inner wall
  `thickness` behind it and a flat rim band joining them in the cut plane
  (`rim` lists the (outer, inner) vertex pairs), so an open jaw shows solid
  edges in three-quarter view instead of a paper-thin open shell. `gap` separates
  the rims. Pass the upper teeth's gum line (their highest point) as `gum_z`: the
  chin plate rides `jawOpen`, and the verifier fails jaw-moved skin above the gum
  line, so a split that would put the plate's rim above it is rejected. Give the
  plate `add_jaw_open(plate, jaw, rigid=True, min_chin_drop=.1)`.
- `brow_plate_geometry(center, (width, depth, height), side, down=12, drop=None,
  inner_up=10, outer_up=10, surface=None, clearance=.0005)` is a rigid brow bar.
  `browDown<Side>` turns it about its outer end so the inner end drops by `down`
  degrees and lowers it by `drop` (40% of its height), `browInnerUp` lifts the
  inner end about the outer end, `browOuterUp<Side>` lifts the outer end about
  the inner end. With `surface` its back sits `clearance` in front of the face at
  every weight combination.
- `rubber_mouth_geometry(surface, mouth_z, half_width, jaw=None, radius=.0015,
  smile=(.0015, .004), frown=.004, stretch=.004, funnel=.004, pinch=.2)` is the
  rubber mouth edge between the plates: an upper and a lower tube touching at
  the mouth line, just proud of the face. It carries `mouthSmile`, `mouthFrown`,
  `mouthStretch` (each side, fading in toward that corner) and `mouthFunnel`
  (forward, pinched and rounded apart), so the plates stay rigid; with `jaw` its
  lower tube rides `jawOpen` rigidly and the upper tube stays on the skull. Each
  ring of a tube moves as one, so the tubes never twist. `upper` and `lower`
  list each tube's vertices.

### Contract extras

`face_contract(root, objects, yaw_max, pitch_max, lid_follow=None, emotions=None,
exposed_teeth=(), drop_missing=True)` collects the morph names from `objects`,
builds the `extras.arkitFace` object (`face_contract_extras`) and attaches it to
`root`: the rig, which is the scene's only root node once the meshes are bound.
It holds `contract: "arkit-face/1"`, the `morphs` list, `gaze.yawMax/pitchMax`,
`lidFollow` (`DEFAULT_LID_FOLLOW`: down .35, up .8), the six `emotions` (default: the
canonical concept-sheet presets, `CANONICAL_EMOTIONS`, with morph curves the head
lacks dropped) and `exposedTeeth` (the teeth visible at rest; `[]` when none).
All 21 required morphs must exist.

**Lid follow must be visible.** E2 wants the upper lid's edge higher at
`eyeLookUp` = 1 (`eyeWide` = `lidFollow.up`) and lower at `eyeLookDown` = 1
(`eyeBlink` = `lidFollow.down`). The contract's fallback `up` of .25 lifts the
default lids (wide 10 degrees) by under a pixel at 512 px (round 3: Pip 0 px,
Bolt 1 px), and the wide travel cannot grow much: blink 1 + wide 1 must still
close. So the helpers tie lid follow to the wide travel and write `up` .8: a lift
of 1.7-2.8 mm on 12-20 mm eyes, and on the default shutters (wide .2 radii) 1.9-2.6
mm. The verifier's `lid-follow` check measures the edge in a front view and fails
a lift or drop under 1.5 mm (about 2 px at 512 px). If you shrink `wide`, raise
`lid_follow={'down': .35, 'up': ...}` to match.

`validate_face_contract_extras(extras, morphs)`
lists schema problems. `ARKIT_REQUIRED`, `ARKIT_OPTIONAL`, `ARKIT_GAZE` and
`ARKIT_NAMES` (all 52 ARKit curves) are exported.

Blender's glTF exporter drops JSON-shaped custom properties, so `export_glb` now
writes each exported object's attached extras into its glTF node after export.
`merge_glb_node_extras(path, {node_name: extras})` patches the GLB's JSON chunk and
leaves the binary chunk untouched. three.js exposes the result as
`root.userData.arkitFace`.

Check the exported head with `node scripts/agent-meshes.mjs verify model.glb
--contract arkit-face/1`, and look at it with `node scripts/check-face-rig-browser.mjs`
(see the main README).
