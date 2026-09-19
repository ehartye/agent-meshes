import { build } from 'vite';
import { fileURLToPath } from 'node:url';
let bundle: Promise<string> | undefined;
async function previewScript(): Promise<string> {
  if (!bundle) bundle = (async () => {
    const result = await build({ configFile: false, logLevel: 'error', build: { write: false, lib: { entry: fileURLToPath(new URL('./web/preview.ts', import.meta.url)), formats: ['iife'], name: 'MeshPreview' }, minify: true } });
    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) throw new Error('Preview bundle did not produce output');
    const chunk = output.output.find(item => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Preview bundle missing');
    return chunk.code;
  })();
  return bundle;
}
export async function previewHTML(name: string, glb: Uint8Array): Promise<string> {
  const data = JSON.stringify({ name, glb: Buffer.from(glb).toString('base64') }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Meshes preview</title><style>*{box-sizing:border-box}body{margin:0;background:#dce7eb;color:#213844;font:14px 'Segoe UI',sans-serif;overflow:hidden}canvas{display:block}header{position:absolute;top:25px;left:30px;pointer-events:none}header span{font-size:10px;letter-spacing:2px;color:#146b80}h1{font-size:28px;font-weight:500;margin:8px 0}footer{position:absolute;bottom:25px;left:30px;right:30px;display:flex;gap:12px;align-items:center;background:#f3f6f7e8;padding:15px;border-radius:8px;box-shadow:0 3px 20px #21384412}button,select{background:white;border:1px solid #bfd0d8;border-radius:4px;color:#213844;padding:8px;font:inherit}input{flex:1;min-width:50px;accent-color:#146b80}#status{position:absolute;top:30px;right:30px;font-size:11px;color:#50707e}@media(max-width:700px){#status{top:95px;left:30px}footer{left:10px;right:10px;gap:5px;padding:8px;font-size:11px}}</style><header><span>AGENT MESHES / EXPORTED MODEL</span><h1 id="title"></h1></header><div id="status">Loading…</div><div id="stage"></div><footer><button id="play">Pause</button><select id="clip" aria-label="Clip"></select><input id="scrub" aria-label="Time" type="range" min="0" max="1" step="0.001" value="0"><button id="download">Download GLB</button></footer><script id="asset" type="application/json">${data}</script><script>${(await previewScript()).replaceAll('</script', '<\\/script')}</script></html>`;
}
