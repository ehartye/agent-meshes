# Continuous integration

`Check` always creates `CI required`. Its quick Linux job computes the PR diff,
tests the routing/gate, and checks changed Markdown links, skill frontmatter,
changed JSON, and package/lock/plugin/marketplace version agreement. It does not
install npm packages, download Chromium, or generate meshes.

| Change | Selected runtime jobs |
| --- | --- |
| Root README/AGENTS/CLAUDE/LICENSE, `.github/README.md`, Markdown under `skills/`, or documentation/evidence under `docs/` | None; quick checks still gate |
| TypeScript/CSS/HTML under `src/`, or `tests/**/*.test.ts` | Full Windows JavaScript and Linux system-Chromium jobs |
| Python, recipes, fixtures, dependencies, scripts, CI/risk policy, or any unknown path | All existing JavaScript/browser and four Windows Python lanes |
| Manual dispatch, Monday 06:17 UTC schedule, version tag `v*`, or PR labeled `ci:full` | All runtime jobs |

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
Software-GPU capture runs separately from geometry workloads. The Linux browser
lane checks the installed Chrome path, a fresh managed runtime, and real render
artifacts; the Windows lane retains Playwright Chromium coverage. The Python
geometry suites need NumPy but do not require Blender. Hosted CI does not replace
native Blender exports, Unreal imports or visual review for changes that need them.

Local policy checks (Python 3.12 and Node 24):

```powershell
python -m pip install -r .github/requirements-ci.txt
node --test tests/ci-plan.test.mjs
python tests/ci_docs.py
python scripts/check_docs.py --paths-file <JSON-array-of-repo-relative-paths>
```

The [owner-confirmed risk map](../.testing/risk.yml) records preservation obligations.
The [audit](../docs/validation/ci-efficiency/audit.md) separates scanner findings,
manual review and measured costs. No tests were deleted or demoted in this change.
