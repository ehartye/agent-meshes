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
| TypeScript, helper modules, recipes or Python tests | `affected`: typecheck, build, the `.mjs` tests, vitest, and the Python scripts that read the changed helper (read from `check.yml`) |
| A version file, dependency, fixture, CI file or unknown path | `full`: every script of the workflow |

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
