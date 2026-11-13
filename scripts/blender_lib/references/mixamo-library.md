# Local Mixamo folder and registry

Adobe Mixamo animations and characters are licensed to the Adobe account that downloads them. They may be used in
your own work, but the files themselves are not ours to pass on. So Meshes does not ship any, and a project does not
commit any. Each machine keeps its own downloads in one folder, and a registry beside them says what is there.

Read Adobe's current terms yourself before shipping work made with them; this page is not legal advice.

## The folder

| Order | Location |
| --- | --- |
| 1 | `AGENT_MESHES_MIXAMO_DIR`, when set |
| 2 | `mixamo` inside `AGENT_MESHES_HOME`, when that is set |
| 3 | `~/.agent-meshes/mixamo` |

It sits in the managed home, outside every repository and outside the plugin. A plugin update does not touch it.
Another machine has its own folder: download the same files there and add them again.

## Commands

Run these from a Meshes source or runtime package, or use the absolute script path from your project.

```text
node scripts/mixamo-library.mjs dir
node scripts/mixamo-library.mjs add <file.fbx | pack.zip | folder> ...
node scripts/mixamo-library.mjs scan
node scripts/mixamo-library.mjs list [--json]
node scripts/mixamo-library.mjs path <id>
```

- `add` copies FBX files into the folder and rescans. A zip archive is read in place and its FBX members land in a
  subfolder named after the archive; a folder is copied under its own name. Sources are left where they are, a file
  that is already there is not overwritten, and nothing but `.fbx` is taken.
- `scan` reads every FBX under the folder and rewrites `registry.json`. Run it after adding or removing files by hand.
- `list` prints one line per entry: id, clip length, bone count, whether a mesh is inside, and the file.
- `path` prints one entry's absolute path, after checking that the file's bytes still match the registry.

## The registry

`registry.json` (schema `agent-meshes/mixamo-registry/1`) holds, per file: `id`, `file` (relative to the folder),
`sha256`, `bytes`, `fbxVersion`, `creator`, `skeleton` (the bone-name prefix, `mixamorig` for Mixamo's own),
`bones`, `hasMesh` and `clips` (`name` and `seconds` of each animation stack).

- The id is the file name in lower case with hyphens: `Rifle Run.fbx` is `rifle-run`. A second file of that name takes
  its folder's name in front, then a number.
- Two files with the same bytes are listed once; `scan` reports the other under `skipped`.
- A file that is not a binary FBX is skipped with the reason.
- A character download with a mesh usually holds a second, one-frame clip: its rest pose.

The registry is a description, not a licence record. Keep the names of the clips a project uses in that project's
build inputs, so another machine knows what to download.

## Use it from a Blender source

```python
from agent_meshes_mixamo import clip_path, import_fbx

run = import_fbx('rifle-run')          # {'objects': [...], 'armature': <object>, 'actions': [<action>]}
path = clip_path('rifle-idle')         # for your own importer
```

`import_fbx` runs Blender's FBX importer on the registered file and returns what it made, unchanged: the armature keeps
the importer's scale (0.01) and rotation, and bones keep the file's names (`mixamorig:Hips`). Files downloaded for one
character share one rest pose, so an action from one file plays on the armature from another. `mixamo_dir`, `registry`
and `entry` are pure Python and need no Blender.

What a build makes from a clip (a GLB of your own character with the motion baked in, or sprite frames) is your work
and may ship. The FBX stays in the folder. A build that reads the folder depends on files outside the project: it
cannot be reproduced on a machine that lacks them, and an [input audit](../../../skills/mesh-build/references/native-build-identity.md)
reports the read as undeclared.

For motion with a clear licence that can ship, use the bundled [rig library](rig-library.md) and
[mannequins](mannequin-library.md).
