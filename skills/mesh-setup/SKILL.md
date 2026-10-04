---
name: mesh-setup
description: Install, check and repair the managed agent-meshes runtime outside the plugin cache, including the built workbench, Chromium for renders and the optional Blender stage (found automatically, including portable copies).
when_to_use: Use before the first agent-meshes command in a session, after a plugin update, or when a mesh skill reports "Managed CLI ... is missing", "rerun mesh-setup", a missing dist-web, a missing Chromium, or a version mismatch.
---

# Agent Meshes setup

The plugin cache is a bare git checkout: no dependencies, no built workbench, no browser. Setup
copies the runtime into `~/.agent-meshes/releases/<version-hash-platform>`, installs lockfile
dependencies, builds the workbench, installs Chromium for renders, links the CLI, and records a
receipt. Every other mesh skill runs through a launcher that refuses anything but that release.
Node.js 24 or newer with npm must already be installed; the CLI runs TypeScript directly.

## Steps

Resolve `<plugin-root>` from this loaded file: two directories above its `mesh-setup` directory.
Confirm `scripts/setup.js` exists there. Use the absolute path; never infer it from PATH or the
current project.

1. Run the read-only check: `node "<plugin-root>/scripts/setup.js" --check --json`.
2. If it reports `ok: false`, run the install: `node "<plugin-root>/scripts/setup.js" --json`.
   It takes a few minutes the first time (dependencies, workbench build, a Chromium download).
   Stop on failure and show the error; never install dependencies in the plugin cache and never
   substitute a checkout or a PATH executable.
3. Run the check again and require exit 0 and `ok: true`. Report `cliVersion`, `runtimeRoot`,
   `node`, `blender` (a path, or `null` when Blender is absent) and `blenderSource` (which rule found it).

**`--check` exiting 1 on a first run is expected.** It exits 1 whenever `ok` is false, and "not yet installed" is the
usual reason (`errors` says `Managed CLI ... is missing`, and `nextStep` repeats the instruction). Treat it as "run the
install", not as a failure, and read the JSON on stdout rather than the exit code alone; a script that shells out to
`setup --check` must not throw on exit 1 (use `spawnSync`).

## Blender (optional)

Only the refine stage, Blender-authored sources, `mesh preview` and the `recipes/` that drive Blender need it. Discovery
order, first hit wins, and `--check` reports it as `blenderSource`:

1. The `AGENT_MESHES_BLENDER` environment variable (source `AGENT_MESHES_BLENDER`): always first, trusted without checking.
2. A portable copy under `~/.agent-meshes/blender/*/` (or `$AGENT_MESHES_HOME/blender/*/`), newest version first
   (`agent-meshes-home`).
3. A portable copy under `~/tools/blender/*/` (`tools-blender`): `blender.exe` on Windows, `blender` on Linux,
   `Blender.app/Contents/MacOS/Blender` on macOS.
4. The system install: Windows `C:/Program Files/Blender Foundation/*` (`program-files`) or the Store launcher
   (`windows-store`), macOS `/Applications/Blender.app` (`applications`).
5. `blender` on PATH (`path`).

When Blender is absent `--check --json` carries `blenderHint`; read it to the person. To install a portable copy:
1. Download the zip from the official mirror, whose layout is
   `https://mirrors.ocf.berkeley.edu/blender/release/Blender<major.minor>/blender-<ver>-windows-x64.zip`
   (for example `Blender5.2/blender-5.2.2-windows-x64.zip`; Linux `-linux-x64.tar.xz`, macOS `-macos-arm64.dmg`).
   `download.blender.org` sits behind a bot challenge that returns 403 to curl and winget, and `winget install` also
   returned 403 on the machine this was written against; the mirror serves the same files.
2. Unzip it into `~/tools/blender`, so the executable is `~/tools/blender/blender-<ver>-windows-x64/blender.exe`.
3. Optionally set `AGENT_MESHES_BLENDER` to that path (it overrides discovery), then rerun `setup --check`.

A repeated setup reuses a complete matching release and repairs its npm link. A changed plugin
version or content produces a new release directory; older releases are kept. `AGENT_MESHES_HOME`
overrides the managed home for both setup and launch and must stay outside the plugin and any
checkout. If the report carries `pathHint`, the bare `agent-meshes` command needs that directory
on PATH; skills never depend on it.

## Invocation used by every mesh skill

```text
node "<plugin-root>/scripts/run-managed.js" <command> ...
```

The launcher validates the receipt and content hash of the matching release, then runs its CLI
with the original arguments in the current working directory. A missing or modified release fails
with instructions to rerun this skill. Read [CLI setup](../mesh-authoring/references/cli-setup.md)
for checked PowerShell and POSIX invocation patterns.
