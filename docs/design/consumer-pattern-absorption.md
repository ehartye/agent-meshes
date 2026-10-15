# Consumer pattern absorption

This is a source audit and implementation map for the owner's five-project request.
Shared behavior is established by current source/tests; existing tests are not a
claim that this audit reran every historical geometry or native-engine scenario.
The accompanying workflow ledger records fresh checks separately.

## Reviewed source identity and scope

| Consumer | Inspected identity | Scope/limits |
| --- | --- | --- |
| Space2Grow 3D | `0defa6dd6050b3c41a239d2ec136f6be48505b2d` | Current clean source, baseline/clothed recipes, hand/hair studies, gait/frozen-build scripts and wiki intent |
| Art Explorers | `a656f898b07d9ac0f3d53de2e556f139282edad4` | Gallery geometry, mechanisms, assemblies and exported-surface checks |
| Talking Heads | `b675cee448c8a55a210035eda1714ed78fc4c9cf` | Consumer driver, head sources, portability docs and current shared counterparts; later wiki pilots remain separate |
| Internal Race | remote `0a79d9491518d9c1dbf08ec598ec0ee211679366` | Read-only GitHub source; local checkout absent; current source differs from reconstructed historical wiki rationale |
| The Fort / Art Explorers FN | `66be1f6cf10096a179fe5d9a9895c04d6e9592f7` | Tracked export/import/collision/material/pose scripts; unrelated untracked native editor data preserved; no editor or Fortnite operation |

The separate Fortnites Sky wiki describes an uncompiled Verse design/space game,
not a verified authored-mesh pipeline. It contributes no demonstrated additional
Meshes implementation lesson in this audit. The Fortnite asset lessons below
come from The Fort; neither an editor receipt nor a source script certifies current
player-visible acceptance or performance.

## Space2Grow 3D

| Lesson and source evidence | Existing shared owner | Absorption in this change / limit |
| --- | --- | --- |
| Identity/anatomy before fitting: `asset-src/tess-baseline/character.py:74`, corresponding eyes `:91` | `agent_meshes_reproportion.py`, reference-rig fitting, reproportion tests | Craft guide separates age/species, silhouette, joint layout and donor roles; never treats fitting as identity approval |
| External `.blend` and donor prerequisites: `asset-src/tess-baseline/character.py:14` | `src/build.ts` top-script provenance; hm08 `SOURCES.json` | Four actual reference GLBs now ship with hashes/source identity; original native regeneration prerequisites remain explicit, not manufactured |
| Chain length versus fingertip pads: `asset-src/hand-fit/fit.py:17`, `:150` | motion styling, anatomical regions, gait hand observations | Craft guide requires palm/digit/thumb geometry and open/relaxed/curl evidence; character-specific ratios and fitting remain local |
| Continuous weighted garment cuts: `asset-src/tess-dressed/character.py:49`; shared partition `pip-dressed/character.py:91` | garments, garment_partition, skin regions and correspondence tests | Guides preserve topology/ownership and hidden sleeve anatomy; no late cuts over dependent morphs without maps |
| Source folds versus normal direction, offset amount and weights: `pip-dressed/character.py:95`, `:128` | surface-fan repair, offset directions, garment-fit helpers/tests | Explicit diagnostic order replaces blanket smoothing/relaxation; sampled fit is not continuous clearance or art approval |
| Connected cuffs/neckbands: `pip-dressed/character.py:171`, `:191`; `kit-dressed/character.py:107` | neckband construction/fitting and tests | Shared seam weights, thickness, capped open ends and underside inspection are called out |
| Hair coverage before strands: `asset-src/hair-detail/README.md:3`; `kit-dressed/README.md:21` | sweep/binding, construction and quality review | Craft guide separates scalp/roots/mass/coverage from detail; specific hairline, locks and density remain character-owned |
| Morphs preserve approved rest identity: `kit-dressed/README.md:15`; `pip-dressed/face-details.py:14` | sculpt-face transfer with explicit fixed/anatomical selections | Guidance distinguishes motion transfer, partial gaze and full face contracts; correspondence loss is a stop condition |
| Jaw/lining/dental ownership: `pip-dressed/face-mouth.py:24`, `:44`, `:71` | sculpt-jaw, lip lining, mouth-pocket maps, face helpers/verifier | Craft and consumer guides retain fixed skull/upper teeth versus moving jaw/lower dentals, combinations and oblique inspection |
| Contact speed/events versus adoption gates: `scripts/human-gait-contact.mjs:11` | `src/gait-analysis.ts`, sprout gait construction and tests | Mannequin guide requires measured sole surfaces, source/speed and footfall correspondence; equal phase is not equal event |
| Frozen bytes versus semantic equivalence: `scripts/build-playable.mjs:14`; `tess-dressed/README.md:68`; `mara-dressed/check-gaze-preservation.mjs:73` | GLB accessor reader; build source identity | Catalog freezes actual bytes. Generic full semantic-preservation CLI remains absent; no byte mismatch is labeled anatomical failure |
| Separate experimental entrypoints: Tess hand-study configs and README | Isolated build configs/output ownership | Keep neutral demonstrations independent of accepted cast recipes; no consumer output overwritten |

## Art Explorers and The Fort

| Lesson and source evidence | Existing shared owner | Absorption in this change / limit |
| --- | --- | --- |
| Preserve causal mechanism, not only mesh: FN `scripts/bake_mechanisms.mjs:48`, `:73`, `:82`, `:98` | planar-linkage, belt-drive, coupled mobile models/tests | Consumer guide separates live solver, baked clips, manual controls and static output; exhibit-specific exporters remain local |
| Rigid machinery differs from skin: FN `scripts/rigid_animation.py:111`, `:138`, `:157`, `:219` | explicit Blender skin binding, independent pose samplers | State rigid ownership, rest frames, evaluated-vertex error and fresh roundtrip; a bone per rod is not an anatomical rig |
| Actual surface contact/seam: Art `scripts/check-horse-motion.mjs:10` | gait analyzer, posed bounds, pose roundtrip tests | Guides require skinned soles/vertices and closing frames rather than joint-height-only acceptance |
| Full local mating frames: Art `rietveld/source/make_chair.py:48`; `scripts/play-rietveld.mjs:20` | `src/render/assembly.ts`, affine and GLB/shear tests | Distinguish bottom pivot, node socket, complete mating frame and deformed surface endpoint |
| Morphing end rings: Art `brancusi/source/page.html:106`, `:120` | observation explicitly excludes morph-following surface contact | Document the limit; asset-specific deformed ring measurements are not advertised as a generic node/socket API |
| Negative space and flowing joins: Art Moore runtime carver; `check-boccioni-form.mjs:12`, `:23` | carving/session/worker and shell subtraction | Craft/consumer guides prioritize real holes, voids, junctions and underside checks; fixture thresholds do not become universal anatomy |
| Sweep frames/caps and planar winding through motion: Art `brancusi/source/make_bird.py:23`, `:28`, `:51`; FN `bake_haring.mjs:29`, `:62` | parallel-transport sweeps, capped/open path tests, lathe sector winding | Explicit frame seeds, stable vertex order, outward caps versus smooth sides, and posed orientation checks |
| Material attributes and slot meaning: FN `repair_muybridge_coat.py:22`, `:43`, `:65`; `author_mesh_budget.py:54`, `:60` | Blender materials, color conversion, puppet slots, Unreal material facts | Source attribute → exported data → imported slot → effective graph → render acceptance; arbitrary native PBR equivalence remains consumer proof |
| Calibrated importer frames: FN `chair_collision_geometry.py:19`; `museum/bodies/README.md:3` | GLB world-geometry bounds, sockets and affine assembly | Known asymmetric calibration model; apply units/reflection once; preserve scale exemplar and names |
| Authoring versus render/native counts: FN `static_mesh_budget.py:28`, `:65`, `:73` | `src/geometry-budget.ts`, UEFN warning preflight/tests | Preserve UVs/paint/voids/shape/deformation; source estimates remain `nativeVerified:false`; inspect actual imported LOD0 |
| Semantic collision and hidden-state behavior: FN `verify_chair_cover.py:26`, `:105`, `:118`, `:127` | No generic exhibit semantic-collision import contract | Lesson documented; existing wiki semantic-collision/bone-budget item remains planned. Do not invent dozens of bounding boxes or conflate hidden with nonblocking |
| Bone/material inventories are not performance: Haring source/native count and museum receipts | Unreal import facts and budgets | Profile actual runtime before reduction; importer roots can alter counts. Haring's cost is not a demonstrated frame-time defect |
| Finite numeric pose changes, q/-q and stationary negative control: FN `numeric_pose.py:14`, `:44`, `:52`, `:60`; test `test_numeric_pose.py:29` | Numeric observation/sampling; native sequence audit belongs engine integration | Explicit acceptance guidance; strings/asset names/compile success cannot establish motion; restore native inspection state |

## Talking Heads

| Lesson and source evidence | Existing shared owner | Absorption in this change / limit |
| --- | --- | --- |
| Soft union/additive gaze/exactly-once follow: `src/driver/layers.ts:18`, `:27`; `src/driver/face.ts:216`; consumer `arkit-three.js:74` | puppet derived layers and preview-gaze tests | Explicit composition owner and reset. Meshes preview max policy is not promised identical to TH soft union |
| Authored eye frame and diagonal rotation order: `src/consumer/arkit-three.js:145`; `src/driver/gaze.ts:51` | preview YXZ pose offsets, clip-relative composition and tests | Guides require authored axes, limits, diagonals and clearing overrides; partial eye-gaze does not imply full face compliance |
| Combined lids can cross despite continuous construction | `src/face-lids.ts`, combined/mutation/grid contract tests | Already code/tests; craft guide refuses single-shape or continuous-skin-only proof; sampled grids do not certify all continuous states |
| Lower teeth can outrun corner lips: `heads/mossjaw/mossjaw_head.py:647`, `:655`, `:765`; jaw test `:128` | explicit jaw weights and rigid option in face helpers; mouth ownership verifier | Generic primitives exist. Stable whole-tooth lip-relative weight convenience helper is not extracted; geometry-specific five-vertex tooth assumptions remain local |
| Containment, crossing and visibility are distinct: Mossjaw test and consumer docs | sampled mouth/skin crossing, exposed-teeth declarations and tests | Guide treats these as separate checks; intentional exposed fangs do not exempt skin intersections |
| Morph topology/identity and rest preservation | sculpt-face transfer helper/tests; TH records fusion-before-morph ordering | Relevant shared capability, not falsely attributed to proven TH donor-transfer adoption |
| Per-frame complete state/reset: `src/driver/face.ts:218`; consumer `arkit-three.js:168` | puppet reset→sample→overrides→derived, grouped primitive morphs, sync/samplers | Clear persistent overrides; call sync before raw observations; speech scheduling/network policy remains TH-owned |
| Stock Three, Unreal import and native playback differ: `docs/consumers.md:51`, `:61`, `:67`, `:73` | Unreal hierarchy/morph/geometry/import verifier and tests | Explicit separate native source/export/import/playback/art claims; Unity remains unverified by these sources |

## Internal Race

| Lesson and pinned source evidence | Existing shared owner | Absorption in this change / limit |
| --- | --- | --- |
| Named asset boundary: `docs/MODELS.md:8`, `:19`, `:25`; `src/models.js:131` | named GLB groups, sockets and full-frame assembly | Consumer contract records moving nodes/material roles/clips; no new racing assembly system |
| Ground origin differs from seat/axle frame: `docs/MODELS.md:8`, `:19`, `:27`; `scene.js:78` | pivot bounds and affine frame solver | Guidance separates origin/attachment/articulation; consumer seat offset remains local |
| Static authoring data may contain runtime controls: `models.js:133`; `scene.js:200` | merge rejects authored skin/rig/clip and documents name loss | Build skill now gates merge against addressed-node inventory; no clips does not establish merge safety |
| Named palette roles: `docs/MODELS.md:10`; `models.js:31` | named material export/dedup and instance material isolation | Check final material roles across variants; wet Phong policy stays in consumer |
| Retain reproducible source, not stale paths: `models-src/run.sh:4`; kart source import | isolated build configs and canonical generator guidance | Do not copy old cache/scratch paths or stale imports merely because generator files exist |
| Immutable geometry sharing versus per-instance state: `models.js:18`; `scene.js:89` | puppet shared geometry and cloned slots, sampler ownership | Explicit pose/material/buffer/disposal ownership; no new generic race loader |
| LOD controls/material integrity: `models.js:88`; `scene.js:102` | static merge/budgets | Inspect every optimized output. Consumer baker takes material[0] at `:93`; it is not a generic safe multi-material baking implementation |
| Seed generation and simulation have separate proof: `track3d.js:55`; `tools/sim.js:1`; `docs/MODELS.md:37` | seeded params and runtime authoring data contracts | Save generator identity plus seed/resolved params. Passing a headless race cannot certify meshes, attachments or LOD art |

## Delivery boundary and remaining work

The absorbed knowledge is now reachable through shipped character/mannequin/consumer
references and existing skill entrypoints. Most mechanism, geometry, rigging,
observation and verification code was already shared; the audit deliberately
does not create second implementations or transplant consumer policy.

Explicit remaining tool candidates are source-owned semantic collision/bone
budgets, a general semantic preservation comparator, stable whole-tooth jaw-weight
ergonomics, and fully pinned native-source regeneration of reference fixtures.
These are recorded as gaps, not claimed as implemented by documentation. Final
consumer art, continuous clearance, native playback and Fortnite acceptance stay
with their actual evidence owners.
