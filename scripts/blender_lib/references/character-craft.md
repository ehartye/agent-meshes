# Character modeling craft

Use this reference when constructing or repairing a character's form and deformation.
The [construction checklist](character-construction.md) owns the repeatable procedure and evidence ledger.
[Mannequin selection](mannequin-library.md) owns donor discovery; [consumer patterns](consumer-patterns.md) owns reusable production lessons.
The [Blender helper reference](../README.md) owns API contracts; this document explains what to build and inspect.
Static props need shape, assembly and material craft, without anatomical rigs or facial ownership.

Evidence labels used here: **craft heuristic** means a modeling judgment to test against the brief;
**documented capability** means a linked helper supports the stated operation;
**project lesson** means a concrete defect informed the workflow, without certifying every future model.
No anatomical ratio, topology layout or shader setting is a universal acceptance test.

## 1. Establish the character and the viewing conditions

Write a short identity contract: age cues, species, gesture, silhouette, face, clothing and signature details.
Separate approved exaggerations from accidental distortions; preserve approved asymmetry and dimensions.
Collect front, profile, three-quarter and rear evidence where available, plus pose and costume references.
An unseen side permits an authored inference; label it instead of claiming exact reference fidelity.
For an original alien, specify which anatomical relationships are invented and which remain functional.
Do not inherit a human pelvis, digit count, foot plant or facial layout merely because a donor provides it.

Match the reference's projection before measuring it: perspective changes apparent head and limb size.
Use orthographic front/profile views to compare construction, then the intended perspective camera for readability.
Record focal length or projection, camera height, framing and character orientation for repeatable comparisons.
Keep a common camera when comparing revisions; a closer camera can conceal a proportion regression.
Inspect at delivery size as well as close range: an attractive sculpt detail can disappear in the actual game view.
Use silhouette, clay and wire views to isolate problems, then recheck the normal materials and lighting.
Stop if conflicting references require incompatible silhouettes; resolve the intended design before refining it.

## 2. Proportions, gesture, balance and negative spaces

Block the pelvis, rib cage, head and supporting limbs before fingers, facial creases or costume trim.
Compare their relative width, depth, height and tilt in the accepted reference, rather than using a remembered canon.
Check the distances between landmarks as well as the shapes themselves: shoulder to pelvis, jaw to chest, knee to ground.
Read the body as a gesture through head, chest and pelvis, with limb actions supporting that direction.
A neutral authoring stance should expose the anatomy and permit binding; it need not erase the character's posture.
Distinguish the rest mesh's structural posture from a performance pose imposed by the rig.

In a planted pose, inspect where the apparent body mass falls relative to the supporting contacts.
Use front and side views: a balanced front silhouette can still lean implausibly forward in profile.
For movement, inspect transitions between supports, toe-off, recovery and landing; a static balance check is insufficient.
An exaggerated pose can be intentional; record the exaggeration and required contacts instead of enforcing realism blindly.
Measure negative spaces: arm to torso, between thighs, under the jaw, between digits, and around a tail or accessory.
These gaps describe the pose and often expose merged forms or unwanted costume bridges sooner than surface shading.
Keep diagnostic views unobstructed; isolate a limb to diagnose it, then inspect it assembled again.
Gate: approve front/profile silhouettes, major mass relationships and required contacts before adding small forms.

## 3. Build primary, secondary and tertiary forms

**Craft heuristic:** primary forms carry the silhouette and weight; secondary forms explain anatomy and construction.
Tertiary forms provide wrinkles, pores, scales, seams and other local surface information.
If the model reads as blobs, return to primary and secondary decisions rather than adding texture or displacement.
Rotate each large mass and inspect its cross-section: cylindrical everywhere is rarely the intended body construction.
Use deliberate changes of width and depth at anatomical landmarks, with transitions that explain the neighboring volumes.
Compare a limb's section near the joint, through the muscle mass and near the distal end; avoid uniform tube radii.

Build broad plane changes at the chest, pelvis, cheeks, jaw and limb fronts where the design calls for them.
Stylization can simplify these planes; it still needs distinct directions for light to describe the form.
A smooth shader cannot supply a missing cheek projection or a missing side plane of the torso.
Keep convex masses, concave transitions and sharper landmarks distinguishable at the intended camera distance.
Fuse overlapping solids where a continuous skin is needed, while retaining intentional gaps and thin structures.
Tune fusion resolution against the smallest feature that must survive; inspect webbing, nostrils and finger separation.
See [geometry construction](../README.md#creating-geometry) for `fuse_meshes` and its topology limits.
Global smoothing, subdivision and procedural noise are finishing operations, not anatomical repairs.
Gate: the clay model must explain the character before color, outlines or surface noise are allowed to carry identity.

## 4. Shoulder girdle, pelvis and real pivots

Model the shoulder as a relationship among chest, clavicle/scapular region, upper arm and underarm opening.
A sphere stuck to the side of a torso creates a joint-shaped lump without explaining its insertion.
Inspect the front chest-to-arm transition, rear shoulder mass, top silhouette and underside in both rest and raised-arm poses.
The shoulder's visible surface and its rotation center are different things; do not place a pivot at the outermost bulge.
For the required range, determine whether the rig needs clavicular/scapular contribution as well as upper-arm rotation.
A drawing landmark helps identify a surface relationship; it does not establish a rig's axes or joint kinematics.
If raised arms collapse, test the bare body with the skeleton visible before changing clothes or smoothing weights.

Construct the pelvis as a volume supporting the trunk and leg insertions, with enough crotch and buttock volume for bending.
Place hip pivots inside the intended articulation, rather than on the outer thigh silhouette.
Check seated flexion, leg lift and lateral separation; inspect the groin, buttock fold and waist from front, side and rear.
Distinguish a misplaced pivot from insufficient geometry, inappropriate pose rotation and unrelated weight influences.
Measure elbow and knee positions on the actual character; bending midway through a long limb mass can reveal a bad pivot.
Use [reference-rig fitting](../README.md#fitting-a-reference-rig) with authored landmarks, then inspect the fitted skeleton.
Weight transfer and relaxation cannot establish anatomical joint centers for you.
Stop when a required pose demands a different joint chain or rest stance; correct the structure before polishing weights.

## 5. Species, age and foot construction

State the support chain explicitly: hip, knee, ankle/hock, any elongated distal segment, and contacting toes or sole.
In a plantigrade design, the intended heel and sole participate in the support surface.
In a raised-hock design, the raised bend is the ankle/hock; the metatarsal continues toward the contacting digits.
Do not call that raised bend a backward knee or collapse the distal segment into a human foot bone.
Check front and side leg silhouettes, bend directions, toe spread, pad/hoof shape and the actual lowest skinned surface.
Preserve the species' rest stance and limb proportions when borrowing motion; a donor's timing need not dictate geometry.

Child construction is an age-specific design, not an adult uniformly scaled down.
Measure the intended head-to-body relationship, facial maturity, limb lengths, hands, feet and soft tissue against the reference.
Avoid adding adult muscular landmarks or human infant proportions to every small nonhuman character.
For [digitigrade plant-kin](../README.md#digitigrade-plant-kin-anatomy), child/adult helpers encode one particular body plan.
Their pear trunk, bulb head, digits, fronds and tail are reusable only where they match the new intent.
Inspect the supporting toes through stance and the full recovery arc; solving a target does not prove believable gait.
Use the [gait analyzer](../../../src/gait-analysis.ts), with the appropriate reference and explicit interpretation of species limits.
Movement-range passes do not establish reference-curve correlation, costume clearance, balance or visual approval.

## 6. Hands, thumbs and digits

Construct the palm as a shaped mass with a back, a padded side, an edge and a distinct thumb root.
Place digit roots on that mass; do not arrange identical capsules along a flat bar unless that is the design.
Vary the digit silhouette through base, joints, shaft and tip; use the reference's taper and section changes.
Check fingertip shape separately from chain length: a long round cap can make a correctly sized finger look tubular.
Locate each joint from the intended bending anatomy and inspect where the skin actually creases when it curls.
The thumb needs its own base orientation and useful opposition, not simply a short finger pointing sideways.
For a nonhuman hand, define its grasp and contact behavior before copying human joint counts or proportions.

Inspect both hands from palm, back and side in open, relaxed, curled and required grasp/contact poses.
Check web spaces, thumb clearance, knuckle rhythm, palm thickness and unintended fused fingers.
Separate geometry errors, bone endpoint errors, palm orientation and weight leakage before choosing a repair.
**Documented capability:** sprout `finger_scale` changes digit-chain lengths while retaining tip radii and palm roots.
It therefore cannot alone repair tip shape, tubular sections, thumb orientation or fused hand topology.
See [digitigrade anatomy](../README.md#digitigrade-plant-kin-anatomy) and [baked rotation styling](../README.md#styling-baked-rotations).
Scaling an entire baked rotation also scales splay and twist; it is not an anatomical grasp solver.

## 7. Head depth, eyes and mouth ownership

Read the head as skull volume plus facial projection, jaw and their transitions into the neck.
Compare crown, rear skull, brow/orbit depth, cheek projection, muzzle/nose, mouth and chin in profile and three-quarter views.
A face that looks alike from every angle may lack these depth relationships, even when its front landmarks are correct.
Set eyeball position and socket depth together; protruding eyes with applied lids can leave an unexplained mound.
Inspect both canthi, the lid margin, underside and closed-lid silhouette, with neighboring cheek and brow forms visible.
Continuous skin is a construction choice; it does not by itself establish coverage or safe combined expressions.

Declare ownership of exterior skin, lids, socket lining, lips, cavity, upper/lower teeth, gums, tongue and facial attachments.
Upper teeth belong to the skull; lower dentals must follow the intended jaw behavior without outrunning the lip envelope.
Robot plates may require rigid motion where organic lips need graded motion; retain the character-specific mechanism.
Build the mouth's opening and interior as connected construction with readable depth, rather than a dark patch on fixed skin.
Inspect jaw opening at intermediate weights and with smiles, funnels, stretches and relevant presets.
**Project lesson:** whole-row rigid dental motion can expose corner teeth through a deforming cheek.
Use the [consumer patterns](consumer-patterns.md) for that diagnosis; do not blindly apply the same solution to a rigid robot.
An intentionally exposed fang still needs a valid attachment and must not accidentally cross exterior skin.
See [existing-sculpt expressions](../README.md#expressions-on-an-existing-sculpt) and [face helpers](../README.md#face-rig-helpers-arkit-face1).
Stop if a repair changes approved facial identity; show matched views and obtain the defined identity checkpoint.

## 8. Deformation topology and early stress poses

Choose topology for the required silhouette, deformation, shading and export budget, rather than an all-quads slogan.
Place enough vertices where curvature changes or the mesh compresses and stretches; keep needless density out of quiet regions.
Route edges to support the intended fold and sliding transition without concentrating distortion at a single pole.
Inspect poles, long thin faces, abrupt density changes and triangles that collapse under the actual motion.
No universal loop count guarantees a shoulder, mouth corner or knuckle will deform well.
Quads can support editing and predictable flows; triangulated export still determines the rendered surface.
Inspect the export's triangles when the native sculpt shades or bends differently.

Bind a coarse structural version early and test arms overhead/forward, elbows bent, seated hips and raised knees.
Add ankle/hock extremes, toe loading, spine twist, neck tilt, hand curl and the required facial combinations.
Use the actual performance range; an impossible test pose is not automatically a production defect.
Compare skeleton-only, body-only, garment-only and assembled views at the same time sample to isolate the cause.
Inspect the inside and outside of bends for collapse, volume loss, folds, intersections and detached layers.
Prefer a local source repair supported by the diagnosis over repeated global relaxation or added corrective noise.
Gate: required early poses must explain the intended motion before final detail, fitted costume or expression polish.

## 9. Order sculpt, retopology, UVs, weights and morphs

For a new character: establish the sculpt and joints, test coarse deformation, then finalize the working surface.
Complete intended fusion/remeshing, retopology and major garment partitioning before dependent UVs, weights and morph targets.
UVs and fine detail can develop alongside rigging once their topology dependencies are explicit and controlled.
Preserve the high-detail source for projection/baking; keep the editable low-detail deformation surface separately.
**Documented capability:** voxel fusion replaces topology and does not preserve UV/material layout; it rejects existing shape keys.
See [geometry construction](../README.md#creating-geometry) before using it on a developed asset.

For an existing approved character, preserve its source topology unless the authorized repair requires changing it.
Record which operations preserve coordinates, vertex order, UV loops, weights, morphs and animation; these are separate properties.
When topology changes, retain and use explicit vertex/face correspondence, or deliberately rebuild every dependent dataset.
Never assume surviving old vertices form a contiguous prefix after native mesh edits.
**Documented capability:** mouth-pocket replacement returns original vertex/polygon maps; dental attachment can reuse an authored jaw.
Their native-preservation contracts are in [existing-sculpt expressions](../README.md#expressions-on-an-existing-sculpt).
Donor morph transfer needs common-frame landmarks, valid donor topology and explicit anatomical/fixed selections.
Approximate nearest-surface correspondence does not prove the donor's expression fits the target's face.
Stop if required correspondence is lost or an unexpected approved region changes; restore from source before continuing.

## 10. Cloth, hair and attachments

Design garments as garments: choose where fabric hangs, stretches, gathers, bridges a hollow or rests against the body.
Ease is intentional room between body and garment; a uniform normal offset often copies anatomy too closely.
Establish shoulder/waist/strap support and gravity before decorative wrinkles; show tension toward actual anchors.
Use the intended fabric's thickness, stiffness and fold scale, judged at delivery scale rather than as tiny sculpt detail.
Fit layers in order and inspect gaps at cuffs, collars, openings and overlaps from underneath as well as outside.
Continuous joins need compatible boundary positions and deformation; proximity alone does not join front and back panels.
Keep enough interior anatomy to cover views through open sleeves and necklines; do not hide a gap with a favorable camera.
Place hems, capped collar ends and thickness so the inside has a designed finish.

Inspect bare garment cross-sections before skinning; exclude neighboring arms or neck from the geometry source itself.
Restricted weight donors cannot fix a cloth envelope already built from the wrong body surface.
Use [anatomical skin sources](../README.md#selecting-anatomical-skin-sources) and [posed fitting](../README.md#fitting-garment-offsets-through-animation).
Weight relaxation changes influences, not garment construction; a converged offset fit covers only supplied intersection samples.
For hair, establish skull coverage and a few coherent directional masses before strands, grooves or flyaways.
Inspect temples, behind both ears, nape and underside; a front-facing cap can leave the rear skull exposed.
Separate hair volume from attachment: roots must meet the scalp, and a beard must wrap the intended jaw/chin region.
Check which hair or beard areas ride facial deformation versus the head, neck or independent motion.
Accessories need support and attachment evidence, not merely a penetration-free position near the body.

## 11. Identity, materials and geometry budget

Preserve the recognizable silhouette, facial depth, gesture and costume hierarchy before tertiary texture.
Use color/value grouping to guide attention; verify identity in neutral lighting and at the destination camera distance.
Gloss and outlines can clarify a style but can also hide seams or exaggerate tiny surface defects.
Check skin, cloth, hair, ceramic, metal and glass with finishes appropriate to the brief; material polish cannot repair anatomy.
Agree the target platform, camera range, animation needs and geometry/material budget before high-detail construction.
Spend geometry on visible contour changes and deforming regions; reserve texture/baking for suitable surface detail.
Measure exported triangles, material splits and morph cost; a low native polygon count is not the complete delivery cost.
Review decimation around eyelids, finger webs, mouth corners and garment rims before accepting its savings.
If the budget removes an identity feature or required deformation, change the construction or negotiate scope explicitly.

## 12. Isolate symptoms before fixing them

| Symptom | Diagnostic isolation | First source repair to test |
| --- | --- | --- |
| Smooth pile of blobs | Clay front/profile, cross-sections, silhouette without detail | Restore mass relationships, taper and plane changes; reduce indiscriminate fusion |
| Shoulder caves in when raised | Bare body plus skeleton, fixed camera and matched pose | Correct pivot/chain, then local volume/topology and anatomical weight ownership |
| Knee appears to bend backward | Side skeleton, identify hip/knee/hock/toe landmarks | Correct joint interpretation and chain; preserve raised-hock anatomy |
| Tubular or oversized fingers | Both hands open/curled from palm/back/side; show endpoints | Separate chain length from tip radius; shape palm, taper, joints and thumb root |
| Clothes cling to every hollow | Rest cross-sections before weights or thickness | Rebuild ease, support and garment envelope; then fit motion |
| Jagged or torn underarm | Wire/skin views at rest and raised-arm time sample | Repair connected boundary construction or weights after identifying which failed |
| Face loses identity off-axis | Matched front/profile/three-quarter clay views | Correct skull, cheek, orbit and jaw depth before expressions |
| Lid tears only in combinations | Exported partial blink/squint/wide plus gaze states | Correct interacting targets/topology; isolate runtime composition ownership |
| Teeth emerge through cheek | Mouth-only and assembled intermediate jaw/preset states | Fit dentals to moving lip envelope and intended jaw mechanism |
| Hair or pouch floats | Rear/underside rest and motion close-ups | Repair root/support contact and deformation ownership |
| Native model passes, export fails | Same triangulated pose, transforms and named parts | Inspect export correspondence, bindings, morph ownership and preserved attributes |

Stop repeated cosmetic iterations when the same anatomical defect persists; revisit structure or the missing capability.
Use the agreed attempt/time cap and human checkpoint; count builds, inspection and bookkeeping within it.
Keep technical validity, sampled geometry checks, visual fidelity and owner acceptance as separate results.
Finish with the [exported-evidence checklist](character-construction.md#6-recheck-the-same-exported-evidence): inspect a full orbit and head-to-toe close-ups, including both hands, soles, hidden joins and delivered motion.
Record uninspected regions and unresolved causes honestly; captured images are evidence only after someone inspects them.
