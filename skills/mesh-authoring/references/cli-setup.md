# Managed CLI setup and invocation

Every mesh skill uses the managed CLI installed by [mesh setup](../../mesh-setup/SKILL.md).
Run setup on first use and after a plugin update. Never use a bare PATH `agent-meshes`, a
checkout's `scripts/agent-meshes.mjs`, or the plugin-cache CLI for skill work: the cache has no
dependencies, no built workbench and no browser, so those commands fail or render nothing.

Resolve the plugin root from the loaded skill's actual path, two directories above its skill
directory. Invoke that plugin's `scripts/run-managed.js` by absolute path. Claude Code also
supplies the root as `CLAUDE_PLUGIN_ROOT` when the skill runs from a plugin; in PowerShell use
`$env:CLAUDE_PLUGIN_ROOT` only when it actually exists.

Run from the project directory so relative workspace, batch and output paths resolve there. This
PowerShell helper stops a workflow when a native command fails:

```powershell
$meshPluginRoot = 'C:\actual\installed\plugin\root'
$meshLauncher = Join-Path $meshPluginRoot 'scripts/run-managed.js'
function Invoke-Mesh {
    node $meshLauncher @args
    if ($LASTEXITCODE -ne 0) { throw 'agent-meshes command failed' }
}
Invoke-Mesh --workspace .agent-meshes/fox recipe vulpine --gaits walk,trot
Invoke-Mesh --workspace .agent-meshes/fox batch .\edits.json --dry-run
Invoke-Mesh --workspace .agent-meshes/fox export .\fox.glb
Invoke-Mesh build .\build.json
```

For POSIX shells, use `set -e` before sequences, then
`node "/actual/plugin/root/scripts/run-managed.js" <command> ...`.

Global options go before the command: `--workspace <dir>` and `--expect-revision <n>`.
Inline JSON for `op` is awkward to quote in PowerShell; prefer `batch <file>` with a JSON file.
Most commands print one JSON line. `silhouette`, `verify-unreal` and `check-garments` print indented JSON unless
given `--json`, and `clip-report` prints text unless given `--json`. On failure a command exits nonzero and prints
`{"ok":false,"error":{...}}` on stderr with a `code` and, for batches, the failing `operationIndex`.

Codes an authoring agent meets:

- `REVISION_CONFLICT`: `--expect-revision <n>` no longer matches the workspace, because someone else changed it. The
  error carries `expected` and `actual`; `inspect` again, replan the edit, and retry with the new revision.
- `UNKNOWN_CAPABILITY`: `capabilities <name>` got a name that is neither an operation nor a geometry kind. The message
  lists the valid operations and geometries.
- `SHELL_VERTEX_COLORS`: see [operations](operations.md#shells) (`shell.set` with `vertexColors: false`).

## Optional pieces

- Rendering (`build` with previews, `view`) needs the Chromium that setup installs. `build
  --no-preview` produces the GLB and validation report without a browser, and deletes the previews an
  earlier build left in the output folder (the warning `BUILD_PREVIEWS_REMOVED` names them; see
  [mesh-build](../../mesh-build/SKILL.md)).
- The Blender refine stage needs Blender at `AGENT_MESHES_BLENDER`, in a portable folder (`~/.agent-meshes/blender` or
  `~/tools/blender`), in a usual install folder, or on PATH. Setup reports the path it found as `blender`. It must be a
  5.2.x copy: any other version stops with `BLENDER_UNSUPPORTED_VERSION`, and `setup --check` reports
  `blenderSupported: false` with the message in `blenderError`. A Windows Store launcher is always unsupported because
  its version cannot be read, so it never counts as a place Blender is found; use a portable 5.2.x copy. The search
  order is in [mesh-setup](../../mesh-setup/SKILL.md).
- Rendering from an offline or system Chromium: set `AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH` (see mesh-setup).
- `serve` starts the loopback workbench on port 3388 for a human to look at; skills do not need
  it. Do not stop a server you did not start.
