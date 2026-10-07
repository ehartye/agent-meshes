/** A connector profile says which connector kinds exist and which pairs mate. The geometric
 * checks (position and axis alignment, double use) are shared; the vocabulary is the profile's. */
export interface ConnectorProfile {
  readonly id: string;
  /** Each kind maps to the kind it mates with. Must be symmetric. */
  readonly mates: Readonly<Record<string, string>>;
  /** Kinds that occupy a physical site: two connections cannot consume the same site on a part. */
  readonly exclusive: readonly string[];
  /** Kinds with no meaningful axis (for example a ball and socket); alignment checks skip them. */
  readonly axisless: readonly string[];
}

export const DEFAULT_PROFILE = 'lego-technic';

export const LEGO_TECHNIC: ConnectorProfile = {
  id: DEFAULT_PROFILE,
  mates: { pin: 'pin-hole', 'pin-hole': 'pin', axle: 'axle-hole', 'axle-hole': 'axle', ball: 'socket', socket: 'ball' },
  exclusive: ['pin-hole', 'axle-hole'],
  axisless: ['ball', 'socket'],
};

const profiles = new Map<string, ConnectorProfile>();

function check(profile: ConnectorProfile): void {
  if (!/^[a-z][a-z0-9-]*$/.test(profile.id)) throw new Error(`Invalid connector profile id: ${profile.id}`);
  for (const [kind, mate] of Object.entries(profile.mates)) {
    if (profile.mates[mate] !== kind) throw new Error(`Connector profile ${profile.id}: ${kind} mates with ${mate}, which does not mate back`);
  }
  for (const kind of [...profile.exclusive, ...profile.axisless]) {
    if (!(kind in profile.mates)) throw new Error(`Connector profile ${profile.id}: ${kind} is not a declared kind`);
  }
}

export function registerConnectorProfile(profile: ConnectorProfile): void {
  check(profile);
  if (profiles.has(profile.id)) throw new Error(`Connector profile already registered: ${profile.id}`);
  profiles.set(profile.id, profile);
}
export function unregisterConnectorProfile(id: string): void {
  if (id === DEFAULT_PROFILE) throw new Error('The default connector profile cannot be removed');
  profiles.delete(id);
}
export function connectorProfile(id: string): ConnectorProfile {
  const profile = profiles.get(id);
  if (!profile) throw new Error(`Unknown connector profile: ${id}. Registered: ${[...profiles.keys()].join(', ')}`);
  return profile;
}

check(LEGO_TECHNIC);
profiles.set(LEGO_TECHNIC.id, LEGO_TECHNIC);
