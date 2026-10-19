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

For a deliberate archive/vendor fork, retain the complete declared source,
helper/data and license set plus the toolchain identity. Editing an installed
plugin cache is not an update policy. Project-level design changes normally
belong in the small editable recipe instead.
