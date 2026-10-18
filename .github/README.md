# Continuous integration

`Check` always creates `CI required`. Its quick Linux job computes the PR diff,
tests the routing/gate, and checks changed Markdown links, skill frontmatter,
changed JSON, and package/lock/plugin/marketplace version agreement. It does not
install npm packages, download Chromium, or generate meshes.

| Change | Selected runtime jobs |
| --- | --- |
| Root README/AGENTS/CLAUDE/LICENSE, `.github/README.md`, Markdown under `skills/`, or documentation/evidence under `docs/` | None; quick checks still gate |
| TypeScript/CSS/HTML under `src/`, or `tests/**/*.test.ts` | Full Windows JavaScript and Linux system-Chromium jobs |
| Python under `recipes/`, `scripts/blender_lib/`, or top-level `tests/` | JavaScript/browser and four Python lanes; broad geometry sweeps deferred |
| Versions, dependencies, fixtures, selection/fixture helpers, CI/risk policy, other scripts or unknown paths | All runtime jobs and every geometry sweep |
| Manual dispatch, Monday 06:17 UTC schedule, or PR labeled `ci:full` | All runtime jobs |
| Version tag `v*` | Separate release-identity workflow; requires matching successful full-CI evidence |

The executable whitelist is in [ci-plan.mjs](../scripts/ci-plan.mjs). A Markdown
file inside `scripts/` is a runtime input and selects all suites. A deleted or
renamed source still selects its original area. Missing diff information selects
all suites. New file types default to all suites until deliberately classified.
This is conservative area routing, not a complete per-test dependency graph.

`CI required` runs even when dependencies fail or are skipped. A selected job
must succeed; an unselected job must be skipped. Failure, cancellation, missing
planning output and unexpected skips fail the gate. Keep this stable check name
for branch protection. Repository protection is configured separately; the
workflow does not turn enforcement on.

There is no branch-push trigger. New PR commits cancel obsolete runs. Adding or
removing a PR label replans the run; `ci:full` overrides affected routing. Manual
and scheduled runs become available through this workflow after it lands on the
default branch:

```powershell
gh workflow run check.yml --ref <branch>
```

Every original runtime test/typecheck/build command remains in its existing lane.
Python commands use `AGENT_MESHES_TEST_LANE=merge` for ordinary known Python
changes, and `full` for release/shared/policy inputs, manual/scheduled runs and
`ci:full`. Local commands default to `full`. The explicit IDs and reasons in
[geometry-sweeps.json](../tests/geometry-sweeps.json) defer broad standard-risk
shape/pose sweeps; unlisted/new tests remain in merge, and stale IDs fail.
Prepared costume/helmet meshes are reused only within a process, with isolated
copies for each caller. Direct repeatability checks still build independently.
Software-GPU capture runs separately from geometry workloads. The Linux browser
lane checks the installed Chrome path, a fresh managed runtime, and real render
artifacts; the Windows lane retains Playwright Chromium coverage. The Python
geometry suites need NumPy but do not require Blender. Hosted CI does not replace
native Blender exports, Unreal imports or visual review for changes that need them.

Local policy checks (Python 3.12 and Node 24):

```powershell
python -m pip install -r .github/requirements-ci.txt
node --test tests/ci-plan.test.mjs tests/release-candidate.test.mjs
python tests/ci_docs.py
python tests/geometry_scope.py
python scripts/check_docs.py --paths-file <JSON-array-of-repo-relative-paths>
```

The [owner-confirmed risk map](../.testing/risk.yml) records preservation obligations.
The [audit](../docs/validation/ci-efficiency/audit.md) separates scanner findings,
manual review and measured costs. The original area-routing change retained every test. The current geometry
trim defers only the explicitly listed sweeps to full runs; its acceptance and
coverage mapping are in the [trim plan](../docs/superpowers/plans/2026-10-18-trim-geometry-tests.md).

## Release candidates

Put the version bump into the candidate before final CI. Package, lockfile and
plugin manifest changes still select full coverage. After the aggregate gate
passes with both runtime groups and every geometry sweep selected, it uploads `candidate.json` under an
artifact named for the checked Git tree. A docs-only, JS-only or merge-only geometry run cannot produce
release authorization.

Tagging the validated candidate runs `Verify release candidate`, without repeating
the mesh suites. It requires the tag to equal `v<package version>`, the entire Git
tree to match the receipt, and the source Check run to be completed/successful in
this repository with the same run attempt. Tree identity permits a normal squash
merge without treating a different source tree as tested. Changed contents,
another version, failed/forked/unrelated runs, and missing/expired receipts fail.
The full receipt expires after90days; it is evidence, not a dependency cache.

If proof is unavailable, run full Check for the candidate/tag, then rerun the
release-identity workflow. Do not skip this gate or rename a different commit to
reuse old results. Source/plugin installation still checks version and managed
fingerprint; this workflow verifies evidence and does not publish the marketplace
entry automatically. Later version-only edits have no special exemption in this
slice: they create a new candidate requiring full validation.
