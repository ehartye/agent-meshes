# Continuous integration

The owner selected `phase: dev` in [the risk map](../.testing/risk.yml) for fast
solo pre-release iteration. There are no external users or production support
promises. Saved-project and source/output safety remain critical.

## Current dev policy

Ordinary PRs run one quick Linux observer: CI/release policy controls, changed
Markdown links and skill frontmatter, changed JSON, and version agreement across
package/lock/plugin/marketplace metadata. It does not install npm dependencies,
download Chromium, generate meshes or run the full geometry suites. The runtime
matrix and aggregate `CI required` job are deliberately skipped. Keep this
observer non-blocking in repository branch protection; workflows do not configure
protection themselves. A green quick check does not certify runtime behavior.

Run affected local checks for code edits. Full suites remain available through
the Monday 06:17 UTC schedule, manual dispatch, or a PR's `ci:full` label:

```powershell
gh workflow run check.yml --ref <branch>
```

These full runs still require every selected job to succeed, and only they can
produce a full validated-tree receipt. Adding/removing `ci:full` replans a PR.
There is no branch-push trigger; new PR revisions cancel obsolete runs.

Dev tags check a clean Git tree, valid package/repository identity and exact
`v<package version>` agreement. By the owner's explicit iteration preference,
they do **not** require a full-CI receipt. Their summary says identity-only and
does not claim runtime validation. This is a deliberate exception to
test-strategy's default full release lane. Native builds/imports, visual review
and installed smoke checks remain appropriate when the change needs them.

## Test and production phases

Changing the risk map to `test` or `production` restores conservative affected
PR routing and the aggregate gate, plus mandatory full evidence for version tags.
Keep `phase` as one plain top-level `dev`, `test` or `production` value; missing,
duplicate or unsupported values fail rather than silently selecting dev.

| Change | Selected runtime jobs in test/production |
| --- | --- |
| Named root docs, `.github/README.md`, Markdown under `skills/`, or docs/evidence under `docs/` | None; quick checks and aggregate gate remain |
| TypeScript/CSS/HTML under `src/`, or `tests/**/*.test.ts` | Windows JavaScript and Linux system Chromium |
| Python shared helpers or top-level helper tests | JavaScript/browser and face/geometry contracts; broad sweeps deferred |
| Python recipes or `tests/stylized_*.py` | Helper jobs plus character, costume and face examples |
| Versions, dependencies, fixtures, selection/fixture helpers, CI/risk policy, unknown paths or missing diff | Every runtime job and geometry sweep |

The executable routes are in [ci-plan.mjs](../scripts/ci-plan.mjs). Both sides of
a rename and deleted inputs participate. This is area routing, not a complete
dependency graph. The aggregate gate rejects failures, cancellations, missing
planning output and unexpected skips. Branch-protection enforcement is separate;
returning to production should also restore required checks in repository settings.

All original runtime test/typecheck/build commands remain available. Python
commands default to `full` locally. In test/production, known Python PR edits use
`AGENT_MESHES_TEST_LANE=merge`; explicit full runs retain every sweep. The exact
deferred IDs/reasons are in [geometry-sweeps.json](../tests/geometry-sweeps.json).
New tests stay in merge and stale IDs fail. Prepared costume/helmet fixtures
return isolated copies; direct repeatability checks still generate independently.
The Python suites need NumPy and do not launch Blender. Hosted checks do not
replace native exports, engine imports or visual review.

## Full receipts and local policy checks

Only a successful full `Check` uploads `candidate.json` under an artifact named
for the checked Git tree. The recorder rejects every partial scope in all phases.
In test/production, tag verification requires the exact tree/version/repository
and live successful run attempt. Changed contents, failed/forked/unrelated runs,
missing or expired receipts fail. Receipts expire after 90 days. In dev, these
receipts are optional evidence, separate from the identity-only tag check.

```powershell
python -m pip install -r .github/requirements-ci.txt
node --test tests/ci-plan.test.mjs tests/release-candidate.test.mjs  # the .mjs tests; vitest does not run them
python tests/ci_docs.py
python tests/geometry_scope.py
python scripts/check_docs.py --paths-file <JSON-array-of-repo-relative-paths>
```

## Local gate

In the dev phase a pull request runs only the quick observer, so the runtime checks
fall to the local run. `node scripts/ci-plan.mjs local-gate --base <sha>` reads
`git diff --name-only <sha>...HEAD` plus uncommitted and untracked files, ignores the
phase, and prints the commands to run for that diff (add `--run` to run them and stop
at the first failure). It selects:

| Diff | Lane |
| --- | --- |
| Only `skills/*/SKILL.md` and `skills/*/references/*.md` | `skills-only`: typecheck, `ci_docs.py`, `check_docs.py` and the skill vitest files |
| Docs and named root documents | `docs-only`: `ci_docs.py` and `check_docs.py` |
| TypeScript, helper modules, recipes or Python tests | `affected`: typecheck, build, the `.mjs` tests, the vitest files that can reach the diff, and the Python scripts that read the changed helper (read from `check.yml`) |
| The four version files with only their version strings changed (a release bump), with or without docs | `affected`: the same checks, with the vitest files that assert a version and no Python suite |
| A dependency, any other edit to a version file, a fixture, CI file or unknown path | `full`: every vitest file and every script of the workflow |

`npm run gate` is `local-gate --base origin/main --run`.

**Affected vitest files.** `scripts/ci-affected.mjs` builds a reach graph from each
`tests/*.test.ts`: relative imports, repository paths written as string literals
(`resolve('scripts/agent-meshes.mjs')`, `new URL('../scripts/blender-author.py', ...)`)
and the directory of a template path. A test file runs when it changed, when it can
reach a changed file, or when it reaches no source at all; the three content tests
(hygiene and the two skill tests) always run. A Blender helper or recipe selects the
tests that can reach a module naming a Blender script, and a workbench source the tests
that can reach `dist-web`. The graph answers "every file" for anything it cannot
follow: a deleted or renamed file, a file no test reaches, a fixture no test names, a
dependency or configuration file. `tests/ci-plan.test.mjs` holds its negative controls.

**Workers.** Local vitest runs use the worker count of `vitest.config.ts`; the hosted
jobs keep `--maxWorkers=2` for two-core runners. The Python scripts are independent
processes and run six at a time (`node scripts/ci-plan.mjs pool <scripts>`), each
script's output shown only when it fails. `tests/blender_face_geometry.py`, whose
cases would otherwise run one after another in one process, runs as four interleaved
shards: `AGENT_MESHES_TEST_SHARD=<i>/<n>` keeps every n-th case of the selected lane,
so the shards are disjoint and together run every case (`tests/geometry_scope.py`
checks that, and the gate runs it before any Python suite). The hosted job sets no
shard and runs the file whole.

**Failures.** Every vitest command of a `--run` also writes a JSON report beside the
changed-paths file, outside the checkout, and a failed command prints one
`FAILED tests/<file> > <test name>` line per failed test before the done marker, so
the list survives a truncated log.

A change to `agent_meshes_digitigrade_gait.py` selects `digitigrade_gait.py` and
`digitigrade_body_timing.py`. The last line is always
`LOCAL-GATE-DONE lane=<lane> status=<planned|pass|fail> commands=<n>`, so one monitor
can wait for it. The `.mjs` tests run with `node --test`; `npm test` (vitest) only
includes `tests/**/*.test.ts`.

The [audit](../docs/validation/ci-efficiency/audit.md) and
[trim plan](../docs/superpowers/plans/2026-10-18-trim-geometry-tests.md) retain prior
production-policy findings and measurements; their historical claims do not
override the owner's current dev phase. Publishing a marketplace update remains
a separate action. This CI policy change does not bump the plugin version.
