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
from agent_meshes_author import (face_skeleton, build_eye, JawHinge, add_jaw_open,
    slit_mouth, cut_hole, front_surface, teeth_row_geometry, exposed_teeth_geometry,
    mouth_cavity_geometry, tongue_geometry, brow_ridge_geometry, chin_drop,
    mesh_from_geometry, soft_offset, symmetric_offsets, shape_key,
    join_face_parts, face_contract, recommended_gaze)
```

They follow the face contract in `arkit-face/1` and Blender's axes: **Z up,
meters, the face looks down -Y, the character's left is +X** (glTF export turns
this into Y up with the face looking down +Z). Angles are degrees. Geometry
helpers are pure Python and return `{'vertices', 'faces', ...}` dicts in world
coordinates; the Blender wrappers build objects with identity transforms. The
pure-Python checks run with `python tests/blender_face_geometry.py`. The complete
worked examples are `tests/fixtures/face-rig/test_head.py` (round eyes, lids, an
ear-hinged puppet jaw), `test_robot.py` (shutter eyes, grille teeth, a rigid chin
plate) and `test_frog.py` (a wide frog: lid domes with brow ridges, saw teeth,
two exposed fangs, a cavity fitted to the curved face).

### Skeleton, binding and one face mesh

`face_skeleton(head, eye_left, eye_right, name='Face rig')` creates the armature
with `head` (root) and `eye_L`/`eye_R` children pivoting at the eyeball centers.
`eye_left` must have the larger x. Bones point up with zero roll, so each exports
with an identity rest rotation: gaze yaw is a turn about the bone's local Y (up),
pitch about its local X. `bind_rigid(mesh, rig, bone='head')` binds every vertex
100% to one bone.

`join_face_parts(parts, name='face', rig=None, bone='head')` joins every
morph-bearing part (skin, lids, sockets, teeth, tongue, mouth cavity) into **one**
mesh object, keeping each part's materials, smooth flags and shape keys; a part
without a key keeps its rest shape in it. It is required: Unreal discards *every*
morph name in a file when a name repeats across glTF meshes, and the jaw, for
one, moves the skin, the lower teeth, the tongue and the cavity. The object
exports as one glTF mesh with one primitive per material, all carrying the same
morph names. The parts are consumed and UV maps are not carried. With `rig`, the
result is bound to `bone`. Eyeballs stay separate: they are bound to their eye
bones and carry no morphs. The pure `join_geometry(parts)` does the same for
geometry dicts.

### Eyes: eyeball, lids or shutters, socket

`build_eye(rig, side, center, radius, style='lid', lid_material=None,
socket_material=None, eye_materials=None, iris=26, pupil=12, socket=True,
**options)` builds one eye (`side` is `'L'` or `'R'`, and `center` must be the eye
bone's head):

- `eyeball_<side>`: a sphere whose poles lie on the gaze axis, with rings on the
  iris and pupil borders and three material slots `eye_white`, `eye_iris`,
  `eye_pupil`, bound 100% to `eye_<side>` (`eyeball_geometry`).
- `lids_<side>`: the lids with `eyeBlink<Side>`, `eyeSquint<Side>` and
  `eyeWide<Side>` shape keys, bound to `head`. `options` go to `lid_geometry`
  (`style='lid'`) or `shutter_geometry` (`style='shutter'`).
- `eye_socket_<side>`: a dark cup between the eyeball and the lids, open toward
  the front, that hides the head's interior (`socket_geometry`).

It returns `{'eyeball', 'lids', 'socket', 'geometry'}`; `geometry` reports the lid
radii, `min_clearance` and the achieved `squint_ratio`.

**Why lids need solving.** glTF morphs are linear: a vertex travels a straight
chord between rest and target, which dips toward the eye center by
`R * (1 - cos(sweep / 2))`. A lid swept across a round eye as one chord cuts into
the eyeball mid-blink. `lid_geometry(center, eye_radius, opening=(45, 38, 30),
meet=-8, overlap=4, clearance=.0005, thickness=None, squint=.45,
squint_upper_share=.35, wide=(10, 4), span_margin=15, columns=24, rows=8,
gap=None, min_radius=None, corner=1.25)` makes upper and lower lids as thick
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

`shutter_geometry(center, eye_radius, aperture=None, opening=(.7, .55), meet=0,
overlap=None, clearance=.0005, thickness=None, blade_height=None, squint=.45,
squint_upper_share=.35, wide=(.2, .1), gap=None)` makes a robot's two flat blades
in planes in front of the lens (heights are fractions of the eyeball radius). The
blades translate, so clearance holds trivially at every weight, and the upper
blade slides in front of the lower one. `recommended_gaze(opening, iris=26,
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
on the jaw like a curtain. Call it before shape keys.

`teeth_row_geometry(style, center, half_width, depth, count, height, row='upper',
width=None, thickness=None, sizes=None, span=150)` lays teeth along an elliptical
arch from `center` (front middle of the gum line), hanging down (`upper`) or
standing up (`lower`). Styles: `'rounded'` (human incisors), `'saw'` (pointed
fangs) and `'grille'` (a robot's rectangular blocks). `sizes` holds one
(width scale, height scale) per tooth, for buck teeth or two long fangs. **Name
the materials `teeth_upper` and `teeth_lower`**: the verifier finds teeth by that
convention.

`exposed_teeth_geometry(surface, xs, mouth_z, length, width, style='saw',
root=None, thickness=None, clearance=.0005, sizes=None)` makes upper teeth that
show with the mouth closed: Mossjaw's fangs, Pip's buck teeth. One tooth hangs
at each x, `length` below the mouth line, its root tucked `root` (default 0.35 *
length) under the upper lip. Each stands at least `clearance` in front of the
skin below the line (measured on its vertices, reported as `clearance`), so the
closed lower lip never cuts it and drops away behind it when the jaw opens.
`surface` is the skin's front: `front_surface(vertices, faces)` returns a
function (x, z) -> y of the frontmost skin point (None beside the head). Name
the material `teeth_upper`, bind it to `head` and list it in `exposedTeeth`.

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
`remove(centroid)` accepts (a chin plate) and reindexes the rest. Its rim
follows the mesh's faces, so a round hole comes out stair-stepped.

`cut_hole(vertices, faces, center, radius)` cuts a smooth hole for an eye (or a
mouth): it removes every face with a vertex inside the sphere (or the
ellipsoid, when `radius` is (rx, ry, rz)) and slides each rim vertex along its
removed edge onto it, so the rim lies exactly on the circle and stays on the
original surface. Moves that would fold a face are backed off. It returns
`{'vertices', 'faces', 'mapping', 'source', 'boundary'}`.

`brow_ridge_geometry(center, radius, side, inner=20, outer=55, elevation=50,
height=12, thickness=None, arch=4, down=12, inner_up=10, outer_up=10)` builds a
brow ridge for eyes that sit in domes (a frog, a creature): a tapered ridge on
the sphere of `radius` around the eye center (pass the lid's outer radius,
`upper_radius + thickness` from `build_eye(...)['geometry']`), from `inner`
degrees toward the nose to `outer` degrees away, at `elevation` degrees above
the gaze axis. Its morphs turn it over the dome about the eye center:
`browDown<Side>` lowers the inner end most (angry), `browInnerUp` lifts the inner
end (sad, surprised), `browOuterUp<Side>` the outer end. Its base sits far
enough out that no weight combination dips into the dome (`min_clearance`
reports the margin), so it never cuts the lids. Make it a mesh, add its morphs
with `shape_key`, and join it into the face.

### Contract extras

`face_contract(root, objects, yaw_max, pitch_max, lid_follow=None, emotions=None,
exposed_teeth=(), drop_missing=True)` collects the morph names from `objects`,
builds the `extras.arkitFace` object (`face_contract_extras`) and attaches it to
`root`: the rig, which is the scene's only root node once the meshes are bound.
It holds `contract: "arkit-face/1"`, the `morphs` list, `gaze.yawMax/pitchMax`,
`lidFollow` (default down .35, up .25), the six `emotions` (default: the
canonical concept-sheet presets, `CANONICAL_EMOTIONS`, with morph curves the head
lacks dropped) and `exposedTeeth` (the teeth visible at rest; `[]` when none).
All 21 required morphs must exist. `validate_face_contract_extras(extras, morphs)`
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
