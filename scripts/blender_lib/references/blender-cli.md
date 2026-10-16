# Blender command-line reference

The CLI starts and controls the Blender process. The [Python API reference](blender-api.md)
describes work performed inside that process. Meshes' JSON CLI and Python helpers are
separate interfaces; a Meshes operation name is not a `bpy` operator or Blender flag.

## Choose the entry point

| Task | Entry point |
| --- | --- |
| Reproducible authored model with verification and preview | `mesh build build.json`, with `blender.script` defining `build()` |
| Fast clay/wire/posed source inspection | `mesh preview`, following mesh-build's preview contract |
| Trusted standalone script needing exporter/variant control | Verified Blender executable with `--python` |
| Interactive edits to an existing scene | Blender UI; record/save the source before export |

Run mesh-setup's read-only check first. Resolve the executable from its `blender`
field or an intentional `AGENT_MESHES_BLENDER` override; record `blenderSource`.
Do not guess a PATH executable, install into plugin cache or silently switch versions.
The managed build wrapper owns export, validation and output replacement; a direct
script owns those responsibilities itself.

## A background Python job

Pass executable and arguments separately. In PowerShell:

```powershell
& $taskBlender --background --factory-startup --python-exit-code 1 --python $taskSource -- --output $taskOutput
```

Here the three variables are verified absolute paths supplied by the caller.
`--factory-startup` starts from defaults; omit it when intentionally loading an
existing `.blend`. To inspect a saved scene, put its path before the Python script:

```powershell
& $taskBlender --background $taskBlend --python-exit-code 1 --python $taskSource -- --output $taskOutput
```

Within Python, parse only arguments after Blender's separator:

```python
import argparse, sys
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
arguments = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
```

CLI arguments execute in order. Put scene/configuration flags before the operation
that consumes them; arguments after `--` belong to the script. Set a nonzero
`--python-exit-code` before `--python`: a Python exception otherwise need not make
the Blender process fail. Keep stdout/stderr and the exact executable/argv.

| Option | Purpose |
| --- | --- |
| `--background` / `-b` | Run without the interactive editor |
| `--factory-startup` | Use factory defaults for a new reproducible scene |
| `--python PATH` | Execute a trusted Python source inside Blender |
| `--python-exit-code 1` | Nonzero process status for a script exception |
| `--threads N` / `-t N` | Bound supported render/worker thread use; not a GPU selector |
| `--render-frame N` / `-f N` | Render a specified scene frame after configuring output |
| `--version`, `--help` | Inspect the selected executable's version/options |
| `--` | End Blender option parsing; subsequent values are script arguments |

Check the installed binary's help before adding unfamiliar options. Avoid long
`--python-expr` snippets: an owned script is easier to quote, review and reproduce.
Neither background mode nor a subprocess provides a filesystem sandbox.

## Windows Store launchers and completion

A Store `blender-launcher.exe` can return before the real Blender process ends;
its exit zero and empty stdout do not establish completion. On the Saloon host,
5.2.2 LTS background Python execution wrote its native completion record, while
the launcher's `--help` returned no output. Invoking `bpy.app.binary_path` directly
under WindowsApps was denied. Do not change permissions or assume that the reported
binary path is an executable entry point for the caller.

The existing managed author/preview wrappers use their own completion records and
record the actual Blender PID. Follow that contract. A custom direct job should
write a unique final JSON completion marker only after saving and checking its
outputs, recording Blender version, PID, input identity, output hashes and errors.
Observe that exact process/output; an old file or launcher exit cannot replace it.
On timeout or failed observation, inspect effects before repeating an export.

## Verify the delivered result

Record input/source and exported GLB hashes separately. Validate the final GLB and
inspect it in the destination viewer: native modifier output, shader nodes,
constraints and runtime skinning are not interchangeable. Inspect named sockets,
clips, deformed contact and rendered motion at actual playback speed. A native
completion marker proves the declared job completed, not visual quality.

Implementation owners: `src/author.ts`, `scripts/blender-author.py`, `src/preview.ts`
and `src/refine.ts`. The source build was inspected with Blender 5.2.2 LTS; flags
and behavior outside that version/platform require their own checks.

Official references: [command-line arguments](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
and [argument ordering](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html#argument-order).
Those links are navigation, not a claim that every latest-version option is supported locally.
