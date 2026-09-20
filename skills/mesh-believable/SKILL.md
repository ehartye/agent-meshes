---
name: mesh-believable
description: Make agent-meshes models read as believable objects and creatures rather than piles of primitives, using shells, lathe and prism profiles, anchored joints, ground contact checks, scale and silhouette rules, render polish and the Blender refine stage.
when_to_use: Use when a model looks blocky, boxy, lumpy, robotic or like floating pieces, when feet hover or sink, when asked to make a model look real, organic, smooth, or "like an actual bird/horse/animal", or before presenting any model to a person.
---

# Believable shapes

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

## 4. Anchor at joints and touch the ground

Place limb parts with `anchor` at the bone they belong to, so nothing drifts when the rest pose
changes. Then check contact: measure the lowest point of the posed model over each clip (the
viewer's `bounds()` in [viewer API](../mesh-build/references/viewer-api.md)) and adjust bone
positions or the root height until stance feet sit within a centimeter of y = 0. Hanging things
(wires, chains, ropes) must be authored in the same frame as what they hang from; a wire drawn at
a bone-local x while its arm sits at a world x is the classic detached-string bug.

## 5. Render polish, then Blender if it earns it

Renders already carry environment lighting, soft shadows and shell ambient occlusion. An
`outline` in the viewer options gives an illustrated look that hides small seams. When the
subject needs fur, feathers or a sculpted skin, add the `refine` block to `build.json`
([mesh-build](../mesh-build/SKILL.md)): one subdivision level plus a small noise displacement
(around 0.003 m, scale 0.04) limited with `only` to the shell. Lower the shell resolution first;
a 96-cell shell subdivided once produces tens of thousands of vertices.

## 6. Verify by looking

Structure passes when `verify` reports zero errors. Believability passes when the front, side
and perspective renders and every contact sheet match the intent, feet contact the ground, and
nothing floats. If a shape cannot be made believable with these tools, say so and describe the
missing capability rather than shipping a compromise; the tool is meant to grow.
