import { Matrix4, Vector3 } from 'three';

/** Sixteen column-major affine matrix elements, matching Three's Matrix4.toArray(). */
export type AssemblyMatrix = readonly number[];
export type AssemblyPoint = readonly [number, number, number];
export interface AssemblyPiece {
  readonly id: string;
  /** Complete transform in assembly coordinates; no TRS decomposition is performed. */
  readonly assembled: AssemblyMatrix;
  readonly staged: AssemblyMatrix;
  /** Translation in assembly coordinates for the fully exploded display. */
  readonly explode: AssemblyPoint;
  /** Always logically joined and cannot be removed. This is not a physical constraint. */
  readonly fixed?: boolean;
}
export interface AssemblyJoint {
  readonly id: string;
  readonly child: string;
  readonly parent: string;
  /** Local mating frames must agree in position, orientation and scale after joining. */
  readonly childFrame: AssemblyMatrix;
  readonly parentFrame: AssemblyMatrix;
}
export interface AssemblySpec {
  readonly pieces: readonly AssemblyPiece[];
  readonly joints: readonly AssemblyJoint[];
}
export type AssemblyAction = Readonly<{ ok: true }> | Readonly<{
  ok: false;
  reason: 'missing-pieces' | 'dependent-pieces' | 'fixed-piece' | 'exploded-view';
  pieces: readonly string[];
}>;
export interface AssemblySnapshot {
  readonly connected: readonly string[];
  readonly explode: number;
  /** Display matrices: staged for loose pieces, solved plus explode translation for joined pieces. */
  readonly transforms: Readonly<Record<string, AssemblyMatrix>>;
  /** Dependency-ready loose pieces; snapping also requires explode=0. */
  readonly available: readonly string[];
  readonly missing: Readonly<Record<string, readonly string[]>>;
}
export interface AssemblyAnchor {
  readonly id: string;
  readonly child: string;
  readonly parent: string;
  readonly source: AssemblyPoint;
  readonly target: AssemblyPoint;
  readonly gap: number;
  /** Logical connection, including while the display is deliberately exploded. */
  readonly joined: boolean;
}
export interface Assembly {
  snap(id: string): AssemblyAction;
  remove(id: string): AssemblyAction;
  setExplode(amount: number): void;
  reset(): void;
  snapshot(): AssemblySnapshot;
  anchors(): readonly AssemblyAnchor[];
  /** Idempotent; owns only numeric state, never a scene, geometry or material. */
  dispose(): void;
}

const MAX_COMPONENT = 1e9, MIN_LINEAR_NORM = 1e-9, MAX_CONDITION = 1e8;
const FRAME_TOLERANCE = 1e-7, AFFINE_TOLERANCE = 1e-12;
const IDENTITY = new Matrix4().toArray();
const SUCCESS: AssemblyAction = Object.freeze({ ok: true });
const blocked = (reason: Exclude<AssemblyAction, { ok: true }>['reason'], pieces: string[] = []): AssemblyAction =>
  Object.freeze({ ok: false, reason, pieces: Object.freeze(pieces) });

function linearNorm(matrix: Matrix4): number {
  const e = matrix.elements;
  return Math.max(...[0, 1, 2].map(row => Math.abs(e[row]) + Math.abs(e[row + 4]) + Math.abs(e[row + 8])));
}
function matrix(value: AssemblyMatrix, label: string): Matrix4 {
  if (!Array.isArray(value) || value.length !== 16 || !Array.from({ length: 16 }, (_, i) => Number.isFinite(value[i])).every(Boolean)) {
    throw new Error(`${label} must contain 16 finite numbers`);
  }
  if (value.some(v => Math.abs(v) > MAX_COMPONENT)) throw new Error(`${label} exceeds the numerical range of ±1e9`);
  if ([3, 7, 11].some(i => Math.abs(value[i]) > AFFINE_TOLERANCE) || Math.abs(value[15] - 1) > AFFINE_TOLERANCE) {
    throw new Error(`${label} must be affine, not perspective`);
  }
  const result = new Matrix4().fromArray(value);
  // Canonicalize only bottom-row roundoff, preserving every linear/translation element.
  result.elements[3] = result.elements[7] = result.elements[11] = 0; result.elements[15] = 1;
  const determinant = result.determinant(), norm = linearNorm(result);
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error(`${label} is singular`);
  const condition = norm * linearNorm(result.clone().invert());
  if (norm < MIN_LINEAR_NORM || !Number.isFinite(condition) || condition > MAX_CONDITION) {
    throw new Error(`${label} is outside the supported numerical conditioning range`);
  }
  return result;
}
function output(value: Matrix4): AssemblyMatrix { return Object.freeze([...value.elements]); }
function product(a: Matrix4, b: Matrix4, label: string): Matrix4 { return matrix(a.clone().multiply(b).elements, label); }
function mismatch(a: Matrix4, b: Matrix4): number { return Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i]))); }

/**
 * Place a source's local frame onto a target world frame under the moving object's parent.
 * Returns inverse(parentWorld) * targetWorld * inverse(sourceLocal), including reflections
 * and shear. Assign the complete matrix with matrixAutoUpdate=false; do not decompose it.
 */
export function solveFrame(sourceLocal: AssemblyMatrix, targetWorld: AssemblyMatrix, parentWorld: AssemblyMatrix = IDENTITY): AssemblyMatrix {
  const source = matrix(sourceLocal, 'Source frame'), target = matrix(targetWorld, 'Target frame'), parent = matrix(parentWorld, 'Parent frame');
  return output(matrix(parent.invert().multiply(target).multiply(source.invert()).elements, 'Solved frame'));
}

interface PieceState {
  id: string;
  assembled: Matrix4;
  staged: Matrix4;
  explode: AssemblyPoint;
  fixed: boolean;
  incoming: JointState[];
  dependencies: string[];
  dependents: string[];
}
interface JointState { id: string; child: string; parent: string; childFrame: Matrix4; parentFrame: Matrix4 }
function name(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${label} must be a nonempty name of at most 128 characters`);
}
function translated(value: Matrix4, offset: AssemblyPoint, amount: number): Matrix4 {
  return matrix(new Matrix4().makeTranslation(...offset.map(v => v * amount) as [number, number, number]).multiply(value).elements, 'Exploded placement');
}

/**
 * Deterministic construction state with at most 128 pieces and 512 named mating joints.
 * Every movable piece requires an acyclic path to a fixed foundation. All its parent pieces
 * must be joined before it can snap. This controls placement, not collisions or joint strength.
 */
export function createAssembly(spec: AssemblySpec): Assembly {
  if (!spec || !Array.isArray(spec.pieces) || spec.pieces.length < 1 || spec.pieces.length > 128) throw new Error('Assembly needs 1..128 pieces');
  if (!Array.isArray(spec.joints) || spec.joints.length > 512) throw new Error('Assembly accepts at most 512 joints');
  const pieces = new Map<string, PieceState>(), joints: JointState[] = [], jointIds = new Set<string>();
  for (const value of spec.pieces) {
    if (!value || typeof value !== 'object') throw new Error('Each piece must be an object');
    name(value.id, 'Piece id');
    if (pieces.has(value.id)) throw new Error(`Duplicate piece: ${value.id}`);
    if (value.fixed !== undefined && typeof value.fixed !== 'boolean') throw new Error('Fixed must be boolean');
    if (!Array.isArray(value.explode) || value.explode.length !== 3 || ![0, 1, 2].every(i => Number.isFinite(value.explode[i]) && Math.abs(value.explode[i]) <= MAX_COMPONENT)) {
      throw new Error('Explode offset must contain three finite numbers in ±1e9');
    }
    const assembled = matrix(value.assembled, `Assembled ${value.id}`), staged = matrix(value.staged, `Staged ${value.id}`);
    const explode = [...value.explode] as [number, number, number];
    translated(assembled, explode, 1);
    pieces.set(value.id, { id: value.id, assembled, staged, explode, fixed: value.fixed ?? false, incoming: [], dependencies: [], dependents: [] });
  }
  for (const value of spec.joints) {
    if (!value || typeof value !== 'object') throw new Error('Each joint must be an object');
    name(value.id, 'Joint id');
    if (jointIds.has(value.id)) throw new Error(`Duplicate joint: ${value.id}`); jointIds.add(value.id);
    const child = pieces.get(value.child), parent = pieces.get(value.parent);
    if (!child || !parent || child === parent || child.fixed) throw new Error(`Joint ${value.id} needs a movable child and a distinct known parent`);
    const joint = { id: value.id, child: value.child, parent: value.parent, childFrame: matrix(value.childFrame, 'Child frame'), parentFrame: matrix(value.parentFrame, 'Parent frame') };
    joints.push(joint); child.incoming.push(joint);
    if (!child.dependencies.includes(parent.id)) child.dependencies.push(parent.id);
    if (!parent.dependents.includes(child.id)) parent.dependents.push(child.id);
  }
  // Three-state DFS bounds validation to the graph size even for densely shared supports.
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(piece: PieceState): void {
    if (visiting.has(piece.id)) throw new Error(`Dependency cycle at ${piece.id}`);
    if (visited.has(piece.id)) return;
    if (!piece.fixed && !piece.incoming.length) throw new Error(`Movable piece ${piece.id} needs a joint`);
    visiting.add(piece.id);
    for (const id of piece.dependencies) visit(pieces.get(id)!);
    visiting.delete(piece.id); visited.add(piece.id);
  }
  for (const piece of pieces.values()) visit(piece);
  for (const joint of joints) {
    const child = pieces.get(joint.child)!, parent = pieces.get(joint.parent)!;
    const a = product(child.assembled, joint.childFrame, 'Assembled child anchor'), b = product(parent.assembled, joint.parentFrame, 'Assembled parent anchor');
    if (mismatch(a, b) > FRAME_TOLERANCE) throw new Error(`Authored mating frames must coincide: ${joint.id}`);
    for (const [piece, frame] of [[child, joint.childFrame], [parent, joint.parentFrame]] as const) {
      product(piece.staged, frame, 'Staged anchor');
      product(translated(piece.assembled, piece.explode, 1), frame, 'Exploded anchor');
    }
  }

  let connected = new Set<string>(), placements = new Map<string, Matrix4>(), explode = 0, disposed = false;
  const alive = () => { if (disposed) throw new Error('Assembly is disposed'); };
  const piece = (id: string): PieceState => { const result = pieces.get(id); if (!result) throw new Error(`Unknown piece: ${id}`); return result; };
  function displayed(value: PieceState, amount = explode): Matrix4 { return connected.has(value.id) ? translated(placements.get(value.id)!, value.explode, amount) : value.staged.clone(); }
  function reset(): void {
    alive(); connected = new Set([...pieces.values()].filter(p => p.fixed).map(p => p.id));
    placements = new Map([...pieces].map(([id, p]) => [id, p.assembled.clone()])); explode = 0;
  }
  reset();
  return {
    snap(id) {
      alive(); const value = piece(id);
      if (explode !== 0) return blocked('exploded-view');
      const missing = value.dependencies.filter(parent => !connected.has(parent));
      if (missing.length) return blocked('missing-pieces', missing);
      if (connected.has(id)) return SUCCESS;
      const first = value.incoming[0], target = product(placements.get(first.parent)!, first.parentFrame, 'Target anchor');
      const candidate = matrix(target.multiply(first.childFrame.clone().invert()).elements, 'Solved placement');
      for (const joint of value.incoming) {
        const actual = product(candidate, joint.childFrame, 'Candidate anchor'), expected = product(placements.get(joint.parent)!, joint.parentFrame, 'Required anchor');
        if (mismatch(actual, expected) > FRAME_TOLERANCE) throw new Error(`Mating frames disagree: ${joint.id}`);
      }
      placements.set(id, candidate); connected.add(id); return SUCCESS;
    },
    remove(id) {
      alive(); const value = piece(id);
      if (value.fixed) return blocked('fixed-piece', [id]);
      const dependents = value.dependents.filter(child => connected.has(child));
      if (dependents.length) return blocked('dependent-pieces', dependents);
      connected.delete(id); return SUCCESS;
    },
    setExplode(amount) {
      alive(); if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error('Explode must be finite and within 0..1');
      // Check output placements and anchor products before committing the display change.
      const candidates = new Map([...pieces.values()].map(p => [p.id, displayed(p, amount)]));
      for (const joint of joints) { product(candidates.get(joint.child)!, joint.childFrame, 'Exploded child anchor'); product(candidates.get(joint.parent)!, joint.parentFrame, 'Exploded parent anchor'); }
      explode = amount;
    },
    reset,
    snapshot() {
      alive();
      const transforms: Record<string, AssemblyMatrix> = Object.create(null), missing: Record<string, readonly string[]> = Object.create(null), available: string[] = [];
      for (const value of pieces.values()) {
        transforms[value.id] = output(displayed(value));
        missing[value.id] = Object.freeze(value.dependencies.filter(id => !connected.has(id)));
        if (!connected.has(value.id) && !missing[value.id].length) available.push(value.id);
      }
      return Object.freeze({ connected: Object.freeze([...connected]), explode, transforms: Object.freeze(transforms), available: Object.freeze(available), missing: Object.freeze(missing) });
    },
    anchors() {
      alive();
      return Object.freeze(joints.map(joint => {
        const a = product(displayed(piece(joint.child)), joint.childFrame, 'Child anchor'), b = product(displayed(piece(joint.parent)), joint.parentFrame, 'Parent anchor');
        const source = new Vector3().setFromMatrixPosition(a), target = new Vector3().setFromMatrixPosition(b);
        return Object.freeze({ id: joint.id, child: joint.child, parent: joint.parent, source: Object.freeze(source.toArray() as [number, number, number]), target: Object.freeze(target.toArray() as [number, number, number]), gap: source.distanceTo(target), joined: connected.has(joint.child) && connected.has(joint.parent) });
      }));
    },
    dispose() { if (disposed) return; disposed = true; connected.clear(); placements.clear(); pieces.clear(); joints.length = 0; },
  };
}
