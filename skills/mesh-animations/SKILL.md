---
name: mesh-animations
description: Import, preview, tag and find Adobe Mixamo animations in the owner's animation library through the agent-meshes animations page, then load a move set the owner picked there by clip id. The library is a folder of the owner's own, often a private repository, and never an agent-meshes checkout. Each clip gets a looping GIF on a mannequin, a motion summary (in place or root motion) and editable tags. Rigging a model or keyframing clips of its own is mesh-rigging.
when_to_use: Use when the owner has Mixamo FBX or zip downloads to import, wants to browse, find, preview, tag, retitle or remove animations in the library, wants to choose a move set or a set of clips for a character, pastes a "move set" block of clip ids, or asks to sync the animation library between machines.
---

# Mixamo animation library

The animations page is a local web page that Meshes serves on `127.0.0.1`. The owner imports their Mixamo downloads
there, sees each clip as a looping GIF, tags and titles them, and copies a **move set**: a Markdown block naming the
clips an agent should use. Read the [Mixamo library reference](../../scripts/blender_lib/references/mixamo-library.md)
for the layout, the sidecar and registry fields, the import rules, the HTTP API and the exact move-set format.

Load `mesh-setup` first. Commands run through the managed launcher: `node "<plugin-root>/scripts/run-managed.js" ...`.

## Open the page for the owner

1. Run `node "<plugin-root>/scripts/run-managed.js" animations serve --open` as a background command. When it starts
   a server it keeps running until it is stopped; when one is already running it exits at once.
   - It prints one JSON line, `{"service":"animations","url":"http://127.0.0.1:3390/"}`. Read the URL from it.
   - There is one server per machine. A live server for the same library is reused: the command prints its URL and
     starts nothing. Run the command again instead of looking for the process.
   - The library is `AGENT_MESHES_MIXAMO_DIR` (or `--library <dir>`). The Import tab lists the owner's Downloads folder
     (or `--downloads <dir>`). When another program holds port 3390, `--port 0` picks a free port.
   - When it fails because a server for another library holds the port, tell the owner. Do not stop that server
     without asking.
2. Tell the owner the URL and what the page does:
   - **Import:** tick files in the Downloads list, or pick or drop files from anywhere, then **Import selected**. Each
     file shows imported, duplicate or rejected with a reason.
   - **Library:** filter by text and tag, select with click, shift-click or ctrl-click, add or remove tags, edit a
     title or note, **Remove**, **Copy move set** and **Sync**.
3. Wait while the owner imports, tags and copies. Do not import, tag or sync for them meanwhile. They come back with a
   pasted move set or a request.

**Never put Mixamo files in an agent-meshes checkout.** The files are licensed to the owner's Adobe account and must not
be redistributed. Import, tag edits and Sync refuse a library folder inside an agent-meshes checkout, with a message
naming the rule. When you see that refusal, ask the owner to point `AGENT_MESHES_MIXAMO_DIR` at a folder outside it.
Never copy an FBX, its GIF or its sidecar into the plugin, a test fixture or a commit there.

## Use a pasted move set

The page copies a move set in this form:

```markdown
## Ronin
Mixamo clips from the agent-meshes animation library. Load each by id with `agent_meshes_mixamo.import_fbx('<id>')`, or get its path with `node <runtime>/scripts/mixamo-library.mjs path <id>`.
- Sword Idle (`sword-idle`): Two-handed guard. idle, in-place. 8.3 s, in place.
- Run Forward (`run-forward`): locomotion, root-motion. 0.7 s, root motion, travels 2.6 m.
```

1. The id in backticks is the handle, and it never changes. The title and note say what the owner wants the clip for.
2. Load each id in a Blender source, with the runtime's `scripts/blender_lib` on `sys.path`:

   ```python
   from agent_meshes_mixamo import entry, import_fbx
   run = import_fbx('sword-idle')   # {'objects': [...], 'armature': <object>, 'actions': [<action>]}
   facts = entry('sword-idle')      # kind, title, tags, note, motion, skeleton, clips
   ```

   Outside Blender, `node <runtime>/scripts/mixamo-library.mjs path <id>` prints the file's path after checking its
   bytes. `<runtime>` is the `runtimeRoot` that `mesh-setup` reports.
   When `entry(id)` has a `sidecarError`, its sidecar cannot be read and its tags and note are defaults: tell the
   owner, who fixes or restores that file.
3. Note for each clip whether it is **in place** or **root motion** (the bullet says which, and how far it travels). An
   in-place clip loops on the spot, for a controller that moves the character itself. A root-motion clip carries its
   travel in the hips. Keep that travel, or remove it on purpose, and treat every clip of the set the same way.
4. Check the bone prefix before you combine clips. A clip downloaded with another Mixamo character names the same
   skeleton `mixamorig1:` instead of `mixamorig:`, so its action does not drive the other armature until the bones are
   renamed. `entry(id)['skeleton']` gives each clip's prefix; the
   [reference](../../scripts/blender_lib/references/mixamo-library.md#use-it-from-a-blender-source) has the details.
5. Record the move set (ids and titles) in the project's build inputs, so another machine knows which clips the build
   needs. What you build from the clips may ship; the FBX files stay in the library.

## Import without the page

When the owner asks for a headless import, run
`node "<plugin-root>/scripts/run-managed.js" animations import <file.fbx | pack.zip | folder> ... [--tags a,b]`
(`--library <dir>` names another library). It runs the page's import pipeline, renders the previews and prints
`{"results":[...]}`: each file is `imported` with its id, `duplicate` with the id it already has, or `rejected` with the
reason. A duplicate whose sidecar or preview was missing is repaired and lists what in `repaired`; a `previewError`
means the clip was imported without a GIF. `--tags` are added to the suggested ones.

## Sync

Sync is the owner's button on the Library tab: it commits the library's `mixamo/` changes, pulls with rebase and
pushes. Do not commit, pull or push the library yourself unless the owner asks you to. When Sync reports a conflict, it
has undone the rebase and kept the local commit; pass the conflicting paths it names on to the owner.

For rigging, binding and keyframing a model's own clips, use [mesh-rigging](../mesh-rigging/SKILL.md).
