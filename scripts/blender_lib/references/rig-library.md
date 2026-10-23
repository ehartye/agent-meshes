# Organized rigging and animation libraries

Use this library when choosing a body-plan reference, extracting motion, fitting a
prepared target rig or inspecting the imported rigging algorithms. The original
[four-model mannequin library](mannequin-library.md) remains available, including
the digitigrade pair. The new catalog reuses its two human payloads; it does not replace them.

## Discover and inspect

Run these from a Meshes source/runtime package, or use absolute script paths from
your project. Paths inside the catalog resolve from the package, not the current
directory. Commands write generated reviews to your chosen project directory.

```text
node scripts/rig-library.mjs catalog
node scripts/rig-library.mjs catalog --body-plan quadruped
node scripts/rig-library.mjs verify
node scripts/rig-library.mjs demo --out <project>/rigs.html human-base fox spider
```

`demo` reuses the existing offline comparison viewer: 2–4 selected libraries,
play/pause, scrubbing, orbit, fixed views and skeleton overlay. Without IDs it
shows both humans, fox and spider. It produces HTML plus an editable comparison
config; choose fresh output names to retain evidence. The viewer uses diagnostic
clay materials and normalized clip phase. It does not preserve final material
appearance or align different species' footfall events. Browser inspection of this
demo exercised human-base, fox and spider playback, scrubbing, views and skeleton
toggle. A narrow-panel cropping defect was repaired with aspect-aware camera
fitting; all 16 sampled phase/view combinations retained complete bounds. This
does not inspect every bank/clip or establish animation quality. Generation alone
does not establish playback.

| Library ID | Body plan | Skin joints | Selectable motion/pose clips |
| --- | --- | ---: | ---: |
| human-base | Biped | 66 | 87 |
| human-addon | Biped, alternate bank | 66 | 75 |
| fox | Quadruped | 48 | 13 |
| kaiju | Biped with arms and tail | 57 | 9 |
| bird | Winged biped | 55 | 4 |
| dragon | Winged quadruped | 100 | 4 |
| spider | Eight-legged, axial body/abdomen | 56 | 9 |
| snake | Limbless axial chain | 28 | 7 |
| shark | Limbless axial chain with fins | 33 | 6 |

Read the actual [catalog](../../reference-assets/rigs/catalog.json) for exact joint
counts, raw clip names and all 214 selectable IDs. Each entry declares roles:
joint reference, skin-weight donor and motion donor. Choose the specific role
and match the target's anatomy before borrowing it; a shared label does not prove
compatible proportions, joint orientations, cloth or foot contact.

## Portable CPU extraction and retargeting

Use your explicit Python interpreter with NumPy, SciPy and pygltflib installed;
template/weight preparation also use trimesh. No command installs dependencies.
Run `readiness` to inspect module presence and optional external configuration.
Use trusted NPZ inputs: upstream schemas contain Python object arrays.

```text
<python> scripts/rigging/rig-tools/rig_library.py readiness
<python> scripts/rigging/rig-tools/rig_library.py extract human-base Walk_Loop <project>/walk.npz
<python> scripts/rigging/rig-tools/rig_library.py retarget human-base <project>/rigged.npz <project>/walk.npz <project>/walk.glb
<python> scripts/rigging/rig-tools/rig_library.py extract fox Walk <project>/fox-walk.npz
<python> scripts/rigging/rig-tools/rig_library.py retarget fox <project>/fox-rigged.npz <project>/fox-walk.npz <project>/fox-walk.glb
```

Extraction samples actual GLB animation channels and FK at 60Hz. That rate matches
the imported solver's fixed `frame / 60` output time base. It applies the human
bone-name map only to the signature humanoid skeleton; animal names remain intact.
Clip names containing spaces must be quoted. Namespaced IDs are also accepted.
The pinned banks are the supported extraction inputs; the upstream reader is not
a complete arbitrary glTF importer (matrix/non-joint ancestors, sparse accessors,
cubic curves and morph animation require separate handling).

`rigged.npz` has `vertices[V,3]`, triangle `faces[F,3]`, dense `weights[V,J]`,
`joints[J,3]`, `parents[J]` with one `-1` root, and optional `uv`/`texture_png`.
Use a common Y-up frame. Upstream preparation additionally retains names/tails and
the skin backend stamp. Do not feed a skeleton-only candidate where skin weights
are required. Keep source hashes, frame conversion and selected clip with the job.

Humans route to `retarget2`; seven animals route to `retarget_plan` and shared
`rt_solve`. Detection scores yaw/chain pairings; incompatible anatomy fails.
This is direction-based retargeting, not Blender's fitted world-rest-frame helper.
It has its own twist, chain-detection and skin limitations. Output curves are checked
for finite values and reported movement, without a universal artistic threshold.
Diagnostics default to a skeleton overlay. `--presentation asset` requests the
clean upstream skin export and its optional USDZ attempt; USD requires pxr and its
own verification. There is no automatic learned-backend substitution.

`--weight-policy upstream` retains the original body-plan filtering policy and
backend stamps. `preserve` explicitly disables its geodesic/unshred compensation;
use it only when that matches the weight source. Neither policy proves deformation.
Existing output paths reject so a stale file cannot masquerade as a fresh result.
NPZ-producing commands require an exact lowercase `.npz` output suffix; retarget
requires `.glb`. Asset presentation also rejects an existing same-stem `.usdz`.
Retarget builds in a fresh staging directory and reserves produced destinations
exclusively before copying, preserving files that appear after its initial check.
`optionalUsdz` names only a USDZ produced by this job; an unavailable or failed
optional export leaves it null, and diagnostic presentation never claims a sibling.

## Prepare weights and template candidates

```text
<python> scripts/rigging/rig-tools/rig_library.py spider-template <project>/mesh.npz <project>/candidate.npz
<python> scripts/rigging/rig-tools/rig_library.py prepare-skin <project>/source.glb <project>/inference.npz <project>/rigged.npz
```

`mesh.npz` contains vertices and faces. The spider template fits a clean eight-leg
body and returns a skeleton candidate; failure is explicit and starts no fallback.
It does not supply learned skin. `prepare-skin` transfers an inference result's
sampled weights to the source mesh, preserves its backend stamp and applies the
upstream anatomical filtering policy. Inspect the resulting candidate/skin and
actual exported motion before selecting it. See [construction](character-construction.md)
and [sampled cadence diagnostics](../README.md#sampled-motion-diagnostics).

## Optional external learned backends

UniRig and SkinTokens implementations are retained with their original source
identity. External code, environments, checkpoints and licenses remain separate.
No installer, sidecar setup script, model download or inference ran for this import.
`readiness` is file/module presence, not an executed-backend certification.

```text
<python> scripts/rigging/rig-tools/rig_library.py readiness --unirig-root <ComfyUI> --unirig-python <isolated-python> --skintokens-root <SkinTokens> --skintokens-python <sidecar-python>
<python> scripts/rigging/rig-tools/rig_library.py infer-unirig <project>/mesh.npz <project>/rig.npz --comfy-root <ComfyUI> --python <isolated-python>
<python> scripts/rigging/rig-tools/rig_library.py skin-skintokens <project>/mesh.npz <project>/candidate.npz <project>/skin.npz <project>/fresh-work-dir> --sidecar-root <SkinTokens> --python <sidecar-python>
```

These execution commands are unexecuted here. UniRig's worker replaces only the
pinned `COMFY` assignment with your explicit root and runs offline. SkinTokens
uses your root/interpreter, with up to four same-backend retries. Missing
prerequisites fail without selecting another model. Keep inference separate from
stable NumPy/mesh analysis: upstream records native OpenMP/LAPACK, Blender teardown
and mesh-I/O failures. Model temperature uses `SKEL_TEMP`, never Windows `TEMP`.

## Preserved modules, licensing and verification scope

The [module map and Python API](../../rigging/rig-tools/README.md) organize all
26 source snapshots by role. Historical README claims, machine paths and fallback
prose describe the original rigging project. Some snapshots write beside their source or assume old
caches; use adapters or deliberately configure a project-owned copy.

The [inventory](../../rigging/rig-tools/inventory.json) records source paths, pins,
roles, bytes/hashes, tracked-at-pin flags and local-only artifacts. The
[provenance record](../../reference-assets/rigs/PROVENANCE.md) separates CC0 GLBs,
application/helper code, Adobe Mixamo and CMU/third-party FBX. The latter are
inventoried with clip IDs and original paths and are not bundled as CC0. Local FBX
import uses the retained `extract_mixamo.py` with explicit `FBX`/`OUT_NPZ` and a
caller-supplied Blender environment; see module notes before using its time base.

Actual import checks: nine GLB hashes and Khronos validation, all 26 source hashes,
real CPU extraction/retarget on human/fox/spider diagnostic targets, and an
eight-leg template positive/box-negative case. These do not establish every clip,
arbitrary target fitting, external inference, native FBX/USD execution, continuous
skin clearance or artistic acceptance. The three-bank browser check above does
not establish all-bank playback. The existing human-base
duplicate-channel repair remains intact. See [Blender CLI](blender-cli.md) and
[native API](blender-api.md) for separate native tooling scope.
