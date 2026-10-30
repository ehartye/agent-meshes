import { Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { bindClip, loadGait, pose, restore, type Bound, type GaitCheck, type GaitSource } from './gait-analysis.ts';

/**
 * Per-clip motion diagnostics for any skinned or bone-animated GLB, with no renderer and no rig assumptions.
 * Clips are sampled the way gait analysis samples them (`bindClip` and `pose`, which already honour node scale).
 *
 * Every clip gets two rig-free checks:
 * - loop-discontinuity: the first pose against the last, per animated bone and channel.
 * - velocity-spike: a joint speed far above that joint's own typical speed, which a single bad key produces.
 *
 * Three foot checks run only for bones the caller declares as feet, because a generic rig does not say which bones
 * touch the ground. A foot's sole is the skinned vertices whose strongest influence is that bone or one below it:
 * - foot-penetration: the sole below the floor (world y = 0 unless `floor` says otherwise).
 * - stance-sliding: a planted sole moving at other than the declared travel speed (also needs `speed`).
 * - support-count: samples with fewer planted feet than `minSupport` (needs two or more declared feet).
 * A check that cannot run reports `not-evaluated` with the reason; that is a distinct state, never a pass.
 */
export const CLIP_REPORT_FORMAT = 'agent-meshes/clip-report/1';
export type CheckStatus = 'pass' | 'fail' | 'not-evaluated';
export const CLIP_CHECK_IDS = ['loop-discontinuity', 'velocity-spike', 'foot-penetration', 'stance-sliding', 'support-count'] as const;
export type ClipCheckId = typeof CLIP_CHECK_IDS[number];

export interface ClipReportOptions {
  /** Report only this clip (default: every clip). */
  clip?: string;
  /** Bones declared as feet. */
  feet?: string[];
  /** Travel speed (m/s) the in-place clip is played at; enables stance-sliding. */
  speed?: number;
  /** Uniform sampling rate (default 60); every key time is sampled as well. */
  fps?: number;
  /** World height of the floor (default 0). */
  floor?: number;
  /** Fewest planted feet at any sample (default 1). */
  minSupport?: number;
  loopRotationDeg?: number; loopPositionM?: number; loopScale?: number;
  /** A speed is a spike above this multiple of the joint's median speed, and above the minimum for its kind. */
  spikeRatio?: number; spikeMinDegPerSec?: number; spikeMinMetersPerSec?: number;
  /** Sole below the floor by more than this (m) is penetration (default 0.005). */
  penetrationM?: number;
  /** Sole within this height (m) of the floor is planted (default 0.002); a looser limit counts a heel graze at touchdown as planted. */
  contactM?: number;
  /** Planted-sole speed may differ from the declared travel by this fraction (default 0.1, at least 0.02 m/s). */
  slideFraction?: number;
}
const DEFAULTS = { fps: 60, floor: 0, minSupport: 1, loopRotationDeg: 1, loopPositionM: 0.002, loopScale: 0.01,
  spikeRatio: 6, spikeMinDegPerSec: 180, spikeMinMetersPerSec: 1, penetrationM: 0.005, contactM: 0.002, slideFraction: 0.1 };

/** One precise failure: which clip, which bone, when, and which check. */
export interface ClipFinding {
  clip: string; bone: string; time: number; check: ClipCheckId; message: string;
  /** The measured value and the limit it broke, in the check's unit. */
  value: number; limit: number; unit: string;
  property?: 'rotation' | 'position' | 'scale';
  /** The span of samples the finding covers, when it covers more than one. */
  from?: number; to?: number;
}
export interface ClipCheck extends Omit<GaitCheck, 'pass'> {
  /** null when not evaluated. */
  pass: boolean | null; status: CheckStatus;
  /** Why a check was not evaluated. */
  reason?: string;
  findings: ClipFinding[];
}
export interface ClipSummary {
  clip: string; duration: number; tracks: number; keys: number;
  /** Tracks whose node is not in the scene or whose property is not position, rotation or scale. */
  unboundTracks: number; samples: number; ok: boolean; checks: ClipCheck[];
}
export interface ClipReport {
  format: typeof CLIP_REPORT_FORMAT; ok: boolean; feet: string[]; speed?: number;
  clips: ClipSummary[];
  /** Counts of checks over all clips. */
  summary: { pass: number; fail: number; notEvaluated: number };
  failures: ClipFinding[];
}

const DEG = 180 / Math.PI;
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
/** Angle in degrees of the rotation from a to b, from the vector part of conj(a) * b, which keeps its precision near zero. */
const rotationBetween = (a: Quaternion, b: Quaternion) => {
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y, y = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x, z = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  const w = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w)) * DEG;
};

interface TargetState { position: Vector3; quaternion: Quaternion; scale: Vector3; parentScale: number }
interface FootSample { height: number; x: number; z: number }

/** Sample times: a uniform grid plus every key time. `key` marks the key times, which the velocity check measures between. */
function sampleTimes(duration: number, fps: number, keyTimes: number[]): { times: number[]; key: boolean[] } {
  const tolerance = 1e-3, raw: { time: number; key: boolean }[] = [{ time: 0, key: true }, { time: duration, key: true }];
  for (let i = 1; i < Math.floor(duration * fps); i++) raw.push({ time: i / fps, key: false });
  for (const time of keyTimes) if (Number.isFinite(time) && time > 0 && time < duration) raw.push({ time, key: true });
  raw.sort((a, b) => a.time - b.time);
  const times: number[] = [], key: boolean[] = [];
  for (const entry of raw) {
    if (times.length && entry.time - times[times.length - 1] <= tolerance) {
      if (entry.key && !key[key.length - 1]) times[times.length - 1] = entry.time;
      key[key.length - 1] ||= entry.key;
    } else { times.push(entry.time); key.push(entry.key); }
  }
  if (duration <= 0) return { times: [0], key: [true] };
  // The loop check compares exactly the first and last poses of the clip.
  times[0] = 0; times[times.length - 1] = duration; key[0] = key[key.length - 1] = true;
  return { times, key };
}

/** Runs of consecutive flagged indices, as [first, last] pairs. */
function runs(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) { const start = i; while (i + 1 < flags.length && flags[i + 1]) i++; out.push([start, i]); }
  return out;
}

function soleVertices(source: GaitSource, foot: Object3D): { mesh: SkinnedMesh; index: number }[] {
  const below = new Set<Object3D>(); foot.traverse(object => below.add(object));
  const out: { mesh: SkinnedMesh; index: number }[] = [];
  source.scene.traverse(object => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    if (!indices || !weights) return;
    for (let i = 0; i < indices.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (weights.getComponent(i, k) > weights.getComponent(i, best)) best = k;
      if (weights.getComponent(i, best) > 0 && below.has(mesh.skeleton.bones[indices.getComponent(i, best)])) out.push({ mesh, index: i });
    }
  });
  return out;
}

function notEvaluated(id: ClipCheckId, label: string, limit: string, reason: string): ClipCheck {
  return { id, label, value: null, limit, pass: null, status: 'not-evaluated', reason, findings: [] };
}
function verdict(id: ClipCheckId, label: string, value: unknown, limit: string, findings: ClipFinding[]): ClipCheck {
  const pass = findings.length === 0;
  return { id, label, value, limit, pass, status: pass ? 'pass' : 'fail', findings };
}

function analyzeClip(source: GaitSource, name: string, options: ClipReportOptions, feetNames: string[]): ClipSummary {
  const clip = source.clips.find(candidate => candidate.name === name)!;
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as typeof DEFAULTS & ClipReportOptions;
  const bound: Bound[] = bindClip(source, clip);
  const keys = clip.tracks.reduce((sum, track) => sum + track.times.length, 0);
  const { times, key: isKey } = sampleTimes(clip.duration, o.fps, clip.tracks.flatMap(track => Array.from(track.times)));
  const keyed = times.map((_, i) => i).filter(i => isKey[i]);
  const targets = [...new Set(bound.map(entry => entry.target))];
  const properties = new Map<Object3D, Set<Bound['property']>>(targets.map(target => [target, new Set(bound.filter(entry => entry.target === target).map(entry => entry.property))]));
  const nodes = new Map<string, Object3D>();
  source.scene.traverse(object => { if (object.name && !nodes.has(object.name)) nodes.set(object.name, object); });
  const feet = feetNames.map(foot => ({ name: foot, node: nodes.get(foot)!, sole: soleVertices(source, nodes.get(foot)!) }));

  const states: Map<Object3D, TargetState>[] = [], footSamples: FootSample[][] = feet.map(() => []);
  const vertex = new Vector3();
  restore(source);
  for (const time of times) {
    pose(source, bound, time);
    const state = new Map<Object3D, TargetState>();
    for (const target of targets) {
      const parent = target.parent ? new Vector3().setFromMatrixScale(target.parent.matrixWorld) : new Vector3(1, 1, 1);
      state.set(target, { position: target.position.clone(), quaternion: target.quaternion.clone(), scale: target.scale.clone(), parentScale: (parent.x + parent.y + parent.z) / 3 });
    }
    states.push(state);
    feet.forEach((foot, f) => {
      let height = Infinity, x = 0, z = 0;
      for (const { mesh, index } of foot.sole) { mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld); height = Math.min(height, vertex.y); x += vertex.x; z += vertex.z; }
      const n = Math.max(1, foot.sole.length);
      footSamples[f].push({ height: height - o.floor, x: x / n, z: z / n });
    });
  }
  restore(source);

  const findings: Record<ClipCheckId, ClipFinding[]> = { 'loop-discontinuity': [], 'velocity-spike': [], 'foot-penetration': [], 'stance-sliding': [], 'support-count': [] };
  const last = states.length - 1, end = times[last];

  // Loop discontinuity: first pose against last, per animated bone and channel.
  let worstRotation = 0, worstPosition = 0, worstScale = 0;
  for (const target of targets) {
    const first = states[0].get(target)!, final = states[last].get(target)!, has = properties.get(target)!;
    const add = (property: 'rotation' | 'position' | 'scale', measured: number, limit: number, unit: string) => {
      const text = property === 'rotation' ? `${round(measured, 2)} deg` : property === 'position' ? `${round(measured * 1000, 2)} mm` : `${round(measured, 4)}`;
      findings['loop-discontinuity'].push({ clip: name, bone: target.name, time: round(end), check: 'loop-discontinuity', property, value: round(measured, 5), limit, unit,
        message: `${property} at the last key (t=${round(end)} s) differs from the first by ${text}; the loop is limited to ${limit} ${unit}` });
    };
    if (has.has('quaternion')) { const d = rotationBetween(first.quaternion, final.quaternion); worstRotation = Math.max(worstRotation, d); if (d > o.loopRotationDeg) add('rotation', d, o.loopRotationDeg, 'deg'); }
    if (has.has('position')) { const d = first.position.distanceTo(final.position) * final.parentScale; worstPosition = Math.max(worstPosition, d); if (d > o.loopPositionM) add('position', d, o.loopPositionM, 'm'); }
    if (has.has('scale')) { const d = Math.max(Math.abs(first.scale.x - final.scale.x), Math.abs(first.scale.y - final.scale.y), Math.abs(first.scale.z - final.scale.z)); worstScale = Math.max(worstScale, d); if (d > o.loopScale) add('scale', d, o.loopScale, ''); }
  }

  // Velocity spikes: between key times, a segment far faster than the joint's own median and fast in absolute terms.
  // A bad key makes the segments on both sides of it fast, so a run of two or more is reported at the key they share.
  let worstRatio = 0;
  for (const target of targets) {
    const has = properties.get(target)!;
    for (const [property, enabled, minimum, unit] of [['rotation', has.has('quaternion'), o.spikeMinDegPerSec, 'deg/s'], ['position', has.has('position'), o.spikeMinMetersPerSec, 'm/s']] as const) {
      if (!enabled || keyed.length < 2) continue;
      const speeds = keyed.slice(1).map((end, i) => {
        const start = keyed[i], a = states[start].get(target)!, b = states[end].get(target)!;
        return (property === 'rotation' ? rotationBetween(a.quaternion, b.quaternion) : a.position.distanceTo(b.position) * b.parentScale) / (times[end] - times[start]);
      });
      const typical = median(speeds), threshold = Math.max(minimum, o.spikeRatio * typical);
      if (typical > 0) worstRatio = Math.max(worstRatio, Math.max(...speeds) / typical);
      for (const [from, to] of runs(speeds.map(speed => speed > threshold))) {
        let peak = from;
        for (let i = from; i <= to; i++) if (speeds[i] > speeds[peak]) peak = i;
        // Segment i runs from key i to key i + 1; the key between segments i and i + 1 is key i + 1.
        let join = peak + 1, best = -1;
        for (let i = from; i < to; i++) { const pair = Math.min(speeds[i], speeds[i + 1]); if (pair > best) { best = pair; join = i + 1; } }
        const at = times[keyed[join]];
        findings['velocity-spike'].push({ clip: name, bone: target.name, time: round(at), from: round(times[keyed[from]]), to: round(times[keyed[to + 1]]), check: 'velocity-spike', property,
          value: round(speeds[peak], 2), limit: round(threshold, 2), unit,
          message: `${property} speed reaches ${round(speeds[peak], 1)} ${unit} around t=${round(at)} s (between t=${round(times[keyed[from]])} s and t=${round(times[keyed[to + 1]])} s); the joint's median is ${round(typical, 1)} ${unit} and the limit ${round(threshold, 1)} ${unit}` });
      }
    }
  }

  const checks: ClipCheck[] = [
    verdict('loop-discontinuity', 'Loop discontinuity (first pose against last)', { rotationDeg: round(worstRotation, 3), positionM: round(worstPosition, 5), ...(worstScale ? { scale: round(worstScale, 5) } : {}) },
      `<= ${o.loopRotationDeg} deg and ${o.loopPositionM} m per bone`, findings['loop-discontinuity']),
    verdict('velocity-spike', 'Joint velocity spikes', { peakOverMedian: round(worstRatio, 2) },
      `no speed over ${o.spikeRatio}x the joint's median that is also over ${o.spikeMinDegPerSec} deg/s (rotation) or ${o.spikeMinMetersPerSec} m/s (position)`, findings['velocity-spike']),
  ];

  // Foot checks, only for declared feet.
  const penetrationLimit = `sole no lower than ${o.penetrationM} m below the floor`;
  const slidingLimit = `planted sole within ${Math.round(o.slideFraction * 100)}% (at least 0.02 m/s) of the travel speed`;
  const supportLimit = `at least ${o.minSupport} planted foot at every sample`;
  const missing = feet.filter(foot => !foot.sole.length).map(foot => foot.name);
  const reason = !feet.length ? 'no foot declared; pass --foot <bone> for each foot' : missing.length ? `no skinned vertices follow foot bone ${missing.join(', ')}, so there is no sole to measure` : '';
  if (reason) {
    checks.push(notEvaluated('foot-penetration', 'Foot penetration', penetrationLimit, reason));
    checks.push(notEvaluated('stance-sliding', 'Stance sliding', slidingLimit, reason));
    checks.push(notEvaluated('support-count', 'Support count', supportLimit, reason));
  } else {
    // Penetration
    let deepest = 0;
    feet.forEach((foot, f) => {
      const heights = footSamples[f].map(sample => sample.height);
      deepest = Math.min(deepest, ...heights);
      for (const [from, to] of runs(heights.map(height => height < -o.penetrationM))) {
        let worst = from;
        for (let i = from; i <= to; i++) if (heights[i] < heights[worst]) worst = i;
        findings['foot-penetration'].push({ clip: name, bone: foot.name, time: round(times[worst]), from: round(times[from]), to: round(times[to]), check: 'foot-penetration', value: round(-heights[worst], 5), limit: o.penetrationM, unit: 'm',
          message: `sole is ${round(-heights[worst] * 1000, 1)} mm below the floor at t=${round(times[worst])} s; the limit is ${o.penetrationM * 1000} mm` });
      }
    });
    checks.push(verdict('foot-penetration', 'Foot penetration', { deepestM: round(-deepest, 5) }, penetrationLimit, findings['foot-penetration']));

    // Stance sliding
    if (o.speed === undefined) checks.push(notEvaluated('stance-sliding', 'Stance sliding', slidingLimit, 'no travel speed declared; pass --speed <m/s>'));
    else {
      const allowed = Math.max(o.slideFraction * o.speed, 0.02);
      let worstSlide = 0, plantedSegments = 0;
      feet.forEach((foot, f) => {
        const samples = footSamples[f], velocity: ([number, number] | null)[] = times.slice(1).map((time, i) => {
          const a = samples[i], b = samples[i + 1], dt = time - times[i];
          return a.height <= o.contactM && b.height <= o.contactM ? [(b.x - a.x) / dt, (b.z - a.z) / dt] : null;
        });
        const planted = velocity.flatMap(v => v ? [v] : []);
        if (!planted.length) return;
        plantedSegments += planted.length;
        // A planted foot of an in-place clip moves backward at the travel speed; the direction is the way it actually moves.
        const mean = planted.reduce((sum, v) => [sum[0] + v[0] / planted.length, sum[1] + v[1] / planted.length] as [number, number], [0, 0] as [number, number]), length = Math.hypot(...mean);
        const direction: [number, number] = length > 1e-6 ? [mean[0] / length, mean[1] / length] : [1, 0];
        const residual = velocity.map(v => v ? Math.hypot(v[0] - direction[0] * o.speed!, v[1] - direction[1] * o.speed!) : 0);
        worstSlide = Math.max(worstSlide, ...residual);
        for (const [from, to] of runs(residual.map(value => value > allowed))) {
          let worst = from;
          for (let i = from; i <= to; i++) if (residual[i] > residual[worst]) worst = i;
          findings['stance-sliding'].push({ clip: name, bone: foot.name, time: round(times[worst + 1]), from: round(times[from]), to: round(times[to + 1]), check: 'stance-sliding', value: round(residual[worst], 4), limit: round(allowed, 4), unit: 'm/s',
            message: `planted sole slides ${round(residual[worst], 3)} m/s off the ${round(o.speed!, 3)} m/s travel at t=${round(times[worst + 1])} s; the limit is ${round(allowed, 3)} m/s` });
        }
      });
      checks.push(plantedSegments ? verdict('stance-sliding', 'Stance sliding', { worstMetersPerSec: round(worstSlide, 4) }, slidingLimit, findings['stance-sliding'])
        : notEvaluated('stance-sliding', 'Stance sliding', slidingLimit, `no declared foot is planted within ${o.contactM} m of the floor for two samples in a row`));
    }

    // Support count
    if (feet.length < 2) checks.push(notEvaluated('support-count', 'Support count', supportLimit, 'support needs at least two declared feet'));
    else {
      const counts = times.map((_, i) => footSamples.filter(samples => samples[i].height <= o.contactM).length);
      for (const [from, to] of runs(counts.map(count => count < o.minSupport)))
        findings['support-count'].push({ clip: name, bone: feet.map(foot => foot.name).join('+'), time: round(times[from]), from: round(times[from]), to: round(times[to]), check: 'support-count', value: Math.min(...counts.slice(from, to + 1)), limit: o.minSupport, unit: 'feet',
          message: `${Math.min(...counts.slice(from, to + 1))} planted feet from t=${round(times[from])} s to t=${round(times[to])} s; at least ${o.minSupport} expected` });
      checks.push(verdict('support-count', 'Support count', { min: Math.min(...counts), max: Math.max(...counts) }, supportLimit, findings['support-count']));
    }
  }
  return { clip: name, duration: round(clip.duration, 5), tracks: clip.tracks.length, keys, unboundTracks: clip.tracks.length - bound.length, samples: times.length,
    ok: checks.every(check => check.status !== 'fail'), checks };
}

export function analyzeClips(source: GaitSource, options: ClipReportOptions = {}): ClipReport {
  if (options.clip !== undefined && !source.clips.some(clip => clip.name === options.clip))
    throw Object.assign(new Error(`No clip named ${options.clip}; clips: ${source.clips.map(clip => clip.name).join(', ') || 'none'}`), { code: 'CLIP_NOT_FOUND' });
  if (!source.clips.length) throw Object.assign(new Error('The GLB has no animation clips to report on'), { code: 'NO_CLIPS' });
  const feet = options.feet ?? [], names = new Set<string>();
  source.scene.traverse(object => { if (object.name) names.add(object.name); });
  const unknown = feet.filter(foot => !names.has(foot));
  if (unknown.length) throw Object.assign(new Error(`--foot names no node in the GLB: ${unknown.join(', ')}`), { code: 'FOOT_BONE' });
  if (options.speed !== undefined && !(Number.isFinite(options.speed) && options.speed >= 0)) throw Object.assign(new Error('speed must be a non-negative number of m/s'), { code: 'CLIP_REPORT_ARGUMENT' });
  const clips = source.clips.filter(clip => options.clip === undefined || clip.name === options.clip).map(clip => analyzeClip(source, clip.name, options, feet));
  const all = clips.flatMap(clip => clip.checks);
  return { format: CLIP_REPORT_FORMAT, ok: clips.every(clip => clip.ok), feet, ...(options.speed !== undefined ? { speed: options.speed } : {}), clips,
    summary: { pass: all.filter(check => check.status === 'pass').length, fail: all.filter(check => check.status === 'fail').length, notEvaluated: all.filter(check => check.status === 'not-evaluated').length },
    failures: all.flatMap(check => check.findings) };
}

export async function clipReport(bytes: Uint8Array, options: ClipReportOptions = {}): Promise<ClipReport> {
  return analyzeClips(await loadGait(bytes), options);
}

/** Readable text: one block per clip, one line per check, and one FAIL line per finding naming clip, bone, time and check. */
export function formatClipReport(report: ClipReport): string {
  const lines: string[] = [];
  for (const clip of report.clips) {
    lines.push(`clip ${clip.clip}: ${clip.duration} s, ${clip.tracks} tracks, ${clip.keys} keys, ${clip.samples} samples${clip.unboundTracks ? `, ${clip.unboundTracks} tracks bind to nothing` : ''}`);
    for (const check of clip.checks) {
      const tag = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'NOT-EVALUATED';
      lines.push(`  ${tag} ${check.id}: ${check.status === 'not-evaluated' ? check.reason : `${JSON.stringify(check.value)} (limit ${check.limit})`}`);
      for (const finding of check.findings) lines.push(`    FAIL clip ${finding.clip} bone ${finding.bone} t=${finding.time} s [${finding.check}] ${finding.message}`);
    }
  }
  const { pass, fail, notEvaluated: skipped } = report.summary;
  lines.push(`${report.ok ? 'ok' : 'FAILED'}: ${pass} passed, ${fail} failed, ${skipped} not evaluated`);
  return lines.join('\n');
}
