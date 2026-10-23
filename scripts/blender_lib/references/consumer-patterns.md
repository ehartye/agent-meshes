# Carry consumer lessons into the next model

Use this guide when a model must retain its appearance and controls in a game,
interactive lesson, face viewer or native engine. It transfers patterns exercised
by five consuming projects. Examples establish
bounded workflows; they do not declare every consumer adaptation a shipped API.

Start character work with [construction](character-construction.md),
[character craft](character-craft.md) and the
[mannequin library](mannequin-library.md). Static props need shape, material,
scale and attachment checks, without adopting character anatomy or a face rig.

## Declare what the consumer actually controls

Record canonical source/config paths, tool version, input hashes, units, forward
axis, pivot, named controls and required views before building. Preserve a known
accepted export and its evidence before repairs. Generated assets are outputs;
make repeatable changes in their canonical sources.

For parameterized models, save the seed and the resolved parameter values.
A seed alone cannot reproduce a result after the generator or defaults change.
Keep style presets separate from sampled dimensions and record both.

Inventory the nodes the consumer addresses: exact names, parent paths, local
frames, bones, morph groups, material slots and required sockets. Distinguish
these controls from authored clips. A car with no clips can still expose named
wheel transforms and glow groups driven by its runtime. An empty animation list
does not establish that the model has no useful animation controls.

| Need | Construction/control choice | Acceptance evidence |
| --- | --- | --- |
| Rigid moving mechanism | Named rigid parts; explicit pivots; analytic solver or sampled transforms | Fixed lengths, endpoint alignment, phase/ratio and loop checks on exported parts |
| Deforming creature | Anatomical joints, continuous skin and selected weight donors | Isolated bends, actual posed skin, sole contact and whole-loop closure |
| Editable sculpture | Stable morph topology or real topology-changing carving | Silhouette, voids, attachment points and required parameter combinations |
| Runtime vehicle | Named wheel/glow groups and consumer motion policy | Addressed-node inventory and actual steering, spin, glow and reset behavior |
| Facial performance | Declared clip/manual/blink/gaze ownership | Combined exported poses, coverage, clearance and state restoration |
| Engine installation | Explicit import manifest and calibrated frame conversion | Actual imported identities, LODs, materials, poses and consumer checks |

Read the shipped APIs for [runtime controls](../../../src/render/puppet.ts),
[rigging](../../../src/core/rig.ts) and
[named-frame assemblies](../../../src/render/assembly.ts).

## Preserve the mechanism, not only its mesh

Identify which behavior is live simulation, analytic kinematics, baked animation,
manual pose control or static geometry. A GLB contains only the authored data
exported into it. Copying a static exhibit does not port its coupled mobile,
linkage, rotating paper, drawing trace or visitor controls.

Use one source of dimensions for geometry and its solver. Belt pitch radii must
match the rendered wheels; rod endpoints must follow the solved joints. Derive
a drawing trace from the actual nib in the paper's moving frame. Independent
decorative motion can look plausible while breaking the lesson's causal result.

Keep rigid rods and timbers rigid. A rigid bone per part can transport sampled
machine motion, but it is not an anatomical skinning recipe. Preserve source
ancestry, material names, clip timing and transform samples in the handoff.
Check evaluated vertices against the source transforms, then round-trip the
export. Include the closing frame when inspecting a claimed loop.

Ideal linkages and belts do not establish load, friction, collision or balance.
A coupled physics model also has declared approximations. Read the
[belt model](../../../src/mechanisms/belt-drive.ts),
[mobile model](../../../src/physics/mobile.ts) and
[explicit skin binding](../README.md#creating-geometry) for their actual scope.

## Separate mating frames, pivots and surface attachments

A bottom-center pivot places a prop on a floor. A mating frame also declares
orientation and the local attachment position. Keep both when a part needs both;
moving the origin to the bottom cannot replace its socket or joint frame.

Solve mating frames in a declared common space, including transformed parents.
Retain full affine transforms where nonuniform scale or shear matters. Check
secondary contacts and dependency order before accepting a snap. Coincident
frames establish placement, not strength, support or collision-free assembly.

Node observations track local points through node transforms. They do not follow
arbitrary morphing skin. For repeated morphable forms, measure deformed end
rings or retain explicit surface correspondence. For weighted attachments, use
the intended donor surface and check the real posed attachment boundary.

Declare metres/centimetres, up/forward axes and rotation conventions at each
boundary. Calibrate an importer with known asymmetric landmarks and dimensions.
Apply conversion once; inspect reflected scale, normals and actual native bounds.
Keep a reference person's dimensions intact when that person teaches scale.

See [reference fitting](../README.md#fitting-a-reference-rig),
[local influence transfer](../README.md#transferring-a-local-skin-influence) and
[bounds/pivot checks](../../../src/glb-limits.ts).

## Keep shape, negative space and materials meaningful

Judge silhouette, major masses, junctions and intentional holes before polish.
A dark patch is not a through-hole. Carving must remove real volume; distinguish
the cutter preview, the remaining solid and the removed piece. Inspect through
the opening from several sides, including the underside and intended camera.

Blending can join masses but can also erase landmarks and gaps. A smooth pile
of primitives still needs purposeful cross-sections. Avoid capped limbs leaving
shelves at a junction, thin fins pasted onto skin and garments tracing every
body hollow. Preserve those shape decisions during reduction and posed fitting.

A fixed furniture footprint does not require a block silhouette. The saloon's
second environment response retained its table/chair bounds while adding turned
supports, eased tabletop edges, depressed seats and joined curved back members.
Check actual member intersections, seat depth, ground contact and the complete
posed/assembled bounds. Wood grain should follow each member's length; planar
caps need a different UV projection from a turned side. Keep diffuse, normal and
roughness coordinates aligned. Restrained contact wear and finish variation
support construction; arbitrary noise over the photograph cannot supply it.

For members that become gameplay cover, retain their slope, radius and finite
end treatment in the handoff. A sloped round rail's enclosing box can block empty
space above its low end; clipping only to its centerline can omit the beam's
upper half. Compare the consumer's cover proxy with actual exported/rendered
member intersections, including endpoint rims and grazing rays. Camera padding
is a separate consumer policy. Semantic collision export remains planned.

Use stable parallel-transport frames for sweeps. Pin contact rings across morphs
and use the same explicit initial normal for a family of shapes. Check outward
winding, end caps and shading separately. An open path needs its intended caps;
a closed path joins back to itself without caps. A lathe closes on the axis only
where its profile reaches radius zero; a hollow object needs an inner wall.

Topology-changing cuts, fusion and reduction precede dependent morphs and final
weights, or require explicit correspondence. Equal vertex counts alone do not
establish matching order or anatomical correspondence. Check planar triangle
orientation across bent poses; valid rest triangulation can invert in motion.

Preserve color-space intent and material meaning. Vertex paint needs exported
color attributes and an imported shader that consumes them. Preserve native
materials by semantic slot identity, then read the assignments back. Verify
effective base color, metalness, roughness and transparency before visual review.
Neither a material filename nor a successful setter proves the rendered finish.

For photographic fabric, leather or skin maps in Blender sources, use
[image materials with authored UVs](../README.md#image-materials-with-authored-uvs).
The Python `image_material` helper keeps the three explicit image roles, color
spaces, named repeating UVs and normal strength coherent and packs the images.
It does not extend JSON operations, unwrap geometry or choose physical scale.
Measure sweep circumference/arc length and garment panels in metres, divide
by the provider's U/V tile dimensions, and correct face-corner wrap seams and
cap islands before assigning maps. A global-axis projection on a bent sleeve
can stretch weave while a correct material still exports successfully.
Repair shoulder, elbow, pelvis and boot junctions before texture polish; check
those same boundaries through the actual consumer's pose limits.

Use [geometry helpers](../README.md#creating-geometry),
[lathe contract](../../../src/agent-contract.ts),
[skin paint](../README.md#skin-paint-skin_tints-paint_vertices-use_vertex_colors)
and [static props](../README.md#static-props-agent_meshes_props).

## Reuse humanoid rigs with their actual rest frames

Pin donor geometry, skeleton, inverse binds, clips and their separate asset/code
licenses. Matching bone names do not establish matching rest orientations:
Mesh2Motion's inspected human-base, addon and standalone human rig differ there.
Convert the source forward axis once, preserve left/right identity, fit actual
joint landmarks/lengths and retarget through source/target world rest frames.
Select the needed clips rather than exporting a whole library into every actor.

Verify the conversion in the actual world matrix and sampled forward/left vectors.
An imported quaternion-mode armature ignored the saloon wrapper's Euler assignment:
neutral fitted anchors still passed, while the zombie leaned backward and a hip
looked malformed. Composing the matrix rotation flipped the measured toe/side axes
and restored forward hunching without rebuilding the trousers. Check rotation mode
and posed anatomy before prescribing geometry or weight changes for that symptom.

Capture neutral attachment matrices only after explicitly restoring the fitted
bind pose and updating the scene. The current reference retargeter clears the
active action after baking, but leaves the sampled pose transforms/frame; clearing
an action alone does not reset bone matrices. The saloon's first native checkpoint
caught grip offsets captured in that final pose. Preserve the caller's declared
pose ownership instead of assuming any helper returned the model to rest.

Nearby surfaces can belong to different anatomy. A bent hand beside the chest
must not lend its weights to the shirt; constrain transfer to declared anatomical
regions, normalize retained influences and inspect shoulder/hip overlap in posed
surfaces. A zero-unweighted-vertex count does not establish plausible deformation.
Keep neutral socket measurements distinct from actual animated world sockets.
Source walk poses and a planted neutral sole do not establish translated contact:
check real speed, forward/backward/strafe transitions, turns, ramps, stairs and
idle settling in the destination runtime. New skin contact needs evaluated
deformed vertices; the earlier rigid POSITION scan cannot certify it.

Audit calibration before naming an unsigned low-foot velocity a stride. Low feet
can include forward recovery as well as backward stance; record signed projection,
height selection, phase ranges/coverage and speed quantiles relative to the pelvis
in explicit forward/up axes. The saloon Jog's reported 5.2156m equivalent cycle
distance implies about 1.68s per cycle at 3.1m/s. That consequence can look too slow
for the scenario without proving corrupt motion: denser exported-pose measurements
still found substantial backward speed. Check source and re-imported interpolation,
multiple sampling densities, endpoint position/velocity and temporal spikes before
choosing a clip or cadence. Use the [sampled motion diagnostics](../README.md#sampled-motion-diagnostics);
they report measurements without imposing a universal gait threshold.

Keep authored motion, calibrated cadence and live sole/stance IK as separate
evidence. Bone samples and a profile manifest cannot establish planted skinned
feet, smooth transitions, turns or an attack reaching its target. Verify the
destination's actual translated speed, start/stop and direction changes, attack
windup/contact/recovery, pause and retry with the delivered clip/skin. A hit-state
flag without an observed attack performance does not establish that behavior.

Separate conservative influence bounds from the actual posed surface. In the
saloon, a hunched head was visibly clear while the body's skin envelope covered
it: all 48 sampled head rays were initially classified as body hits. Keep the
box as a broad phase and resolve the nearest non-head triangles before claiming
visible-head targeting. The corrected actual-pose regression passes all 48.

Measure surface-query cost in the destination. The saloon's collapse scanned
every support vertex repeatedly during catch-up frames. Exact indexed world
queries, bounded presentation batching and cached Float64 skin matrices reduced
that work without replacing the skin with an approximate hull. The matrix
comparison retained all vertices and found zero differences over 5.12 million
comparisons, full collapse and reset on ground, stairs and gallery. That CPU
equivalence preserves the earlier sparse native poses; it does not establish
browser frame pacing or continuous artistic quality. Keep captured source
identities and the new comparison separate when reusing unchanged images.

These are source-inspected and native-checkpoint lessons, not a completed saloon
motion acceptance. See [reference-rig helpers](../README.md#fitting-a-reference-rig)
and the actual [retarget implementation](../agent_meshes_retarget.py).

## Make control composition and mutation ownership explicit

Share immutable geometry/textures where useful; isolate each instance's pose,
skeleton, morph arrays and mutable materials. Vertex-color or geometry edits
mutate shared buffers: clone those buffers first when the edit must be private.
Dispose only resources the instance owns. Independent pose samplers borrow
geometry/textures, so they are not isolation from later shared-buffer edits.

Declare the order of authored clips, manual overrides and derived effects.
Persistent pose/morph overrides keep their ownership until cleared. Clear them
when returning to clip control; dispose derived layers when their owner ends.
Before raw Three.js reads through cached object references, call `sync()` so
pending pose and morph changes have been applied.

For faces, choose the blink/gaze composition policy explicitly and apply lid
follow exactly once. Talking Heads' soft union and Meshes preview's max-based
composition are distinct policies; their combined results are not promised equal.
Do not bake follow into inputs and then apply it again as a display layer.

Use the authored eye frame: local +Z forward and +Y up, with yaw then pitch in
YXZ order. Respect authored gaze limits and test combined extremes after head
motion. Clear old offsets before changing control modes. Live derived morph
layers are excluded from independent pose samplers; reproduce the intended
composition explicitly when using a sampler to judge the final displayed face.

List skin, lids, lining, jaw, teeth, tongue and attachments with their deformation
owners. Mouth behavior, including per-tooth lower-lip policy, remains specific
to the consumer and its geometry. Do not turn a successful local correction into
a universal mouth rule. Test containment, surface intersection and visibility
separately: a contained tooth can intersect a lip, and a nonintersecting part can
still be visibly exposed or detached. Inspect front, oblique and interior views.

See [existing-sculpt expressions](../README.md#expressions-on-an-existing-sculpt),
[face helpers](../README.md#face-rig-helpers-arkit-face1) and
[runtime composition](../../../src/render/puppet.ts).

## Optimize only with retained behavior and final checks

Gate optimization against the addressed-node inventory. `merge: byMaterial`
merges static geometry and loses individual part names; it cannot preserve a
consumer's named wheel, glow, socket or visibility controls by assumption.
Check the final delivered asset, not an earlier unmerged source.

Measure source positions, exported render records, triangles and native LOD
vertices separately. UV seams, normals and material sections split vertices;
importers may weld or split again. The observed UEFN 30,000 LOD0 threshold is a
warning budget, not a universal hard limit or a total-scene vertex allowance.

Reduce with bounded surface error and preserved silhouette, holes, traces,
paint/UV identity and joint behavior. Check every delivered LOD and its retained
controls. Record bones, material slots and variants as costs to investigate;
they are not measured draw calls, runtime memory or frame-time results. Profile
before claiming that rig reduction or material consolidation improves performance.

Read the shipped APIs for [static merge](../../../src/export-merge.ts),
[export budgets](../../../src/geometry-budget.ts) and
[native import checks](../../../src/unreal.ts).

## Isolate failures at the boundary that can explain them

| Symptom | First isolation | Evidence required before accepting a repair |
| --- | --- | --- |
| Named control stops working | Compare source/final node inventory and merge settings | Final runtime addresses the expected node and exercises its control |
| Attachment floats or swings wrongly | Show local frames, rest transforms and posed surfaces | Matching endpoint/frame or surface-boundary measurements |
| Skin collapses | Separate pivot placement, rest form, topology and weights | Isolated bend plus actual exported vertices from several views |
| Face looks right only alone | Disable clip, override, blink and follow owners one at a time | Declared composition passes the required combined poses |
| Native material changes | Inspect slot identity, attributes and effective shader | Stored readback and a fresh rendered view |
| Export appears finished but is missing | Inspect fresh success/error receipts and active process | Current output hashes and completed validation; launcher exit alone is insufficient |
| Timeline claims motion | Sample numeric transforms and the posed surface | Finite TRS changes with tolerances; unchanged-pose negative control |

For native poses, compare normalized quaternions with q/-q equivalence and reject
missing bones/nonfinite values. `str(Transform)` may contain allocation addresses;
different strings do not prove movement. Check exact actor/component/mesh/clip
bindings, section range/rate/offsets, and restore prior sequence/time/selection.
Compilation or source inspection alone does not prove native execution.

## What remains consumer-owned

The consumer owns artistic acceptance, reference fidelity, interaction policy,
solver timing, educational meaning, engine calibration and actual player views.
A race simulation can verify behavior under its rules; it cannot certify art.

Keep three acceptance records: local/exported behavior, sampled native editor
behavior, and actual destination runtime behavior. Import success and editor
queries do not establish Fortnite rendering, physical controls, reset, late
joining, player/weapon collision, cooking or measured performance. Sampled poses
also do not prove continuous clearance between them.

Native sequence inspection belongs on the engine integration side. Source-owned
semantic collision and animation bone-budget APIs remain planned work, not a
promise of this guide. Fit collision to meaningful solids, preserve intentional
gaps and test collision state independently of visibility. Keep source hashes,
negative controls, fresh receipts and remaining limits with each handoff.
