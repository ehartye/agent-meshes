# Assemble, mobile physics and the editing server

Three commands outside the build loop. Entry: [mesh-build](../SKILL.md).

## assemble: LDraw parts to a verified GLB

```text
mesh assemble hardware/robot.json artifacts/robot
```

Builds a version-1 manifest of named, catalog-backed parts into `model.glb`, `robot.json`, `verification.json` and
`ATTRIBUTION.md` in the directory, with no server and no network. `libraryPath` in the manifest points at a local LDraw
library (`LDConfig.ldr`, `parts/`, `p/`) holding every referenced dependency. The README section "Physical assemblies"
lists the manifest fields, the `adapter` and `profile` options and the connector rules.

## mobile-physics: offline hanging-mobile physics

```text
mesh mobile-physics lib/mobile-physics.js
```

Writes one script that defines `window.MobilePhysics` with `createHangingMobile(spec)` and `validateMobileSpec(spec)`
(a Rapier engine and its WASM, no renderer, no network). The success line is one JSON line with `output` and `bytes`.
Load it only in a page that needs physics; `mesh viewer` and the workbench do not include it. The README section
"Optional hanging-mobile physics" has the spec and the snapshot loop.

## serve: the editing server behind a proxy

`mesh serve --port 3388 --project model.mesh.json` starts the loopback authoring server and prints one JSON line with
its `url`; `--port` defaults to 3388 and `--project` opens a saved project. Behind a trusted reverse proxy,
`--public-origin <origin>` permits that one browser origin (an HTTP or HTTPS origin with no path, credentials, query or
fragment); every other origin is still refused and the server still binds to loopback. Anyone who can reach the proxy
shares the one active project, so let the proxy control network access.
