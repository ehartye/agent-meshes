// Capture review evidence. The output deliberately contains no automatic art pass.
// Usage: node scripts/review-model.mjs path/to/review.json
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {resolve,dirname,join,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {viewerScript} from '../src/preview-html.ts';

const configPath=resolve(process.argv[2]??'review.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const base=dirname(configPath),model=resolve(base,config.model),output=resolve(base,config.output);
const slug=value=>{if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(value))throw Error('Use lowercase slug names for poses and regions');return value;};
const angles=config.angles??[0,45,90,135,180,225,270,315];
const regions=config.regions??[];
const poses=config.poses??[{name:'rest'}];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const ring=value=>{if(!Array.isArray(value)||!value.length||!value.every(finite)||new Set(value.map(a=>((a%360)+360)%360)).size!==value.length)throw Error('Angles must be a nonempty list of unique finite directions');};
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(finite);
ring(angles);
if(!Array.isArray(regions)||!Array.isArray(poses)||!poses.length)throw Error('Regions and poses must be arrays, with at least one pose');
for(const r of regions){slug(r.name);if(r.name==='body')throw Error('The body region name is reserved');if(!finite(r.radius)||r.radius<=0)throw Error('A region needs a positive radius');if(r.center&&!vector(r.center))throw Error('Invalid region center');if(r.offset&&!vector(r.offset))throw Error('Invalid region offset');}
for(const [i,p] of poses.entries()){slug(p.name);if(!p.clip&&i!==0)throw Error('The rest pose must come first');if(p.phase!==undefined&&(!finite(p.phase)||p.phase<0||p.phase>1))throw Error('Phase must be in [0,1]');if(p.regions!==undefined&&p.regions!==false&&(!Array.isArray(p.regions)||p.regions.some(n=>!regions.some(r=>r.name===n))))throw Error('Pose regions must name existing regions');for(const w of Object.values(p.morphs??{}))if(!finite(w)||w<0||w>1)throw Error('Morph weights must be in [0,1]');}
for(const item of [...regions,...poses]){if(item.angles)ring(item.angles);if(item.elevation!==undefined&&(!finite(item.elevation)||Math.abs(item.elevation)>=90))throw Error('Elevation must be between -90 and 90 degrees');}
if(new Set(poses.map(p=>p.name)).size!==poses.length||new Set(regions.map(r=>r.name)).size!==regions.length)throw Error('Pose and region names must be unique');
const existing=await readdir(output).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
if(existing.length)throw Error('Use a new empty review directory to preserve prior evidence');
await mkdir(output,{recursive:true});
const bytes=await readFile(model),hash=createHash('sha256').update(bytes).digest('hex');
const manifest={model,sha256:hash,created:new Date().toISOString(),config:configPath,referenceIntent:config.intent??null,references:[],captures:[],errors:[],reviewStatus:'unreviewed'};
for(const [i,ref] of (config.references??[]).entries()){
 const source=resolve(base,ref.path),file=`reference-${i}${extname(source)}`;
 await copyFile(source,join(output,file));manifest.references.push({label:ref.label??ref.path,file,source});
}
await writeFile(join(output,'viewer.js'),await viewerScript());
await writeFile(join(output,'viewer.html'),`<!doctype html><meta charset="utf-8"><style>body{margin:0}#stage{width:720px;height:720px}</style><div id="stage"></div><script src="viewer.js"></script><script>window.ready=MeshViewer.mount(document.getElementById('stage'),{glb:${JSON.stringify(bytes.toString('base64'))},autoplay:false,orbit:false,floor:false,background:'#e1e6e8'}).then(v=>window.viewer=v)</script>`);
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:720,height:720},offline:true});
 page.on('pageerror',e=>manifest.errors.push(e.message));
 await page.goto(pathToFileURL(join(output,'viewer.html')).href);await page.evaluate(()=>window.ready);
 for(const pose of poses){
  await page.evaluate(p=>{viewer.resetMorph();viewer.resetPose();if(p.clip){if(!viewer.clips.includes(p.clip))throw Error('Unknown clip: '+p.clip);viewer.play(p.clip);viewer.pause();viewer.seek(Math.min(viewer.duration*(p.phase??0),Math.max(0,viewer.duration-1e-7)));}for(const [name,w]of Object.entries(p.morphs??{})){const groups=viewer.morphGroups.filter(g=>viewer.morphTargets(g).includes(name));if(!groups.length)throw Error('Unknown morph: '+name);for(const group of groups)viewer.setMorph(group,name,w);}viewer.sync();},pose);
  if(!pose.clip)await page.evaluate(()=>{viewer.pause();const root=viewer.root,skeletons=new Set();root.traverse(o=>{if(o.isSkinnedMesh)skeletons.add(o.skeleton);});for(const s of skeletons)s.pose();root.updateMatrixWorld(true);for(const s of skeletons)s.update();});
  const selected=pose.regions===false?[]:regions.filter(r=>!pose.regions||pose.regions.includes(r.name));
  for(const region of [{name:'body'},...selected]){
   const ring=region.angles??pose.angles??angles;
   for(const azimuth of ring){
    const elevation=region.elevation??pose.elevation??8;
    const result=await page.evaluate(({region,azimuth,elevation})=>{
     const bounds=viewer.bounds();let center=bounds.getCenter(viewer.camera.position.clone()),radius=bounds.getSize(viewer.camera.position.clone()).length()/2;
     if(region.center)center.fromArray(region.center);
     if(region.node){const node=viewer.root.getObjectByName(region.node);if(!node)throw Error('Unknown region node: '+region.node);node.getWorldPosition(center);}
     if(region.offset)center.add({x:region.offset[0],y:region.offset[1],z:region.offset[2]});
     radius=region.radius??radius;const distance=radius/Math.sin(viewer.camera.fov*Math.PI/360)*1.08;
     const yaw=azimuth*Math.PI/180,pitch=elevation*Math.PI/180;
     const position=[center.x+distance*Math.sin(yaw)*Math.cos(pitch),center.y+distance*Math.sin(pitch),center.z+distance*Math.cos(yaw)*Math.cos(pitch)];
     viewer.view({position,target:center.toArray()});
     return {image:viewer.screenshot(),camera:{position,target:center.toArray()},time:viewer.time,clip:viewer.clip};
    },{region,azimuth,elevation});
    const file=`${pose.name}--${region.name}--${azimuth}.png`;
    await writeFile(join(output,file),Buffer.from(result.image.split(',')[1],'base64'));
    manifest.captures.push({file,pose:pose.name,region:region.name,azimuth,elevation,camera:result.camera,clip:pose.clip?result.clip:null,time:pose.clip?result.time:0,requestedPhase:pose.phase??null,morphs:pose.morphs??{}});
   }
  }
 }
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const style='<style>body{margin:20px;background:#edf0f1;color:#25343c;font:14px sans-serif}section{display:grid;grid-template-columns:repeat(4,300px);gap:8px}figure{margin:0;background:white}img{width:100%;display:block}figcaption{padding:8px}h2{margin-top:32px}.ref img{width:auto;max-height:500px;max-width:1200px}</style>';
 const refs=manifest.references.map(r=>`<figure class="ref"><img src="${esc(r.file)}"><figcaption>${esc(r.label)}</figcaption></figure>`).join('');
 const groups=Object.groupBy(manifest.captures,c=>c.pose+' / '+c.region);
 let html=`<!doctype html><meta charset="utf-8">${style}<h1>${esc(config.name??'Model review')}</h1><p>${esc(config.intent??'Reference intent not supplied — fidelity remains unreviewed.')}</p><p>Evidence only. Inspect every relevant view before recording a decision. Model SHA-256: ${hash}</p>${refs}`;
 for(const [name,captures]of Object.entries(groups)){
  const grid=captures.map(c=>`<figure><a href="${c.file}"><img src="${c.file}"></a><figcaption>${esc(c.pose)} · ${esc(c.region)} · ${c.azimuth}° · ${c.time.toFixed(3)}s</figcaption></figure>`).join('');
  html+=`<h2>${esc(name)}</h2><section>${grid}</section>`;
  const file=slug(name.replace(' / ','-'))+'-sheet.html';await writeFile(join(output,file),`<!doctype html><meta charset="utf-8">${style}<h2>${esc(name)}</h2><section>${grid}</section>`);
  await page.goto(pathToFileURL(join(output,file)).href);await page.setViewportSize({width:1272,height:800});
  await page.screenshot({path:join(output,file.replace('.html','.png')),fullPage:true});
 }
 await writeFile(join(output,'index.html'),html);
 await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
 await writeFile(join(output,'findings.json'),JSON.stringify({status:'unreviewed',modelSha256:hash,findings:[],coverageGaps:[],note:'Captures are not inspection. Record observed evidence, reference expectation, severity and same-view recheck for every finding.'},null,2));
 if(manifest.errors.length)throw Error(manifest.errors.join('\n'));
 console.log(JSON.stringify({output,captures:manifest.captures.length,sha256:hash,status:'unreviewed'}));
}finally{await browser.close()}
