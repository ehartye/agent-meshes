import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCreature, creatureKinds, creatureInfo } from '../src/recipes/index.ts';
import { buildAsset } from '../src/build.ts';
import { decorateBuild } from '../src/capture.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const gallery = resolve(repository, 'artifacts/creatures');
await mkdir(gallery, { recursive: true });
// Rebuild the legacy fox URL alongside the five canonical presets.
for (const kind of [...creatureKinds, 'quadruped']) {
  const source = resolve(repository, 'artifacts/creature-sources', kind);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'source.mesh.json'), `${JSON.stringify(createCreature(kind), null, 2)}\n`);
  const config = join(source, 'build.json');
  await writeFile(config, `${JSON.stringify({ version: 1, project: 'source.mesh.json', output: `../../creatures/${kind}` }, null, 2)}\n`);
  const built = await buildAsset(config, { decorate: decorateBuild });
  console.log(`${creatureInfo[kind === 'quadruped' ? 'vulpine' : kind].name}: ${built.files.length} files → ${built.output}`);
}

const cards = creatureKinds.map(kind => {
  const info = creatureInfo[kind];
  return `<article style="--creature:${info.color}">
    <a class="portrait" href="${kind}/preview.html" aria-label="Watch ${info.name}"><img src="${kind}/perspective.png" alt="${info.name}, an articulated ${info.label.toLowerCase()} with ${info.legs} legs"><span class="watch">Watch ${info.gait} <span aria-hidden="true">↗</span></span></a>
    <div class="caption"><div><p class="body-plan">${info.label} <span>· ${info.legs} legs</span></p><h2><a href="${kind}/preview.html">${info.name}</a></h2><p>${info.description}</p></div><span class="gait">${kind === 'equine' || kind === 'vulpine' ? 'walk · trot' : info.gait}</span></div>
    <div class="links" aria-label="${info.name} files"><a href="${kind}/front.png">Front</a><a href="${kind}/side.png">Side</a>${createCreature(kind).clips.map(clip => `<a href="${kind}/${clip.name}-contact.png">${clip.name[0].toUpperCase() + clip.name.slice(1)} sheet</a>`).join('')}<a href="${kind}/model.glb" download>Download model</a><a href="${kind}/project.mesh.json" download>Editable project</a></div>
  </article>`;
}).join('\n');
await writeFile(join(gallery, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Creature studies — Agent Meshes</title>
<style>
:root{--paper:#e9f0f4;--ink:#213844;--muted:#58727f;--line:#bdced7;--blue:#35677c;--white:#f8fbfc}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 'Segoe UI',sans-serif}a{color:inherit}a:focus-visible{outline:3px solid var(--blue);outline-offset:5px}main{max-width:1320px;margin:auto;padding:38px 5vw 46px}.brand{font-size:11px;letter-spacing:.15em;text-transform:uppercase;display:flex;align-items:center;gap:10px}.brand i{width:18px;height:18px;display:inline-block;border:2px solid var(--blue);transform:rotate(30deg)}header{display:grid;grid-template-columns:1fr 330px;gap:36px;align-items:end;margin:48px 0 36px}h1{font-family:Georgia,serif;font-size:clamp(48px,6.8vw,84px);font-weight:400;letter-spacing:-.045em;line-height:1.03;margin:0}h1 em{color:var(--blue);font-weight:400}header p{margin:0 0 5px;color:var(--muted);max-width:340px}.collection{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px 28px}.portrait{display:block;position:relative;background:#dce7eb;overflow:hidden;border-radius:4px}.portrait img{width:100%;aspect-ratio:1.36;object-fit:contain;display:block}.watch{position:absolute;right:18px;bottom:18px;padding:8px 14px;background:var(--white);border-radius:24px;font-size:12px;box-shadow:0 2px 12px #21384412}.watch span{margin-left:12px}.portrait:hover .watch{background:var(--ink);color:var(--white)}.caption{display:flex;justify-content:space-between;gap:15px;padding-top:18px}.body-plan{font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px!important;color:var(--creature)!important;font-weight:700}.body-plan span{color:var(--muted);font-weight:400}h2{font:normal 30px/1.15 Georgia,serif;letter-spacing:-.025em;margin:0 0 9px}h2 a{text-decoration:none}.caption p{margin:0;font-size:13px;color:var(--muted)}.gait{height:fit-content;margin-top:4px;color:var(--muted);font-size:12px;text-transform:capitalize;border-bottom:2px solid var(--creature);padding-bottom:3px}.links{display:flex;flex-wrap:wrap;gap:9px 20px;border-top:1px solid var(--line);margin-top:18px;padding-top:12px;font-size:11px}.links a{text-decoration-color:#96acb7;text-underline-offset:3px}.links a:hover{text-decoration-color:var(--ink)}footer{display:flex;justify-content:space-between;gap:18px;margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}footer p{margin:0}@media(max-width:760px){main{padding:26px 20px}header{grid-template-columns:1fr;gap:20px;margin:34px 0 28px}header p{max-width:420px}.collection{grid-template-columns:1fr;gap:38px}.portrait img{aspect-ratio:1.3}footer{display:block}footer p+p{margin-top:6px}}@media(prefers-reduced-motion:no-preference){.watch{transition:background .15s,color .15s}}
</style></head><body><main><div class="brand"><i aria-hidden="true"></i> Agent Meshes <span aria-hidden="true">/</span> Creature studies</div><header><h1>Five studies<br>in <em>motion.</em></h1><p>Meet five articulated creatures. Horses and foxes each have walk and trot clips. Watch their gaits, orbit each model, or take one into your next scene.</p></header><section class="collection" aria-label="Animated creatures">${cards}</section><footer><p>Two, four, six, eight legs. A different rhythm for each.</p><p>Previews work offline. Drag to orbit; scroll to zoom.</p></footer></main></body></html>`);
console.log(`Gallery → ${join(gallery, 'index.html')}`);
