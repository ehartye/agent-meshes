# Native build identity and project ownership

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

This extension requires a build with `blender.inputs` and `blender.toolchain`
support; the published 0.19.0 release predates it. The entry script is always
included. Declare additional files individually, relative to `build.json`:

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

Run the build once with the intended toolchain and review both asset and receipt.
`authoring.json.provenance.inputs` contains the entry and declared file digests;
`provenance.toolchain` contains `agentMeshesVersion`, `helpersSha256` and the
actual `blenderVersion`. Copy that reviewed toolchain object into
`blender.toolchain`. Add a reviewed `sha256` to an input declaration when it is
meant to stay fixed, such as a donor mesh; leave editable project modules unpinned
when you want their changing bytes recorded rather than rejected. A toolchain
lock requires the Meshes version and helper digest; the Blender version pin is
optional. Review and update pins deliberately when the relevant inputs change.

The helper digest covers the sorted paths and raw-byte SHA-256 digests of the
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

With an incremental-capable build, opt in per asset:

```text
mesh build build.json --if-changed
mesh build build.json --force
```

The published 0.19.0 release predates these flags. Default builds continue to run
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
implementation, Node/platform, working directory, environment digest and a
recognized complete Blender installation. Environment values are not written
to the cache. Tool files are byte-hashed on each check, including bundled scripts,
Python and data; an unchanged filename/version alone is not enough. Hashing has
a real cost even when Blender is skipped. Store launchers, unrecognized distro
layouts, linked runtime files and external Blender/Python/helper overrides fall
back to generation rather than claiming a cache hit. Supported reuse launches
use the selected command/environment and factory startup.

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
