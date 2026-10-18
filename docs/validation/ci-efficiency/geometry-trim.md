# Geometry test trimming

The owner requested trimming after the face lane took 48 minutes. This is a test/CI change; production geometry and version are unchanged.

## Decisions

| Test file | Source tier | Verdict | Replacement/protection |
| --- | --- | --- | --- |
| blender_face_geometry.py | Standard modeling, with public-contract owners retained | Defer 29 shape/pose sweeps | Merge runs 128 of 157 native cases, including canonical public-helper positives, GLB extras/pruning, direct API rejection and collision negative controls. Full runs retain all 157. |
| stylized_character.py | Standard recipe | Share helmet preparation; defer two matrices | Merge runs 11 of 13 cases; independent repeatability, parameter rejection, actual glass-triangle clearance and enclosure metadata remain. Full runs retain the original eight-way variant and shell-clearance matrices. |
| stylized_costume.py | Standard recipe | Share preparation; defer three dense matrices | Merge runs 26 of 29; direct slab construction, straps, body/boot geometry, weights, seams and posed vertices remain. Full runs include every-layer seating and dense gait/pouch sweeps. |

The explicit ID/reason manifest is tests/geometry-sweeps.json. New/unlisted tests run in merge. Stale IDs and invalid lanes fail. Cheap API rejection was split from expensive construction where appropriate; each public geometry helper retains canonical positive coverage. Imported CurvedMouth cases remain in the native inventory. The static JS/TS audit adapter still does not discover Python, so this table comes from manual source review and native unittest inventory; agent-token/churn metrics were not remeasured for Python.

No original assertion was deleted: source AST counts remain 593 face, 46 character and 93 costume assertion calls. Three new cases split rejection assertions out of matrices, increasing full native inventory from 196 to 199 across these files. Static assertion-call counts alone are not proof of behavioral equivalence; complete runs and independent review provide the other evidence.

The prepared-mesh cache is bounded to 32 input configurations per process. It keys all supplied values, isolates producer inputs and deep-copies parts/lofts together for each caller. Direct generation repeatability checks are uncached. Five small controls cover real manifest IDs, new-test defaults, absent/invalid policy, avoiding excluded class setup, input/result isolation and bounded eviction. They first failed against inert helpers. Fifteen Node policy/release checks include ordinary Python routing, full/shared/version fallback, missing scope and refusal to record a partial release receipt; the new cases first failed against the old policy.

## CI scope

Known recipe, Blender-library and top-level Python test changes select the merge lane, plus both JS/browser platforms and every other Python command. Version/dependency/fixture/selection-policy/unknown changes, ci:full, manual and scheduled runs select full sweeps. Docs and JS-only behavior stay as previously documented. Every original runtime command remains. Only a successful full selection, including all geometry sweeps, can emit release authorization. Local Python commands default to full; use AGENT_MESHES_TEST_LANE=merge explicitly for the trimmed lane.

## Validation and limits

Native inventory is retained in geometry-inventory.json. All known assertion owners and native inventory were reviewed. Complete merge-command measurements, full hosted verification and final integration are recorded in the canonical wiki profiling/backlog pages so operational receipts do not mutate the checked candidate. Do not interpret the 34 deferred test IDs as deleting their checks or as a measured whole-CI reduction. Full runs still execute their full matrices.

Time: one focused replacement, with actual complete-lane timing required. Risk: standard-risk matrix regressions are detected later on full runs; direct API/output controls remain in merge. Complexity: explicit selection metadata and bounded in-process fixture preparation. Best practice: remove duplicate setup and retain a fast contract lane plus full sweeps. Maintainability: new tests stay fast-lane by default, stale entries fail and full candidates remain distinguishable from partial checks.
