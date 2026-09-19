# Agent Meshes

Named-part 3D authoring for coding agents, with a live browser workbench. Requires Node.js 24 or later.

```powershell
npm ci
npm run build
npm start
```

Open the loopback URL printed by the server (normally http://127.0.0.1:3388). Add primitives, select named parts, edit their dimensions and positions, orbit or select a fixed camera view, and undo/redo edits. Open and Save project buttons load/download portable JSON. The live editing state is in memory; save your project before stopping the server. Use `serve --project path.json` to reopen saved work on startup.

In another terminal:

```powershell
node scripts/agent-meshes.mjs new robot
node scripts/agent-meshes.mjs op '{"op":"add","part":{"name":"body","geometry":{"type":"box","size":[1,2,1]},"position":[0,1,0]}}'
node scripts/agent-meshes.mjs save robot.mesh.json
node scripts/agent-meshes.mjs state
```

The CLI prints JSON and exits nonzero on failures. `batch operations.json` applies an array of operations atomically, with one undo step. `open`, `save`, `undo`, and `redo` share the browser's active project. `--url` chooses an already-running server; identity checks prevent edits against an unrelated service. Run `node scripts/agent-meshes.mjs --help` for commands. Names start with a letter and contain letters, numbers, underscores, hyphens or dots. Transforms use meters and Y-up coordinates; rotations are unit quaternions `[x,y,z,w]`.

Development: run the API with `npm start`, then `npm run dev` for Vite's live reload. `npm test`, `npm run typecheck`, and `npm run build` verify the code. `npx playwright install chromium` then `node scripts/check-browser.mjs` exercise the built workbench and write a screenshot under `artifacts/`.

Project design and the animated biped/quadruped/insectoid/arachnid acceptance bar are maintained in the owner's wiki under `wiki/authored/agent-meshes/`. Rigging, animation and export are subsequent implementation features.
