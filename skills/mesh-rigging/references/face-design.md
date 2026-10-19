# Face design: reuse a lesson, choose an implementation

Start with the brief, existing asset and consuming app. Record required rest
silhouette, expressions, view distance, coordinate system, topology/rig ownership
and the output contract. A tiny game face with three custom expressions can be a
better fit than a full human expression set. A robot's rigid plates can be a better
fit than deforming skin. These are choices to make, not missing features to fill.

## Ownership and consumption

Keep the editable recipe, shape choices, palette, input sculpt/landmarks and
application acceptance images in the project. Import the shared helper operations
you need. The supported Blender runner supplies `scripts/blender_lib`; do not
hardcode a mutable plugin cache path or copy an entire helper implementation for
one proportion change. Pin the toolchain and declare project imports/data in the
build config; see [native build identity](../../mesh-build/references/native-build-identity.md).

Blender Python runs at asset build time. R3F/three.js, Godot, Unity or Unreal loads
the exported model and runs its own animation/control code. Importing Python face
helpers into the web app is not the consumption model. Copying an example into
authored project inputs is expected; copying the shared library means owning a
fork, its donor-data licenses, updates and validation. See
[tool profiles](../../mesh-tool-selection/references/tool-profiles.md) for
engine-specific representation and mutation limits.

## Pick only what the task needs

| Task | Useful shared operation | Inputs and limits | Check the result |
| --- | --- | --- | --- |
| Shape a new procedural blank | `ellipsoid_geometry`, `sdf_blank`, `join_geometry` | metre-scale vertices/faces; topology is your choice | silhouette and valid indices before Blender |
| Add features to an existing sculpt | contact, lining and skin-follow helpers | actual surface, landmark positions and morph states; preserve its topology assumptions | seams and contact through intermediate poses |
| Make lids over spherical eyes | continuous eye/lid helpers | eye centers/radii, aperture and chosen motion range | penetration and coverage at rest, mid-blink and mixed expressions |
| Make a mechanical face | shutter/plate geometry and rigid bindings | recessed eyes and explicit pivots; suitable clearance | parts remain rigid and clear each other through motion |
| Make a talking jaw | `JawHinge`, mouth cavity and attachment helpers | meaningful hinge, mouth surface and parts that follow it | chin motion, lip seam and teeth/cavity intersections |
| Deliver an ARKit-compatible head | [arkit-face/1 profile](arkit-face.md) | its named morphs, eye bones and extras | selected contract verifier plus consumer renders |
| Adapt the hm08 stylized character example | project-owned `stylized_face` recipe | hm08 head and the example's parameter/landmark vocabulary | explicit composition and exported old/new comparison |

The first operations do not imply the last two. The hm08 example's age/presentation
defaults, head envelope, beard choices and neck fit are not requirements for a
different sculpt or a nonhuman head.

## Diagnose the cause before selecting a helper

| Symptom | Transferable lesson | Example implementation and applicability |
| --- | --- | --- |
| A blink is clear at its endpoints but cuts the eye halfway | Linear morph interpolation follows straight chords; sample intermediate states and combinations | continuous spherical lids solve one eye construction; a flat shutter needs a recessed mechanical layout |
| The mouth opens but the chin hardly moves | The pivot and which vertices/parts follow it determine jaw motion | a puppet hinge is one implementation; a hinged metal plate can use a rigid transform |
| A brow, nostril or tooth floats during an expression | Attached features need compatible motion and a meaningful support surface | skin-follow or shared weights/morphs; rigid robot components may intentionally remain separate |
| Openings look dark or disconnected in three-quarter view | An opening needs coherent thickness, support and interior surfaces | lining/cavity or a modeled solid opening; do not assume a front-view cut is enough |
| A hood clips through the head or changes silhouette in a pose | Fit involves ease, support, openings and motion clearance | test the chosen garment/head poses; one cast's millimetre clearance and backpack fit are examples |
| Import drops morphs, colors or bones | Verify the exported representation and actual engine importer | use the chosen engine profile and inspect its imported asset, not Blender's preview alone |

## Small authoring loop

1. Freeze one brief and the current inputs. Select one failure to solve.
2. Copy a small example only if its construction fits. Name its assumptions.
3. Keep design parameters in the project and call selected shared operations.
4. Check small pure geometry fixtures while editing. Export after the local
   operation works; check rest, intermediate and combined required states.
5. Judge the delivered model against the brief in the target app. Retain the
   cause, applicability and verification lesson for the next project.

Our CI protects supported input/output and helper behavior. Full recipe studies
show that particular examples still behave as authored; they do not promise a
specific artistic result for every face or prove skill transfer. Measuring time
saved requires different briefs at comparable accepted quality, including reading,
setup, rework and review time.
