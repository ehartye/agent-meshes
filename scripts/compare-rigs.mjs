// Build an offline, synchronized rig review from {models:[{label,path,clips:{reviewName:assetClip}}]}.
// Usage: node scripts/compare-rigs.mjs comparison.json output.html
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { viewerScript } from '../src/preview-html.ts';
import { readGLB } from '../src/gltf-read.ts';

const [configPath, output] = process.argv.slice(2);
if (!configPath || !output) throw new Error('Usage: node scripts/compare-rigs.mjs comparison.json output.html');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!Array.isArray(config.models) || config.models.length < 2 || config.models.length > 4) throw new Error('Choose 2–4 models');
const names = Object.keys(config.models[0].clips);
if (!names.length) throw new Error('Name at least one comparison clip');
const models = await Promise.all(config.models.map(async model => {
  const bytes = await readFile(resolve(dirname(configPath), model.path));
  const gltf = readGLB(bytes).json;
  const clips = new Set((gltf.animations ?? []).map(a => a.name));
  for (const name of names) if (!clips.has(model.clips[name])) throw new Error(`${model.label}: missing clip ${model.clips[name] ?? name}`);
  return { label: model.label, clips: model.clips, glb: bytes.toString('base64') };
}));
const data = JSON.stringify({ models, names }).replaceAll('<', '\\u003c');
const runtime = (await viewerScript()).replaceAll('</script', '<\\/script');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rig comparison</title><style>
*{box-sizing:border-box}body{margin:0;background:#e7e9e6;color:#26332f;font:15px system-ui}header{padding:16px 24px}h1{font-size:22px;margin:0 0 5px}p{margin:4px 0;color:#53665e}#panels{display:flex;height:calc(100vh - 190px);min-height:360px}.panel{flex:1;min-width:0;border-right:1px solid #bdc8c2;position:relative}.label{position:absolute;top:12px;left:16px;z-index:2;background:#ffffffd9;padding:5px 9px}.viewport{position:absolute;inset:0}.bones{position:absolute;inset:0;pointer-events:none;width:100%;height:100%}footer{padding:12px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}button,select{font:inherit;padding:7px 10px}#phase{flex:1;min-width:150px}#error{color:#a12222;white-space:pre-wrap}@media(max-width:700px){header{padding:10px}#panels{height:65vh}footer{padding:8px;gap:6px}.label{font-size:11px;left:3px;top:4px}}
</style><header><h1>Rig and motion comparison</h1><p>Same clip phase in every viewport. Drag to orbit; scrub to inspect contact, swing and skin deformation.</p><div id="error"></div></header>
<main id="panels"></main><footer><button id="play">Play</button><select id="clip" aria-label="Clip"></select><select id="view" aria-label="View"><option>front</option><option>side</option><option>perspective</option><option>back</option></select><label><input id="bones" type="checkbox" checked>Skeleton</label><input id="phase" aria-label="Clip phase" type="range" min="0" max="1" step="0.001" value="0"><output id="time">0%</output></footer>
<script>${runtime}</script><script>
const config=${data};
const viewers=[], overlays=[];let running=false,last=0,phase=0;
const control=id=>document.getElementById(id);
window.ready=(async()=>{
 for(const model of config.models){
  const panel=document.createElement('section');panel.className='panel';
  const label=document.createElement('div');label.className='label';label.textContent=model.label;
  const viewport=document.createElement('div');viewport.className='viewport';
  const overlay=document.createElement('canvas');overlay.className='bones';
  panel.append(viewport,label,overlay);control('panels').append(panel);
  const v=await MeshViewer.mount(viewport,{glb:model.glb,autoplay:false,background:'#e7e9e6',view:'front',quality:'fast'});
  v.root.traverse(o=>{if(o.isMesh){for(const m of Array.isArray(o.material)?o.material:[o.material]){m.color.set('#b9ada0');m.metalness=0;m.roughness=.85;}}});
  viewers.push(v);overlays.push(overlay);
  v.onFrame(()=>drawBones(v,overlay));
 }
 for(const name of config.names){const o=document.createElement('option');o.textContent=name;control('clip').append(o);}
 window.review={viewers,setPhase,selectClip,setView};selectClip(config.names[0]);setView('front');
})();
window.ready.catch(e=>control('error').textContent=e.stack);
function setPhase(value){phase=value;for(const v of viewers){v.seek(Math.min(v.duration*value,Math.max(0,v.duration-1e-7)));v.sync();}control('phase').value=value;control('time').textContent=(value*100).toFixed(1)+'%';}
function selectClip(name){control('clip').value=name;viewers.forEach((v,i)=>{v.play(config.models[i].clips[name]);v.pause();});setPhase(0);}
function setView(name){control('view').value=name;for(const v of viewers){v.view(name,1.65);}}
function drawBones(v,canvas){
 const w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);if(!control('bones').checked)return;
 v.sync();v.camera.updateMatrixWorld();
 const project=o=>{const p=o.getWorldPosition(v.camera.position.clone()).project(v.camera);return [(p.x+1)*w/2,(1-p.y)*h/2];};
 v.root.traverse(o=>{if(!o.isBone||!o.parent?.isBone||/thumb|index|middle|ring|pinky|leaf/i.test(o.name))return;
  const a=project(o.parent),b=project(o);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineWidth=4;ctx.strokeStyle='#123b48aa';ctx.stroke();ctx.lineWidth=2;ctx.strokeStyle='#68f0e0';ctx.stroke();ctx.beginPath();ctx.arc(...b,3,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
 });
}
control('clip').onchange=e=>selectClip(e.target.value);control('view').onchange=e=>setView(e.target.value);
control('phase').oninput=e=>{running=false;control('play').textContent='Play';setPhase(+e.target.value);};
control('play').onclick=()=>{running=!running;control('play').textContent=running?'Pause':'Play';};
function tick(now){if(running&&viewers.length)setPhase((phase+Math.min((now-last)/1000,.1)/viewers[0].duration)%1);last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
</script></html>`;
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, html);
console.log(JSON.stringify({ output: resolve(output), models: models.map(m => m.label), clips: names }));
