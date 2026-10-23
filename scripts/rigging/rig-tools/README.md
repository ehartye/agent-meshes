# Rigging tools import

Start with the [rig library guide](../../blender_lib/references/rig-library.md)
and `python rig_library.py --help`. This directory provides portable adapters;
`upstream/` holds all 26 exact text snapshots from the rigging source project
`78593cdd61d0bc3e7324648fd70a3760974e6b82`. Their hashes, roles, original paths,
and local-only cache/FBX inventory are in [inventory.json](inventory.json).
Ignored local artifacts are explicitly distinguished from files tracked at that pin.

| Role | Preserved files | Current import readiness |
| --- | --- | --- |
| GLB extraction | `glb_clip.py` | Real human/fox/spider extraction checked; pinned banks only |
| Biped/body-plan retarget | `retarget2.py`, `retarget_plan.py`, `rt_solve.py` | Real CPU solve/bake checked on three diagnostic targets |
| Body plans and sampling | `body_plans.py`, `sample_mix.py` | Source configs retained; template/classification checked, learned sampling unexecuted |
| Template skeleton | `spider_template.py` | Synthetic eight-leg positive and box-negative checked |
| Weight preparation/filtering | `prep_skin.py`, `voxel_skin.py` | Imported, geodesic/unshred exercised by animal retarget; inference-to-source prep needs its own job |
| Procedural/clip visualization | `build_rig_glb.py`, `build_mixamo_skeleton.py` | Source retained; fixed adjacent input defaults require deliberate relocation/configuration |
| Diagnostics | `measure_stretch.py`, `check_biped.py` | Source retained; old byte gate needs the source project's external baseline and Mixamo clip, not bundled here |
| Native FBX | `extract_mixamo.py` | Source retains Mixamo/CMU mapping and CMU up-axis conversion; native import not executed here |
| USD | `usdskel.py` | Source retained; explicit asset presentation attempts optional export; native/Quick Look unverified |
| UniRig | `rig_skin_test.py` | Explicit isolated worker adapter; model execution unverified |
| SkinTokens | `skintokens_skin.py` | Explicit external root/interpreter wrapper; model execution unverified |
| Sidecar setup history | `skintokens/README.md`, `setup_sidecar.py`, `tokenrig-sdpa.patch`, `flash_attn_interface.py` | Preserved setup/compatibility sources, not run or automatically invoked |
| Research sweeps | `skel_experiment.py`, `skel_matrix.py`, `r1_sweep.py`, `spider_sweep.py` | Historical experiments with local assumptions, not production entrypoints |
| Historical upstream guide | `README.md` | Preserved evidence; current adapter guide takes precedence for use |

The raw snapshots are unchanged, including machine paths and old results. Their
presence is not a promise that every script runs unchanged after relocation.
Source-project-owned code is retained under its original ownership; no new CC0 license
is assigned to helper code. The GLB reader's human name map cites Mesh2Motion MIT
code; the seven art payloads carry the separate CC0 asset statement.

## Python entrypoints

`rig_library.py` resolves the catalog/source snapshots from its own file location;
its inputs and outputs are explicit. Import it with `importlib.util` when calling
from Python (the directory has a hyphen), or use the CLI. Functions:

- `catalog()`, `library(id)`, `verify_payloads()` inspect package-owned references.
- `extract(id, raw_name_or_clip_id, output)` writes60Hz FK NPZ and reports actual
  finite sampled joint movement; source/helper hashes belong in your job receipt.
- `retarget(id, rig, clip_npz, output, weight_policy='upstream', presentation='diagnostic')`
  executes the imported biped/body-plan script with explicit paths and returns
  source logs, output hash and finite quaternion-motion measurements.
- `reference_target(id, output)` makes a diagnostic bind-chain fixture, not a new
  auto-rig. It currently uses the first skinned primitive; do not treat it as a
  general assembled-character conversion.
- `readiness(...)` checks explicit optional roots/interpreters/checkpoint paths.
  `infer_unirig(...)` and `skin_skintokens(...)` execute only the chosen configured
  backend; they are unexecuted wrapper paths in this import and never select a
  fallback or run an installer.

Upstream NPZ schemas require trusted files (`allow_pickle=True`). Generated files
must use fresh paths outside the bundled references/source. CPU retarget accepts
its upstream prepared-rig schema, not a raw arbitrary GLB. Skin/geometry shape and
deformation remain caller responsibilities. Output curves are finite/moving
measurements, not a gait, contact, reference-fidelity or quality pass.

## Local FBX and experimental scripts

Adobe Mixamo FBXs and derived NPZs remain local-only; keep their license/source
records when importing them. CMU/rancidmilk FBX provenance is separate too. The
inventory records 251 raw FBX files and 172 local NPZ cache/experiment artifacts;
those counts describe this captured machine, not git-tracked distributable assets.

To use the retained FBX extractor, choose a fresh `OUT_NPZ`, set `FBX` to your own
licensed source and execute `upstream/extract_mixamo.py` in your explicit Blender
CLI/bpy environment. It writes through an atomic rename and intentionally calls
`os._exit(0)`; verify the new NPZ rather than trusting launcher exit. It samples
source frames, while the retarget bake assumes 60Hz: measure the original frame
rate and deliberately resample to 60Hz before retargeting other-rate FBX. This
import does not certify that native path or supply a universal FBX converter.

Experimental sweeps, old byte gates and procedural scripts retain historical
adjacent-file defaults and external baseline paths. Copy the required sources
into a fresh project-owned directory and configure their inputs before execution;
never generate files inside the immutable installed snapshots. No default script
here runs those experiments, setup scripts or model downloads.

## Checks

```text
<python-with-numpy-scipy-trimesh-pygltflib> tests/rig-tools-rig-library.py
node node_modules/vitest/vitest.mjs run tests/rig-library.test.ts
node scripts/rig-library.mjs verify
```

The native spider detector currently emits NumPy empty-slice warnings on the
box-negative case while rejecting it. Source preservation retains that behavior;
the adapter reports rejection and does not run UniRig. GPU inference, all-clip
retarget, browser demo playback and USD/FBX native execution remain unverified.
