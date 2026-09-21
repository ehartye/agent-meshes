import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, ImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import { coordinates, polygonInfo, validateMobileSpec } from './mobile-spec.ts';
import type { MobilePiece, MobileSheet, MobileSpec, MobileWire, Quat, Vec3 } from './mobile-spec.ts';
import { add, dot, finite, freeze, length, multiply, pathDistances, quaternion, rotate, samplePath, subtract, tuple, vector, wireRotation } from './mobile-math.ts';

export { validateMobileSpec } from './mobile-spec.ts';
export type { MobileHanger, MobilePiece, MobileSheet, MobileSpec, MobileWire, Quat, Vec3 } from './mobile-spec.ts';

export interface MobilePose {
  readonly name: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly angularVelocity: Vec3;
  readonly mass: number;
  readonly centerOfMass: Vec3;
  readonly principalInertia: Vec3;
  readonly inertiaRotation: Quat;
  readonly scale: number;
  readonly leafMass: number;
  /** Local geometry, including the current sliding hanger. Shared immutable data. */
  readonly wires: readonly MobileWire[];
  readonly leaf?: MobileSheet;
  readonly hanger?: number;
}
export interface MobileJoint {
  readonly name: string;
  readonly parent: string | null;
  readonly parentLocal: Vec3;
  readonly childLocal: Vec3;
  readonly parentWorld: Vec3;
  readonly childWorld: Vec3;
  readonly gap: number;
}
export interface MobileSnapshot {
  readonly nodes: readonly MobilePose[];
  readonly joints: readonly MobileJoint[];
  readonly maxJointGap: number;
  readonly counts: { readonly bodies: number; readonly colliders: number; readonly joints: number };
}
export interface HangingMobile {
  readonly fixedStep: number;
  /** Run at most eight 1/120-second steps. Discard excess elapsed time; return step count. */
  advance(seconds: number): number;
  /** Clear fractional elapsed work when pausing or hiding the page. */
  clearAccumulator(): void;
  /** Scale a sheet about its local origin in XY; thickness/density and attached wires stay fixed. */
  setLeafScale(name: string, scale: number): void;
  /** Target normalized distance along the named rail; attachment speed is at most .96 m/s. */
  setHanger(name: string, position: number): void;
  /** Impulse per exposed square meter (0..2 N·s/m²), applied at each leaf's area centroid. */
  applyGust(gust: { direction: Vec3; strength: number }): void;
  snapshot(): MobileSnapshot;
  /** Rebuild the authored world, including solver state and controls. */
  reset(): void;
  /** Idempotent. Other methods throw after disposal. */
  dispose(): void;
}

const STEP = 1 / 120, MAX_STEPS = 8, MAX_HANGER_MOVE = .008;
let engineReady: Promise<void> | undefined;

interface PieceState {
  spec: MobilePiece;
  body: RigidBody;
  scale: number;
  wires: readonly MobileWire[];
  anchor: Vec3;
  colliders: Collider[][];
  leafCollider?: Collider;
  leafInfo?: ReturnType<typeof polygonInfo>;
  joint?: ImpulseJoint;
  hanger?: { position: number; target: number; distances: readonly number[]; origin: Vec3 };
}
function worldPoint(body: RigidBody, point: Vec3): Vec3 {
  return add(rotate(point, quaternion(body.rotation())), tuple(body.translation()));
}
function leafDescriptor(leaf: MobileSheet, scale = 1): RAPIER.ColliderDesc {
  const points: number[] = [];
  for (const z of [-leaf.thickness / 2, leaf.thickness / 2]) for (const [x, y] of leaf.contour) points.push(x * scale, y * scale, z);
  const descriptor = RAPIER.ColliderDesc.convexHull(new Float32Array(points));
  if (!descriptor) throw new Error('Engine rejected convex sheet');
  return descriptor.setDensity(leaf.density).setCollisionGroups(0x00010001).setFriction(.35).setRestitution(.08);
}

function createWorld(spec: MobileSpec) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  world.numSolverIterations = 16;
  // The one-substep default tunnels through a 1.4 mm sheet in the collision proof.
  world.maxCcdSubsteps = 4;
  const nodes = new Map<string, PieceState>();
  const joints: { parent: RigidBody; child: PieceState; parentAnchor: Vec3 }[] = [];

  function wireColliders(body: RigidBody, wire: MobileWire): Collider[] {
    const colliders: Collider[] = [];
    for (let i = 1; i < wire.points.length; i++) {
      const a = wire.points[i - 1], b = wire.points[i], delta = subtract(b, a), segmentLength = length(delta), center = multiply(add(a, b), .5);
      // Use cylinder mass, without counting capsule end volumes at every sample.
      // Inertia is the engine's capsule approximation. Wire contacts are disabled.
      const descriptor = RAPIER.ColliderDesc.capsule(segmentLength / 2, wire.radius)
        .setTranslation(...center).setRotation(wireRotation(delta))
        .setMass(Math.PI * wire.radius ** 2 * segmentLength * wire.density).setCollisionGroups(0);
      colliders.push(world.createCollider(descriptor, body));
    }
    return colliders;
  }
  try {
    for (const piece of spec.nodes) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinearDamping(.6).setAngularDamping(.8).setCcdEnabled(true));
      const state: PieceState = { spec: piece, body, scale: 1, wires: piece.wires, anchor: piece.suspension.anchor, colliders: [] };
      if (piece.leaf) {
        state.leafCollider = world.createCollider(leafDescriptor(piece.leaf), body);
        state.leafInfo = polygonInfo(piece.leaf.contour);
      }
      state.colliders = piece.wires.map(wire => wireColliders(body, wire));
      if (piece.hanger) {
        const distances = pathDistances(piece.hanger.path);
        state.hanger = { position: piece.hanger.initial, target: piece.hanger.initial, distances, origin: samplePath(piece.hanger.path, distances, piece.hanger.initial) };
      }
      nodes.set(piece.name, state);
    }
    const ceiling = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    function place(node: PieceState, parent: RigidBody): void {
      const parentAnchor = node.spec.suspension.parentAnchor;
      node.body.setTranslation(vector(subtract(worldPoint(parent, parentAnchor), node.anchor)), true);
      node.joint = world.createImpulseJoint(RAPIER.JointData.spherical(vector(parentAnchor), vector(node.anchor)), parent, node.body, true);
      node.joint.setContactsEnabled(false);
      joints.push({ parent, child: node, parentAnchor });
      for (const child of nodes.values()) if (child.spec.suspension.parent === node.spec.name) place(child, node.body);
    }
    place(nodes.get(spec.nodes.find(n => n.suspension.parent === null)!.name)!, ceiling);

    function moveHanger(node: PieceState, position: number): void {
      const hanger = node.spec.hanger!, state = node.hanger!;
      const delta = subtract(samplePath(hanger.path, state.distances, position), state.origin);
      const wire = freeze({ ...node.spec.wires[hanger.wire], points: node.spec.wires[hanger.wire].points.map(p => add(p, delta)) });
      node.anchor = add(node.spec.suspension.anchor, delta);
      node.joint!.setAnchor2(vector(node.anchor));
      for (const collider of node.colliders[hanger.wire]) world.removeCollider(collider, true);
      node.colliders[hanger.wire] = wireColliders(node.body, wire);
      node.wires = node.wires.map((current, i) => i === hanger.wire ? wire : current);
      state.position = position;
      node.body.recomputeMassPropertiesFromColliders();
      for (const piece of nodes.values()) piece.body.wakeUp();
    }
    return { world, nodes, joints, moveHanger };
  } catch (error) {
    world.free();
    throw error;
  }
}

/** Create a renderer-free mobile. Validation finishes before WASM initialization/world allocation. */
export async function createHangingMobile(input: unknown): Promise<HangingMobile> {
  const spec = validateMobileSpec(input);
  await (engineReady ??= RAPIER.init().catch(error => { engineReady = undefined; throw error; }));
  let state = createWorld(spec), disposed = false, accumulator = 0;
  const alive = () => { if (disposed) throw new Error('Mobile is disposed'); };
  function named(name: string): PieceState {
    alive();
    const node = state.nodes.get(name);
    if (!node) throw new Error(`Unknown mobile piece: ${name}`);
    return node;
  }
  function step(): void {
    for (const node of state.nodes.values()) if (node.hanger) {
      const hanger = node.hanger, maxFraction = MAX_HANGER_MOVE / hanger.distances.at(-1)!;
      const next = hanger.position + Math.max(-maxFraction, Math.min(maxFraction, hanger.target - hanger.position));
      if (Math.abs(next - hanger.position) > 1e-12) state.moveHanger(node, next);
    }
    state.world.step();
  }
  return {
    fixedStep: STEP,
    advance(seconds) {
      alive(); finite(seconds, 0, 1e6, 'Elapsed seconds');
      accumulator += Math.min(seconds, MAX_STEPS * STEP);
      let count = 0;
      while (accumulator + 1e-12 >= STEP && count < MAX_STEPS) { step(); accumulator = Math.max(0, accumulator - STEP); count++; }
      return count;
    },
    clearAccumulator() { alive(); accumulator = 0; },
    setLeafScale(name, scale) {
      const node = named(name), leaf = node.spec.leaf;
      if (!leaf) throw new Error('Piece has no leaf');
      finite(scale, ...(leaf.scaleRange ?? [1, 1]), 'Leaf scale');
      const shape = leafDescriptor(leaf, scale).shape;
      node.leafCollider!.setShape(shape);
      node.leafCollider!.setDensity(leaf.density);
      node.body.recomputeMassPropertiesFromColliders();
      node.scale = scale;
      for (const piece of state.nodes.values()) piece.body.wakeUp();
    },
    setHanger(name, position) {
      const node = named(name);
      if (!node.hanger) throw new Error('Piece has no sliding hanger');
      finite(position, 0, 1, 'Hanger position');
      node.hanger.target = position;
    },
    applyGust(gust) {
      alive();
      const direction = coordinates(gust?.direction, 'Gust direction'), magnitude = length(direction);
      if (magnitude < 1e-7) throw new Error('Gust direction must be nonzero');
      finite(gust.strength, 0, 2, 'Gust impulse per area');
      const axis = multiply(direction, 1 / magnitude);
      for (const node of state.nodes.values()) if (node.leafInfo) {
        const normal = rotate([0, 0, 1], quaternion(node.body.rotation()));
        const exposedArea = node.leafInfo.area * node.scale ** 2 * Math.abs(dot(normal, axis));
        const point = worldPoint(node.body, multiply(node.leafInfo.centroid, node.scale));
        node.body.applyImpulseAtPoint(vector(multiply(axis, exposedArea * gust.strength)), vector(point), true);
      }
    },
    snapshot() {
      alive();
      const joints: MobileJoint[] = state.joints.map(joint => {
        const parentWorld = worldPoint(joint.parent, joint.parentAnchor), childWorld = worldPoint(joint.child.body, joint.child.anchor);
        return { name: joint.child.spec.name, parent: joint.child.spec.suspension.parent, parentLocal: joint.parentAnchor, childLocal: joint.child.anchor, parentWorld, childWorld, gap: length(subtract(parentWorld, childWorld)) };
      });
      const nodes: MobilePose[] = [...state.nodes.values()].map(node => ({
        name: node.spec.name, position: tuple(node.body.translation()), rotation: quaternion(node.body.rotation()), angularVelocity: tuple(node.body.angvel()),
        mass: node.body.mass(), centerOfMass: tuple(node.body.localCom()), principalInertia: tuple(node.body.principalInertia()), inertiaRotation: quaternion(node.body.principalInertiaLocalFrame()),
        scale: node.scale, leafMass: node.leafCollider?.mass() ?? 0, wires: node.wires,
        ...(node.spec.leaf ? { leaf: node.spec.leaf } : {}), ...(node.hanger ? { hanger: node.hanger.position } : {}),
      }));
      return freeze({ nodes, joints, maxJointGap: Math.max(...joints.map(j => j.gap)), counts: { bodies: state.world.bodies.len(), colliders: state.world.colliders.len(), joints: state.world.impulseJoints.len() } });
    },
    reset() {
      alive();
      const next = createWorld(spec); // Leave the current world usable if reconstruction fails.
      state.world.free(); state = next; accumulator = 0;
    },
    dispose() { if (disposed) return; state.world.free(); disposed = true; },
  };
}
