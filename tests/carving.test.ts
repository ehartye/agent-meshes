import { expect, it } from 'vitest';
import { createSolid, type SolidMesh } from '../src/render/carving.ts';

const bounds = { min: [-1.25,-1.25,-1.25] as [number,number,number], max: [1.25,1.25,1.25] as [number,number,number] };
const sphere = ([x,y,z]: readonly number[]) => Math.hypot(x,y,z)-1;
function inspect(mesh: SolidMesh) {
  const edges=new Map<string,{count:number,direction:number}>(), adjacency=Array.from({length:mesh.positions.length/3},()=>new Set<number>());
  let volume=0;
  for(let i=0;i<mesh.indices.length;i+=3){const ids=Array.from(mesh.indices.slice(i,i+3)),p=ids.map(id=>Array.from(mesh.positions.slice(id*3,id*3+3)));
    volume+=(p[0][0]*(p[1][1]*p[2][2]-p[1][2]*p[2][1])+p[0][1]*(p[1][2]*p[2][0]-p[1][0]*p[2][2])+p[0][2]*(p[1][0]*p[2][1]-p[1][1]*p[2][0]))/6;
    for(let j=0;j<3;j++){const a=ids[j],b=ids[(j+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(','),edge=edges.get(key)??{count:0,direction:0};edge.count++;edge.direction+=a<b?1:-1;edges.set(key,edge);adjacency[a].add(b);adjacency[b].add(a)}
  }
  const seen=new Set<number>();let components=0;for(let i=0;i<adjacency.length;i++)if(!seen.has(i)){components++;const todo=[i];seen.add(i);while(todo.length)for(const j of adjacency[todo.pop()!]!)if(!seen.has(j)){seen.add(j);todo.push(j)}}
  expect([...edges.values()].every(e=>e.count===2&&e.direction===0)).toBe(true);
  for(let i=0;i<mesh.normals.length;i+=3)expect(Math.hypot(...mesh.normals.slice(i,i+3))).toBeCloseTo(1,5);
  expect([...mesh.positions].every(Number.isFinite)).toBe(true);
  return{volume,components,euler:adjacency.length-edges.size+mesh.indices.length/3};
}

it('carves a real through-hole with consistently oriented closed faces and an actual removed volume',()=>{
  const solid=createSolid(sphere,{bounds,resolutions:[40,64]});
  const original=solid.carve({cutter:null,resolution:64}),before=inspect(original.mesh);
  const result=solid.carve({cutter:{center:[0,0,0],radii:[.38,.24],halfLength:1.3,rotation:[0,0,Math.sin(.25),Math.cos(.25)]},resolution:64,cutBlend:.04,removed:true});
  const after=inspect(result.mesh),removed=inspect(result.removed!);
  expect(before.components).toBe(1);expect(before.euler).toBe(2);expect(before.volume).toBeCloseTo(4*Math.PI/3,1);
  expect(after.components).toBe(1);expect(after.euler).toBe(0);expect(after.volume).toBeLessThan(before.volume-.25);
  expect(removed.volume).toBeGreaterThan(.25);expect(Math.abs(after.volume+removed.volume-before.volume)).toBeLessThan(.035);
  expect(result.stats.cached).toBe(true);solid.dispose();
});

it('caches immutable body samples, returns fresh arrays and restores the original solid',()=>{
  let calls=0;const solid=createSolid(p=>{calls++;return sphere(p)},{bounds,resolutions:[32,48]});
  const first=solid.carve({cutter:null,resolution:32}),sampleCount=calls;
  const far=solid.carve({cutter:{center:[10,0,0],radii:[.1,.2],halfLength:1},resolution:32,removed:true});
  expect(calls).toBe(sampleCount);expect(far.mesh.positions).toEqual(first.mesh.positions);expect(far.removed!.indices.length).toBe(0);
  far.mesh.positions[0]=999;expect(solid.carve({cutter:null,resolution:32}).mesh.positions).toEqual(first.mesh.positions);
  expect(solid.carve({cutter:null,resolution:48}).stats.cached).toBe(false);expect(calls).toBeGreaterThan(sampleCount);
  solid.dispose();expect(()=>solid.carve({cutter:null,resolution:32})).toThrow(/disposed/i);
});

it('shares exact-zero grid vertices and emits no collapsed triangles at aligned surfaces',()=>{
  const solid=createSolid(sphere,{bounds:{min:[-1.5,-1.5,-1.5],max:[1.5,1.5,1.5]},resolutions:[48]});
  const {mesh}=solid.carve({cutter:null,resolution:48});
  for(let i=0;i<mesh.indices.length;i+=3){const p=[0,1,2].map(j=>Array.from(mesh.positions.slice(mesh.indices[i+j]*3,mesh.indices[i+j]*3+3))),a=p[1].map((v,j)=>v-p[0][j]),b=p[2].map((v,j)=>v-p[0][j]);expect(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])).toBeGreaterThan(1e-12)}
  expect(inspect(mesh).euler).toBe(2);
});

it('points cavity normals into the opening and preserves outward body normals',()=>{
  const solid=createSolid(sphere,{bounds,resolutions:[48]}),original=solid.carve({cutter:null,resolution:48});
  for(let i=0;i<original.mesh.positions.length;i+=3){const p=original.mesh.positions.slice(i,i+3),n=original.mesh.normals.slice(i,i+3);expect(p.reduce((s,v,j)=>s+v*n[j],0)/Math.hypot(...p)).toBeGreaterThan(.98)}
  const {mesh}=solid.carve({cutter:{center:[0,0,0],radii:[.38,.24],halfLength:1.3},resolution:48,cutBlend:.03});let wall=0;
  for(let i=0;i<mesh.positions.length;i+=3){const[x,y,z]=mesh.positions.slice(i,i+3);if(Math.abs(z)<.5&&Math.hypot(x,y)<.5){wall++;expect(x*mesh.normals[i]+y*mesh.normals[i+1]).toBeLessThan(-.15)}}
  expect(wall).toBeGreaterThan(100);
});

it('welds crossings that become coincident at Float32 precision into closed nondegenerate surfaces',()=>{
  for(const center of[1,10,900000]){
    const solid=createSolid(p=>Math.hypot(...p.map(v=>v-center))-1.00000001,{bounds:{min:[center-1.5,center-1.5,center-1.5],max:[center+1.5,center+1.5,center+1.5]},resolutions:[48]});
    const mesh=solid.carve({cutter:null,resolution:48}).mesh;
    const coordinates=new Set<string>();for(let i=0;i<mesh.positions.length;i+=3)coordinates.add(Array.from(mesh.positions.slice(i,i+3)).join(','));
    expect(coordinates.size).toBe(mesh.positions.length/3);
    for(let i=0;i<mesh.indices.length;i+=3){const p=[0,1,2].map(j=>Array.from(mesh.positions.slice(mesh.indices[i+j]*3,mesh.indices[i+j]*3+3))),a=p[1].map((v,j)=>v-p[0][j]),b=p[2].map((v,j)=>v-p[0][j]);expect(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])).toBeGreaterThan(0)}
    expect(inspect(mesh).components).toBe(1);
  }
});

it('rejects precision-open surfaces and keeps other cached resolutions usable',()=>{
  const center=100000,solid=createSolid(p=>Math.hypot(...p.map(v=>v-center))-1.00000001,{bounds:{min:[center-1.5,center-1.5,center-1.5],max:[center+1.5,center+1.5,center+1.5]},resolutions:[32,40]});
  expect(()=>solid.carve({cutter:null,resolution:40})).toThrow(/topology.*precision/i);
  expect(inspect(solid.carve({cutter:null,resolution:32}).mesh).components).toBe(1);
});

it('rejects invalid bounds, sample budgets, fields and cutter values before corrupting the cache',()=>{
  expect(()=>createSolid(sphere,{bounds:{min:[0,0,0],max:[0,1,1]},resolutions:[32]})).toThrow();
  expect(()=>createSolid(sphere,{bounds,resolutions:[256]})).toThrow();
  expect(()=>createSolid(()=>NaN,{bounds,resolutions:[16]}).carve({cutter:null,resolution:16})).toThrow(/finite/i);
  expect(()=>createSolid(()=>-1,{bounds,resolutions:[16]}).carve({cutter:null,resolution:16})).toThrow(/boundary/i);
  const solid=createSolid(sphere,{bounds,resolutions:[32]});
  for(const cutter of[{center:[0,0,0],radii:[0,.2],halfLength:1},{center:[NaN,0,0],radii:[.1,.2],halfLength:1},{center:[0,0,0],radii:[.1,.2],halfLength:1,rotation:[0,0,0,0]}])expect(()=>solid.carve({cutter:cutter as any,resolution:32})).toThrow();
  expect(()=>solid.carve({cutter:null,resolution:31})).toThrow();expect(()=>solid.carve({cutter:null,resolution:32,cutBlend:-1})).toThrow();
  expect(inspect(solid.carve({cutter:null,resolution:32}).mesh).components).toBe(1);
});
