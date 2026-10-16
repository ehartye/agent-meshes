# Rigging & animation pipeline (proven 2026-07-04)

Turns a Toy Maker GLB into a rigged toy playing real Mixamo motion. Validated
end-to-end on the T-pose android (`gallery/eda40b8cd5b4`): user-confirmed
natural walk, no tearing.

## Two interpreters (do not mix)

| stage | interpreter |
|---|---|
| UniRig inference, FBX import (bpy) | `C:\Users\ehart\AppData\Local\Programs\comfy-env\envs\unirig-nodes\.pixi\envs\default\python.exe` |
| everything else (numpy/trimesh/pygltflib) | `C:\Users\ehart\repos\ComfyUI\venv\Scripts\python.exe` |

The isolated env crashes on `trimesh.load` of GLBs and on bpy's glTF export —
mesh I/O stays in the stable venv; hand off arrays via `.npz`. Scripts end with
`os._exit(0)` to dodge bpy's teardown segfault (exit code is unreliable; check
for the output file). ALSO (2026-07-05): numpy LAPACK (`np.linalg.svd` etc.)
aborts NATIVELY in the isolated env once torch/CUDA is initialized (OpenMP
conflict — no traceback, weird exit code): numpy ANALYSIS stays in the stable
venv too. And never pass an env var named `TEMP` to a Windows subprocess — it
shadows `%TEMP%` and breaks CUDA/libraries (use `SKEL_TEMP` etc.).

## Pipeline

```
1. mesh -> npz          (stable)   inline trimesh: vertices+faces -> mesh_X.npz
2. rig                  (isolated) rig_skin_test.py    MESH_NPZ, OUTPUT_NPZ [, HF_HUB_OFFLINE=1]
                                   -> skeleton + learned skin weights (predict_skeleton
                                      + predict_skinning with real tails; NOT rig_mesh)
3. weight transfer      (stable)   prep_skin.py        RIG_NPZ, SRC_GLB
                                   -> rigged_input.npz  (K=8 inverse-square blend,
                                      radius cap, prune <10% of max, ANATOMY FILTER:
                                      only bones whose segment passes near the vertex —
                                      removed 29k cross-limb influences on a 34k mesh)
4a. procedural gait     (stable)   build_rig_glb.py    OUT_GLB
                                   -> body-plan-aware walk (biped/quadruped/N-leg) + overlay
4b. mocap retarget      (stable)   retarget2.py        CLIP_NPZ, OUT_GLB
                                   -> direction-based retarget (see below)
clip prep (once/clip)   (isolated) extract_mixamo.py   FBX, OUT_NPZ -> pose_world FK matrices
source viz (debug)      (stable)   build_mixamo_skeleton.py OUT_GLB -> position-baked reference
```

`prep_skin.py`/`retarget2.py`/`build_rig_glb.py` read their input npz from the
directory they live in (`rigged_input.npz`, clip npz) — run them with the
artifacts beside them or adjust env vars.

## Retargeting: what works (hard-won)

- **Direction aiming, not rotation-delta copying.** Aim each of our bones along the
  source skeleton's per-frame bone directions (from `pose_world` positions — the
  representation we visually validated). Rotation-delta transfer fails invisibly
  when rest poses/conventions mismatch (arms-up / backwards / swapped symptoms).
- **Resolve ambiguities numerically, never by eye:** score yaw ∈ {0,90,180,270} ×
  per-limb L/R pairings against the two rest skeletons; take min residual.
- **Anchor arms at the shoulder:** UniRig arm chains start with a clavicle joint at
  the chest; trim to the joint nearest Mixamo's `Arm` head, hold inner joints static.
- **Arc-length chain mapping** handles differing joint counts (7-joint arm vs 3 bones).
- **Hips get a two-vector frame** (spine dir + hip line) for torso sway/twist.
- Loop-trim by pose-return (this walk: clean 70-frame cycle, residual 0.0000);
  quaternion hemisphere continuity before baking.
- Mixamo FBX extracts as **Y-up** in armature space — identity conversion (the
  Rx(-90) guess laid the character down and corrupted all motion).
- Self-check: mean bone-direction error vs source ~0.02°.
- Character prompts for rigging: **T-pose, facing forward** ("symmetric T-pose, arms
  stretched straight out horizontally, legs slightly apart").

## Body-plan retargeting (2026-07-05)

Animal clips (mesh2motion libraries) retarget through `retarget_plan.py`, NOT
retarget2 — mocap dispatches by library (`ANIMAL_LIBS`). Architecture:

- **`rt_solve.py`** — the chain-agnostic core extracted verbatim from retarget2
  (loop-trim, arc-length aim targets, FK solve, self-check, GLB+usdz bake).
  retarget2 calls into it; its biped output is BYTE-IDENTICAL to pre-extraction.
  Treat with the same care as retarget2 itself.
- **`body_plans.py`** — per-library source chains by joint name (the animal
  M_CHAINS), dumped from the real GLB skeletons. Anchor/clavicle-like lead
  joints excluded (limbs pivot from the first real joint). Also `classify()`:
  informational body-plan stamp written to `rig/bodyplan.json` at rig time.
- **`retarget_plan.py`** — ONE generic detector (N legs 2/4/8 + optional lateral
  pair arms/wings + spine walk + tail from leftovers), every ambiguity scored
  numerically (yaw x leg permutation x lateral L/R, min rest residual), plus a
  limbless plan (two body chains from a mid-body root, head end by cost).

Hard-won rules:
- **Limbs aim ABSOLUTE, axial chains (spine/tail) aim DELTA** (source rotation
  from its own rest applied to the toy's rest direction). Absolute on the spine
  slammed the horse's upright neck onto the fox's flat spine (head in the
  ground); delta preserves the toy's posture and adds the clip's sway.
- **UniRig gives animals no tail bones** (fox, horse: zero tail joints), so
  prep_skin welds tail verts to the nearest legs and the counter-swing shreds
  them. `unshred_offlimb` clears any limb weight on verts radially outside that
  limb (>0.35 chain length); orphans ride the nearest axial bone rigidly. Done
  at retarget time in the plan path only — prep_skin and bipeds untouched.
- **A tail candidate must attach to the axial skeleton** — a finger fan hanging
  off a hand cost-matches a kaiju tail embarrassingly well.
- **One-shot clips (roar, death) must not be loop-trimmed**: trim_loop_or_full
  falls back to full length when no frame returns near frame 0.
- **Pose presets drive generation** (workflows.POSES): the composer's pose
  select makes rig-ready animals. The clause must also fix the VIEW — the mesh
  model hallucinates occluded geometry (a body axis pointing into the camera
  produced a three-tailed shark); long bodies read in profile, quadrupeds in
  three-quarter, wings from the front.

## Known gaps (next)

- No twist control in minimal-rotation aiming (watch wrists/forearms).
- Root bob/translation omitted (in-place walk, no vertical hip motion).
- Wing membranes / feather chains ride coarsely (fidelity was a non-goal).
- Architectural ideal: fold into a rig service instead of env-var scripts.

## Biped byte-identity gate (#10)

`python rigging/check_biped.py` — runs the frozen baseline rig
(`tests/baselines/biped_rig.npz`) + the tracked flat walk clip through
retarget2 and compares the GLB sha256 against `tests/baselines/biped_walk.sha256`.
Any PR not intending to change biped output must leave this green. A PR that
intentionally changes it (e.g. #14 root bob did) reruns with `--update` and
says so in the PR body. This replaces the old ad-hoc scratchpad `cal.glb`
comparison, which went stale between sessions and produced a false alarm.
