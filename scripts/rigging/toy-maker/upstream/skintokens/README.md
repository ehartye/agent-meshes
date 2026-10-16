# SkinTokens sidecar

SkinTokens (VAST-AI, MIT) is the skin-weight backend: given a mesh and OUR
chosen candidate skeleton, it predicts per-vertex weights that beat the
filtered UniRig skin on every bench (spider worst-frame stretch 183 vs 2157 —
see `docs/specs/2026-07-06-skeleton-quality-2.md` R4 and
`2026-07-06-skintokens-skin.md`). UniRig remains the automatic fallback when
this sidecar is absent.

## Setup (idempotent)

```
python rigging/skintokens/setup_sidecar.py
```

Clones the repo to `C:\Users\ehart\repos\SkinTokens` (override:
`SKINTOKENS_DIR`), pins commit `273b691`, applies `tokenrig-sdpa.patch`,
drops `flash_attn_interface.py` at the repo root, builds a uv py3.11 venv
(torch 2.7 cu128 + requirements + scipy), downloads the two checkpoints
(~GBs, HF), and smoke-tests a full rig on their giraffe example.

## Why the patch + shim (no flash-attn build)

flash-attn has no prebuilt sm_120/Windows wheels and the source build is
hours. Not needed:

- `flash_attn_interface.py` (shim) — their model files try
  `from flash_attn_interface import flash_attn_func` FIRST; a repo-root
  module satisfies it with sdpa (matching (B,L,H,D) signature + GQA repeat).
  Spawned dataloader workers miss the shim (different `sys.path[0]`) and hit
  the equivalent built-in sdpa fallback — harmless, workers never run the model.
- `tokenrig-sdpa.patch` — the Qwen backbone hard-codes
  `attn_implementation="flash_attention_2"`, which transformers validates
  against the real package; patched to `sdpa` (env `SKINTOKENS_ATTN` to override).

## Hand-off gotchas (hard-won, keep)

- Their `trim_skeleton` deletes any bone whose subtree carries NO skin. A
  skeleton GLB with all-root dummy weights collapses to 1 bone. Use
  nearest-bone-segment dummy weights (every bone's subtree touched).
- Their bpy export splits vertices (~35k → ~150k); weights come back via
  exact nearest-position remap (both sides live in UniRig-normalized space).
- Their `--use_postprocess` voxel filter cubes weights toward binary — the
  exact artifact we removed from our own pipeline. Never enable it.
- Our geodesic/unshred retarget filters HURT SkinTokens weights (they exist
  to patch UniRig bleed). The backend stamp turns them off automatically.
