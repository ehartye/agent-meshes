import { Matrix4, Quaternion, Vector3 } from 'three';
import type { AssemblyManifest } from './assembly.ts';
import type { Vector } from './ldraw.ts';
import { connectorProfile } from './profiles.ts';

const positionToleranceMeters = .0001, axisDotTolerance = 1e-6;
type Endpoint = AssemblyManifest['connections'][number]['a'];
type Transform = { position: number[]; rotation: number[] };
const matrix = (value: Transform) => new Matrix4().compose(new Vector3().fromArray(value.position), new Quaternion().fromArray(value.rotation), new Vector3(1, 1, 1));

/** Checks declared connector geometry at rest, after schema and body hierarchy validation. */
export function validateConnectivity(manifest: AssemblyManifest) {
  const profile = connectorProfile(manifest.profile), exclusive = new Set(profile.exclusive), axisless = new Set(profile.axisless);
  const parts = new Map(manifest.parts.map(part => [part.name, part]));
  const bodies = new Map(manifest.bodies.map(body => [body.name, body]));
  const bodyMatrices = new Map<string, Matrix4>(), partMatrices = new Map<string, Matrix4>();
  function bodyMatrix(name: string): Matrix4 {
    if (!bodyMatrices.has(name)) {
      const body = bodies.get(name)!;
      const world = body.parent ? bodyMatrix(body.parent).clone().multiply(matrix(body)) : matrix(body);
      bodyMatrices.set(name, world);
    }
    return bodyMatrices.get(name)!;
  }
  const adjacency = new Map(manifest.parts.map(part => [part.name, new Set<string>()]));
  for (const part of manifest.parts) {
    const names = (part.connectors ?? []).map(connector => connector.name);
    if (new Set(names).size !== names.length) throw new Error(`Duplicate connector name on part: ${part.name}`);
    partMatrices.set(part.name, bodyMatrix(part.body).clone().multiply(matrix(part)));
  }
  function endpoint(value: Endpoint) {
    const part = parts.get(value.part);
    if (!part) throw new Error(`Unknown part in connection: ${value.part}`);
    const connector = part.connectors?.find(candidate => candidate.name === value.connector);
    if (!connector) throw new Error(`Unknown connector: ${value.part}.${value.connector}`);
    const world = partMatrices.get(part.name)!;
    const position = new Vector3(...connector.position).applyMatrix4(world), axis = new Vector3(...connector.axis).transformDirection(world);
    if (![...position.toArray(), ...axis.toArray()].every(Number.isFinite)) throw new Error(`Nonfinite connector transform: ${value.part}.${value.connector}`);
    return { kind: connector.kind, position, axis };
  }
  const used = new Set<string>();
  const occupiedHoles = new Map<string, { name: string; position: Vector3; axis: Vector3 }[]>();
  const residuals = manifest.connections.map(connection => {
    if (connection.a.part === connection.b.part) throw new Error('Connections must join distinct parts');
    const a = endpoint(connection.a), b = endpoint(connection.b);
    for (const value of [connection.a, connection.b]) {
      const key = JSON.stringify([value.part, value.connector]);
      if (used.has(key)) throw new Error(`Connector already connected: ${value.part}.${value.connector}`);
      used.add(key);
    }
    if (profile.mates[a.kind] !== b.kind) throw new Error(`Incompatible connector types: ${a.kind} and ${b.kind}`);
    const positionErrorMeters = a.position.distanceTo(b.position);
    const axisError = axisless.has(a.kind) ? null : Math.max(0, 1-Math.abs(a.axis.dot(b.axis)));
    const label = `${connection.a.part}.${connection.a.connector} ↔ ${connection.b.part}.${connection.b.connector}`;
    // Allow only 1e-12 m of floating-point roundoff at the 0.1 mm tolerance boundary.
    if (positionErrorMeters > positionToleranceMeters + 1e-12) throw new Error(`Connector position mismatch (${positionErrorMeters} m): ${label}`);
    if (axisError !== null && axisError > axisDotTolerance + 1e-12) throw new Error(`Connector axis mismatch (${axisError} absolute-dot error): ${label}`);
    for (const [reference, anchor] of [[connection.a, a], [connection.b, b]] as const) {
      if (!exclusive.has(anchor.kind)) continue;
      const occupied = occupiedHoles.get(reference.part) ?? [];
      const sameHole = occupied.find(hole => hole.position.distanceTo(anchor.position) <= positionToleranceMeters + 1e-12
        && 1-Math.abs(hole.axis.dot(anchor.axis)) <= axisDotTolerance + 1e-12);
      if (sameHole) throw new Error(`Physical hole already consumed: ${reference.part}.${sameHole.name} and ${reference.part}.${reference.connector}`);
      occupied.push({ name: reference.connector, position: anchor.position, axis: anchor.axis });
      occupiedHoles.set(reference.part, occupied);
    }
    adjacency.get(connection.a.part)!.add(connection.b.part);
    adjacency.get(connection.b.part)!.add(connection.a.part);
    return { ...connection, positionErrorMeters, axisError, worldPositionA: a.position.toArray() as Vector, worldPositionB: b.position.toArray() as Vector };
  });
  const visited = new Set<string>(), connectedComponents: string[][] = [];
  for (const part of manifest.parts) {
    if (visited.has(part.name)) continue;
    const component: string[] = [], remaining = [part.name];
    while (remaining.length) {
      const name = remaining.pop()!;
      if (visited.has(name)) continue;
      visited.add(name); component.push(name);
      for (const neighbor of adjacency.get(name)!) if (!visited.has(neighbor)) remaining.push(neighbor);
    }
    connectedComponents.push(component.sort());
  }
  connectedComponents.sort((a, b) => a[0].localeCompare(b[0]));
  const allPartsConnected = connectedComponents.length === 1;
  if (manifest.requireConnected && !allPartsConnected) throw new Error(`Disconnected assembly components: ${connectedComponents.map(component => component.join(', ')).join(' | ')}`);
  return { allPartsConnected, connectedComponents, residuals, positionToleranceMeters, axisDotTolerance,
    method: 'Declared connector anchors at rest; no structural strength or interference validation' };
}
