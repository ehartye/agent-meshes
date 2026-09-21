import { describe, expect, it } from 'vitest';
import { createPlanarFigure, validatePlanarContour } from '../src/render/planar-figure.ts';
import type { PlanarFigureSnapshot, PlanarPoint, PlanarTargets, PlanarTargetPatch } from '../src/render/planar-figure.ts';

const keys = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;
// Independent authored limits and lengths: changing the implementation must not
// silently move the visual acceptance domain or shorten limbs to hit a target.
const ranges = [[-128,-58,-165,-70],[58,128,-165,-70],[-110,-30,76,146],[30,110,76,146]];
const distance = (a: PlanarPoint, b: PlanarPoint) => Math.hypot(a[0]-b[0],a[1]-b[1]);
function checkSnapshot(s: PlanarFigureSnapshot) {
  expect(s.points.length).toBe(420);
  expect(s.area).toBeGreaterThan(15000);
  for (const key of keys) {
    const l = s.limbs[key], lengths = key.endsWith('Hand') ? [55,49] : [64,60];
    expect(distance(l.root,l.joint)).toBeCloseTo(lengths[0],10);
    expect(distance(l.joint,l.end)).toBeCloseTo(lengths[1],10);
    expect(l.lengths).toEqual(lengths);
  }
  for (let axis=0;axis<2;axis++) {
    expect(s.bounds.min[axis]).toBe(Math.min(...s.points.map(p=>p[axis])));
    expect(s.bounds.max[axis]).toBe(Math.max(...s.points.map(p=>p[axis])));
  }
  // Independent signed-area and proper-intersection checks on emitted points.
  const cross = (a:PlanarPoint,b:PlanarPoint,c:PlanarPoint) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  let area=0;
  for(let i=0;i<s.points.length;i++) {
    const a=s.points[i],b=s.points[(i+1)%s.points.length];
    area+=(a[0]*b[1]-a[1]*b[0])/2;
    expect(distance(a,b)).toBeGreaterThan(1e-7);
    for(let j=i+2;j<s.points.length;j++) {
      if(i===0&&j===s.points.length-1) continue;
      const c=s.points[j],d=s.points[(j+1)%s.points.length];
      if(cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8) throw new Error(`Crossing ${i}/${j}`);
    }
  }
  expect(s.area).toBeCloseTo(area,8);
}

describe('constrained planar dance figures',()=>{
  it('emits one simple contour, real bounds, and fixed-length connected limbs',()=>{
    checkSnapshot(createPlanarFigure().snapshot());
  });

  it('changes the contour and elbow when a hand moves, retaining untouched limbs',()=>{
    const f=createPlanarFigure(), before=f.snapshot();
    const next=f.setTargets({leftHand:[-128,-70]});
    expect(next.points).not.toEqual(before.points);
    expect(next.limbs.leftHand.joint).not.toEqual(before.limbs.leftHand.joint);
    expect(next.limbs.rightFoot).toEqual(before.limbs.rightFoot);
    checkSnapshot(next);
  });

  it('bounds enormous finite requests before solving and reports actual constrained endpoints',()=>{
    const f=createPlanarFigure();
    const s=f.setTargets({leftHand:[-Number.MAX_VALUE,-Number.MAX_VALUE],rightFoot:[Number.MAX_VALUE,Number.MAX_VALUE]});
    expect(s.targets.leftHand).toEqual([-128,-165]);
    expect(s.targets.rightFoot).toEqual([110,146]);
    expect(s.limbs.leftHand.constrained).toBe(true);
    expect(s.limbs.rightFoot.constrained).toBe(true);
    checkSnapshot(s);
    expect(distance(s.limbs.leftHand.root,s.limbs.leftHand.end)).toBeLessThanOrEqual(100.000001);
  });

  it('rejects malformed patches atomically, then remains usable',()=>{
    const f=createPlanarFigure(), good=f.setTargets({rightHand:[128,-70]});
    const invalid:unknown[]=[null,[],42,'pose',new Date(),new Map(),{unknown:[0,0]},{leftHand:null},{leftHand:[1]},{leftHand:[1,2,3]},
      {leftHand:[NaN,0]},{rightFoot:[0,Infinity]},{leftFoot:[0,'2']},{leftHand:undefined},{leftHand:new Float32Array([1,2])},
      {leftHand:[-128,-70],rightFoot:[Infinity,0]}];
    for(const patch of invalid) {
      expect(()=>f.setTargets(patch as PlanarTargetPatch)).toThrow();
      expect(f.snapshot()).toBe(good);
    }
    expect(f.setTargets({leftFoot:[-110,76]})).not.toBe(good);
  });

  it('rejects sparse targets without changing the current pose',()=>{
    const f=createPlanarFigure(), before=f.snapshot();
    const target=new Array<number>(2); target[0]=-100;
    expect(()=>f.setTargets({leftHand:target as unknown as PlanarPoint})).toThrow(/finite numbers/);
    expect(f.snapshot()).toBe(before);
  });

  it('owns immutable snapshots and creation targets, with independent controllers',()=>{
    const initial={leftHand:[-100,-130] as [number,number]};
    const f=createPlanarFigure(initial), first=f.snapshot(), other=createPlanarFigure();
    initial.leftHand[0]=NaN;
    expect(()=>{(first.points[0] as unknown as number[])[0]=99}).toThrow();
    expect(()=>{(first.limbs.leftHand.joint as unknown as number[])[0]=99}).toThrow();
    expect(()=>{(first.targets.leftHand as unknown as number[])[0]=99}).toThrow();
    expect(()=>{(first.bounds.min as unknown as number[])[0]=99}).toThrow();
    f.setTargets({leftHand:[-128,-70]});
    expect(other.snapshot().targets.leftHand).not.toEqual(f.snapshot().targets.leftHand);
    expect(f.reset()).toBe(first);
    expect(f.snapshot().targets.leftHand).toEqual([-100,-130]);
    expect(f.setTargets({})).toBe(first);
  });

  it('keeps a simple fixed-size contour across all256 joint range corners and continuous interior poses',()=>{
    const f=createPlanarFigure();
    for(let mask=0;mask<256;mask++) {
      const pose=Object.fromEntries(keys.map((k,j)=>{const r=ranges[j];return[k,[r[(mask>>(j*2))&1],r[2+((mask>>(j*2+1))&1)]]]})) as unknown as PlanarTargets;
      checkSnapshot(f.setTargets(pose));
    }
    let seed=91;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    for(let i=0;i<128;i++) {
      const pose=Object.fromEntries(keys.map((k,j)=>{const r=ranges[j];return[k,[r[0]+random()*(r[1]-r[0]),r[2]+random()*(r[3]-r[2])]]})) as unknown as PlanarTargets;
      checkSnapshot(f.setTargets(pose));
    }
  });

  it('has no branch flips or vertex correspondence jumps along a continuous gesture',()=>{
    const f=createPlanarFigure();let previous:PlanarFigureSnapshot|undefined;
    for(let i=0;i<=200;i++) {
      const t=i/200,s=f.setTargets({leftHand:[-128+70*t,-70-95*t],leftFoot:[-110+80*t,146-70*t]});
      if(previous) {
        expect(Math.max(...s.points.map((p,j)=>distance(p,previous!.points[j])))).toBeLessThan(3);
        expect(distance(s.limbs.leftHand.joint,previous.limbs.leftHand.joint)).toBeLessThan(3);
      }
      previous=s;
    }
  });
});

describe('bounded simple-contour validation',()=>{
  it('rejects sparse contours at the missing point with an explicit input error',()=>{
    const points=new Array<PlanarPoint>(4); points[0]=[0,0]; points[2]=[10,10]; points[3]=[0,10];
    expect(()=>validatePlanarContour(points)).toThrow(/Contour point 1 must be a two-number array/);
  });

  it('accepts either winding, implicit closure, and straight boundary subdivisions',()=>{
    const points:PlanarPoint[]=[[0,0],[5,0],[10,0],[10,10],[0,10]];
    expect(validatePlanarContour(points)).toEqual({area:100,bounds:{min:[0,0],max:[10,10]}});
    expect(validatePlanarContour([...points].reverse()).area).toBe(-100);
  });

  it('rejects crossing, touching, overlaps, collapsed edges and unbounded input',()=>{
    const bad:unknown[]=[null,[],[[0,0],[1,0]],[[0,0],[1,1],[0,1],[1,0]],
      [[0,0],[10,0],[10,10],[5,0],[0,10]], // nonadjacent touching
      [[0,0],[10,0],[5,0],[5,5],[0,5]], // adjacent backtracking
      [[0,0],[1e-10,0],[1,1],[0,1]], // collapsed edge
      [[0,0],[1,0],[1,1],[0,0]], // duplicate closing vertex
      [[0,0],[1,0],[2,0]], [[0,0],[NaN,1],[1,1]], [[0,0],[1,Infinity],[1,1]],
      [[0,0],[10001,0],[1,1]],Array.from({length:513},(_,i)=>[Math.cos(i),Math.sin(i)]),
      [[0,0,0],[1,0],[0,1]]];
    for(const points of bad) expect(()=>validatePlanarContour(points as PlanarPoint[])).toThrow();
  });
});
