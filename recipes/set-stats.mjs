#!/usr/bin/env node
// Per-GLB budget table for a set of static props: real triangles, world bounds with every node matrix applied, the
// pivot (is the lowest point on y = 0 and the base centred on the origin), materials, and budget flags.
// Generalised from the chess set's stats.mjs. Needs only Node; it reads the GLB itself.
//
//   node recipes/set-stats.mjs [options] a.glb b.glb ...
//     --max-tris N              triangle budget for every file
//     --budget <regex>=N        per-file budget; first regex matching the path wins, else --max-tris (repeatable)
//     --max-materials N         fail when a file declares more materials (default: no limit)
//     --require-named-materials fail on a material with no name
//     --pivot bottom-centre|bottom|none   bottom-centre (default): min y = 0 and base centre at x = z = 0; bottom: min y = 0 only
//     --expect-height H         fail when the world height differs from H metres
//     --tolerance M             pivot and height tolerance in metres (default 0.001)
//     --json                    machine-readable report on stdout
// Exit 1 when any flag fires, 2 on a usage error or unreadable file.
import { inspectGLB } from './lib/glb.mjs';

const usage = 'Usage: node set-stats.mjs [--max-tris N] [--budget <regex>=N ...] [--max-materials N] [--require-named-materials] [--pivot bottom-centre|bottom|none] [--expect-height H] [--tolerance M] [--json] <file.glb ...>';
const options = { budgets: [], pivot: 'bottom-centre', tolerance: 0.001, files: [] };
const args = process.argv.slice(2);
const value = name => { const v = args.shift(); if (v === undefined) throw new Error(`${name} needs a value`); return v; };
const number = (name, v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} needs a number, got "${v}"`); return n; };
try {
  while (args.length) {
    const arg = args.shift();
    if (arg === '--max-tris') options.maxTris = number(arg, value(arg));
    else if (arg === '--budget') { const v = value(arg), i = v.lastIndexOf('='); if (i < 1) throw new Error('--budget needs <regex>=N'); options.budgets.push([new RegExp(v.slice(0, i)), number(arg, v.slice(i + 1))]); }
    else if (arg === '--max-materials') options.maxMaterials = number(arg, value(arg));
    else if (arg === '--require-named-materials') options.requireNames = true;
    else if (arg === '--pivot') { options.pivot = value(arg); if (!['bottom-centre', 'bottom', 'none'].includes(options.pivot)) throw new Error('--pivot is bottom-centre, bottom or none'); }
    else if (arg === '--expect-height') options.height = number(arg, value(arg));
    else if (arg === '--tolerance') options.tolerance = number(arg, value(arg));
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (!options.files.length) throw new Error('no GLB files given');
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }

const rows = [];
for (const file of options.files) {
  let info;
  try { info = inspectGLB(file); } catch (error) { console.error(`${file}: ${error.message}`); process.exit(2); }
  const flags = [], budget = options.budgets.find(([re]) => re.test(file))?.[1] ?? options.maxTris;
  if (budget !== undefined && info.triangles > budget) flags.push(`triangles ${info.triangles} > budget ${budget}`);
  if (options.maxMaterials !== undefined && info.materials.length > options.maxMaterials) flags.push(`${info.materials.length} materials > ${options.maxMaterials}`);
  if (options.requireNames && info.materials.some(m => !m.name)) flags.push('unnamed material');
  if (options.pivot !== 'none' && Math.abs(info.min[1]) > options.tolerance) flags.push(`lowest point y = ${info.min[1].toFixed(4)}, expected 0`);
  if (options.pivot === 'bottom-centre' && info.base.centre.some(c => Math.abs(c) > options.tolerance)) flags.push(`base centre (${info.base.centre.map(c => c.toFixed(4))}) is not on the origin`);
  if (options.height !== undefined && Math.abs(info.size[1] - options.height) > options.tolerance) flags.push(`height ${info.size[1].toFixed(4)} != ${options.height}`);
  const unused = info.materials.filter(m => !m.used);
  if (unused.length) flags.push(`${unused.length} material(s) no primitive uses`);
  rows.push({ ...info, budget: budget ?? null, flags, ok: flags.length === 0 });
}

if (options.json) console.log(JSON.stringify(rows, null, 2));
else {
  const f = v => v.toFixed(3);
  for (const r of rows) {
    const mats = r.materials.map(m => m.name ?? '(unnamed)').join('+') || 'none';
    console.log(`${r.file}  tris=${r.triangles}${r.budget !== null ? `/${r.budget}` : ''}  size=[${r.size.map(f)}]  min=[${r.min.map(f)}]  max=[${r.max.map(f)}]  base=[${r.base.centre.map(c => c.toFixed(4))}]  mat=${mats}  nodes=${r.nodes.total} (${r.nodes.matrix} matrix)  ${r.ok ? 'OK' : 'FAIL'}`);
    for (const flag of r.flags) console.log(`  FLAG ${flag}`);
  }
}
process.exit(rows.some(r => !r.ok) ? 1 : 0);
