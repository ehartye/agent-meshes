---
name: mesh-setup
description: Install, check and repair the managed agent-meshes runtime outside the plugin cache, including the built workbench, Chromium for renders and the optional Blender stage.
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
   `node`, and `blender` (a path, or `null` when Blender is absent; only the refine stage needs it).

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
