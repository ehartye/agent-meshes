# Native build identity and project ownership

## Contents

- [Declare and pin a native build](#declare-and-pin-a-native-build)
  - [Declare a library tree](#declare-a-library-tree-0210-and-later)
- [Reuse native Blender output](#reuse-native-blender-output-when-unchanged)
  - [Observe project reads](#observe-project-reads-0220-and-later)
  - [Enable incremental generation](#enable-incremental-generation)
  - [Share defaults and build a batch](#share-defaults-and-build-a-batch-0230-and-later)
  - [Diagnose a native miss](#diagnose-a-native-miss-0230-and-later)
  - [Declare Blender's environment](#declare-blenders-environment-0240-and-later)
  - [Share inputs under an explicit project root](#share-inputs-under-an-explicit-project-root-0240-and-later)
  - [Keep audit receipts portable](#keep-audit-receipts-portable-0240-and-later)

Keep authored Python, imported project modules, donor data and design parameters
under project ownership. Run builds through the version-matched managed launcher
from [mesh-setup](../../mesh-setup/SKILL.md). Python helper modules are build-time
dependencies; the app consumes the exported GLB, not these Python modules.

A reproducible asset needs more than the entry script's hash. Record the selected
Meshes/helper identity, Blender version, declared input bytes and final GLB hash.
Pin the toolchain deliberately when updating a project's assets. A lock is a
validation requirement: if it is unavailable or mismatched, install/select the
intended release or review an update, rather than silently using the latest one.

Python can import modules and read files dynamically. Declared input tracking is
not an automatic complete dependency graph or a hermetic Python sandbox. Include
every project module, parameters file and donor used by that recipe; review
environment variables, external tools and intentional development overrides.
Do not use this receipt alone to skip regeneration for undeclared dependencies.

Legacy build configs continue to work, but an unpinned legacy build does not
acquire a reproducibility guarantee. Keep existing receipt fields usable and use
the added identity records to attribute exactly what was declared and generated.

## Declare and pin a native build

Native builds support `blender.inputs` and `blender.toolchain` starting with
0.20.0. The entry script is always
included. Declare additional files individually, relative to `build.json` by
default (or the explicit project root described below):

```json
{
  "version": 1,
  "blender": {
    "script": "head.py",
    "inputs": [
      { "path": "identity.py" },
      { "path": "head-parameters.json" }
    ]
  },
  "output": "generated/head"
}
```

### Declare a library tree (0.21.0 and later)

Use a named subdirectory when imported modules or parameters change together:

```json
{
  "version": 1,
  "blender": {
    "script": "prop.py",
    "inputs": [
      { "dir": "lib", "exclude": ["notes/**"], "maxFiles": 1000 },
      { "dir": "parameters", "include": ["**/*.json", "**/.*.json"] }
    ]
  },
  "output": "generated/prop"
}
```

An omitted `include` selects every regular file, including dotfiles. Explicit
patterns use Node's POSIX glob behavior: `*` and `?` stay within a path component,
and a complete `**` component spans directories. Dot paths need explicit dot
patterns. Patterns are relative to the declared directory; `exclude` removes
matches. Brace lists, brackets, negation, extglobs, absolute paths and traversal
are rejected. `__pycache__`, `.pyc` and `.pyo` are always excluded. This is
declared expansion, not Python import discovery or a file-read audit.

Trees must be named subdirectories of the input base: the config directory by
default, or an explicit project root. `.` and traversal in input declarations are
rejected. The default and maximum selected-file budget is
10,000 per tree; `maxFiles` can lower it. Traversal is bounded at 50,000 entries
per tree. Empty matching sets remain tracked. Links, overlapping declarations,
non-file entries and output/tree overlap fail before publishing. Existing file
declarations and their optional byte pins remain supported.

`provenance.inputs` lists the entry and every selected file's raw-byte SHA256.
`provenance.inputTrees` records each directory, normalized patterns, budget,
expanded input-base-relative paths and actual `sha256`. Its digest is SHA256 of the
UTF-8 JSON serialization of the tree's sorted `[{"path", "sha256"}]` records.
Sort paths by ECMAScript UTF-16 code-unit lexical order, without locale collation
or Unicode normalization; for example U+10000 sorts before U+E000. Serialize each
object with keys `path` then `sha256`, using JSON.stringify escaping, input-base-relative
POSIX paths and no whitespace or newline. A Python implementation must sort by
`path.encode('utf-16-be', errors='surrogatepass')`, then use
`json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8')`
for ordinary Unicode filesystem names. File names and
raw line endings are significant. Copy that reviewed digest into the tree
declaration's optional `sha256` to pin the complete selected membership/bytes;
editable trees can remain unpinned. `provenance.pins.inputTrees` names pinned
directories. No absolute project paths are added to that provenance.

Adding, removing or editing a selected file changes native reuse identity. The
build re-expands membership and rechecks selected bytes before output
replacement; a change during generation stops publication and preserves the
prior owned output. Excluded files intentionally do not affect the key.
Directory metadata is also guarded during that attempt: temporary additions or
removals can abort generation even when final membership is restored, including
conservative rejection for excluded membership changes. Directory timestamps
are not part of the portable tree digest or future-build key. Include
all actual dependencies and relevant environment/tool inputs before opting into
reuse; the tree feature does not establish complete dynamic dependency closure.

Run the build once with the intended toolchain and review both asset and receipt.
`authoring.json.provenance.inputs` contains the entry and declared file digests;
`provenance.toolchain` contains `agentMeshesVersion`, `helpersSha256` and the
actual `blenderVersion`. Copy that reviewed toolchain object into
`blender.toolchain`. Add a reviewed `sha256` to an input declaration when it is
meant to stay fixed, such as a donor mesh; leave editable project modules unpinned
when you want their changing bytes recorded rather than rejected. A toolchain
lock requires the Meshes version and helper digest; the Blender version pin is
optional. Review and update pins deliberately when the relevant inputs change.

The helper digest uses that same UTF-16 sorting and JSON construction for paths and raw-byte SHA-256 digests of the
Blender runner and the complete helper/data tree. It excludes Python bytecode
and `__pycache__`; machine-specific cache locations are not part of the identity.
Raw-byte identity is intentionally exact: a checkout's line-ending conversion
can change the digest. Prefer the same immutable distribution, and do not treat
matching package versions alone as matching helper contents.

The build rejects missing declarations, unsafe/duplicate declared file names, links in declarations and
pin mismatches, and checks for changes during execution before replacing an owned
output. The output may not contain declared inputs. Blender's version is checked
from the actual completed author operation, so a Blender-version mismatch may
still perform work in staging; it does not publish that staged output.
Legacy entry/config paths retain canonical resolution and their existing hard-link
behavior. Adding an explicit declaration opts that file into the stricter policy.

The receipt preserves `version`, `source`, `blender` and `meshes`. Its added
`provenance` records declared input/toolchain pins, helper identities and the
final `model.glb` digest after decoration. `dependencyDiscovery` is explicitly
`entry-and-declared-only`. These identities provide attribution and rejection
controls; they do not provide a new cache or guarantee deterministic output from
arbitrary Python, external tools or environment-dependent recipes.

For a deliberate archive/vendor fork, retain the complete declared source,
helper/data and license set plus the toolchain identity. Editing an installed
plugin cache is not an update policy. Project-level design changes normally
belong in the small editable recipe instead.

## Reuse native Blender output when unchanged

### Observe project reads (0.22.0 and later)

Every generated native build installs a bounded CPython audit hook before project
imports. The CLI result reports Python read open attempts and module filenames,
including modules already loaded at startup. From 0.24.0, the authoring receipt
uses a distinct portable summary described below.
Pure writes, pseudo module filenames, the exact fresh generated GLB and the fresh
private bytecode prefix are excluded. Both default and incremental native builds
use fresh bytecode lookup before project imports; disabling writes alone does not
prevent loading old timestamp bytecode.

The enforced scope is the **config directory** by default, or the explicitly
declared **project root**, matching the selected input boundary. `reads` lists
observed project paths and `undeclaredReads` identifies
those absent from entry/expanded input declarations. Exact hashed helper files
and installed Blender runtime paths are classified separately. Other paths appear
in the CLI's `externalReads`, relative to the input base; they are **outside the enforced scope**,
remain owner-reviewed dependencies and are not made fresh by this diagnostic.
Blender may inspect an external extension-registry cache during export, for example.

The default is `"blender": {"script":"prop.py", "readAudit":"warn"}`; omitting
`readAudit` also selects warn. Findings publish current output with a
`BLENDER_READ_AUDIT` warning, but no reusable native cache. Repeated --if-changed
calls therefore generate again until declarations or incomplete observation are
resolved. `"readAudit":"strict"` rejects undeclared/incomplete observation before
publishing, preserving previous owned output. Results distinguish `clean`,
`undeclared` and `incomplete`; clean means clean **within this diagnostic's scope**.
Strict mode does not fail merely for a reported out-of-scope external read.

Observation has a 20,000-unique-path budget. A failed hook self-probe, unresolved
descriptor/path event, malformed/missing report or truncation is incomplete and
cannot seed reuse. Clean reports are saved with the pristine native cache and
replayed on a hit without launching Blender; old cache records without reports
miss conservatively. A strict-config change also changes the build key.

CPython raises open events before attempting the operation, so even a caught
missing-file open may need a declaration or recipe change. Hooks can miss native
C/C++ file reads, child processes, directory/glob membership, network and code
that bypasses the observer. They do not discover complete dependencies or enforce
a sandbox. Keep explicit tree declarations and forced validation; inspect
`externalReads` and do not treat a clean audit as permission to omit dependencies.
Relative `os.open` read events are incomplete because the event omits `dir_fd`;
the observer cannot distinguish cwd-relative from descriptor-relative lookup.
Use an absolute path when the recipe can do so without changing its meaning.
See [CPython audit events](https://docs.python.org/3/library/audit_events.html),
[audit hook limits](https://docs.python.org/3/library/sys.html#sys.addaudithook) and
[PEP 578](https://peps.python.org/pep-0578/).

### Enable incremental generation

With an incremental-capable build, opt in per asset:

```text
mesh build build.json --if-changed
mesh build build.json --force
```

These flags are available starting with 0.20.0. Default builds continue to run
Blender. `--force` regenerates and refreshes the incremental result; it does not
silently keep the prior cached mesh. These flags currently support native
`blender.script` configs, not workspace/refine or Unreal import/cook stages.

Before opting in, declare every imported project module, donor and data file in
`blender.inputs`, and make changing seeds/settings explicit inputs. This is an
owner assertion that the recipe is reusable under its tracked dependencies.
Arbitrary imports, external file reads, network responses and time-dependent
generation are not discovered or sandboxed. Compiling Python alone cannot prove
that those dependencies or the resulting mesh are valid. Use normal/forced
generation when that input contract is not established.

The change key includes config/entry/declared bytes, shared helpers, authoring
implementation and its absolute helper location, Node/platform, working directory, effective environment digest and a
recognized complete Blender installation. Environment values are not written
to the cache. Tool files are byte-hashed on each standalone check, including bundled scripts,
Python and data; an unchanged filename/version alone is not enough. Hashing has
a real cost even when Blender is skipped. Moving between a checkout and an installed
runtime regenerates even when their helper bytes match, since Python can observe
module and wrapper locations. Store launchers, unrecognized distro
layouts, linked runtime files and external Blender/Python/helper overrides fall
back to generation rather than claiming a cache hit. Undeclared local shared-helper
shadows and bytecode-only shared helpers also fall back. Supported launches use
the selected command/environment and factory startup, with fresh bytecode lookup
before importing project/shared source. Suppressing bytecode writes alone would
still permit stale timestamp caches to override changed Python source.

A successful incremental build owns a pristine Blender GLB and a small versioned
cache record alongside its generated output. Subsequent matching builds verify
that pristine digest and skip Blender. Current verification, limits, previews and
decorations still run; a decorator is never applied repeatedly to last run's
already-decorated GLB. Missing/corrupt cache bytes cause regeneration. Missing or
damaged final generated artifacts can be repaired from valid pristine bytes.
Ownership, links, concurrent builds and input/tool changes retain their checks;
failure preserves the previous published output.

The result's `incremental.blender` is `built` or `reused`, with a reason. Keep
forced rebuilds in validation and compare the actual required output, rather than
assuming one deterministic fixture proves all recipes reproducible. This is a
local producer cache, not a remote cache or a promise that all build stages skip.

### Share defaults and build a batch (0.23.0 and later)

Put shared verification, strict-audit and toolchain settings in one JSON file:

```json
{
  "version": 1,
  "blender": { "readAudit": "strict", "inputs": [{ "dir": "lib" }] },
  "verify": { "maxTriangles": 5000 }
}
```

Each leaf config can use `"extends": "defaults.json"`, then specify its own
`blender.script` and `output`. Nested objects merge; arrays and scalar values
replace the inherited value. The leaf wins. Only `extends` resolves relative to
the file declaring it. Every other path, including inherited inputs, scripts and
output, remains relative to the leaf config. Keep that layout explicit rather
than assuming paths follow the defaults file. One ancestor per file and at most
16 configs are allowed; cycles and unsafe property names fail.

All raw config hashes enter the native key. Extended native receipts also list
`provenance.configurations`, leaf first, with paths relative to the leaf config
even when a project root is selected. This list is distinct from root-relative
native input identities. Ancestor changes, deletion, replacement
or alias retargeting during generation prevent publication. Output cannot contain
any config in the chain. Shared pins are validation requirements, never automatic
pin updates. The final merged config must satisfy the ordinary strict schema.

```text
mesh build-batch build-barrel.json build-tank.json build-reaper.json --if-changed --no-preview
```

The explicit ordered batch accepts 1–1000 configs. It rejects duplicate canonical
config paths, executes sequentially and stops at the first failure. Its JSON
lists attempted `assets`, `unattempted` configs and `toolchain` capture/validation
counts; a failed batch exits nonzero. Successfully published earlier assets stay
published; the failing asset keeps its previous output. This is a per-asset
transaction, not an all-or-nothing batch transaction. Give each config its own
output directory. Ordinary `build` and per-asset `--force` semantics remain.

Within one batch, full byte hashing of each selected Blender installation, helper
toolchain and native implementation happens once. Before sharing and publishing,
the session rechecks membership and high-resolution file metadata. A changed
shared resource invalidates the session; no later asset uses it. Snapshots are
private, and the session closes at the end. There is no persistent metadata cache
or daemon. The next invocation hashes again. Input hashing, verification and
requested previews still run per asset. Batching removes repeated tool hashing;
it does not remove Blender generation time for changed assets.

### Diagnose a native miss (0.23.0 and later)

`incremental.reason` distinguishes `cache-record-missing`, `cache-record-invalid`,
`legacy-cache-record`, `cache-key-changed`, `cache-output-missing` and
`cache-output-corrupt`. A changed key also reports `changedComponents`: `inputs`,
`tools`, `runtime`, `environment`, `cwd`, `location`, `platform` or `policy`.
The cache stores each component's digest; it does not write environment names,
values or raw working-directory paths into those components. Diagnoses explain
the same authoritative key used for reuse. They never authorize a hit themselves.
Old records rebuild once. Forced builds, unsupported launch environments and
unclean read audits retain their specific reasons.

### Declare Blender's environment (0.24.0 and later)

Use `"blender": { "script": "asset.py", "environment": { "inputs": ["MESH_STYLE"] } }`
to pass only declared semantic variables plus the tracked platform baseline.
Unlisted parent variables are absent from Blender, including run IDs, timestamps,
`OLDPWD` and undeclared Python/Blender overrides. Ignoring a variable in the key
alone would permit stale geometry; this option filters the actual launch too.
The same environment is used for plain, forced and unsupported-cache fallback
generation. Explicit mode uses factory startup. Omitted `environment` preserves
full inheritance and its conservative full-environment reuse key.

An empty `inputs` list selects only the baseline. Names use
`[A-Za-z_][A-Za-z0-9_]*`, with at most 256 declarations. Windows names are
case-insensitive, emitted uppercase; duplicate declaration aliases and conflicting
selected parent aliases fail. On POSIX names are case-sensitive. A declared
missing variable stays absent, and defining it later invalidates reuse.

The Windows baseline is `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`,
`SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`,
`WINDIR`. Node/libuv may supplement omitted variables from the real parent, so
explicit mode snapshots, passes and hashes these values. Missing or empty Windows
baseline values fail before launch instead of allowing unkeyed supplementation.
The POSIX baseline is `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`, `TMPDIR`, `TZ`;
only present values are passed. Recipes needing more variables must declare them.
An internal negative guard prevents Node from reinserting unlisted coverage
variables. Declared mode rejects active Node permission mode, which synthesizes
child `NODE_OPTIONS`; inherited mode can generate there but cannot reuse a cache.

This is a launch contract, not an OS, native-code, network or environment-read
sandbox. External runtime overrides that remain in the effective environment
still disable reuse. The chosen Blender executable is resolved before filtering.
Declared receipts add `provenance.environment` with mode, declared/platform names
and an aggregate SHA-256 of effective values. Values are never written there.
The native key includes that contract and the effective map, excluding undefined
negative guards. The platform rules were exercised with Node 24.18.0 on Windows;
see [Node child processes](https://nodejs.org/docs/v24.18.0/api/child_process.html),
[its spawn normalization](https://github.com/nodejs/node/blob/v24.18.0/lib/child_process.js)
and [bundled libuv](https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/process.c).

### Share inputs under an explicit project root (0.24.0 and later)

A nested asset can set `"blender": { "script": "asset.py", "projectRoot": "../..", "inputs": [{ "dir": "lib" }] }`.
Only input declarations move to that root; scripts and output remain leaf-config
relative, and `extends` retains its declaring-file rule. Every leaf/ancestor
config, script and output must remain inside the selected root. A root must be
an explicit relative directory, not a filesystem root. Config aliases, links,
hardlinked configs/scripts, linked declared inputs and output escape fail.

`provenance.inputRoot` records a portable `relativeToConfig` and `scope` marker.
Entry, config and declared file/tree identities use root-relative POSIX paths.
The native location key includes the canonical root. Strict read-audit coverage
widens to that boundary, so an undeclared sibling library is rejected rather than
listed as outside a nested config's scope. Output transactions retain their
ownership checks. Root identity is guarded without treating ordinary staging and
output changes to directory timestamps as an input change.

### Keep audit receipts portable (0.24.0 and later)

CLI results and local producer caches retain the complete schema-1 read-audit
diagnostic. `authoring.json.provenance.readAudit` now uses schema 2: all in-scope
facts and status are preserved, but `externalReads` becomes
`{ "count": 1, "paths": "omitted", "coverage": "outside-enforced-scope" }`.
No outside machine path is stored in that receipt. Inspect the CLI diagnostic
when investigating those paths. Counts may still differ between machines.

An outside read is neither declared benign nor promoted into enforced coverage.
Redaction does not change strict rejection, incomplete status or cache eligibility.
The full local cache is machine-specific and should not be used as a portable
committed receipt. Saved project inputs are unchanged; receipt consumers must
branch on the nested audit schema instead of assuming `externalReads` is always
an array. Neither schema proves complete native dependencies or external freshness.
