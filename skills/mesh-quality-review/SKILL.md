---
name: mesh-quality-review
description: Review a 3D model for reference fidelity, anatomy, construction and deformation. Use for a 360-degree or head-to-toe quality check, repeated visual defects, clothing intersections, or a deliberate pre-delivery art review.
---

# Inspect the whole model against its intent

A valid GLB and a folder of renders are not an art review. Open and inspect the images.
Record anything you did not see as unreviewed, including details hidden behind another part.

## Establish what faithful means

Read the brief and view the actual reference images. Record the intended silhouette,
proportions, anatomy or assembly, clothing layers, materials and signature details.
Explicit owner approvals override older references: preserve accepted stylization rather
than redesigning an approved face or body. An unseen reference angle permits an inference,
not a claim of exact fidelity.

For each region ask: **Does this look faithful to the intended source material, reference
or target idea? What visible evidence supports that judgment?**

## Capture coverage before judging

Inspect the final exported model as well as the source when diagnosing a discrepancy.
Capture a full orbit in 45-degree steps, including both profiles and the back, at rest and
in a representative pose. Add elevated and underside views for hidden construction.
Use separate close-ups of both hands and feet: palms, finger separation, glove openings,
fastenings and soles cannot be judged from a whole-body thumbnail.

For a repeatable GLB capture use [the capture helper](references/capture.md). Other renderers
are fine if they provide equivalent coverage. Keep evidence outside the build's owned output.
If another surface blocks a close-up, change the angle or isolate the part diagnostically,
then inspect it assembled too. A capture filled by the torso is not a hand inspection.

## Review head to toe

Adapt this inventory to the actual anatomy or assembly of nonhuman creatures and props.

| Region | Inspect against intent |
| --- | --- |
| Whole model | Silhouette, proportions, balance, identity and readability at delivery scale |
| Head and hair | Facial features, eyes/lids, mouth, hairline coverage and hair attachments |
| Neck and shoulders | Anatomical insertion, continuous collar edges, lapels, rear openings and fabric thickness |
| Torso and layers | Body, waist and pelvis; jacket/bib/strap order, hems, closures, pockets, belt; crossings, floating pieces and body showing through |
| Arms and hands | Joint bend location and clearance, palm, opposing thumb, separate plausible fingers, knuckles, nails and glove openings; both sides |
| Hips and legs | Crotch volume, cuffs, inner-leg clearance and bend shape |
| Feet and footwear | Heel/toe contact, boot opening and tongue, eyelets, believable lace routing and fastening; floating or cutting laces and soles |
| Materials and detail | Color hierarchy, roughness, texture scale, seams, edges and intended asymmetry |

For animation, inspect each clip at its start/end, key phases and extremes from front,
both sides and rear where overlap matters. Compare suspect frames with the matching skeleton
pose: distinguish a bad pose, misplaced pivot, weight error, geometry defect and garment
construction. Inspect the local details during movement too; a good rest pose proves little.
Check facial extremes and relevant combinations. Normal materials establish fidelity;
clay, wire and skeleton views diagnose problems but do not replace that inspection.

## Record, repair and recheck

For every finding record the region, observed defect, reference expectation, severity,
view/clip/time, evidence path and proposed cause. Separate observations from hypotheses.
Prioritize broken anatomy, intersections, detached parts and identity errors before polish.

Within the authorized scope, fix the authoring source or the underlying tool, rebuild and
recheck the same angles/phases plus adjacent regions for regressions. Preserve before/after
evidence and the model hash. Do not change camera, lighting or clip coverage to hide a defect.

Finish with a coverage ledger: inspected regions and motion, repaired findings, remaining
defects, unknowns and review links. File durable findings in the project's designated wiki.
Keep technical validation, visual inspection and owner approval distinct. Do not expand
into unrelated redesigns, or count captured-but-uninspected images as reviewed.
