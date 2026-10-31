# Clip checks, budgets and rig comparison

Commands run through the managed launcher (`mesh`, see [mesh-rigging](../SKILL.md)). Each check reads an
exported GLB, needs no browser and exits 1 when an evaluated check fails.

## `clip-report`: any rig, any clip

```text
mesh clip-report model.glb
mesh clip-report model.glb --clip walk --foot leg_L_ankle --foot leg_R_ankle --speed 0.7 --json
```

Reports every clip (or one with `--clip <name>`) with five checks: `loop-discontinuity` and `velocity-spike` always
run; `foot-penetration`, `stance-sliding` and `support-count` run only for bones named with `--foot`.
Each failure names the clip, bone, time and check. A check that cannot run prints `NOT-EVALUATED` with its reason,
which is not a pass.

| Option | Use | Default |
| --- | --- | --- |
| `--clip <name>` | Report only this clip | every clip |
| `--foot <bone>` | A bone that touches the ground; repeatable. Turns on penetration, sliding (with `--speed`) and support count (two or more feet) | none, so the foot checks are not evaluated |
| `--speed <mps>` | Travel speed the in-place clip is played at; turns on `stance-sliding` for the `--foot` bones | unset |
| `--min-support <count>` | Fewest planted feet at any sample; use 0 for a run or hop | 1 |
| `--json` | One JSON document (`agent-meshes/clip-report/1`) instead of text | text |

It prints text, not a JSON line, unless `--json` is given. The thresholds are fixed and `clip-report --help` prints them
from the code: loop discontinuity above 1 degree, 2 mm or 0.01 scale; a velocity spike above 6 times the joint's own median and above
180 deg/s or 1 m/s; penetration more than 5 mm below y = 0; planted within 2 mm of the floor; planted-sole speed within 10% of
`--speed` (at least 0.02 m/s).

Errors: `CLIP_NOT_FOUND` (`--clip` names no clip; the message lists the clips), `NO_CLIPS` (the GLB has no animation),
`FOOT_BONE` (a `--foot` names no node) and `CLI_ARGUMENT_ERROR` (a negative `--speed` or `--min-support`).

## `gait`: humanoid curves and natural-gait ranges

`mesh gait model.glb --clip walk` samples a clip into per-phase body curves and metrics (see Locomotion in
[mesh-rigging](../SKILL.md) for `skate`). It finds a humanoid's pelvis, spine, head, arm and leg bones by name.

| Option | Use | Default |
| --- | --- | --- |
| `--clip <name>` | Clip to analyze (required) | none |
| `--samples <count>` | Curve samples per cycle | 64 |
| `--height <m>`, `--forward <x,y,z>` | Body height and travel direction | declared gait extras, else the skinned bounds and the planted feet |
| `--travel-speed <mps>` | Speed the in-place loop travels at | declared extras, else the planted-foot median |
| `--reference <file>` | Reference curves JSON (the file `--out` writes) scored against the clip; repeatable | none |
| `--compare <file>` | Same, scored for information only, so `--gait` does not require it; repeatable | none |
| `--gait walk\|jog` | Check the report against natural walk or jog ranges and exit 1 on a failed check | none |
| `--curve-score raw\|symmetric` | Which reference score the `--gait` check uses (`symmetric` compares only the mirror-symmetric part of both gaits) | `raw` |
| `--out <file>` | Write the curves JSON there and print a summary | print the report |

Without `--reference` the `--gait` check has no curve correlation to judge. A required reference must reach a correlation of
0.8 on every scored curve.

Errors: `GAIT_CLIP` (no clip of that name), `GAIT_BONES` (a humanoid bone, the spine between pelvis and head, or a
wing joint is not found by name; a non-humanoid rig raises it), `GAIT_HEIGHT` (no skinned mesh to measure; pass `--height`), `GAIT_EXTRAS`
(declared gait extras lack a contact phase for a foot) and `CLI_ARGUMENT_ERROR` (`--gait` not `walk` or `jog`, `--curve-score` not
`raw` or `symmetric`, a malformed `--forward`).

## Clip and track budgets in `verify`

`mesh verify model.glb --max-clips 4 --max-tracks 60 --max-keys 240` fails when the GLB holds more clips, a clip more
tracks (animation channels) or a track more keys; the message names the clip and track. All three are positive integers
and unset by default. `--warn-only` reports the violation in the JSON and exits 0. Without it the failure is a `FAIL` line
on stderr and exit 1. The matching `build.json` keys are in [mesh-build](../../mesh-build/SKILL.md).

## `compare-rigs`: side-by-side motion review

`node scripts/compare-rigs.mjs comparison.json review.html`, run from the runtime root (the `runtimeRoot` that
`mesh-setup` reports), writes an offline page that plays two to four GLBs in step. The config is
`{"models":[{"label":"Reference","path":"reference.glb","clips":{"walk":"Walk_Loop"}}, ...]}`: paths are relative to the config,
and each model maps the same review names to its own clip names. Scrub by normalized phase in front, side, perspective and back
views, with an optional skeleton overlay. Compare skeletons first to find retargeting errors, then surfaces to find weight errors.
A matching phase aligns clips of the same cycle; it does not match footfalls between different animations. Fewer than two or
more than four models, no clip name, or a clip missing from a model stops it with a message.

## Character recipes with a rig

`recipes/` is in the plugin root, not in the managed runtime; copy a file beside the authored source.
`stylized_character.py` builds a named, metre-scale character (`build_character`); `stylized_walk.py` rigs it with
`rig_character(objects, landmarks(definition), duration=1.1, jog_duration=.75)` and bakes an in-place `walk`, and a `jog` when
`jog_duration` is given, at 60 Hz with identical loop endpoints (durations 0.6 to 3 s; 20 bones, all but `head` prefixed `rig-`).
`face_project.py` with `face-project.build.json` adds the living `arkit-face/1` head to that rig (see
[arkit-face](arkit-face.md)). Their bindings are specific to the recipe's own part names. Details and tests are in
`recipes/README.md`.
