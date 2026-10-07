import { describe, expect, it } from 'vitest';
import { applyOperation, createProject } from '../src/core/model.ts';
import { geometryFor } from '../src/geometry.ts';
import { latheWinding, lintProject } from '../src/project-lint.ts';
import { inspectProject, planOperations } from '../src/agent-contract.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Operation, Part, Vec2 } from '../src/core/types.ts';

// The engine bell from the Sector Run kit: inner wall top to bottom, then outer wall bottom to top (renders correctly).
const bell: Vec2[] = [[0.2, 0.5], [0.22, 0.1], [0.4, -0.5], [0.5, -0.5], [0.32, 0.2], [0.28, 0.5]];
// The first attempt: outer wall first, top to bottom, then the inner wall (rendered inside out, silently).
const bellInsideOut: Vec2[] = [...bell].reverse();
const pawn: Vec2[] = [[0, -0.5], [0.5, -0.5], [0.5, -0.4], [0.2, 0], [0.3, 0.3], [0, 0.5]];

const lathePart = (profile: Vec2[], extra: Partial<Part['geometry']> = {}): Part =>
  applyOperation(createProject('p'), { op: 'add', part: { name: 'turned', geometry: { type: 'lathe', size: [1, 1, 1], segments: 24, profile, ...extra } } }).parts[0];

/** Signed volume of the revolved surface after closing the profile: positive when every face points out of the material. */
function signedVolume(profile: Vec2[], extra: Partial<Part['geometry']> = {}): number {
  const geometry = geometryFor(lathePart([...profile, profile[0]], extra));
  const p = geometry.getAttribute('position'), index = geometry.getIndex()!;
  let volume = 0;
  for (let i = 0; i < index.count; i += 3) {
    const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)].map(k => [p.getX(k), p.getY(k), p.getZ(k)]);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return volume;
}

describe('lathe winding', () => {
  it('agrees with the faces the renderer builds: bottom to top faces out, top to bottom faces in', () => {
    for (const [profile, expected] of [[pawn, 'outward'], [[...pawn].reverse(), 'inward'], [bell, 'outward'], [bellInsideOut, 'inward']] as const) {
      expect(latheWinding(profile)).toBe(expected);
      expect(Math.sign(signedVolume([...profile]))).toBe(expected === 'outward' ? 1 : -1);
    }
  });

  it('holds for the hard-edged, metre and sector lathes too', () => {
    const plinth: Vec2[] = [[0, 0], [0.4, 0], [0.4, 0.1], [0.2, 0.1], [0.2, 0.5], [0, 0.5]];
    expect(latheWinding(plinth)).toBe('outward');
    expect(signedVolume(plinth, { profileUnits: 'metres', corners: [2, 3] })).toBeGreaterThan(0);
    expect(signedVolume([...plinth].reverse(), { profileUnits: 'metres', corners: [2, 3] })).toBeLessThan(0);
  });

  it('judges a single wall by its direction and leaves a flat profile alone', () => {
    expect(latheWinding([[0.5, -0.5], [0.5, 0], [0.5, 0.5]])).toBe('outward');
    expect(latheWinding([[0.5, 0.5], [0.5, 0], [0.5, -0.5]])).toBe('inward');
    expect(latheWinding([[0, 0], [0.25, 0], [0.5, 0]])).toBe('flat');
  });
});

describe('lintProject', () => {
  const add = (name: string, profile: Vec2[], extra: Partial<Part['geometry']> = {}): Operation => ({ op: 'add', part: { name, geometry: { type: 'lathe', size: [1, 1, 1], profile, ...extra } } });

  it('warns about an inward lathe by name, with a code and a fix, and stays silent on valid profiles', () => {
    let project = createProject('engine');
    for (const op of [add('bell_ok', bell), add('bell_bad', bellInsideOut, { corners: [0, 2] }), add('pawn', pawn), { op: 'add', part: { name: 'box' } } as Operation]) project = applyOperation(project, op);
    const warnings = lintProject(project);
    expect(warnings).toEqual([{ code: 'LATHE_PROFILE_INWARD', part: 'bell_bad', message: expect.stringContaining('renders inside out'), hint: expect.stringContaining('Reverse the profile array and corners [3,5]') }]);
    expect(warnings[0].message).toMatch(/^Part "bell_bad": /);
    expect(warnings[0].hint).toContain('bottom to top');
  });

  it('reaches agents through the plan report and inspect, and stays out of them when there is nothing to say', () => {
    const report = planOperations(createProject('engine'), [add('bell', bellInsideOut)]).report;
    expect(report.warnings).toEqual([expect.objectContaining({ code: 'LATHE_PROFILE_INWARD', part: 'bell' })]);
    expect(planOperations(createProject('engine'), [add('bell', bell)]).report).not.toHaveProperty('warnings');
    const project = applyOperation(createProject('engine'), add('bell', bellInsideOut) as Extract<Operation, { op: 'add' }>);
    expect(inspectProject(project).warnings).toEqual([expect.objectContaining({ part: 'bell' })]);
    expect(inspectProject(createProject('empty'))).not.toHaveProperty('warnings');
  });

  it('ignores lathes inside a shell, which are rebuilt as a smooth field', () => {
    let project = createProject('blob');
    for (const op of [add('hoof', [...pawn].reverse()), { op: 'add', part: { name: 'leg', geometry: { type: 'capsule', size: [0.2, 1, 0.2] } } } as Operation,
      { op: 'shell.set', shell: { name: 'skin', parts: ['hoof', 'leg'], blend: 0.05, resolution: 24 } } as Operation]) project = applyOperation(project, op);
    expect(lintProject(project)).toEqual([]);
  });
});

describe('the CLI', () => {
  const run = promisify(execFile);
  const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 30000, windowsHide: true });
  const bellOp = (profile: Vec2[]) => [{ op: 'add', part: { name: 'bell', geometry: { type: 'lathe', size: [0.85, 0.6, 0.85], segments: 12, profile } } }];

  it('warns on batch --dry-run, batch and inspect in a workspace and in a build, and is silent for a valid bell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mesh-lathe-lint-'));
    try {
      const workspace = join(directory, 'ws'), bad = join(directory, 'bad.json'), good = join(directory, 'good.json');
      await writeFile(bad, JSON.stringify(bellOp(bellInsideOut))); await writeFile(good, JSON.stringify(bellOp(bell)));
      const json = async (...args: string[]) => JSON.parse((await cli('--workspace', workspace, ...args)).stdout);
      expect((await json('batch', good, '--dry-run')).warnings).toBeUndefined();
      expect((await json('batch', bad, '--dry-run')).warnings).toEqual([expect.objectContaining({ code: 'LATHE_PROFILE_INWARD', part: 'bell' })]);
      const applied = await json('batch', bad);
      expect(applied).toMatchObject({ revision: 1, warnings: [{ code: 'LATHE_PROFILE_INWARD', part: 'bell' }] });
      expect((await json('inspect')).warnings).toEqual([expect.objectContaining({ part: 'bell', hint: expect.stringContaining('Reverse the profile array') })]);
      await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, name: 'bell', operations: 'bad.json', output: 'dist' }));
      const built = JSON.parse((await cli('build', join(directory, 'build.json'), '--no-preview')).stdout);
      expect(built.warnings).toEqual([expect.objectContaining({ code: 'LATHE_PROFILE_INWARD', part: 'bell' })]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60000);
});
