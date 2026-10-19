# Incremental native Blender build plan

The owner requested implementation in Meshes on 2026-10-18. Execute inline with
the planning, test-first and verification disciplines; independent review follows
integration. Base: PR155 candidate ddfbeb82, retained unchanged while its CI runs.
Rebase this branch onto the squash-merged PR155 before publication.

**Goal:** `agent-meshes build asset.json --if-changed` avoids Blender when a
previous successful native author result still matches its tracked inputs.
`--force` regenerates and refreshes that result. Existing default builds retain
their full-generation behavior. This slice supports native `blender.script`
builds, not project/refine caching or Unreal imports/cooking.

**Architecture:** Cache the pristine Blender GLB and a bounded identity record
inside the existing owned output transaction. Every invocation still verifies
the GLB and runs current Node decorations, so callback/preview/verifier changes
are not silently skipped. A cache miss invokes Blender normally; unsupported
tool layouts/overrides fall back to generation. Never infer reuse from PR155's
old provenance receipt alone.

**Evidence:** The wiki's Incremental Build Freshness concept and captured Gradle,
Bazel and Python compilation/import documentation distinguish input/output
fingerprints, tool/environment influences and declared-input owner obligations.
Compilation is not dependency discovery or geometry validation. No extra host
Python dependency or syntax-only success claim is introduced.

**Implications:** Time: hashing now, much less regeneration for expensive assets;
measure cold/warm/forced native runs rather than promise zero cost. Risk: dynamic
undeclared reads or nondeterminism remain the owner's responsibility when opting
in; hash declared files, helpers and recognized complete tool trees, reject
corrupt cache bytes and retain forced checks. Complexity: one native cache module
and two owned cache artifacts. Best practice: producer reuse with fresh downstream
verification and explicit fallbacks. Maintainability: shared Meshes behavior and
preserved legacy defaults, no per-game stamp implementation.

## Contract and boundaries

- Add `BuildOptions.ifChanged?: boolean` and `force?: boolean`, plus matching CLI
  flags. Force implies incremental mode and bypasses reuse. These flags require a
  native Blender config. Return an additive incremental Blender status/reason.
- Entry, every declared import/data file, config bytes, complete helper identity,
  author/cache implementation bytes, Node/platform identity, captured environment
  digest and working directory participate in the key. Opt-in explicitly means
  all remaining external reads are represented by declarations; this is not a
  sandbox or automatic Python dependency graph. Never persist environment values.
- Recognize self-contained archive/install layouts with co-located versioned
  scripts/data/python directories (and the macOS Contents/Resources variant).
  Hash all regular tool files and directory names, with no metadata-based skip of
  byte hashing. Store launch identity and actual completion-reported version.
  Store aliases, distro layouts, links or external resource/module overrides are
  unsupported for reuse and cause a normal Blender build. Do not hash /usr/bin
  as if it were the complete Blender runtime.
- Supported incremental authoring freezes the environment/cwd and chosen Blender
  command, and uses --factory-startup/--disable-autoexec. Native5.2.2 executable
  help confirms these flags. Recheck runtime file identities before publication;
  changed inputs/tools never publish a reusable stale result.
- Cache records have a versioned strict schema, matching input key and pristine
  GLB digest. Only records in this config's already-owned output are considered.
  Malformed/old/missing records or corrupt bytes cause generation. Unsafe links,
  unowned outputs and source/output overlap retain rejection behavior.
- Write the pristine cache before any decoration; validate it again before
  publication so a callback cannot poison the next run. Reuse still checks pins,
  current verification/limits, decorations and transactional output ownership.

## Execution checklist

### 1. Failing behavioral controls

Files: new `tests/build-incremental.test.ts`; extend existing author/CLI test
owners only where needed. Use a tiny recognized portable installation fixture,
mock authorGLB and a real small exported GLB. Canonicalize temporary roots.

- [ ] Baseline `npm test -- tests/build-author.test.ts tests/build-provenance.test.ts --maxWorkers=1` passes (observed25).
- [ ] Add a first failing no-launch control:

```ts
await buildAsset(config, { ifChanged: true });
await buildAsset(config, { ifChanged: true });
expect(authorGLB).toHaveBeenCalledOnce();
```

- [ ] Cover changed entry/import/data/config/tool file, helpers/pins, missing and
  corrupt cache, force refresh, per-asset isolation and legacy full generation.
- [ ] Cover fresh decorators/limits, untouched pristine bytes, invalid decorated
  output preserving prior output, mutation during build, unsafe paths/links and
  unsupported override/layout fallbacks. Assert launch count, final output and
  cleanup, rather than private object layouts.
- [ ] Run the focused tests and observe RED for absent incremental behavior.

### 2. Implement producer reuse

Files: new `src/build-native-cache.ts`, `src/build.ts`, `src/author.ts`.

- [ ] Implement strict record parsing, streaming SHA-256 tool hashing with bounded
  file concurrency, supported-layout discovery and stable identity rechecks.
- [ ] Use one explicit public options type:

```ts
export interface BuildOptions {
  ifChanged?: boolean;
  force?: boolean;
  decorate?: (project: Project, stage: string) => Promise<string[]>;
  decorateAsset?: (asset: AuthoredAsset, stage: string) => Promise<string[]>;
}
```

- [ ] Under the existing lock/ownership transaction, select verified pristine
  bytes or author fresh bytes. All verification/decorating/finalization follows
  the existing path. Include cache files in the owned marker only in this mode.
- [ ] Extend AuthorOptions only to freeze the selected command/env/cwd and factory
  startup for this opt-in. Preserve original default arguments otherwise.
- [ ] Pass focused tests, typecheck and build; inspect output preservation and
  source diffs before continuing.

### 3. CLI and guidance

Files: `src/cli.ts`, `tests/cli.test.ts`, `README.md`, and the existing native
build identity reference. If editing a SKILL.md, read yoda first.

- [ ] Wire --if-changed and --force to buildAsset without changing default preview
  behavior. CLI help names native-only/declared-input semantics.
- [ ] Explain declarations, pristine reuse, fresh checks, fallbacks and force;
  existing published0.19.0 predates this support. No Unreal .uasset/cook cache is
  implied. Link the wiki research/architecture and record roadmap state.

### 4. Fresh acceptance and integration

- [ ] Run all build/output regressions, author launch controls, CLI checks,
  typecheck/build/docs checks and independent source review.
- [ ] Build a real declared native fixture cold, unchanged, changed and forced;
  count Blender invocations, compare accepted output hashes and record end-to-end
  durations. Corrupt cached bytes and confirm safe regeneration/preservation.
- [ ] Validate a clean managed candidate install and the same unchanged path.
- [ ] After PR155 passes/merges, rebase onto latest main, freeze candidate, create
  a separate PR and run its required affected CI. Unknown/full/release policy
  remains intact; no new version bump/publication is included.
- [ ] Verify exact merged tree, update/push wiki architecture/roadmap/evidence and
  retain both worktrees and failed/control receipts. Report measured gains and
  limitations without treating one deterministic fixture as universal proof.

## Reviewed revision: fresh Python source

The independent review of 625b3cb found timestamp-valid bytecode can run different
code from the tracked source: dont_write_bytecode suppresses writes, not reads.
Root reproduced it with actual Blender: params.py said WIDTH1.3 but exported
width1.2. Preserve this RED receipt. Cacheable launches now set a fresh private
sys.pycache_prefix before wrapper/helper/project imports, reject pre-existing
prefixes, and suppress writes. This changes only opt-in author launch arguments;
the Python wrapper/default builds stay unchanged. Bytecode-only shared helpers,
external prefix overrides and undeclared local shared-helper shadows fall back.
Recheck shared runtime state before publication, run native GREEN and get a fresh
scoped review before accepting this revision. PR155 separately passed/merged at
099decd3ac96a4d911fb96cd23fdec897e224994; this branch is rebased onto that main.
