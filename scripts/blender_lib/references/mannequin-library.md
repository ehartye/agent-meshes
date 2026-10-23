# Neutral mannequin reference library

For all nine human/animal animation banks and the organized rigging
tools, use the [rig library](rig-library.md): catalog/verify/offline-demo commands,
portable CPU extraction/retargeting and explicit optional-backend readiness.
It reuses the two humans below and keeps this four-model catalog intact.

Use these models to study a body plan, inspect deformation or compare motion. The
brief and approved design determine your character; a donor mannequin supplies
explicitly selected structure or motion, not a universal anatomy standard.

The actual GLBs and [catalog](../../reference-assets/mannequins/catalog.json) ship
inside the managed runtime. No source-project checkout, network download or ignored
local artifact is required. Resolve paths from the executing package, not the
current working directory. `capabilities` reports that package as `guidance.baseUrl`.

| Catalog ID | Reference | Skeleton | Animation bank | Good use |
| --- | --- | --- | --- | --- |
| human-base | Neutral human mannequin | 66 bones | 88 clips | Human joint hierarchy, locomotion and interaction reference |
| human-addon | Same human mannequin, alternate clips | 66 bones | 76 clips | Alternate walk/run styles and gestures; not another body type |
| plant-kin-adult | Adult plant-kin, 1.70 m | 50 bones | Walk, jog and six joint diagnostics | Raised hock, long metatarsal, toe support, tail and crest anatomy |
| plant-kin-child | Child plant-kin, 1.12 m | 46 bones | Walk, jog and six joint diagnostics | Child proportions on that species; not a uniformly scaled adult |

## Open the offline demo

From a source checkout, run:

```text
node scripts/compare-rigs.mjs scripts/reference-assets/mannequins/catalog.json artifacts/mannequins.html
```

Open the generated HTML directly in a browser. It embeds the four GLBs and viewer,
with walk/run selection, playback, scrubbing, orbit, fixed camera views and skeleton
overlays. The comparison normalizes base color and finish for diagnostic clay views; texture
maps can retain their color coding. It is not an authored-material fidelity review.
Inspect the unchanged GLB through a normal viewer for material acceptance.
The catalog is also a normal comparison config: copy it to your project,
retain the source metadata and replace selected models/clip mappings with your
candidate and the nearest useful reference. The comparison helper accepts 2–4
models; model paths resolve relative to the config.

For an installed managed runtime, run from your own project using absolute paths to the runtime's
`scripts/compare-rigs.mjs` and catalog, and an output path owned by your project.
Keep generated reviews outside the installed runtime.
The helper writes the requested output file; choose a fresh file to retain a review.
Do not edit the installed reference assets. Copy a GLB into your own source tree
when a fitting workflow needs a donor path. Save the catalog ID, source hash,
chosen clip and intended use alongside your model's build config.

## Choose what to borrow

1. Match the limb chain before matching its silhouette. A plantigrade foot and a
   digitigrade foot have different support geometry. Identify hip, knee, raised
   ankle/hock, metatarsal and toes independently; the hock is not a backward knee.
2. Compare cross-sections, shoulder/hip insertions, palm/thumb structure, tail and
   center of mass against the target. These plant-kin bodies impose particular pear trunks,
   bulb heads, fronds and three-digit hands; those choices do not define all aliens.
3. Select a role: visual study, joint-location donor, skin-weight donor or motion
   donor. State that role; do not silently transfer all four.
4. Keep age and stylization explicit. Evaluate head/body ratio, torso depth, limb
   proportions, hands/feet and stance separately. Shortening an adult globally does
   not produce a child. Approved nonhuman proportions outrank a human norm.
5. Use the existing [reference-rig fitting API](../README.md#fitting-a-reference-rig)
   for a custom body. Define correspondence, coordinate frames and anatomical donor
   regions, reset imported poses and compare the fitted skeleton before judging skin.

The [character craft guide](character-craft.md) covers form and deformation choices;
the [construction checklist](character-construction.md) covers ownership and joins.

## Compare references without inventing evidence

Inspect bind rest first, then isolated joints, then full clips. Front/profile show
length and ground contact; oblique/rear/underside views expose insertions, overlap
and hidden surfaces. Inspect both hands and feet separately. Clay and skeleton views
are diagnostics; also inspect final materials and the intended display size.

The demo synchronizes normalized clip phase. Different clips can put footfalls at
different fractions, so identify touchdown, support, passing and toe-off events
before treating poses as equivalent. Compare their skeletons first; then the posed
surfaces. A donor's joint names do not prove anatomical laterality: use the rest
geometry and forward frame. The comparison overlay omits finger/leaf bones, so use
dedicated digit views when inspecting hands.

For ground contact use the actual deformed sole/toe surfaces and declared in-place
travel policy, not just ankle height or whole-body bounds. Sample seam endpoints,
contact transitions and maxima. Use the existing gait analysis for measurable
motion; a statistical correlation does not approve a body plan, acting style or art.

## Provenance and known limits

The [provenance record](../../reference-assets/mannequins/PROVENANCE.md) and catalog
record source commit, generated asset hashes, clip maps, generator identity and
validation scope. Human sources are the frozen source-project copies of the Mesh2Motion/Quaternius
assets with their included CC0 statement. The separate Mixamo walk is excluded.
No blanket CC0 license is assigned to this entire mixed-source library.

The human-base export removes 198 exact duplicate channels from Sword_Regular_C_RM;
all samplers and the binary payload remain unchanged. The addon is byte-identical
to its captured original. Each retains the upstream NODE_SKINNED_MESH_NON_ROOT
warning. Both alien exports have zero validator errors/warnings, but eyes are
placeholders and there are no facial controls. Their diagnostic walk/jog clips
are not certification of a consuming game's full gait, collisions or final art.

A valid donor is not automatically compatible with a target's face, proportions,
topology or engine. Keep source preservation, GLB validity, destination import,
destination playback and visual acceptance as distinct checks, as explained in
[consumer patterns](consumer-patterns.md).
