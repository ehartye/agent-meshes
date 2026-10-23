# Mannequin payload provenance

Harvest source: a private game project repository, commit
`0defa6dd6050b3c41a239d2ec136f6be48505b2d`. `catalog.json` records the
source path, SHA-256 of each delivered GLB, skeleton/clip counts and walk/run map.

Human input paths are `review/gait-audition/assets/human-base.glb.gz` and
`human-addon.glb.gz` at that commit. Their decompressed source hashes are recorded
as `sourceSha256`. The addon is unchanged. The base's Sword_Regular_C_RM contains
198 repeated channels that are exactly equal to retained channels and reference
the same samplers. Only those repeats were removed; geometry, animation samplers,
bind matrices, mesh/material metadata and the full binary payload are preserved.
The original frozen inputs remain in the named source repository.

The source manifest declares Mesh2Motion human assets CC0; the included
LICENSE-human-assets-CC0.txt is the Mesh2Motion asset statement. This is distinct
from Mesh2Motion application code. The local Mixamo walk donor is excluded.

The adult and child plant-kin are fresh exports of their baseline recipes
(paths withheld), copied unchanged into isolated build trees.
They use Agent Meshes 0.16.0 shared sprout anatomy, rig and gait helpers, managed
fingerprint `39e1cc51878b946966ded9abb113600ec6d4ac4f524c30fd13cc256bc6df62e6`,
and the local Mesh2Motion kaiju reference. The adult has five crest fronds and
50 bones; the child has three fronds and 46 bones. Body proportions and placeholder
eyes are the baseline recipes, not stripped or reconstructed clothed cast exports.
These recipes/shared helpers are not assigned a new blanket CC0 dedication here.

Harvest checks: all four GLBs have zero validator errors; each human bank retains
one NODE_SKINNED_MESH_NON_ROOT warning. The aliens have no warnings. Four phases
of eight walk/run clips were sampled for finite moving skeletons. Offline browser
playback, scrub and front/profile/perspective/back views were checked and images
opened. This is bounded reference delivery, not all-clip collision, face, game gait,
native engine import or final artistic acceptance. Asset hashes bind future use
to the actual payload; do not imply a rebuild is byte-identical without checking.

The original adult and child plant-kin Python wrapper text is retained under `source/`, with hashes
in each catalog entry. These are inspection snapshots, not executable relocated
build configs: copy and configure a project-owned source tree and its kaiju/native
input prerequisites before rebuilding. Never run a wrapper inside the immutable
managed runtime, where its relative diagnostic output paths would write into the
installation. The supplied GLBs can be copied and edited directly in Blender.
