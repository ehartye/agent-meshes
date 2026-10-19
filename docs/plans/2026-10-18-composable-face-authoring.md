# Composable face authoring delivery plan

The owner authorized planning and execution on 2026-10-18. Product intent and
current consumer evidence are in the wiki's guidance-first modeling ADR and
face-code-consumption note. Source baseline: `1ae53a43fd14b151680b9ee2a4723501da413b20`.
This is a bounded compatibility-preserving slice, not a universal face SDK.

## Objectives

- O1: Projects own editable face designs; shared algorithms have accessible
  geometry, contract and Blender boundaries behind compatible public imports.
- O2: A project can compose the existing stylized example using explicit inputs,
  without injecting globals or copying helper internals.
- O3: Native builds can declare imported/data inputs and pin tool identities;
  receipts identify those bytes and final output without pretending Python's
  dynamic dependency closure was discovered automatically.
- O4: Guidance teaches route selection and transferable failure diagnosis;
  optional recipes are examples rather than universal artistic requirements.
- O5: CI distinguishes supported helper contracts from expensive recipe sweeps,
  retains fail-closed unknown/full/release behavior, and measures the new path.
- O6: Reviewed integration and fresh verification establish actual compatibility,
  provenance rejection behavior and selected/full validation results.

## Decision and implications

Use project-owned recipes, imported pinned helpers, then GLB delivery. Full
vendoring remains a deliberate fork/archive option. Time: staged implementation
and one full combined validation now; lower repeated recipe/CI work is the goal,
not yet a measured gain. Risk: import cycles, hidden globals and incomplete input
declarations; preserve old imports and defaults, add explicit composition and
negative provenance controls. Complexity: a few internal modules and an optional
strict input/toolchain contract, not an engine abstraction. Best practice: shared
mechanics, project-owned design and behavior-based gates. Maintainability: fix
algorithms once; label topology/style-specific examples and keep updates explicit.

## Scope, ownership and execution

Root coordinator owns this plan, integration, docs/skills, CI policy and wiki.
Two disjoint isolated writers receive the frozen committed source below.
They may read source/tests/recipes/docs/.testing and their scoped inputs.
No downstream repo writes, publication, Git metadata edits, dependency installs,
background services or asset modeling by workers. Read-only inventory is the
first portion of each task and must inform its implementation, not become the
final deliverable.

### face-components — O1, O2, O6 — author and verify face components

- Own `scripts/blender_lib/agent_meshes_face.py`, new
  `scripts/blender_lib/agent_meshes_face_geometry.py`,
  `scripts/blender_lib/agent_meshes_face_contract.py`,
  `scripts/blender_lib/agent_meshes_face_blender.py`,
  `recipes/stylized_face.py`, new `tests/face_components.py` and
  `tests/face_composition.py` only. No other paths.
- Inventory public/private dependencies first. Extract cohesive implementation
  without changing algorithms/style; retain all historically accessible names
  and `__all__` through the facade, including author wildcard reexports.
- Add an explicit keyword composition input for the existing recipe's
  parameters/landmarks. Thread it through public layout/spec/add entrypoints;
  retain old embedded and sibling behavior as compatibility only.
- Early checkpoint: failing small behavioral test for independent component
  imports and explicit composition, then smallest working implementation.
- Acceptance: old imports and explicit new path agree on a representative
  layout; an intentionally missing/bad explicit input is rejected without
  consulting caller globals. Pure helpers import without bpy. Existing focused
  helper tests run; describe deferred expensive/native checks exactly.
- Tools/skills: deliberate empty native skill/tool selections: ordinary Python
  source refactoring, not modeling/export. Python 3.12.10 and NumPy 2.5.4 are
  coordinator-observed; verify actual worker readiness before commands.

### build-provenance — O3, O6 — author and verify native build identity

- Own `src/build.ts`, new `src/build-provenance.ts`,
  `tests/build-author.test.ts`, new `tests/build-provenance.test.ts` only.
- Extend optional Blender config compatibly with explicit declared project
  inputs and an optional toolchain lock. Use a small strict portable contract;
  reuse the installed Meshes version/runtime identity where available rather
  than storing mutable cache paths. Record the actual Blender identity.
- Pin mismatches/missing declared files fail before output publication; protect
  config, entry and all declared inputs from output overlap. Hash declared input
  bytes deterministically and detect mutation while a build runs. Reject unsafe
  path aliases/links or report a deliberate supported policy. No claim of
  hermetic execution or automatic import/file discovery. Preserve old receipt
  fields and legacy configs; add helper/source and output attribution.
- Early checkpoint: failing seam tests for changed/missing imported inputs and
  wrong toolchain, then implementation. Extend existing owner of build/output
  invariants rather than duplicating entire suite.
- Acceptance: one valid pinned declaration works; imported/data changes or a
  wrong pin reject; legacy config still works; output safety and cleanup hold.
  No caching or skip decisions are added from incomplete provenance.
- Tools/skills: deliberate empty native skill/tool selections: TypeScript source
  engineering, not an asset operation. Node 24.18.0 is observed. Isolated writers
  have no prepared npm dependencies: author tests and report them unrun if module
  resolution is absent; coordinator runs them after reviewed integration.

### coordinator integration — O4, O5, O6

- Own all guidance changes, a minimal project-owned face entry example,
  `.github/workflows/check.yml`, `scripts/ci-plan.mjs`, its existing tests,
  `.testing/risk.yml` and focused test invocation wiring.
- Inventory existing helper versus recipe tests. Move only recipe acceptance
  behind recipe-affected or full/scheduled validation. Retain small helper and
  compatibility checks on merges. Full gates include examples, all sweeps,
  installation/browser checks and fail-closed aggregate status/receipt controls.
- Explain geometry versus adaptation versus optional ARKit/topology profiles;
  provide task-based recipes, ownership, coordinate/input assumptions, symptoms,
  transferable principles, limitations, verification and engine handoff links.
- Preserve existing imports and actual art failures. No blanket claim of native
  suite passing: nine prior native failures were reproduced on main.

## Input/output, admission and lifetime budgets

Input choice: snapshotted JSON args file below 32 KiB, containing task prompts,
ownership and this plan reference; source is frozen by committing this plan
before writer capture. Control/observer/receipt files live outside source under
the system temp face-architecture directory. No files are excluded ad hoc.
Workers cannot write coordinator controls or the canonical wiki.

Output choice: retained source capture plus bounded JSON summary (status, files,
checks, missing coverage), not bulk source in the answer. Root independently
verifies full public worker records, producer run/generation/position/attempt,
positive cleanup, capture manifest/blob hashes and exact owned paths, then
reviews patches before integration. Reports and hashes alone are not acceptance.

Writer invocation: two workers, concurrency two, maxAttempts one each. A fresh
verification run has two independent readers, maxAttempts one each. At most two
explicit coordinator-reviewed revision runs, each at most two workers: eight
worker calls total across delivery/verification/revisions, no child workflows.
No automatic retry. No wall deadline; coordinator owns completion/manual Stop.
Run startup has its own admission budget; command yielding is not a timeout.
No model override. Skills/tools deliberately none per source role; baseline
catalog visibility grants no asset/service operation.

Literal `meta.steps` binds each actual worker. Display dependencies do not
schedule calls. The two writers are independent. Completion transfers reports,
not source bytes; the coordinator must integrate before verification.

## Supported commands and observation

Use the installed `agent-workflow/0.6.0/bin/launch.mjs` public CLI through Node.
Root saves `project:composable-face-delivery`, validates the absolute source
script, then starts it with `--cwd` the frozen feature worktree,
`--session` the actual CODEX_THREAD_ID, `--parent-access` the six-field current
unrestricted/network/never snapshot, `--args-file`, `--writable`,
`--concurrency 2`, `--startup-timeout-ms 0`. Native effects remain unaccepted
until reviewed. Root or a named collaboration observer immediately consumes the
receipt's exact `watch.argv`; consumed `attached` is required. Retain actually
processed seq cursors and relay idle/failure/unknown/terminal promptly. A dropped
watch reconnects at its processed cursor after saved-state inspection. It never
authorizes repetition. Dashboard belongs to the originating owner; provide its
complete private URL and leave it available for manual Close. Close does not Stop.

Fresh verification uses a new run and an absolute verified script, not a scoped
definition from another checkout. Freeze the combined commit/tree and checksums;
prepare npm dependencies and native validation outside producer capture. Readers
check real integrated files and run nonmutating checks; root owns temp-producing
tests, Blender/GLB operations and any browser render. Record source identity
before/after checks, exact commands, durations and remaining gaps. Replayed
results cannot establish freshness.

## Recovery

Missing selected source or changed parent catalog stops dependent work. Preserve
original admission/model/activation/effect/cleanup records; never rewrite saved
bindings, silently substitute a package or retry an uncertain writer. Inspect
terminal records, workspace changes and positive drain. Preserve valid completed
captures. Once coordinator/runtime reconciliation establishes what ran and which
unfinished effects are safe, prepare current verified sources and a new explicit
replacement run for only that work; review retained bytes, integrate, freeze a
new combined snapshot and run fresh checks. If effect safety is unresolved,
leave dependent objectives missing while independent work continues. Historical
unknown evidence stays historical and is never relabeled successful.

## Acceptance and delivery

Root independently accepts each O1–O6 against actual integrated bytes/checks,
not worker status or empty missing lists. Run meaningful focused tests, docs/link
metadata checks, typecheck/build and the complete required CI once on the final
candidate. Record routine selection and timings without claiming a speedup from
file splitting. Inspect diff for weakened contractual coverage. Update wiki
as-built/remaining limitations through guarded exact-path operations. Rebase
latest before integration, create reviewable PR and use squash merge only after
required checks. No new plugin version/publication is implied by this slice;
do not rerun release CI for a cosmetic version after validation.

## Coordinator refinement after the first capture

The verified face capture's real layout parity test took167seconds. Retain its
assertions under `tests/face_recipe_parity.py` in the affected/full recipe job;
keep the six small explicit-composition tests in the helper job. This avoids
adding an art-example build to every helper merge. Root owns this test relocation
and the matching CI route. The one-off AST preservation proof replaces a permanent
snapshot of all private implementation names; published export compatibility
remains covered. Two separate read-only planning respondents compared one robot/
hood scenario with and without candidate guidance; this adds two calls outside
the delivery workflow's eight-call budget and does not establish asset efficacy.
