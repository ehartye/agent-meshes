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
