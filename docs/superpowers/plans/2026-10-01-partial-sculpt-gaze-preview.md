# Partial sculpt gaze preview implementation plan

Goal: offer shared eye controls for an explicitly declared partial sculpt, preserving complete-face behavior and every existing model deformation.

Architecture: optional `extras.eyeGaze` identifies `eye-gaze/1`, exported eye-local `+Z` forward and finite positive yaw/pitch limits. Exactly one eligible declaration and one owned `eye_L`/`eye_R` pair are required. Reuse current rotation composition/reset and morph ownership; partial gaze has no automatic lid follow. The sculpt eye helper optionally emits this metadata, preserving unrelated extras and validating before mutation.

Budget: two changed implementation candidates /90 inclusive minutes, started 2026-10-02T02:50:08Z, deadline04:20:08Z. Preserve current main f947a03 and live Oren f59cc816. No eyelid solver, facial contract weakening, new anatomy, camera following or consumer rollout in this feature.

Execution: inline using executing-plans, with independent requesting-code-review before merge. No new execution preference question: owner standing recommendation authorization applies.

Files: `src/web/preview-gaze.ts`, `scripts/blender_lib/agent_meshes_sculpt_face.py`, `tests/preview-gaze.test.ts`, `tests/sculpt-eye-rig-blender.test.ts`, `tests/blender_sculpt_eye_rig_fixture.py`, a partial fixture entry, `README.md`. Keep durable result/backlog in wiki.

- [ ] Run baseline `npm test -- tests/preview-gaze.test.ts` in clean feature worktree.
- [ ] Add failing partial-rig behavioral tests: discovery without full contract; authored-frame eye movement/reset while clips/morphs stay intact; refuse missing/invalid frame, limits, duplicate declaration or alien rig ownership. Run same command and preserve expected RED.
- [ ] Extend declaration selection minimally, sharing existing gaze implementation. Run focused tests and `npm run typecheck`.
- [ ] Extend Blender fixture to opt into yaw14/pitch9 partial metadata; assert exported eyeGaze and absence of full contract. Invalid limits/metadata must fail before any rig/mesh change. Watch `npm test -- tests/sculpt-eye-rig-blender.test.ts` fail before helper implementation.
- [ ] Add optional `gaze={yawMax,pitchMax}` to sculpt eye helper. Validate degrees in(0,90], reject booleans/nonfinite/missing limits, preserve unrelated JSON extras, and store explicit frame declaration only after successful rigging. Run focused Blender test; inspect real exported GLB.
- [ ] Document exact optional helper call/metadata, ownership and no full-face claim in README. Run typecheck/build and final focused regressions. Request independent review, fix important issues, commit/push draft PR with concise validation.
- [ ] Exercise actual partial exported GLB in shared preview on desktop/phone: real slider pointer movement/reset, pupil/skinned eye motion, unchanged non-eye vertices and authored neutral eyes clear of controls. Serve isolated HAL9000 checkpoint and preserve evidence; do not replace current Oren source.
- [ ] Poll required hosted Windows CI on exact PR head; normal protected merge only on green reviewed head under standing authorization. No redundant post-merge rerun, force/admin bypass, branch/worktree deletion or release mixed into feature.
- [ ] Update canonical wiki, validate links/catalogs and one log without Git in vault. Archive exact source/export/capture/hash/CI evidence; report candidates/inclusive time/remaining deficits. Stop at cap and retain any genuine live job for verified polling.

Next separately shipped slice: version/marketplace release and normal managed adoption, then Tess/Kit gaze. Tool merge alone does not demonstrate cast/art completion.
