# Mixamo folder and registry

Adobe Mixamo animations and characters are licensed to the Adobe account that downloads them. They may be used in
your own work, but the files themselves are not ours to pass on. So never commit any to agent-meshes, and Meshes does
not ship any. You keep your downloads in one folder of your own, and a registry in the managed home says what is there.

Read Adobe's current terms yourself before shipping work made with them; this page is not legal advice.

## The folder

| Order | Location |
| --- | --- |
| 1 | `AGENT_MESHES_MIXAMO_DIR`, when set |
| 2 | `mixamo` inside `AGENT_MESHES_HOME`, when that is set |
| 3 | `~/.agent-meshes/mixamo` |

The folder can be any directory. Meshes writes nothing into it except files you `add`, so it can be a private
repository of your own. Clone that repository on each of your machines and set `AGENT_MESHES_MIXAMO_DIR` to the clone
as a user environment variable. A `git pull` is then the only step on each machine: the registry refreshes itself the
next time it is read. Keep such a repository private, because the files must not be redistributed.

- Every FBX under the folder is read, at any depth, so the folder may be organised however you like.
- Folders whose names start with a dot (such as `.git`) and `node_modules` are not searched.
- Only files on Mixamo's own skeleton are registered: bone names prefixed `mixamorig`, `mixamorig1` and so on. Other
  FBX files in the folder are listed under `skipped` with the reason.
- A file that is still a Git LFS pointer (fetched without its content) is skipped with a reason that says to run
  `git lfs pull`.

## Commands

Run these from a Meshes source or runtime package, or use the absolute script path from your project.

```text
node scripts/mixamo-library.mjs dir
node scripts/mixamo-library.mjs registry
node scripts/mixamo-library.mjs add <file.fbx | pack.zip | folder> ...
node scripts/mixamo-library.mjs refresh
node scripts/mixamo-library.mjs scan
node scripts/mixamo-library.mjs list [--json]
node scripts/mixamo-library.mjs path <id>
```

- `dir` prints the folder; `registry` prints where the registry is kept.
- `add` copies FBX files into the folder and updates the registry. A zip archive is read in place and its FBX members
  land in a subfolder named after the archive; a folder is copied under its own name. Sources are left where they are,
  a file that is already there is not overwritten, and nothing but `.fbx` is taken.
- `refresh`, `list` and `path` first compare the folder with the registry. When a file was added, removed or changed
  (by size or modification time), or the registry describes a different folder, the folder is scanned again. Files
  whose size and time are unchanged are not read again.
- `scan` reads every file again, whatever the registry says.
- `list` prints one line per entry: id, clip length, bone count, whether a mesh is inside, and the file.
- `path` prints one entry's absolute path, after checking that the file's bytes still match the registry.

## The registry

`mixamo-registry.json` in the managed home (`AGENT_MESHES_HOME`, else `~/.agent-meshes`) has the schema
`agent-meshes/mixamo-registry/2`. It records the `directory` it describes. Each file it registers has:

- `id`
- `file`, relative to the folder
- `bytes`, `mtimeMs` and `sha256`
- `fbxVersion` and `creator`
- `skeleton`, the bone-name prefix
- `bones` and `hasMesh`
- `clips`, with the `name` and `seconds` of each animation stack

Each skipped file has the same fields where they could be read, and a `reason`.

- The id is the file name in lower case with hyphens: `Rifle Run.fbx` is `rifle-run`. A second file of that name takes
  its folder's name in front, then a number.
- Two files with the same bytes are listed once; the other is skipped.
- A file that is not a binary FBX is skipped with the reason.
- A character download with a mesh usually holds a second, one-frame clip: its rest pose.

The registry describes one folder at a time. Pointing `AGENT_MESHES_MIXAMO_DIR` at another folder rebuilds it there.
Earlier versions wrote `registry.json` inside the folder itself; that file is no longer read and can be deleted.

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
character share one rest pose, so an action from one file plays on the armature from another.

`registry`, `entry` and `clip_path` check the folder against the registry the same way the commands do. When the
folder has changed, they run `node scripts/mixamo-library.mjs refresh`, so Node must be on `PATH`. `mixamo_dir` and
`registry_file` are pure Python. None of them needs Blender.

What a build makes from a clip (a GLB of your own character with the motion baked in, or sprite frames) is your work
and may ship. The FBX stays in the folder. A build that reads the folder depends on files outside the project: it
cannot be reproduced on a machine that lacks them, and an [input audit](../../../skills/mesh-build/references/native-build-identity.md)
reports the read as undeclared.

For motion with a clear licence that can ship, use the bundled [rig library](rig-library.md) and
[mannequins](mannequin-library.md).
