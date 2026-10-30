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
Every command prints one JSON line. On failure it exits nonzero and prints
`{"ok":false,"error":{...}}` on stderr with a `code` and, for batches, the failing
`operationIndex`.

## Optional pieces

- Rendering (`build` with previews, `view`) needs the Chromium that setup installs. `build
  --no-preview` produces the GLB and validation report without a browser, and deletes the previews an
  earlier build left in the output folder (the warning `BUILD_PREVIEWS_REMOVED` names them; see
  [mesh-build](../../mesh-build/SKILL.md)).
- The Blender refine stage needs Blender on PATH, in a usual install folder, in the Microsoft
  Store app alias, or at `AGENT_MESHES_BLENDER`. Setup reports the path it found as `blender`. It must be a 5.2.x
  copy: any other version stops with `BLENDER_UNSUPPORTED_VERSION`, and `setup --check` reports
  `blenderSupported: false` with the message in `blenderError`. A Windows Store launcher counts as unsupported because
  its version cannot be read, so set `AGENT_MESHES_BLENDER` to a portable 5.2.x copy.
- `serve` starts the loopback workbench on port 3388 for a human to look at; skills do not need
  it. Do not stop a server you did not start.
