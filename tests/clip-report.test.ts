import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clipReport, formatClipReport, type ClipReport } from '../src/clip-report.ts';
import { applyOperation } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { wagGLB, wagProject } from './helpers/clip-glb.ts';
import { walkerGLB } from './helpers/gait-glb.ts';

const run = promisify(execFile), directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), 'mesh-clip-report-')); directories.push(directory); return directory; };
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 60000, windowsHide: true });
const check = (report: ClipReport, id: string) => report.clips[0].checks.find(candidate => candidate.id === id)!;
const walkSpeed = 0.6 / (0.55 * 1.2);
const feet = ['foot_l', 'foot_r'];

it('passes loop discontinuity and velocity spikes on the unmodified clip of a non-biped rig', async () => {
  const report = await clipReport(await wagGLB());
  expect(report.ok).toBe(true);
  expect(report.clips.map(clip => clip.clip)).toEqual(['wag']);
  expect(check(report, 'loop-discontinuity')).toMatchObject({ status: 'pass', pass: true, findings: [] });
  expect(check(report, 'velocity-spike')).toMatchObject({ status: 'pass', pass: true, findings: [] });
});

it('names clip, bone, time and check for a loop whose last key is shifted', async () => {
  const report = await clipReport(await wagGLB({ seamDegrees: 20, seamMetres: 0.05 }));
  expect(report.ok).toBe(false);
  const loop = check(report, 'loop-discontinuity');
  expect(loop).toMatchObject({ status: 'fail', pass: false });
  expect(loop.findings).toEqual([
    expect.objectContaining({ clip: 'wag', bone: 'tail', property: 'rotation', time: 2, check: 'loop-discontinuity', value: expect.closeTo(20, 1) }),
    expect.objectContaining({ clip: 'wag', bone: 'root', property: 'position', time: 2, check: 'loop-discontinuity', value: expect.closeTo(0.05, 3) }),
  ]);
  expect(check(report, 'velocity-spike').status).toBe('pass');
  const text = formatClipReport(report);
  expect(text).toMatch(/FAIL clip wag bone tail t=2 s \[loop-discontinuity\]/);
  expect(text).toMatch(/FAIL clip wag bone root t=2 s \[loop-discontinuity\]/);
});

it('names clip, bone, time and check for a single-key velocity spike', async () => {
  // Key 10 is at t=1 s, where the tail is at rest; one key at 60 degrees is a pop up and back.
  const report = await clipReport(await wagGLB({ spike: { index: 10, degrees: 60 } }));
  const spike = check(report, 'velocity-spike');
  expect(spike.status).toBe('fail');
  expect(spike.findings).toHaveLength(1);
  expect(spike.findings[0]).toMatchObject({ clip: 'wag', bone: 'tail', property: 'rotation', check: 'velocity-spike', unit: 'deg/s' });
  expect(spike.findings[0].value).toBeGreaterThan(500);
  expect(spike.findings[0].from).toBeLessThanOrEqual(1);
  expect(spike.findings[0].to).toBeGreaterThanOrEqual(1);
  expect(spike.findings[0].time).toBe(1);
  expect(check(report, 'loop-discontinuity').status).toBe('pass');
  expect(report.failures.map(finding => `${finding.clip}/${finding.bone}/${finding.check}`)).toEqual(['wag/tail/velocity-spike']);
});

it('reports foot checks as not-evaluated, never pass, when no foot is declared or a needed input is missing', async () => {
  const bytes = await wagGLB();
  const none = await clipReport(bytes);
  for (const id of ['foot-penetration', 'stance-sliding', 'support-count']) expect(check(none, id)).toMatchObject({ status: 'not-evaluated', pass: null, findings: [] });
  expect(check(none, 'foot-penetration').reason).toMatch(/--foot/);
  expect(none.ok).toBe(true);
  expect(formatClipReport(none)).toMatch(/NOT-EVALUATED foot-penetration/);
  // A declared bone with no skinned vertices has no sole to measure.
  const paw = await exportGLB(applyOperation(wagProject(), { op: 'bone.add', bone: { name: 'paw', parent: 'root', position: [0.2, 0, 0] } }));
  const soleless = await clipReport(paw, { feet: ['paw', 'root'], speed: 1 });
  for (const id of ['foot-penetration', 'stance-sliding', 'support-count']) expect(check(soleless, id)).toMatchObject({ status: 'not-evaluated', reason: expect.stringContaining('paw') });
  const walker = await walkerGLB();
  const noSpeed = await clipReport(walker, { feet });
  expect(check(noSpeed, 'stance-sliding')).toMatchObject({ status: 'not-evaluated', reason: expect.stringContaining('--speed') });
  expect(check(noSpeed, 'foot-penetration').status).toBe('pass');
  const oneFoot = await clipReport(walker, { feet: ['foot_l'], speed: walkSpeed });
  expect(check(oneFoot, 'support-count')).toMatchObject({ status: 'not-evaluated', reason: expect.stringContaining('two') });
}, 60000);

it('evaluates penetration, stance sliding and support for declared feet and passes a clean walk', async () => {
  const report = await clipReport(await walkerGLB(), { feet, speed: walkSpeed });
  expect(report.clips[0].checks.map(candidate => `${candidate.id}:${candidate.status}`)).toEqual([
    'loop-discontinuity:pass', 'velocity-spike:pass', 'foot-penetration:pass', 'stance-sliding:pass', 'support-count:pass']);
  expect(report.ok).toBe(true);
}, 60000);

it('names the foot, time and check for a sole through the floor, a skating stance and a flight phase', async () => {
  const sunk = await clipReport(await walkerGLB({ lift: -0.03 }), { feet });
  const penetration = check(sunk, 'foot-penetration');
  expect(penetration.status).toBe('fail');
  expect(penetration.findings[0]).toMatchObject({ clip: 'walk', check: 'foot-penetration', unit: 'm' });
  expect(feet).toContain(penetration.findings[0].bone);
  expect(penetration.findings[0].value).toBeGreaterThan(0.02);
  const skating = await clipReport(await walkerGLB(), { feet, speed: 0.3 });
  const sliding = check(skating, 'stance-sliding');
  expect(sliding.status).toBe('fail');
  expect([...new Set(sliding.findings.map(finding => finding.bone))].sort()).toEqual(feet);
  expect(sliding.findings[0]).toMatchObject({ clip: 'walk', check: 'stance-sliding', unit: 'm/s' });
  // A run: a short stance leaves both feet in the air; --min-support 0 accepts that.
  const flight = await clipReport(await walkerGLB({ stance: 0.35 }), { feet });
  const support = check(flight, 'support-count');
  expect(support.status).toBe('fail');
  expect(support.findings[0]).toMatchObject({ clip: 'walk', bone: 'foot_l+foot_r', check: 'support-count', value: 0 });
  expect(check(await clipReport(await walkerGLB({ stance: 0.35 }), { feet, minSupport: 0 }), 'support-count').status).toBe('pass');
}, 60000);

it('sees a walker whose loop seam is open on the foot bone', async () => {
  const report = await clipReport(await walkerGLB({ seamError: 0.1 }));
  // The knee follows the foot, so it opens too; the foot bone is named with the shifted distance.
  expect(check(report, 'loop-discontinuity').findings).toContainEqual(expect.objectContaining({ clip: 'walk', bone: 'foot_l', time: 1.2, property: 'position', value: expect.closeTo(0.1, 3) }));
  expect(check(report, 'loop-discontinuity').findings.every(finding => ['foot_l', 'calf_l'].includes(finding.bone))).toBe(true);
}, 60000);

it('rejects an unknown clip, an unknown foot and a GLB without clips', async () => {
  const bytes = await wagGLB();
  await expect(clipReport(bytes, { clip: 'nope' })).rejects.toMatchObject({ code: 'CLIP_NOT_FOUND', message: expect.stringContaining('wag') });
  await expect(clipReport(bytes, { feet: ['paw'] })).rejects.toMatchObject({ code: 'FOOT_BONE' });
  await expect(clipReport(await exportGLB(wagProject([])))).rejects.toMatchObject({ code: 'NO_CLIPS' });
});

it('clip-report prints text and exits 1 on a corrupted clip, and --json prints the machine-readable report', async () => {
  const directory = await temp(), good = join(directory, 'good.glb'), bad = join(directory, 'bad.glb');
  await writeFile(good, await wagGLB()); await writeFile(bad, await wagGLB({ spike: { index: 10, degrees: 60 }, seamDegrees: 20 }));
  const pass = await cli('clip-report', good);
  expect(pass.stdout).toMatch(/PASS loop-discontinuity/);
  expect(pass.stdout).toMatch(/NOT-EVALUATED stance-sliding: no foot declared/);
  await expect(cli('clip-report', bad)).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/FAIL clip wag bone tail t=2 s \[loop-discontinuity\][\s\S]*FAIL clip wag bone tail t=1 s \[velocity-spike\]/) });
  const json = await cli('clip-report', bad, '--clip', 'wag', '--json').catch((error: { stdout: string; code: number }) => { expect(error.code).toBe(1); return error; });
  const report = JSON.parse(json.stdout) as ClipReport;
  expect(report).toMatchObject({ format: 'agent-meshes/clip-report/1', ok: false, summary: { fail: 2, notEvaluated: 3 } });
  expect(report.failures.map(finding => finding.check).sort()).toEqual(['loop-discontinuity', 'velocity-spike']);
  await expect(cli('clip-report', good, '--clip', 'nope')).rejects.toMatchObject({ stderr: expect.stringContaining('No clip named nope') });
  await expect(cli('clip-report', good, '--speed', '-1')).rejects.toMatchObject({ stderr: expect.stringContaining('--speed') });
}, 120000);

it('clip-report takes repeatable --foot and --speed on a walker GLB', async () => {
  const file = join(await temp(), 'walker.glb'); await writeFile(file, await walkerGLB());
  const out = await cli('clip-report', file, '--foot', 'foot_l', '--foot', 'foot_r', '--speed', String(walkSpeed));
  expect(out.stdout).toMatch(/PASS foot-penetration/);
  expect(out.stdout).toMatch(/PASS stance-sliding/);
  expect(out.stdout).toMatch(/PASS support-count/);
}, 120000);
