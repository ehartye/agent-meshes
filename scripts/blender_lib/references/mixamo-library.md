# Mixamo animation library

Adobe Mixamo animations and characters are licensed to the Adobe account that downloads them. They may be used in
your own work, but the files themselves are not ours to pass on. So never commit any to agent-meshes, and Meshes does
not ship any. You keep your downloads in one library folder of your own, and a registry in the managed home says what
is there.

Read Adobe's current terms yourself before shipping work made with them; this page is not legal advice.

The [mesh-animations skill](../../../skills/mesh-animations/SKILL.md) starts the animations page and hands a move set
to an agent. This page is the reference behind it.

## The folder

| Order | Location |
| --- | --- |
| 1 | `AGENT_MESHES_MIXAMO_DIR`, when set |
| 2 | `mixamo` inside `AGENT_MESHES_HOME`, when that is set |
| 3 | `~/.agent-meshes/mixamo` |

The folder can be any directory, and a private repository of your own works well. Clone it on each of your machines
and set `AGENT_MESHES_MIXAMO_DIR` to the clone as a user environment variable. After a `git pull` (or the page's
**Sync**), the registry refreshes itself the next time it is read. Keep such a repository private, because the files
must not be redistributed.

**The library never lives in an agent-meshes checkout.** Every write refuses a library folder that is, or is inside,
the working tree of an agent-meshes repository: a folder holding `.git` whose `package.json` or
`.claude-plugin/plugin.json` is named `agent-meshes`. That covers imports, tag, title and note edits, removals and
Sync. The message names the rule; set `AGENT_MESHES_MIXAMO_DIR` to a folder outside the checkout.

## Layout

Imports land in a `mixamo/` folder inside the library:

| Path | Holds |
| --- | --- |
| `mixamo/clips/<id>.fbx`, `<id>.gif`, `<id>.json` | anything with a motion take (`clip` and `clip-with-skin`) |
| `mixamo/characters/<id>.fbx`, `<id>.gif`, `<id>.json` | a character: a mesh and only a rest take |

Each asset is three files: the FBX as downloaded, its preview GIF and its sidecar.

- **The id** is the slug of the source file name: lower case, with hyphens. `Idle (1).fbx` becomes `idle-1`. When the
  id is already taken by different bytes, the import takes `-2`, `-3` and so on. Ids never change after import, because
  pasted move sets refer to them; the editable title carries the descriptive name.
- **Other FBX files are still registered.** Every FBX under the folder is read, at any depth, so files added by hand
  outside `mixamo/` keep working. Folders whose names start with a dot (such as `.git`) and `node_modules` are not
  searched. A second file of the same name found by the scan takes its folder's name in front, then a number.
- **Git LFS is the repository's concern.** Meshes does not configure it. Track `*.fbx` with LFS and keep the GIFs and
  sidecars as plain git, so a clone made without LFS content still has its previews and tags.

## The sidecar

`<id>.json` beside each FBX has the schema `agent-meshes/mixamo-asset/1`. It is committed with the FBX, one file per
asset, so tag edits made on two machines rarely conflict on a pull.

| Field | Meaning |
| --- | --- |
| `schema` | `agent-meshes/mixamo-asset/1` |
| `id` | the id; it never changes |
| `kind` | `clip`, `clip-with-skin` or `character` |
| `title` | starts as the source name without its extension; the owner can edit it |
| `sourceName` | the original file name |
| `sha256` | the hash of the FBX bytes |
| `importedAt` | ISO time of the import |
| `tags` | sorted, unique, lower-case kebab |
| `note` | free text, empty by default |
| `motion` | the motion summary below, or `null` |
| `preview` | the GIF's file name, or `null` when the preview failed |

A sidecar with another `schema`, or that is not valid JSON, is ignored. The first tag, title or note edit on an FBX
that has no sidecar writes one beside it.

## Import

One import pipeline serves the page, `agent-meshes animations import` and `mixamo-library.mjs add`.

**Inputs:** FBX files, zip archives (their `.fbx` members, read in place; nothing else is taken), and folders (every FBX
under them). Sources are left where they are.

**Each FBX gets one result:** `imported` with its id and kind, `duplicate` with the existing id, or `rejected` with a
reason. They are classified in this order:

| Check | Result |
| --- | --- |
| a Git LFS pointer (fetched without its content) | rejected: run `git lfs pull` in its repository |
| not a binary FBX | rejected with the parse error, such as `not a binary FBX file` |
| bone names not prefixed `mixamorig`, `mixamorig1`, `mixamorig2` ... | rejected: not on the Mixamo skeleton, naming the prefix found |
| the same sha256 as an entry already in the library | `duplicate`, with that entry's id; nothing is written |
| a mesh, and every take one frame or shorter (0.05 s or less) | imported as `character` |
| a mesh and a longer take | imported as `clip-with-skin` |
| no mesh | imported as `clip` |

A path that does not exist, or is neither an FBX, a zip nor a folder, is rejected with the reason.

**For each accepted file** the pipeline copies the FBX into the layout, computes the motion summary, renders the
preview, writes the sidecar with the suggested tags, and refreshes the registry. A file whose preview fails is still
imported, with its motion and tags, `preview: null` and the message in the result's `previewError`.

**The motion summary** is decoded in Node from the hips' `Lcl Translation` curves of the longest take (the bone named
`Hips` after its prefix). Mixamo files are Y up in centimetres; another `UnitScaleFactor` is scaled.

| Field | Meaning |
| --- | --- |
| `seconds` | the take's length |
| `travelMeters` | the horizontal (X, Z) distance the hips move from the first key to the last |
| `inPlace` | true when that travel is under 0.15 m and the hips' horizontal range is under 0.3 m |
| `hipsRiseCm`, `hipsDropCm` | how far the hips rise above and drop below the first frame |
| `summary` | one line, such as `in place · 8.3 s` or `root motion · travels 1.7 m · hips rise 51 cm · 1.2 s` |

A rise or drop under 5 cm is left out of the summary line. A take without hips curves is in place. When the curves
cannot be read, `motion` is `null`.

**Suggested tags** are one kind tag and one motion tag; the owner edits them freely afterwards. The kind tag is the
first of these rules to match the clip name, ignoring case:

| Tag | Matches |
| --- | --- |
| `roll` | `roll` |
| `transitions` | ` to ` (a separate word), `equip`, `disarm` |
| `hit-and-death` | `hit`, `death`, `dying`, `knocked`, `impact` |
| `magic` | `spell`, `cast`, `magic` |
| `melee` | `slash`, `stab`, `punch`, `kick`, `attack`, `combo`, `sword` |
| `ranged` | `shoot`, `rifle`, `pistol`, `bow`, `throw` |
| `jump` | `jump`, `dodge` |
| `locomotion` | `walk`, `run`, `jog`, `sprint`, `strafe`, `crouch`, `swim`, `climb` |
| `idle` | `idle`, `breath`, `stand` |
| `pose-or-emote` | anything else |

The motion tag is `in-place` or `root-motion`, from the summary. A `character` gets `character` instead. Tags given with
`--tags a,b` are added to the suggested ones.

## Commands

Run these from a Meshes source or runtime package, or use the absolute script path from your project.

```text
node scripts/mixamo-library.mjs dir
node scripts/mixamo-library.mjs registry
node scripts/mixamo-library.mjs add <file.fbx | pack.zip | folder> ... [--tags a,b]
node scripts/mixamo-library.mjs refresh
node scripts/mixamo-library.mjs scan
node scripts/mixamo-library.mjs list [--json]
node scripts/mixamo-library.mjs path <id>
```

- `dir` prints the folder; `registry` prints where the registry is kept.
- `add` runs the import pipeline and prints `{directory, registry, entries, results}`, one result per FBX.
- `refresh`, `list` and `path` first check the registry is fresh (see below) and scan again when it is not.
- `scan` reads every file again, whatever the registry says.
- `list` prints one line per entry: id, kind, motion summary (or the clip lengths), tags, and the file. `list --json`
  prints the whole registry.
- `path` prints one entry's absolute path, after checking that the file's bytes still match the registry.

The managed CLI runs the same pipeline as
`agent-meshes animations import <file.fbx | pack.zip | folder> ... [--tags a,b] [--library <dir>]` and prints
`{"results":[...]}`.

## The registry

`mixamo-registry.json` in the managed home (`AGENT_MESHES_HOME`, else `~/.agent-meshes`) has the schema
`agent-meshes/mixamo-registry/3`. It records the `directory` it describes, its `entries`, the `skipped` files, and the
size and time of every sidecar it read (`sidecars`). Each entry has:

- `id`, and `file`, relative to the folder
- `bytes`, `mtimeMs` and `sha256`
- `fbxVersion` and `creator`
- `skeleton`, the bone-name prefix (`mixamorig`, `mixamorig1` ...)
- `bones` and `hasMesh`
- `clips`, with the `name` and `seconds` of each animation stack
- from its sidecar: `kind`, `title`, `tags`, `note`, `motion` and `preview`

An FBX without a sidecar (added by hand) is still registered: `kind` comes from its header, `title` from its file name,
`tags` are empty, `note` is empty, and `motion` and `preview` are `null`.

Each skipped file has the same header fields where they could be read, and a `reason`: not a binary FBX, a Git LFS
pointer, not on Mixamo's skeleton, or the same bytes as another file (which is listed once).

**Freshness.** Before `refresh`, `list`, `path` and the Python reader answer, the folder is compared with the registry.
When an FBX or a sidecar was added, removed or changed (by size or modification time), or the registry describes a
different folder or an older schema, the folder is scanned again. FBX files whose size and time are unchanged are not
read again; sidecars are always read. So a tag change pulled from another machine shows up on the next read, without
`scan`.

The registry describes one folder at a time. Pointing `AGENT_MESHES_MIXAMO_DIR` at another folder rebuilds it there.
Earlier versions wrote `registry.json` inside the folder itself; that file is no longer read and can be deleted.

The registry is a description, not a licence record. Keep the names of the clips a project uses in that project's
build inputs, so another machine knows what to download.

## Previews

Each import renders a looping GIF in the headless Chromium that `mesh-setup` installs (or the one
`AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH` names). One browser serves a whole batch.

- **The scene:** three.js `FBXLoader` loads the clip, hides any skinned mesh, and builds a mannequin from the skeleton:
  a capsule per bone and a sphere for the head. The orthographic camera looks from a three-quarter front view and is
  fitted to the clip's whole range of motion. For root motion it follows the hips' path, so the figure stays in frame
  and the ground grid scrolls under it.
- **The colours** match the workbench: the stage colour `#dce7eb` behind, a ground grid in the line colour `#d6e0e4`,
  and the figure in tints of the ink colour `#213844`.
- **The GIF:** 192 by 192 pixels, a fixed palette of 16 colours (14 even steps from ink towards stage, then line and
  stage), 12 frames a second over the whole clip with the rate lowered to keep at most 96 frames, looping forever.
  It is encoded in-repo, with no extra dependency.

The page shows a placeholder for an entry with no GIF, or one that is still a Git LFS pointer.

## The animations page

```text
agent-meshes animations serve [--open] [--port <n>] [--library <dir>] [--downloads <dir>]
```

Skills run it as `node "<plugin-root>/scripts/run-managed.js" animations serve --open`. It prints one JSON line,
`{"service":"animations","url":"http://127.0.0.1:3390/"}`, and `--open` opens that URL in the default browser.

- **Loopback only:** it listens on `127.0.0.1`, port 3390 by default (`--port 0` picks a free one). A request whose
  `Origin` or `Host` is not that address (`127.0.0.1` or `localhost` on the same port) gets 403.
- **The library** is `--library`, else the folder above. **Downloads** is `--downloads`, else the Downloads known folder
  on Windows (read from the registry, so a Downloads folder redirected elsewhere is found), else `<home>/Downloads`.
- **One server per machine.** A started server records `{pid, port, url, apiVersion, library}` in
  `animations-server.json` in the managed home, and stays in the foreground until it is stopped; the record is removed
  when it stops. A second `serve` reuses a live server with the same API version and library: it prints the same URL,
  starts nothing and exits. It replaces a server of another API version, and fails with a message naming the other
  library when a server for another library is running. A lock file beside the record makes two agents starting at
  once start one server.

The page has two tabs, on the workbench's styles:

- **Import:** the Downloads list (FBX and zip files, newest first) with checkboxes, sizes, dates and an "in library"
  badge, a file picker and drag-and-drop for files from anywhere else, **Import selected**, and a row per file with its
  result or reason. Each new card appears as its import finishes.
- **Library:** a grid of GIF cards with the title, length, summary line and tags; text and tag filters; click,
  shift-click and ctrl-click selection and **Select visible**; bulk add and remove of tags; title and note editing;
  **Remove** (after a confirmation; it deletes the FBX, the GIF and the sidecar); **Copy move set**; and **Sync** with
  its status. Previews honour `prefers-reduced-motion` by showing the first frame until a card is hovered or focused.

### HTTP API, version 1

The contract between the server and the page. Bodies are JSON unless stated; an error answers `{error}` with 400 for
bad input, 404 for an unknown id, 409 when the checkout rule refuses or Sync is unavailable, and 403 for a foreign
origin. Imports and edits run one at a time.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/health` | | `{service: "agent-meshes-animations", apiVersion, library, pid}` |
| `GET /api/library` | | `{directory, sync: {available, reason?}, entries: [registry entry + previewUrl]}` |
| `GET /api/downloads` | | `{directory, files: [{name, path, bytes, mtimeMs, kind: "fbx" or "zip", inLibrary: id or null}]}`, top level only, newest first; a zip is in the library when every FBX in it is |
| `POST /api/import` | `{paths, tags?}` | `{results: [{source, status, id?, kind?, reason?, previewError?}]}` |
| `POST /api/upload?name=<file>&tags=a,b` | the raw file bytes | `{results}`, as above |
| `GET /api/events` | | server-sent `import-progress` events: one result plus `done` and `total` |
| `POST /api/tags` | `{ids, add?, remove?}` | `{entries}` |
| `POST /api/title` | `{id, title}` | `{entries}`; the id does not change |
| `POST /api/note` | `{id, note}` | `{entries}` |
| `POST /api/remove` | `{ids}` | `{removed}` |
| `GET /api/sync` | | `{available, reason?, branch, ahead, behind, changed}` |
| `POST /api/sync` | | `{committed, pulled, pushed, message?, error?, conflicts?}` |
| `GET /previews/<clips or characters>/<id>.gif` | | the GIF as `image/gif`, or 404 when it is missing or an LFS pointer |

### Sync

**Sync** is a button, never automatic, and it runs only when the owner presses it.

1. It stages the library's `mixamo/` changes and commits them with a message that counts them, such as
   `Animation library: 2 imports, 3 edits, 1 removal`.
2. It runs `git pull --rebase`, then `git push` when there is anything to push.

When the rebase conflicts, Sync aborts it, keeps the local commit, leaves the working tree clean and reports the
conflicting paths; resolve them with git and press Sync again. Sync never force-pushes and does not configure Git LFS.
It is unavailable, with the reason shown, when the folder is not a git working tree, its branch has no upstream (or
HEAD is detached), or the checkout rule applies. `ahead` and `behind` are as of the last fetch or pull. Changes outside
`mixamo/` are not committed, and uncommitted ones can make the pull fail.

### Copy move set

**Copy move set** puts a Markdown block on the clipboard naming the selected clips, in grid order, for the owner to
paste to an agent. The page asks for the heading once per copy; it defaults to `Move set`.

```markdown
## <heading>
Mixamo clips from the agent-meshes animation library. Load each by id with `agent_meshes_mixamo.import_fbx('<id>')`, or get its path with `node <runtime>/scripts/mixamo-library.mjs path <id>`.
- <title> (`<id>`): <note>. <tags joined by ", ">. <seconds> s, <in place | root motion, travels X.X m>.
```

- The note part appears only when a note is set, and the tags part only when there are tags.
- `<seconds>` has one decimal: the motion summary's length, else the longest take's. Without a motion summary the
  travel is left out; without any length the whole part is left out.
- `<runtime>` is the runtime root that `mesh-setup` reports.

For example: ``- Sword Idle (`sword-idle`): Two-handed guard. idle, in-place. 8.3 s, in place.``

The copied text is also kept on `window.__lastCopied`, for browser tests.

## Use it from a Blender source

```python
from agent_meshes_mixamo import clip_path, entry, import_fbx

run = import_fbx('rifle-run')          # {'objects': [...], 'armature': <object>, 'actions': [<action>]}
path = clip_path('rifle-idle')         # for your own importer
facts = entry('rifle-run')             # the registry entry: kind, title, tags, note, motion, preview, skeleton ...
```

Add `scripts/blender_lib` to `sys.path` first. `import_fbx` runs Blender's FBX importer on the registered file and
returns what it made, unchanged: the armature keeps the importer's scale (0.01) and rotation, and bones keep the file's
names (`mixamorig:Hips`). Files downloaded for one character share one rest pose, so an action from one file plays on
the armature from another.

- **Bone prefixes.** A download made with another Mixamo character names the same skeleton `mixamorig1:` (or
  `mixamorig2:` ...), and an action keyed on `mixamorig1:Hips` does not drive an armature whose bone is
  `mixamorig:Hips`. Compare `entry(id)['skeleton']` across the clips of a move set; rename the bones of one armature to
  the other's prefix before assigning actions (Blender renames the action paths with them).
- **Two takes.** A `clip-with-skin` download holds the character's one-frame rest take as well as the motion. Pick the
  motion from `actions` by its length (the entry's `clips` lists both takes); the importer may leave the rest take
  active.
- **In place or root motion.** `entry(id)['motion']` says which, and how far the hips travel. Treat every clip of a set
  the same way: keep the travel, or remove it on purpose.

`registry`, `entry` and `clip_path` check the folder against the registry the same way the commands do and return the
same fields. When the folder has changed, they run `node scripts/mixamo-library.mjs refresh`, so Node must be on
`PATH`. `mixamo_dir` and `registry_file` are pure Python. None of them needs Blender.

What a build makes from a clip (a GLB of your own character with the motion baked in, or sprite frames) is your work
and may ship. The FBX stays in the folder. A build that reads the folder depends on files outside the project: it
cannot be reproduced on a machine that lacks them, and an [input audit](../../../skills/mesh-build/references/native-build-identity.md)
reports the read as undeclared.

For motion with a clear licence that can ship, use the bundled [rig library](rig-library.md) and
[mannequins](mannequin-library.md).
