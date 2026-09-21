import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createSweep } from '../src/render/sweep.ts';
import type { SweepSpec } from '../src/render/sweep.ts';

const straight = (): SweepSpec => ({ centers: [[0,0,0],[0,0,1],[0,0,2]], radii: [[.2,.1],[.2,.1],[.2,.1]], radialSegments: 16, initialNormal: [1,0,0] });
describe('runtime sculptural sweeps', () => {
  it('closes the surface with outward triangles and flat caps, keeping a smooth UV seam', () => {
    const sweep = createSweep(straight()), { geometry } = sweep;
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
    const vertices = new Map<string, number>(), edges = new Map<string, number>();
    const weld = (index: number) => { const key = [positions.getX(index),positions.getY(index),positions.getZ(index)].join(','); if (!vertices.has(key)) vertices.set(key,vertices.size); return vertices.get(key)!; };
    const a = new Vector3(), b = new Vector3(), c = new Vector3(); let volume = 0;
    for (let i=0;i<geometry.index!.count;i+=3) {
      const ids = [0,1,2].map(k=>geometry.index!.getX(i+k));
      a.fromBufferAttribute(positions,ids[0]); b.fromBufferAttribute(positions,ids[1]); c.fromBufferAttribute(positions,ids[2]);
      volume += a.dot(b.cross(c))/6;
      for (let k=0;k<3;k++) { const ids2 = [weld(ids[k]),weld(ids[(k+1)%3])].sort((x,y)=>x-y), key=ids2.join(','); edges.set(key,(edges.get(key)??0)+1); }
    }
    expect(volume).toBeGreaterThan(0); expect([...edges.values()].every(count=>count===2)).toBe(true);
    expect(vertices.size-edges.size+geometry.index!.count/3).toBe(2);
    for (let i=0;i<normals.count;i++) expect(a.fromBufferAttribute(normals,i).length()).toBeCloseTo(1,5);
    for (let i=0;i<3;i++) {
      expect(a.fromBufferAttribute(normals,i*17).toArray()).toEqual(b.fromBufferAttribute(normals,i*17+16).toArray());
      expect(uv.getX(i*17)).toBe(0); expect(uv.getX(i*17+16)).toBe(1);
    }
    expect(a.fromBufferAttribute(normals,51).distanceTo(new Vector3(0,0,-1))).toBeCloseTo(0,8);
    expect(a.fromBufferAttribute(normals,68).distanceTo(new Vector3(0,0,1))).toBeCloseTo(0,8);
    sweep.dispose();
  });

  it('preserves elliptical radii and twist in a stable transported frame', () => {
    const spec = straight(); spec.twist = [0,Math.PI/2,Math.PI/2];
    const sweep=createSweep(spec), p=sweep.geometry.getAttribute('position');
    expect(p.getX(0)).toBeCloseTo(.2); expect(p.getY(4)).toBeCloseTo(.1);
    expect(p.getX(17)).toBeCloseTo(0); expect(p.getY(17)).toBeCloseTo(.2);
    const centers = Array.from({length:40},(_,i)=>[Math.sin(i*.07),0,Math.cos(i*.07)] as [number,number,number]);
    const curve=createSweep({ centers, radii:centers.map(()=>.05), radialSegments:12, initialNormal:[0,1,0] });
    const points=curve.geometry.getAttribute('position'), previous=new Vector3(), current=new Vector3();
    for(let i=0;i<centers.length;i++) { current.fromBufferAttribute(points,i*13).sub(new Vector3(...centers[i])).normalize(); if(i) expect(current.dot(previous)).toBeGreaterThan(.99); previous.copy(current); }
    curve.dispose(); sweep.dispose();
  });

  it('updates fixed buffers in place and refreshes bounds from the actual changed vertices', () => {
    const sweep=createSweep(straight()), geometry=sweep.geometry, position=geometry.getAttribute('position'), normal=geometry.getAttribute('normal'), uv=geometry.getAttribute('uv'), index=geometry.index;
    sweep.update({centers:[[0,0,0],[.5,0,1],[1,0,3]],radii:[.2,.3,.4]});
    expect(geometry.getAttribute('position')).toBe(position); expect(geometry.getAttribute('normal')).toBe(normal); expect(geometry.getAttribute('uv')).toBe(uv); expect(geometry.index).toBe(index);
    const points=Array.from({length:position.count},(_,i)=>new Vector3().fromBufferAttribute(position,i));
    for(const axis of ['x','y','z'] as const) { expect(geometry.boundingBox!.min[axis]).toBe(Math.min(...points.map(p=>p[axis]))); expect(geometry.boundingBox!.max[axis]).toBe(Math.max(...points.map(p=>p[axis]))); }
    expect(points.every(p=>p.distanceTo(geometry.boundingSphere!.center)<=geometry.boundingSphere!.radius+1e-8)).toBe(true);
    expect(sweep.samplePath(1).position).toEqual([1,0,3]); sweep.dispose();
  });

  it('samples normalized arclength rather than point index, with tangent and segment metadata', () => {
    const sweep=createSweep({centers:[[0,0,0],[.01,0,0],[10,0,0]],radii:[.1,.1,.1],initialNormal:[0,1,0]});
    expect(sweep.length).toBe(10);
    expect(sweep.samplePath(.5)).toMatchObject({position:[5,0,0],segment:1,t:(5-.01)/(10-.01)});
    expect(new Vector3(...sweep.samplePath(.5).tangent).distanceTo(new Vector3(1,0,0))).toBeCloseTo(0,8);
    expect(sweep.samplePath(0).position).toEqual([0,0,0]); expect(sweep.samplePath(1).position).toEqual([10,0,0]);
    for(let i=0;i<=10;i++) expect(sweep.samplePath(i/10).position[0]).toBeCloseTo(i);
    const sample=sweep.samplePath(.5); expect(sweep.samplePath(.5)).not.toBe(sample);
    for(const u of [-.1,1.1,NaN,Infinity]) expect(()=>sweep.samplePath(u)).toThrow(); sweep.dispose();
  });

  it('rejects invalid updates before changing buffers, bounds, path state or attribute versions', () => {
    const sweep=createSweep(straight()), position=sweep.geometry.getAttribute('position');
    const snapshot=Array.from(position.array), bounds=sweep.geometry.boundingBox!.clone(), version=(position as {version:number}).version;
    const invalid: Partial<SweepSpec>[] = [
      {centers:[[0,0,0],[0,0,1]]},{radialSegments:12},{radii:[.1,NaN,.1]},
      {centers:[[0,0,0],[0,0,0],[0,0,1]]},{centers:[[0,0,0],[0,0,1],[0,0,0]]},
      {twist:[0,Infinity,0]},{initialNormal:[0,0,1]},
    ];
    for(const change of invalid) {
      expect(()=>sweep.update({...straight(),...change})).toThrow();
      expect(Array.from(position.array)).toEqual(snapshot); expect(sweep.geometry.boundingBox).toEqual(bounds);
      expect((position as {version:number}).version).toBe(version); expect(sweep.samplePath(1).position).toEqual([0,0,2]);
    }
    sweep.dispose(); expect(()=>sweep.update(straight())).toThrow(/disposed/i);
  });

  it('rejects non-finite, degenerate, oversized and malformed input', () => {
    const invalid: Partial<SweepSpec>[] = [
      {centers:[]},{centers:[[0,0,0],[0,0,NaN]]},{centers:[[0,0,0],[0,0,Infinity]]},
      {radii:[0,.1,.1]},{radii:[-.1,.1,.1]},{radii:[.1,.1]},{radialSegments:2},{radialSegments:3.5},{radialSegments:257},
      {twist:[0]},{initialNormal:[0,0,0]},
      {centers:Array.from({length:4097},(_,i)=>[0,0,i]),radii:Array(4097).fill(.1)},
      {centers:Array.from({length:4096},(_,i)=>[0,0,i]),radii:Array(4096).fill(.1),radialSegments:256},
    ];
    for(const change of invalid) expect(()=>createSweep({...straight(),...change})).toThrow();
  });
});
