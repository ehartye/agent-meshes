# CI efficiency audit, 2026-10-18

The owner authorized smarter CI and confirmed a production risk map: installed
plugins, downstream repositories (including Dead Redline), saved projects and
published APIs remain consumers. Saved data, source/output safety and build/export
contracts are critical. Modeling/rendering/generators are standard; prose is low.

## Measured problem and scope

The documentation-only [PR149](https://github.com/ehartye/agent-meshes/pull/149)
started the full workflow, [run39135962653](https://github.com/ehartye/agent-meshes/actions/runs/39135962653).
Its completed lanes took Windows JavaScript 6m52s, Linux browser 4m33s, Python
geometry 50s, character 15m24s and costume 27m53s. Face was still running when
sampled. A prior release run38823169099 recorded 46m50s for face. These are
individual hosted runs, not averages or a new-runtime speedup claim.

The implemented change routes affected *areas*, preserving every existing runtime
command. Documentation gets quick syntax/link/metadata checks; TypeScript/viewer
changes keep both JavaScript/browser platforms. Python, scripts, fixtures,
dependencies, CI policy and unknown paths retain the full suite. Manual, weekly,
version-tag and `ci:full` runs select everything. The final gate validates expected
success/skipped results and fails on missing scope or unexpected job results.

## Audit evidence and judgments

agent-tests0.4.1 initially recognized121 JS/TS files, with65 redundancy findings,
3 shim findings,16 worktree findings,1 wiring gap and1 frequency finding. These
are detector counts, not confirmed defects. The risk map was missing; the owner
confirmed it before it was written. No tests were deleted, merged or demoted.

The highest-priority findings were read with their subjects. Costs below are
static estimated tokens; churn is test-only edits / all edits touching the test.

| File | Tier | Verdict | Evidence and rationale | Agent tokens | Churn |
| --- | --- | --- | --- | ---: | --- |
| tests/set-recipes.test.ts | standard | rewrite (follow-up) | `worktree.absolute-path`, `worktree.home-dir`: optional local sheet render depends on another checkout and installed runtime. Replace with an isolated fixture/runtime contract before changing coverage. It is already skipped on CI, so it is not the hosted bottleneck. | 1634 | 0/0 |
| tests/unreal.test.ts | critical | keep | Windows paths are quoted test inputs; “fallback” names current Unreal import behavior. Independent output/report assertions preserve import contracts. | 9559 | 0/1 |
| tests/server.test.ts | standard | keep | Server binds port0; fixed-port strings are proxy-origin test inputs. | 2157 | 0/1 |
| tests/workspace.test.ts | critical | keep | SQLite filenames are inside a fresh temporary directory. Saves/recovery protect stored projects. | 1106 | 0/0 |
| tests/workspace-server.test.ts | critical | keep | Temporary database directory, not a shared fixed database. Tests server persistence integration. | 1235 | 0/0 |
| tests/browser.test.ts | critical | keep | Fixed missing filename exercises rejection; actual setup uses isolated paths. Complements managed-runtime tests rather than replacing them. | 1108 | 0/0 |
| tests/physical-assembly.test.ts | standard | keep | Absolute paths are unsafe-input rejection cases, not reads from an owner's machine. | 2511 | 0/0 |
| tests/quadruped.test.ts | standard | keep | Compatibility alias protects existing authoring callers; shared model imports alone do not establish duplicate assertions. | 5423 | 4/7 |
| tests/rig.test.ts | critical | keep | Legacy-project upgrade preserves declared stored-project consumers. | 1724 | 0/0 |

58 files without flags/findings and with a resolved tier are retained without
opening them; no recognized files lack a tier. The retained [inventory](inventory.json)
records the scan scope and remaining clusters. Other shared-subject
clusters are retained provisionally, without a deletion/merge judgment: importing
`core/model`, `author`, `export` or `refine` is not proof of redundant behavior.
No token saving from test deletion/merging is claimed; no edit-lane files demoted.

## Architecture advisory

The slow Python suites repeatedly construct complete character/costume/face
geometry. Character and costume import recipes dynamically; face also exercises
pure-Python Blender helper geometry. File-extension routing cannot safely infer a
complete dependency graph. All script inputs are also part of the managed runtime
fingerprint, including Markdown inside scripts. That is why the docs whitelist
excludes that directory and unknown inputs select all suites.

1. **Conservative area routing (implemented).** Time: small policy/checker change;
   hosted documentation timing must be measured. Runtime changes still pay for
   their existing suites. Risk: incorrectly classifying inputs; bounded whitelist,
   full fallback and rename/deletion tests reduce it. Complexity: one planner and
   exact-result gate. Best practice: keep an always-reported aggregate instead of
   workflow-level path filtering. Maintainability: add routes deliberately as new
   input owners appear.
2. **Profile and reuse Python geometry fixtures (follow-up).** Time: estimate one
   focused profiling slice before selecting fixtures; savings unmeasured. Risk:
   shared mutable geometry can hide isolation defects. Complexity: explicit fixture
   ownership and immutable/copy semantics. Best practice: cache only verified
   repeated setup, retaining every oracle and negative control. Maintainability:
   centralized fixture builders and per-suite timing evidence.
3. **Fine-grained per-test dependency routing (deferred).** Time: larger manifest
   and invalidation work, estimate several days. Risk: missed dynamic imports,
   embedded scripts or fixture dependencies silently omit protection. Complexity:
   transitive input graph plus fallback. Best practice: use only a complete input
   manifest with false-negative controls. Maintainability: higher than the first
   approach; validate against regular full runs before trusting selection.

Windows remains on affected runtime PRs because this released plugin has Windows
consumers. The scanner's blanket Windows-frequency warning is advisory, not grounds
to remove platform protection. There is no duplicate branch-push run; only version
tags trigger `push`. Branch-protection settings are separate and unchanged.

## Verification and limits

- The real documentation-only [smoke PR151](https://github.com/ehartye/agent-meshes/pull/151)
  passed [hosted run39138986552](https://github.com/ehartye/agent-meshes/actions/runs/39138986552)
  in33seconds from run creation to completion: quick job12seconds, gate13seconds,
  with both JavaScript jobs and the Python matrix deliberately skipped. It was
  closed without merging. The [receipt](hosted-docs.json) identifies the tested
  policy source blobs; this is one run, not a guaranteed latency target.
- Eight Node tests exercise routing, a real Git rename/deletion diff with spaces,
  and CLI gate positive/negative controls. Six Python tests exercise valid and
  broken links, CommonMark/reference/image links, skill metadata, invalid JSON,
  unsafe changed paths and metadata drift/missing marketplace entries.
- actionlint1.7.12 passes. The original runtime command inventory is compared
  against the base workflow; the new quick checks are additional protection.
- Static agent-tests does not measure wait time, cost or flakiness and does not
  inventory the repository's Python suites. Python coverage remains a manually
  reviewed workflow inventory. Zero declarations for optional Unreal tests does
  not mean zero tests: their `maybe` alias resolves to native `it`/`it.skip`.
- CLI-reported critical coverage gaps for workflow/risk policy and the Python
  checker require manual interpretation: Node policy tests exercise routing/gate;
  Python checker tests are outside this scanner's adapter. Hosted skip scheduling
  needs a real PR run. No native Blender or Unreal verification is claimed here.
- This slice does not accelerate a changed Python face generator. Full-suite
  duration still depends on those geometry sweeps; fixture profiling is separate.

GitHub documents [job outputs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs)
and [job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions).
It warns that [workflow-level path filters can leave required checks pending](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
The checker uses [CommonMark parsing](https://markdown-it-py.readthedocs.io/en/latest/using.html)
instead of treating a Markdown-link regex as a parser.
