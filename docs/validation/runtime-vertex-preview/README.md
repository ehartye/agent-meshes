# Runtime identity and vertex-color preview checks

This records a source candidate based on Meshes 0.25.0 at `e46dcc7`, not an installed marketplace release. It adds narrow bytecode filtering and explicit Workbench `--shading vertex`. Existing matcap defaults and vertex-color export policy are unchanged.

## Runtime inventory

The shared inventory excludes real `__pycache__` directories and `.pyc`/`.pyo` files when hashing, copying and verifying a runtime. Encountered symlinks still reject before filtering. Excluded real cache directories are not traversed. Source `.py`, typing `.pyi`, `.pyc.json` and ordinary resources remain inputs.

Two regression cases first failed on fingerprint drift and copied bytecode. They then passed with the inventory fix, including negative controls for actual source/resource edits and installed source tampering.

An isolated normal setup used a separate managed home and npm prefix. Python 3.12 compiled `blender-preview.py` in both the checkout and temporary managed runtime, producing real `.pyc` files. Source and runtime fingerprints stayed unchanged; the checked launcher rendered source and GLB previews, and the installation remained ready. [Managed receipt](managed-proof.json) retains the candidate fingerprint, selected Blender, preview manifests and check results. Absolute scratch paths are historical execution locations, not portable artifact links.

## Vertex RGB

```text
mesh preview source.py --views body-front --shading color,vertex --sheet
mesh preview model.glb --views body-front --shading color,vertex --sheet
```

The source sheet has material color on the left and active vertex RGB on the right:

![Source material gray and active vertex green](source-colors.png)

The same modes after GLB export and reimport:

![Exported material gray and active vertex green](exported-colors.png)

Blender 5.2.2 native controls rendered POINT and CORNER/FLOAT_COLOR data, measured actual PNG center pixels, and checked that source material nodes and active/render layer selections were preserved. The source fixture deliberately selected green for painting and red for rendering: preview showed green without changing either selection. The fixture explicitly aligned render selection before export; the reimported GLB also rendered green. [Native receipt](native-proof.json) retains the measured pixels.

This is a lit RGB diagnostic. It does not visualize alpha masks, evaluate textures or shader graphs, prove engine appearance, or certify artistic quality. `color` retains material viewport shading; the default remains matcap, and `all` now includes vertex mode.

## Verification scope

The pre-change focused baseline passed 29 tests. Four new checks then failed for the expected missing behavior before implementation. All 33 focused tests now pass across managed-runtime, preview and vertex-color-preview-blender; an independent reviewer reproduced them without findings. Typecheck, production build and changed-document checks passed. Vite retains its existing large-chunk advisory. No full artistic recipe suite, runtime benchmark, new CI policy, or general modeling-guidance efficacy study was run.

Reproduce the automated checks with:

```text
node node_modules/vitest/vitest.mjs run tests/managed-runtime.test.ts tests/preview.test.ts tests/vertex-color-preview-blender.test.ts
```

Set `AGENT_MESHES_VERTEX_PREVIEW_PROOF` to an outside-checkout directory to retain the native test's images and report. Otherwise successful native scratch output is removed. Blender-specific checks skip when no supported direct Blender executable is available; such a skip is not native acceptance.
