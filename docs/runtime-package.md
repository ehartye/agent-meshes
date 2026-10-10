# The slim runtime package

A game that builds meshes from model data imports `src/runtime.ts`, which reaches 18 files and needs only
`three` and `zod`. Installing `agent-meshes` itself from git would also install every dependency of the CLI,
the preview server and the renderer (express, playwright, vite, rapier, commander, gltf-validator), because npm
installs a git dependency's whole `dependencies` list and cannot install a subdirectory of a repository.

So the runtime is also available as its own package, `agent-meshes-runtime`, generated from this repository:

```
node scripts/build-runtime-package.mjs --out <dir>     write the package (src/ closure, package.json, LICENSE, README)
node scripts/build-runtime-package.mjs --check <dir>   exit 1 unless <dir> equals what would be generated
node scripts/build-runtime-package.mjs --publish       commit it onto the local `runtime` branch (never pushes)
```

Every file is byte-identical to its source; only `package.json` and `README.md` are written. The package declares
`three` as a peer (a scene crosses the boundary as `Object3D` instances, so the host's copy must be the only copy)
and `zod` as a dependency. `tests/runtime-package.test.ts` fails if the closure ever reaches a third package.

## The `runtime` branch

`runtime` is an append-only branch whose tree is the generated package. A game pins a commit of it:

```
"agent-meshes-runtime": "github:ehartye/agent-meshes#<commit on runtime>"
```

Refresh it after a change under `src/` that the runtime reaches (run on a clean checkout of `main`, then push):

```
node scripts/build-runtime-package.mjs --publish
git push origin runtime
```

Never force-push `runtime`: games pin its commits. Nothing is published to an npm registry. The CLI, the dev
server and the managed plugin install (`scripts/managed-runtime.js`) still use the root `package.json` and are
unchanged.
