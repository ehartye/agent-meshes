# agent-meshes-runtime

Generated from [agent-meshes](https://github.com/ehartye/agent-meshes) by `scripts/build-runtime-package.mjs`. Do not edit.

The browser-safe entry `src/runtime.ts` and the files it reaches, byte-identical to their sources. It needs only
`three` (peer) and `zod`. TypeScript source is shipped as is; import it with a bundler or runner that accepts
`.ts` specifiers:

```ts
import { buildScene, instantiate, seedParams, checkSockets } from 'agent-meshes-runtime/src/runtime.ts';
```
