# Character construction checklist

Use this procedure before constructing or repairing a skinned character, its
clothing, hair or facial attachments. Static props use the operation schemas;
their shape, scale, material and attachment checks still matter, but they need
no anatomical joints, skin donors or face contract. API details stay in the
linked Blender helper sections. JSON operations use Y-up; these Blender helpers
use their documented local Z-up frames. Record the frame before transferring
landmarks, contours or weights.

## 1. Freeze intent and ownership

Record the reference, accepted silhouette/proportions, source and exported asset
hashes, framing and the specific defect being repaired. Set an attempt/time cap
and a human checkpoint. Preserve approved dimensions unless evidence establishes
a regression or the owner changes the target. Mark which body, garment and face
surfaces each operation may change. A valid GLB, visual fidelity and owner
acceptance are separate results.

## 2. Place joints, then bind

Measure shoulder, elbow and wrist, and hip, knee and ankle landmarks in the
character's frame. Put rotation pivots at the anatomical bend locations; inspect
the skeleton and mesh at rest and flexed before refining weights. A bend in the
bicep requires checking the elbow pivot and its weighted region. Select named
anatomical donor regions before transferring or relaxing weights: nearby chin,
arm, torso and garment surfaces must not borrow unrelated influences.

See [reference-rig fitting](../README.md#fitting-a-reference-rig),
[anatomical skin sources](../README.md#selecting-anatomical-skin-sources) and
[weight relaxation](../README.md#relaxing-garment-skin-weights).

## 3. Measure both hands

Compare palm size, each finger's articulated chain, fingertip geometry and thumb
placement/opposition against the accepted reference. Measure both sides; inspect
open, relaxed and curled poses from palm, back and side. Separate excessive bone
length from an elongated rounded tip. Use the intended body plan rather than a
universal human ratio for stylized or nonhuman hands. Check palm orientation and
thumb direction through the required clips, including contacts and grasps.

See [geometry construction](../README.md#creating-geometry) and
[baked rotation limits](../README.md#styling-baked-rotations).

## 4. Construct connected clothing and attachments

Use continuous contours and shared boundary positions/weights for garment joins.
An overall underarm should join front and back with a rounded opening; inspect
both sides and underneath. Record a jagged edge or exposed gap as a visible
construction symptom; establish its geometry, weight or pose cause with source
inspection and matching posed exports. Retain enough
anatomy inside open sleeves and collars to cover views into them.

Fit closed shirt neckbands continuously around the neck, with raised thickness
and vertical ribbing when the reference calls for it. Fit an open jacket's raised
stand to its actual edge, including capped front ends and the underside. Check that
pouches meet their belt and pant legs meet boot openings in rest and raised-leg
poses. Placement that avoids penetration can still leave a floating attachment.

For a hat, measure the head's crown, brow/temples and the hat's inner sweatband
in one actual head frame. Seat the band on its intended contact ring; a brim
above the skull can be penetration-free yet visibly too high. For a vest, connect
front and back across both shoulder saddles, with a continuous neckline and
armhole rim. Inspect top, side, underside and raised-arm/jog/attack exports: two
torso panels below the clavicles do not establish shoulder coverage. Repair those
source contours and weights before shader, shadow or texture adjustments.

Finalize topology-changing garment fitting before expressions on dependent
meshes, or retain explicit correspondence. Re-check layer order and skin
ownership after cutting, partitioning, thickness and fitting.

Thin overlapping layers also need compatible deformation fields. In the saloon
costume pass, independently sampling a donor for a shirt and vest only 6 mm apart
made the shirt pass through the vest during jogging. A shared, anatomically
restricted torso/spine field kept those layers together; sleeves retained their
own arm ownership. This is a demonstrated repair for that costume, not a rule
to give all clothing identical weights. Nearest-surface projection against an
unrestricted assembled body also caught nearby forearms and produced false
leather wings. Restrict the fitting source before projecting or adding ease.

Compatible weights do not guarantee compatible bent surfaces. A long shirt edge
can chord across several smaller vest faces and cross them during a torso curl.
Compare actual triangulation and deformed surfaces before increasing offsets;
subdivide only the deficient region and retain neutral fit, UVs and donor fields.
Recheck anticipation, strike and deep recovery separately. The saloon candidate
removed sampled central-chest crossings at two strike poses while early/recovery
crossings remained: two passing poses did not establish complete layer clearance.

See [weighted clothing cuts](../README.md#cutting-weighted-clothing),
[posed fitting](../README.md#fitting-garment-offsets-through-animation) and
[raised neckbands](../README.md#raised-garment-neckbands).

## 5. Cover hair and facial ownership explicitly

Inspect rear skull coverage behind both ears and the nape, ending before the
collars. Apply the intended material/texture consistently across raised pieces;
check crown, sides, rear, underside and motion. A beard should wrap beneath the
chin/jaw according to the reference and follow the relevant deformation.

List eye, lid, exterior skin, lining, jaw, teeth, tongue, beard and attachment
membership before facial operations. Inspect neutral, partial/full blink, jaw,
smile and required combinations; check who owns clip, automatic blink and manual
expression state. Existing face helpers and the face verifier supply contracts,
but their success does not establish visual coverage or every combined extreme.

See [existing-sculpt expressions](../README.md#expressions-on-an-existing-sculpt)
and [face-rig contracts](../README.md#face-rig-helpers-arkit-face1).

## 6. Recheck the same exported evidence

Inspect matching before/after views plus adjacent and hidden regions. Sample
suspect mesh frames with the same exported skeleton, clip and timestamps; use
motion events when comparing different clips. Equal normalized phase alone does
not establish equivalent footfalls. Finger/thumb coverage needs its own checks;
the current comparison overlay omits those bones. Four stills or a penetration
report cannot prove continuous clearance, attachment or construction quality.

Inspect actual-speed playback with both soles visible, then isolate contact and
return phases. A planted marker with zero planar drift can coexist with a dragging
toe, implausible return or abrupt root stop. For an attack, compare the actual
runtime hand path, target surface and damage event; a raw donor pose omits consumer
layers. Record cropped feet, blocked views and unplayed recordings as missing
coverage rather than inferring motion quality from counters or file existence.

Record expected appearance, observed evidence, view/clip/time, cause hypothesis
and remaining uncertainty. Run focused checks for the changed scope, then the
required delivery checks. Count builds, inspection, CI and bookkeeping against
the agreed cap; recommend accept, extend by a stated amount, change approach or
park at the checkpoint. This checklist is a procedure, not proof that a model
passes its project's quality bar.

For an ambiguous bright patch or exposed inner layer, retain the original world
ray and repeat it against the same posed, exported triangles before and after
the repair. Record the actual hit material and geometry: an unchanged jog ray
in the saloon pass changed from linen to leather, while nearby pale shapes were
real fingers. A pixel colour alone could not distinguish those causes. Keep the
failed image/source and matching ray; one repaired sample does not prove full
motion clearance.
