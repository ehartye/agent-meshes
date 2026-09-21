import { Quaternion, Vector3 } from 'three';

type Triple = readonly [number,number,number];
export interface SolidBounds { min: Triple; max: Triple }
export interface SolidOptions { bounds: SolidBounds; resolutions: readonly number[] }
/** Cylinder along its local Z axis. Radii are local X/Y, rotation is a unit quaternion. */
export interface EllipticalCutter { center: Triple; radii: readonly [number,number]; halfLength: number; rotation?: readonly [number,number,number,number] }
export interface CarveRequest { cutter: EllipticalCutter | null; resolution: number; cutBlend?: number; removed?: boolean }
export interface SolidMesh { positions: Float32Array; normals: Float32Array; indices: Uint32Array }
export interface SolidResult { mesh: SolidMesh; removed: SolidMesh | null; stats: { resolution: number; cached: boolean; samples: number; gridMs: number; totalMs: number } }
export interface Solid { carve(request: CarveRequest): SolidResult; dispose(): void }
type Grid = { lo: number[]; n: number[]; step: number; base: Float32Array };
const offsets = Array.from({length:8},(_,i)=>[i&1,(i>>1)&1,(i>>2)&1]);
const tetrahedra = [[0,1,3,7],[0,3,2,7],[0,2,6,7],[0,6,4,7],[0,4,5,7],[0,5,1,7]];
const finite = (value: number, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>1e6) throw new Error(`${label} must be finite and within one million scene units`);
  return value;
};
const triple = (value: Triple, label: string) => {
  if (!Array.isArray(value) || value.length!==3) throw new Error(`${label} needs three coordinates`);
  return value.map(v=>finite(v,label));
};

/** Validate/clone the finite grid plan before any allocation or field sampling. */
export function solidOptions(options: SolidOptions): SolidOptions {
  const min=triple(options.bounds.min,'Bounds minimum'),max=triple(options.bounds.max,'Bounds maximum');
  if(max.some((v,i)=>v<=min[i]))throw new Error('Bounds must have positive extent on every axis');
  if(!Array.isArray(options.resolutions)||options.resolutions.length<1||options.resolutions.length>3)throw new Error('Provide one to three grid resolutions');
  const resolutions=[...new Set(options.resolutions)],extent=Math.max(...max.map((v,i)=>v-min[i]));let total=0;
  for(const resolution of resolutions){
    if(!Number.isInteger(resolution)||resolution<16||resolution>192)throw new Error('Resolution must be an integer from 16 to 192');
    const step=extent/resolution,samples=max.reduce((v,p,i)=>v*(Math.ceil((p-min[i])/step)+1),1);
    if(samples>4_000_000)throw new Error('Grid exceeds four million samples');total+=samples;
  }
  if(total>6_000_000)throw new Error('Cached grids exceed six million samples');
  return{bounds:{min:min as [number,number,number],max:max as [number,number,number]},resolutions};
}

/** Clone and validate a request. A null cutter means the unchanged sampled body. */
export function carveRequest(request: CarveRequest, resolutions: readonly number[]): CarveRequest {
  if(!resolutions.includes(request.resolution))throw new Error('Resolution was not included in the immutable grid plan');
  const cutBlend=finite(request.cutBlend??0,'Cut blend');if(cutBlend<0)throw new Error('Cut blend must be nonnegative');
  if(request.removed!==undefined&&typeof request.removed!=='boolean')throw new Error('Removed must be boolean');
  if(request.cutter===null)return{...request,cutter:null,cutBlend};
  const c=request.cutter,center=triple(c.center,'Cutter center') as [number,number,number];
  if(!Array.isArray(c.radii)||c.radii.length!==2||c.radii.some(r=>finite(r,'Radius')<=0))throw new Error('Cutter radii must be positive');
  if(finite(c.halfLength,'Half length')<=0)throw new Error('Half length must be positive');
  const rotation=c.rotation??[0,0,0,1];
  if(!Array.isArray(rotation)||rotation.length!==4||rotation.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...rotation)-1)>1e-5)throw new Error('Cutter rotation must be a finite unit quaternion');
  return{resolution:request.resolution,cutBlend,removed:request.removed,cutter:{center,radii:[c.radii[0],c.radii[1]],halfLength:c.halfLength,rotation:[rotation[0],rotation[1],rotation[2],rotation[3]]}};
}

function cutterField(c: EllipticalCutter): (x:number,y:number,z:number)=>number {
  const inverse=new Quaternion(...c.rotation??[0,0,0,1]).conjugate(),p=new Vector3();
  return(x,y,z)=>{
    p.set(x-c.center[0],y-c.center[1],z-c.center[2]).applyQuaternion(inverse);
    const radial=(Math.hypot(p.x/c.radii[0],p.y/c.radii[1])-1)*Math.min(...c.radii),cap=Math.abs(p.z)-c.halfLength;
    return Math.min(Math.max(radial,cap),0)+Math.hypot(Math.max(radial,0),Math.max(cap,0));
  };
}

/** Cache a static scalar field and explicitly extract new carved surfaces. Does not change shell meshing. */
export function createSolid(field: (point: Triple)=>number, input: SolidOptions): Solid {
  const options=solidOptions(input),cache=new Map<number,Grid>();let disposed=false;
  function grid(resolution:number){
    const previous=cache.get(resolution);if(previous)return{value:previous,cached:true};
    const lo=[...options.bounds.min],step=Math.max(...options.bounds.max.map((v,i)=>v-lo[i]))/resolution;
    const n=options.bounds.max.map((v,i)=>Math.ceil((v-lo[i])/step)),base=new Float32Array(n.reduce((v,p)=>v*(p+1),1));let i=0;
    for(let x=0;x<=n[0];x++)for(let y=0;y<=n[1];y++)for(let z=0;z<=n[2];z++){
      const value=field([lo[0]+x*step,lo[1]+y*step,lo[2]+z*step]);
      if(!Number.isFinite(value)||Math.abs(value)>1e30)throw new Error('Body field must return finite supported values');
      if((x===0||y===0||z===0||x===n[0]||y===n[1]||z===n[2])&&value<=0)throw new Error('Body touches the grid boundary; enlarge bounds to enclose the whole solid');
      base[i++]=value;
    }
    const value={lo,step,n,base};cache.set(resolution,value);return{value,cached:false};
  }
  return{
    carve(input){
      if(disposed)throw new Error('Solid is disposed');
      const request=carveRequest(input,options.resolutions),started=performance.now(),{value:g,cached}=grid(request.resolution),gridMs=performance.now()-started;
      const values=new Float32Array(g.base.length),removed=request.removed?new Float32Array(g.base.length):null,cut=request.cutter?cutterField(request.cutter):null,k=request.cutBlend!;let i=0;
      for(let x=0;x<=g.n[0];x++)for(let y=0;y<=g.n[1];y++)for(let z=0;z<=g.n[2];z++){
        const b=g.base[i],d=cut?-cut(g.lo[0]+x*g.step,g.lo[1]+y*g.step,g.lo[2]+z*g.step):-Infinity,h=k>0?Math.max(k-Math.abs(b-d),0)/k:0;
        const carved=Math.max(b,d)+h*h*k*.25;values[i]=carved;
        // The complement includes material removed by the rounded rim as well as the cutter core.
        if(removed)removed[i]=Math.max(b,-carved);i++;
      }
      const mesh=extract(g,values),piece=removed?extract(g,removed):null;
      return{mesh,removed:piece,stats:{resolution:request.resolution,cached,samples:g.base.length,gridMs,totalMs:performance.now()-started}};
    },
    dispose(){disposed=true;cache.clear();},
  };
}

/** Consistent six-tetrahedron cells share edge vertices, avoiding ambiguous surface-net pinches. */
function extract(g:Grid,values:Float32Array):SolidMesh {
  const{n:[nx,ny,nz],lo,step}=g,sample=(x:number,y:number,z:number)=>(x*(ny+1)+y)*(nz+1)+z;
  let positions:number[]=[],indices:number[]=[];
  const edgeVertices=new Map<number,number>(),ids=new Int32Array(8),xyz=Array.from({length:8},()=>[0,0,0]);
  for(let x=0;x<nx;x++)for(let y=0;y<ny;y++)for(let z=0;z<nz;z++){
    let mask=0;for(let i=0;i<8;i++){const o=offsets[i];ids[i]=sample(x+o[0],y+o[1],z+o[2]);xyz[i]=[lo[0]+(x+o[0])*step,lo[1]+(y+o[1])*step,lo[2]+(z+o[2])*step];if(values[ids[i]]<0)mask|=1<<i}if(mask===0||mask===255)continue;
    const edge=(a:number,b:number)=>{
      // Zero crossings exactly on a grid point must share that point across all incident edges.
      const key=values[ids[a]]===0?-ids[a]-1:values[ids[b]]===0?-ids[b]-1:Math.min(ids[a],ids[b])*values.length+Math.max(ids[a],ids[b]),existing=edgeVertices.get(key);if(existing!==undefined)return existing;
      if(positions.length>=3_000_000)throw new Error('Extracted surface exceeds one million vertices');
      const t=values[ids[a]]/(values[ids[a]]-values[ids[b]]),index=positions.length/3;positions.push(...xyz[a].map((v,i)=>v+t*(xyz[b][i]-v)));edgeVertices.set(key,index);return index;
    };
    const emit=(...vertices:number[])=>{for(let i=0;i<vertices.length;i+=3){const a=vertices[i],b=vertices[i+1],c=vertices[i+2];if(a===b||b===c||c===a)continue;if(indices.length>=6_000_000)throw new Error('Extracted surface exceeds two million triangles');indices.push(a,b,c)}};
    for(const tet of tetrahedra){
      const inside=tet.filter(i=>values[ids[i]]<0),outside=tet.filter(i=>values[ids[i]]>=0);if(!inside.length||!outside.length)continue;
      const start=indices.length,direction=[0,1,2].map(j=>outside.reduce((s,i)=>s+xyz[i][j],0)/outside.length-inside.reduce((s,i)=>s+xyz[i][j],0)/inside.length);
      if(inside.length===1)emit(...outside.map(b=>edge(inside[0],b)));
      else if(outside.length===1)emit(...inside.map(a=>edge(a,outside[0])));
      else{const a=edge(inside[0],outside[0]),b=edge(inside[0],outside[1]),c=edge(inside[1],outside[0]),d=edge(inside[1],outside[1]);emit(a,b,d,a,d,c)}
      // Orient using the local linear tetrahedral field, not smoothed shading normals.
      for(let i=start;i<indices.length;i+=3){const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3,ab=[0,1,2].map(j=>positions[b+j]-positions[a+j]),ac=[0,1,2].map(j=>positions[c+j]-positions[a+j]),n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];if(n.reduce((s,v,j)=>s+v*direction[j],0)<0)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]]}
    }
  }
  ({positions,indices}=quantizeSurface(positions,indices));
  const interpolated=(x:number,y:number,z:number)=>{
    const q=[x,y,z].map((p,i)=>(p-lo[i])/step),a=q.map((v,i)=>Math.max(0,Math.min(g.n[i]-1,Math.floor(v)))),t=q.map((v,i)=>Math.max(0,Math.min(1,v-a[i])));let value=0;
    for(const o of offsets)value+=values[sample(a[0]+o[0],a[1]+o[1],a[2]+o[2])]*(o[0]?t[0]:1-t[0])*(o[1]?t[1]:1-t[1])*(o[2]?t[2]:1-t[2]);return value;
  };
  const normals=new Float32Array(positions.length),e=step*.65;
  for(let i=0;i<positions.length;i+=3){const x=positions[i],y=positions[i+1],z=positions[i+2],dx=interpolated(x+e,y,z)-interpolated(x-e,y,z),dy=interpolated(x,y+e,z)-interpolated(x,y-e,z),dz=interpolated(x,y,z+e)-interpolated(x,y,z-e),length=Math.hypot(dx,dy,dz);if(!Number.isFinite(length)||length<1e-20)throw new Error('Degenerate field gradient; revise the field or grid resolution');normals.set([dx/length,dy/length,dz/length],i)}
  return{positions:new Float32Array(positions),indices:new Uint32Array(indices),normals};
}

/** Quantization is part of meshing: crossings can coincide only after Float32 conversion. */
function quantizeSurface(source:number[],triangles:number[]):{positions:number[];indices:number[]} {
  const welded:number[]=[],weldMap=new Map<string,number>(),remap=new Uint32Array(source.length/3),faces:number[]=[];
  for(let i=0;i<source.length;i+=3){
    const x=Math.fround(source[i]),y=Math.fround(source[i+1]),z=Math.fround(source[i+2]),key=`${x},${y},${z}`;let index=weldMap.get(key);
    if(index===undefined){index=welded.length/3;weldMap.set(key,index);welded.push(x,y,z)}remap[i/3]=index;
  }
  for(let i=0;i<triangles.length;i+=3){
    const a=remap[triangles[i]],b=remap[triangles[i+1]],c=remap[triangles[i+2]];if(a===b||b===c||c===a)continue;
    const ab=[0,1,2].map(j=>welded[b*3+j]-welded[a*3+j]),ac=[0,1,2].map(j=>welded[c*3+j]-welded[a*3+j]);
    if(Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])===0)continue;
    faces.push(a,b,c);
  }
  // Compact vertices stranded by collapsed triangles, then verify the result rather than
  // assuming that dropping degenerate faces preserves a closed surface.
  const positions:number[]=[],indices:number[]=[],compact=new Map<number,number>();
  for(const old of faces){let index=compact.get(old);if(index===undefined){index=positions.length/3;compact.set(old,index);positions.push(welded[old*3],welded[old*3+1],welded[old*3+2])}indices.push(index)}
  const count=positions.length/3,edges=new Map<number,number>();
  for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
    const a=indices[i+j],b=indices[i+(j+1)%3],key=Math.min(a,b)*count+Math.max(a,b),direction=a<b?1:-1,previous=edges.get(key);
    if(previous===undefined)edges.set(key,direction);
    else if(previous===-direction)edges.set(key,0);
    else throw new Error('Surface topology is unsafe at Float32 precision; change bounds or resolution');
  }
  if([...edges.values()].some(value=>value!==0))throw new Error('Surface topology is unsafe at Float32 precision; change bounds or resolution');
  return{positions,indices};
}
