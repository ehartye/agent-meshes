/** Profile-local coordinates: X right, Y down. No world scale is implied. */
export type PlanarPoint = readonly [number, number];
export type PlanarEffector = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot';
export type PlanarTargets = Readonly<Record<PlanarEffector, PlanarPoint>>;
export type PlanarTargetPatch = Partial<PlanarTargets>;

export interface PlanarLimb {
  readonly root: PlanarPoint;
  readonly joint: PlanarPoint;
  readonly end: PlanarPoint;
  readonly lengths: readonly [number, number];
  /** True when the solved endpoint differs from the finite requested target. */
  readonly constrained: boolean;
}
export interface PlanarContourInfo {
  readonly area: number;
  readonly bounds: { readonly min: PlanarPoint; readonly max: PlanarPoint };
}
export interface PlanarFigureSnapshot extends PlanarContourInfo {
  /** One simple boundary, closed implicitly from the last point to the first. */
  readonly points: readonly PlanarPoint[];
  /** Targets after rectangular clamping; radial reach constraints may move ends further. */
  readonly targets: PlanarTargets;
  readonly limbs: Readonly<Record<PlanarEffector, PlanarLimb>>;
}
export interface PlanarFigure {
  /** Current deeply frozen snapshot. Previously returned snapshots never change. */
  snapshot(): PlanarFigureSnapshot;
  /** Rejects invalid input or geometry without replacing the last valid state. */
  setTargets(targets: PlanarTargetPatch): PlanarFigureSnapshot;
  /** Restores this controller's creation pose, including its initial target constraints. */
  reset(): PlanarFigureSnapshot;
}

const effectors = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;
const defaults: PlanarTargets = {
  leftHand: [-105,-123], rightHand: [72,-151], leftFoot: [-99,104], rightFoot: [45,146],
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A deliberately fixed safe profile, not an arbitrary character/rig definition. */
export const planarFigureProfile = freeze({
  name: 'dance-v1', coordinates: 'x-right-y-down', vertexCount: 420,
  targetBounds: {
    leftHand: [-128,-58,-165,-70], rightHand: [58,128,-165,-70],
    leftFoot: [-110,-30,76,146], rightFoot: [30,110,76,146],
  } as Readonly<Record<PlanarEffector, readonly [number,number,number,number]>>,
  defaults,
} as const);

const add = (a: PlanarPoint, b: PlanarPoint): PlanarPoint => [a[0]+b[0],a[1]+b[1]];
const sub = (a: PlanarPoint, b: PlanarPoint): PlanarPoint => [a[0]-b[0],a[1]-b[1]];
const scale = (a: PlanarPoint, s: number): PlanarPoint => [a[0]*s,a[1]*s];
const length = (a: PlanarPoint) => Math.hypot(a[0],a[1]);
const unit = (a: PlanarPoint) => scale(a,1/length(a));
const dot = (a: PlanarPoint, b: PlanarPoint) => a[0]*b[0]+a[1]*b[1];
const cross = (a: PlanarPoint, b: PlanarPoint) => a[0]*b[1]-a[1]*b[0];
const clamp = (n: number, min: number, max: number) => Math.max(min,Math.min(max,n));

function readPoint(value: unknown, label: string): PlanarPoint {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must be a two-number array`);
  const [x,y] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} must contain finite numbers`);
  }
  return [x,y];
}

function readPatch(value: unknown): PlanarTargetPatch {
  if (!value || typeof value !== 'object' || Object.prototype.toString.call(value)!=='[object Object]') {
    throw new Error('Targets must be an object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4 || keys.some(key => !effectors.includes(key as PlanarEffector))) {
    throw new Error('Targets may only name leftHand, rightHand, leftFoot, rightFoot');
  }
  const result: Partial<Record<PlanarEffector,PlanarPoint>> = {};
  for (const key of keys as PlanarEffector[]) result[key] = readPoint((value as PlanarTargetPatch)[key],key);
  return result;
}

/**
 * Validates a single implicitly closed contour: 3..512 points, |coordinate| <= 10000,
 * edges longer than 1e-7 and |area| > 1e-8. Rejects crossings, nonadjacent touching,
 * and adjacent backtracking. Either winding and straight subdivisions are allowed.
 * This validates a 2D boundary, not triangulation, stroke offsets, or an extruded solid.
 */
export function validatePlanarContour(points: readonly PlanarPoint[]): PlanarContourInfo {
  if (!Array.isArray(points) || points.length < 3 || points.length > 512) throw new Error('Contour needs 3..512 points');
  const p = Array.from(points,(point,i) => readPoint(point,`Contour point ${i}`));
  const min: [number,number] = [Infinity,Infinity], max: [number,number] = [-Infinity,-Infinity];
  const epsilon = 1e-8;
  let area = 0;
  for (let i=0;i<p.length;i++) {
    const a=p[i], b=p[(i+1)%p.length], c=p[(i+2)%p.length];
    if (a.some(n => Math.abs(n)>10000)) throw new Error('Contour coordinates exceed 10000');
    for (let axis=0;axis<2;axis++) { min[axis]=Math.min(min[axis],a[axis]); max[axis]=Math.max(max[axis],a[axis]); }
    const ab=sub(b,a), bc=sub(c,b);
    if (length(ab)<=1e-7) throw new Error('Contour has a collapsed edge');
    if (Math.abs(cross(ab,bc))<=epsilon && dot(ab,bc)<0) throw new Error('Contour boundary backtracks');
    area+=cross(a,b)/2;
  }
  const orient = (a:PlanarPoint,b:PlanarPoint,c:PlanarPoint) => cross(sub(b,a),sub(c,a));
  const onSegment = (a:PlanarPoint,b:PlanarPoint,c:PlanarPoint) =>
    Math.abs(orient(a,b,c))<=epsilon && c[0]>=Math.min(a[0],b[0])-epsilon && c[0]<=Math.max(a[0],b[0])+epsilon &&
    c[1]>=Math.min(a[1],b[1])-epsilon && c[1]<=Math.max(a[1],b[1])+epsilon;
  for (let i=0;i<p.length;i++) {
    const a=p[i], b=p[(i+1)%p.length];
    for (let j=i+2;j<p.length;j++) {
      if (i===0 && j===p.length-1) continue;
      const c=p[j],d=p[(j+1)%p.length];
      if (Math.min(a[0],b[0])>Math.max(c[0],d[0])+epsilon || Math.max(a[0],b[0])<Math.min(c[0],d[0])-epsilon ||
          Math.min(a[1],b[1])>Math.max(c[1],d[1])+epsilon || Math.max(a[1],b[1])<Math.min(c[1],d[1])-epsilon) continue;
      const ac=orient(a,b,c), ad=orient(a,b,d), ca=orient(c,d,a), cb=orient(c,d,b);
      if ((ac*ad<0 && ca*cb<0) || onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b)) {
        throw new Error('Contour crosses or touches itself');
      }
    }
  }
  if (Math.abs(area)<=epsilon) throw new Error('Contour has no usable area');
  return freeze({area,bounds:{min,max}});
}

function solveLimb(key: PlanarEffector, request: PlanarPoint): { limb: PlanarLimb; target: PlanarPoint } {
  const hand=key.endsWith('Hand'), side=key.startsWith('left')?-1:1;
  const root:PlanarPoint=[side*(hand?28:20),hand?-58:20];
  const lengths:readonly [number,number]=hand?[55,49]:[64,60];
  const [l1,l2]=lengths, bounds=planarFigureProfile.targetBounds[key];
  // Clamp before subtraction/length: even finite Number.MAX_VALUE requests stay safe.
  const target:PlanarPoint=[clamp(request[0],bounds[0],bounds[1]),clamp(request[1],bounds[2],bounds[3])];
  const delta=sub(target,root), direction=unit(delta);
  const distance=clamp(length(delta),(l1+l2)*.70,l1+l2-4);
  const end=add(root,scale(direction,distance));
  const along=(l1*l1-l2*l2+distance*distance)/(2*distance);
  const height=Math.sqrt(Math.max(0,l1*l1-along*along));
  // A fixed branch prevents elbows/knees flipping when an endpoint moves.
  const bend=hand?side:-side;
  const joint=add(add(root,scale(direction,along)),scale([-direction[1],direction[0]],height*bend));
  return {target,limb:{root,joint,end,lengths,constrained:length(sub(end,request))>1e-7}};
}

function limbCenters(limb: PlanarLimb, hand: boolean): PlanarPoint[] {
  const {root,joint,end}=limb, u=unit(sub(joint,root)), v=unit(sub(end,joint));
  const turn=Math.acos(clamp(dot(u,v),-1,1)), sign=Math.sign(cross(u,v))||1;
  // Circular joint fillet radius is greater than the silhouette half-width;
  // its inner offset therefore retains an open elbow/knee instead of folding back.
  const radius=(hand?14:18)*1.45, trim=radius*Math.tan(turn/2);
  const p=sub(joint,scale(u,trim)), q=add(joint,scale(v,trim));
  const center=add(p,scale([-u[1]*sign,u[0]*sign],radius));
  const angle=Math.atan2(p[1]-center[1],p[0]-center[0]), result:PlanarPoint[]=[];
  for(let i=0;i<8;i++) result.push(add(root,scale(sub(p,root),i/8)));
  for(let i=0;i<=24;i++) {
    const a=angle+sign*turn*i/24;
    result.push(add(center,[radius*Math.cos(a),radius*Math.sin(a)]));
  }
  for(let i=1;i<=8;i++) result.push(add(q,scale(sub(end,q),i/8)));
  return result;
}

function limbBoundary(key: PlanarEffector, limb: PlanarLimb): PlanarPoint[] {
  const hand=key.endsWith('Hand'), side=key.startsWith('left')?-1:1;
  const centers=limbCenters(limb,hand), a:PlanarPoint[]=[], b:PlanarPoint[]=[];
  let tangent:PlanarPoint=[0,1];
  for(let i=0;i<centers.length;i++) {
    tangent=unit(sub(centers[Math.min(centers.length-1,i+1)],centers[Math.max(0,i-1)]));
    const n:PlanarPoint=[tangent[1],-tangent[0]], radius=(hand?14:18)+(hand?-2:-3)*i/(centers.length-1);
    a.push(add(centers[i],scale(n,radius))); b.push(sub(centers[i],scale(n,radius)));
  }
  const cap:PlanarPoint[]=[], radius=hand?12:15, n:PlanarPoint=[tangent[1],-tangent[0]];
  for(let i=1;i<12;i++) {
    const t=i/12*Math.PI, p=add(limb.end,add(scale(n,radius*Math.cos(t)),scale(tangent,radius*Math.sin(t))));
    const toe=hand?0:Math.sin(t)**2;
    cap.push([p[0]+side*10*toe,p[1]+2*toe]);
  }
  return [...a,...cap,...b.reverse()];
}

function buildFigure(requests: PlanarTargets): PlanarFigureSnapshot {
  const limbs={} as Record<PlanarEffector,PlanarLimb>, targets={} as Record<PlanarEffector,PlanarPoint>;
  for(const key of effectors) { const solved=solveLimb(key,requests[key]); limbs[key]=solved.limb; targets[key]=solved.target; }
  const points:PlanarPoint[]=[];
  for(let i=0;i<=20;i++) {
    const angle=-Math.PI/2+(Math.PI/2+Math.PI/3)*i/20;
    points.push([24*Math.cos(angle),-105+27*Math.sin(angle)]);
  }
  // One clockwise anatomical boundary: head, right arm, right leg, left leg,
  // left arm, head. Limbs never carry separate overlapping strokes or join seams.
  points.push([12,-79],...limbBoundary('rightHand',limbs.rightHand),[31,-31],[26,-10]);
  points.push(...limbBoundary('rightFoot',limbs.rightFoot),[0,22]);
  points.push(...limbBoundary('leftFoot',limbs.leftFoot),[-26,-10],[-31,-31]);
  points.push(...limbBoundary('leftHand',limbs.leftHand),[-12,-79]);
  for(let i=0;i<20;i++) {
    const angle=Math.PI*2/3+(Math.PI*3/2-Math.PI*2/3)*i/20;
    points.push([24*Math.cos(angle),-105+27*Math.sin(angle)]);
  }
  const info=validatePlanarContour(points);
  if (points.length!==planarFigureProfile.vertexCount || info.area<=0) throw new Error('Invalid dance profile contour');
  return freeze({points,targets,limbs,...info});
}

/**
 * Create an independent, renderer-free controller for the fixed dance-v1 profile.
 * Updates are synchronous and transactional; no DOM, Three, GPU resources, timers,
 * or history are retained. Render its points as a closed fill/stroke boundary.
 */
export function createPlanarFigure(targets: PlanarTargetPatch = {}): PlanarFigure {
  const initialRequests=freeze({...defaults,...readPatch(targets)});
  const initial=buildFigure(initialRequests);
  let requests=initialRequests, current=initial;
  return Object.freeze({
    snapshot:()=>current,
    setTargets(patch:PlanarTargetPatch) {
      const next=readPatch(patch);
      if(Object.keys(next).length===0) return current;
      const candidate={...requests,...next}, snapshot=buildFigure(candidate);
      requests=candidate; current=snapshot;
      return current;
    },
    reset() { requests=initialRequests; current=initial; return current; },
  });
}
