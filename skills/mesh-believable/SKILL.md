---
name: mesh-believable
description: Make agent-meshes models read as believable objects and creatures rather than piles of primitives, using shells, lathe and prism profiles, anchored joints, ground contact checks, scale and silhouette rules, render polish and the Blender refine stage.
when_to_use: Use when a model looks blocky, boxy, lumpy, robotic or like floating pieces, when feet hover or sink, when asked to make a model look real, organic, smooth, or "like an actual bird/horse/animal", or before presenting any model to a person.
---

# Believable shapes

For characters and their clothing, hair or facial attachments, read the
[construction checklist](../../scripts/blender_lib/references/character-construction.md)
before adding detail. It covers anatomy, connected construction and scoped evidence.

Separate primitives read as floating pieces. Believability comes from a few mechanisms, applied
in this order, and from looking at renders between steps. Commands run through the managed
launcher from `mesh-setup`; operation shapes are in
[operations](../mesh-authoring/references/operations.md).

## 1. Silhouette first

Block the model as a few large primitives that match the real silhouette from the front and the
side, at real-world scale in meters. Check proportions against a reference: a horse's body is
about two heads long and its legs about as long as its body is deep. Then add secondary forms
(neck, haunches, breast) as overlapping spheres and capsules, not as separate detached shapes.
Render `front.png` and `side.png` and fix the silhouette before any detail.

## 2. Fuse with a shell

`shell.set` blends a list of parts into one surface with rounded, continuous transitions, the
single biggest step from "primitives" to "sculpture". Overlap members by roughly the `blend`
distance; a member that does not touch or nearly touch its neighbor stays a bump. Keep crisp
features (eyes, beak, hooves, buttons) as separate parts on top of the shell rather than inside
it. Use one shell per organism; a rigid-bound shell is skinned automatically from its members.
Holes and hollows come from `cut`: list a part (a cylinder through a torso, a sphere inside a
bowl) and the shell subtracts it with the same blend instead of rendering it.

## 3. Use profiles for anything turned or cut

A `lathe` profile gives hooves, vases, bells, lamp bases, heads of pins and rounded bellies with
a real curve instead of a stack of cylinders. A `prism` outline gives fins, ears, leaves, plates
and letters with a drawn silhouette. Both accept up to 64 points, so trace the reference shape.
Trace a lathe profile bottom to top along the outside (a hollow bell: down the inner wall, back up
the outer wall). A model that renders dark or as a black silhouette inside its outline is usually a
profile traced the other way; the `LATHE_PROFILE_INWARD` warning names the part.

## 4. Anchor at joints and touch the ground

Place limb parts with `anchor` at the bone they belong to, so nothing drifts when the rest pose
changes. Then check contact: measure the lowest point of the posed model over each clip (the
viewer's `bounds()` in [viewer API](../mesh-build/references/viewer-api.md)) and adjust bone
positions or the root height until stance feet sit within a centimeter of y = 0. Hanging things
(wires, chains, ropes) must be authored in the same frame as what they hang from; a wire drawn at
a bone-local x while its arm sits at a world x is the classic detached-string bug.

Parts must touch each other too. On a static model, `verify` (and every build) measures each mesh
part's real triangles against every other part and reports a part, or a group of touching parts,
that is more than 1 cm from the rest as `DETACHED_PART` with the part names, the nearest part and the
gap in metres (`WARN DETACHED_PART: pod_l touches nothing else: 0.137 m from the nearest part
(spine)`). It catches what bounds checks miss: a winglet, vane or drum inside the model's bounds that
touches nothing. Fix it by moving the part onto its neighbour or overlapping them; `--allow-detached
halo` (or `verify.allowDetached`) exempts a part that floats on purpose. The lint measures contact,
not support: a winglet whose root overlaps a wing tip by a few centimetres passes even if most of it
hangs in the air, so still look at the top and side renders. Skinned or animated models are skipped
(rest-pose gaps between moving parts are often intended); check them on the clip contact sheets.

## 5. Render polish, then Blender if it earns it

Renders already carry environment lighting, soft shadows and shell ambient occlusion. An
`outline` in the viewer options gives an illustrated look that hides small seams. When the
subject needs fur, feathers or a sculpted skin, add the `refine` block to `build.json`
([mesh-build](../mesh-build/SKILL.md)): one subdivision level plus a small noise displacement
(around 0.003 m, scale 0.04) limited with `only` to the shell. Lower the shell resolution first;
a 96-cell shell subdivided once produces tens of thousands of vertices. Section 6 has measured
triangle costs for shells and lathes.

## 6. Turned objects and triangle budgets

Measured on a 12-piece chess set (agent-meshes 0.13.1, Blender 5.2.2). Numbers are for these tools as shipped; recheck
`capabilities` for anything that may have changed.

**Lathe conventions.** The unit profile is `[radius, height]` with radius 0 to 0.5 and height -0.5 to 0.5. The real
radius is `r * size[0]` (not `size[0] / 2`), the lathe's centre is the part origin, so the bottom is at `-size[1] / 2`
(place the part at `y = ymin + size[1] / 2` to stand it on the ground). Profile points with radius 0 at the first and
last point close the bottom and top caps; no extra cap geometry is needed. Up to 64 points.

**What a lathe costs.** Triangles = `2 * segments * (profile points - 1)`: a pawn of 27 profile points at 32 segments is
1,664 tris (an earlier, shorter profile measured about 1,400). In Blender's screw lathe each zero-radius endpoint welds its pole
and saves `segments` triangles. So every profile point you add costs `2 * segments` triangles: at 32 segments, 64 triangles;
at 76 segments, 152. A reference-faithful queen profile of about 55 points is 3,000 triangles at 28 segments before the
crown. Spend points on silhouette changes and segments on the largest drum, and use two lathes joined (a body at 40
segments, a head at 76) rather than one lathe at 76.

**Grooves cost 3 profile points each** (in, bottom, out). Nine ring grooves are 27 of about 62 points and took a king to
3,356 tris at 24 segments. Chamfering a circumference edge at 76 segments adds about 150 triangles per ring, and a 2-segment
bevel instead of 1 added about 560 to a rook (3,440 to 4,000). Bake the budget in early with a per-feature count
(`recipes/set-stats.mjs` after each build).

**`shell.set` is the wrong tool under a mobile budget.** Resolution is a cell size (longest axis / resolution), not a
quality knob, and nothing predicts the triangles. Measured: a bishop mitre (about 0.4 x 0.55 m, one member, one cut) was
about 3,300 tris at resolution 22; a knight head shell about 1,600 at 24 (blobby) and about 3,300 at 32; the documented
"good default" of 48 gives 10k+ for the same mitre, so cost rises about 3x for 2.2x the resolution. A smoothed knight at
resolution 28 with blend 0.07 was about 3,300 tris. Features are limited by the cell: a `cut` smaller than about twice the
blend barely registers and a larger one removes thin parts; eyes, nostrils and a mouth as cuts were not readable at 6 cm. A
shell also bakes tint and ambient occlusion into `COLOR_0`/`COLOR_1`, which shifts a flat colour (see mesh-authoring,
"Materials today"). Use a shell for organic fusion on a model with a generous budget; use lathes, prisms and Blender
booleans for hard-surface props with a cap of a few thousand triangles. A piece that must look round at close range needs
about 3,500 triangles, more than a 2,500 mobile cap, so agree the cap before modelling, not after.

**Shallow recesses are invisible without ambient occlusion.** Flat parts get directional shading only. Judge a recess by the
depth it has at the SIZE IT IS SHOWN, in real millimetres: 2 mm at authored scale was invisible, 12 mm still a faint band,
25 to 30 mm (about 1 mm at VR scale) read only faintly in the front view, and 50 mm (about 2 mm at VR scale) finally read
as a slot. Author arrow loops, ring grooves and engraved lines at a depth that survives the viewer's lighting, then check
with a close-up camera (`set-sheet.mjs --camera ...`), not the auto-framed render. A recess built from separate raised
pieces around a gap is never an acceptable stand-in for a cut; if you cannot cut, say so.

**Flushness needs a shared segment grid.** A prism's arc polygon never coincides with a lathe's facets, so flush pieces z-fight
or step by about 1 mm. Generate the added vertices on the lathe's own step angles (a segment count divisible by the number of
repeats, for example 8 merlons on 48 or 56 segments) and union exactly, or cut the feature out of a high-resolution drum so it inherits the drum's curvature:
additive merlons on a 48-step grid read as flat facets, crenels cut from a 76-segment drum read as one round tower.

**Corners and ripples.** A lathe's normals are averaged across every profile joint, so a ledge with real corners shades as a
rounded blob. From 0.14.0, list the corner points in `corners: [indices]` on the lathe: normals split there and nothing else
changes (one extra vertex ring per corner, no extra triangles). On an older release, either put two points about 0.4 mm either
side of the corner (3 corners at 32 segments cost about 500 triangles, 1,472 to 1,984) or build the lathe in Blender and use
`shade_smooth_by_angle` (35 degrees keeps ring corners crisp and still selects no circumferential neighbour at 4.7 degrees;
55 degrees softens them). Two nearly collinear profile points on a flare ripple under smooth shading:
spacing and curvature continuity matter more than point count.

**Notch and lip vocabulary.** Name the feature before you model it, in profile order from the ground up.
- *Plinth*: the flat stepped slab a piece stands on.
- *Shoulder*: the convex turn where the plinth rounds into the body.
- *Cove*: a concave quarter-round (radius goes in, then out). Any profile that goes in and then out is a groove, however gentle.
- *Bead*: a small convex rounded ring. *Collar*: a ring that flares out under a head or neck. *Saucer*: a shallow flared dish
  of a ring. *Lip* or *notch*: an outward ledge on the profile.
- *Battlement*: the notched top of a tower wall, made of raised *merlons* and the gaps (*crenels*) between them. An *arrow loop* is a
  separate narrow slit in the wall below; do not add one unless the brief names it.

**Specify a shape by pointing at one.** The pawn base took four rounds (cove, lip, block ledge, saucer) because each comment
was a single word with no picture. Say "match the neck collar on this same piece", with the numbers: that reference
resolved it in one. When asked for a "uniform" element, first state the geometric invariant ("radius never increases up to the
column") and add a numeric check (a silhouette from the GLB, a local-minimum test on the profile), then design; look at a
side-by-side lineup first to find which piece is the outlier before changing them all.

**When a brief uses a term you do not recognise, restate it or ask before building.** "Parapets / arrow loops" was misread:
the arrow loops were invented, the owner meant the battlements, and the workaround construction produced exactly the faceted
look the owner disliked. One sentence ("I read this as X; correct?") is cheaper than a rebuild.

## 7. Verify by looking

For a deliberate delivery review or recurring anatomy/clothing defects, use
[mesh-quality-review](../mesh-quality-review/SKILL.md): full orbit, reference fidelity and
head-to-toe close-ups, including both hands and soles.

Structure passes when `verify` reports zero errors and no `DETACHED_PART` warning you did not
intend. Believability passes when the front, side
and perspective renders and every contact sheet match the intent, feet contact the ground, and
nothing floats. If a shape cannot be made believable with these tools, say so and describe the
missing capability rather than shipping a compromise; the tool is meant to grow.
