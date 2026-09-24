import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARKIT_FACE_CONTRACT, ARKIT_FACE_REQUIRED_BONES, ARKIT_FACE_REQUIRED_MORPHS, contractExpectations } from '../src/arkit-face.ts';
import {
  acquireProjectLock, buildUnrealReport, checkUnrealReport, findUnreal, parseNameList, parseUnrealLog,
  scratchProject, unrealCommandLine, type ParsedUnrealLog, type UnrealRawReport,
} from '../src/unreal.ts';
import { verifyGLB } from '../src/export.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'am unreal ')); cleanup.push(dir); return dir; };

describe('arkit-face/1 contract module', () => {
  it('lists the 21 required morphs and three bones exactly as rig-contract.md names them', () => {
    expect(ARKIT_FACE_CONTRACT).toBe('arkit-face/1');
    expect(ARKIT_FACE_REQUIRED_MORPHS).toHaveLength(21);
    expect(new Set(ARKIT_FACE_REQUIRED_MORPHS).size).toBe(21);
    expect(ARKIT_FACE_REQUIRED_MORPHS).toEqual(expect.arrayContaining(['eyeBlinkLeft', 'jawOpen', 'mouthFunnel', 'browInnerUp', 'cheekSquintRight']));
    expect(ARKIT_FACE_REQUIRED_BONES).toEqual(['head', 'eye_L', 'eye_R']);
    expect(contractExpectations('arkit-face/1')).toEqual({ morphs: [...ARKIT_FACE_REQUIRED_MORPHS], bones: [...ARKIT_FACE_REQUIRED_BONES] });
    expect(() => contractExpectations('arkit-face/2')).toThrow(/Unknown contract "arkit-face\/2"/);
  });
});

describe('fixture GLB', () => {
  it('builds a valid skinned GLB with every required morph and bone', async () => {
    const bytes = arkitFaceFixtureGLB();
    const verification = await verifyGLB(bytes);
    expect(verification.errors).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true))));
    expect(json.meshes[0].extras.targetNames).toEqual([...ARKIT_FACE_REQUIRED_MORPHS]);
    expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(['head', 'eye_L', 'eye_R']));
  });
});

describe('findUnreal', () => {
  const layout = async (root: string, version: string) => {
    const bin = join(root, `UE_${version}`, 'Engine', 'Binaries', 'Win64'); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'UnrealEditor-Cmd.exe'), '');
    const [major, minor] = version.split('.').map(Number);
    await mkdir(join(root, `UE_${version}`, 'Engine', 'Build'), { recursive: true });
    await writeFile(join(root, `UE_${version}`, 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: major, MinorVersion: minor, PatchVersion: 3 }));
    return join(bin, 'UnrealEditor-Cmd.exe');
  };

  it('prefers the newest engine under a searched Epic Games root', async () => {
    const root = await temp(); await layout(root, '5.6'); const newest = await layout(root, '5.7');
    const found = findUnreal({ env: {}, platform: 'win32', roots: [join(root, 'missing'), root], launcherManifest: join(root, 'none.dat') });
    expect(found).toMatchObject({ editor: newest, version: '5.7.3', source: 'search' });
  });

  it('honors AGENT_MESHES_UNREAL as an editor executable or an engine directory', async () => {
    const root = await temp(); const editor = await layout(root, '5.7');
    expect(findUnreal({ env: { AGENT_MESHES_UNREAL: editor }, platform: 'win32', roots: [] })).toMatchObject({ editor, source: 'AGENT_MESHES_UNREAL' });
    expect(findUnreal({ env: { AGENT_MESHES_UNREAL: join(root, 'UE_5.7') }, platform: 'win32', roots: [] })).toMatchObject({ editor, version: '5.7.3' });
    expect(findUnreal({ env: { AGENT_MESHES_UNREAL: join(root, 'UE_5.7', 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe') }, platform: 'win32', roots: [] })).toMatchObject({ editor });
  });

  it('fails clearly when AGENT_MESHES_UNREAL points nowhere, instead of silently searching', async () => {
    const root = await temp(); await layout(root, '5.7');
    expect(() => findUnreal({ env: { AGENT_MESHES_UNREAL: join(root, 'nope') }, platform: 'win32', roots: [root] })).toThrow(/AGENT_MESHES_UNREAL.*does not contain UnrealEditor-Cmd/);
  });

  it('reads engine locations from the Epic launcher manifest', async () => {
    const root = await temp(); const editor = await layout(join(root, 'custom place'), '5.7');
    const manifest = join(root, 'LauncherInstalled.dat');
    await writeFile(manifest, JSON.stringify({ InstallationList: [{ AppName: 'UE_5.7', InstallLocation: join(root, 'custom place', 'UE_5.7') }, { AppName: 'Fortnite', InstallLocation: root }] }));
    expect(findUnreal({ env: {}, platform: 'win32', roots: [], launcherManifest: manifest })).toMatchObject({ editor, source: 'launcher' });
  });

  it('returns null when no engine is installed', async () => {
    expect(findUnreal({ env: {}, platform: 'win32', roots: [await temp()], launcherManifest: join(await temp(), 'none.dat') })).toBeNull();
  });
});

describe('argument helpers', () => {
  it('splits comma lists, trimming blanks and duplicates', () => {
    expect(parseNameList(' jawOpen, eyeBlinkLeft,,jawOpen ')).toEqual(['jawOpen', 'eyeBlinkLeft']);
    expect(() => parseNameList(' , ')).toThrow(/at least one name/);
  });

  it('builds a headless command line with forward-slash paths that survive spaces and UE escape parsing', () => {
    const args = unrealCommandLine({ project: 'C:\\Users\\a b\\cache\\Verify.uproject', script: 'C:\\x\\5e\\try.py', log: 'C:\\Users\\a b\\logs\\run.log' });
    expect(args[0]).toBe('C:/Users/a b/cache/Verify.uproject');
    expect(args).toContain('-run=pythonscript');
    expect(args).toContain('-script=C:/x/5e/try.py');
    expect(args).toContain('-abslog=C:/Users/a b/logs/run.log');
    for (const flag of ['-unattended', '-nullrhi', '-nosplash', '-nopause', '-nosound', '-stdout']) expect(args).toContain(flag);
  });
});

describe('scratch project', () => {
  it('writes a minimal project enabling Python and Interchange once, and reuses it', async () => {
    const cache = join(await temp(), 'cache dir');
    const first = await scratchProject(cache);
    const project = JSON.parse(await readFile(first.project, 'utf8'));
    expect(project.Plugins).toEqual(expect.arrayContaining([
      { Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'Interchange', Enabled: true },
      { Name: 'InterchangeEditor', Enabled: true }, { Name: 'InterchangeAssets', Enabled: true },
    ]));
    await mkdir(join(first.root, 'Content', 'Verify', 'old'), { recursive: true });
    const second = await scratchProject(cache);
    expect(second).toMatchObject({ project: first.project, created: false });
    expect(first.created).toBe(true);
    expect(existsSync(join(first.root, 'Content', 'Verify'))).toBe(false); // stale imports from a killed run are cleared
  });

  it('replaces a stale lock whose owner process is gone and refuses a live one', async () => {
    const dir = await temp(); const lock = join(dir, 'verify.lock');
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, started: 0 }));
    const release = await acquireProjectLock(dir, { waitMs: 0 });
    expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(process.pid);
    await expect(acquireProjectLock(dir, { waitMs: 50 })).rejects.toThrow(/another verify-unreal run \(pid \d+\) is using/);
    await release();
    expect(existsSync(lock)).toBe(false);
  });
});

const LOG = [
  '[2026.09.24-22.15.10:000][  0]LogPython: Error: early engine noise',
  '[2026.09.24-22.15.15:900][  0]LogPython: AGENT_MESHES_IMPORT_BEGIN',
  '[2026.09.24-22.15.15:976][  0]LogInterchangeImport: Warning: Node [Face] with a skinned mesh is not root.',
  '[2026.09.24-22.15.15:977][  0]LogInterchangeImport: Error: Invalid morph target data.',
  '[2026.09.24-22.15.15:978][  0]LogInterchangeImport: Error: Invalid morph target data.',
  '[2026.09.24-22.15.15:987][  0]LogInterchangeCore: Warning: The Interchange.MaxAssetPathLength value (160) is too high.',
  'Content path: \'C:/x/Content/\'',
  '[2026.09.24-22.15.16:063][  0]LogInterchangeEngine: Display: Interchange import completed',
  '[2026.09.24-22.15.16:070][  0]LogPython: AGENT_MESHES_IMPORT_END',
  '[2026.09.24-22.15.16:079][  0]LogInit: Display: Warning/Error Summary (Unique only)',
  '[2026.09.24-22.15.16:080][  0]LogInit: Display: LogInterchangeImport: Error: Invalid morph target data.',
].join('\r\n');

describe('parseUnrealLog', () => {
  it('separates import-window errors and warnings from engine noise and the summary echo', () => {
    const parsed = parseUnrealLog(LOG);
    expect(parsed.importErrors).toEqual(['LogInterchangeImport: Error: Invalid morph target data.']);
    expect(parsed.importWarnings).toEqual([
      'LogInterchangeImport: Warning: Node [Face] with a skinned mesh is not root.',
      'LogInterchangeCore: Warning: The Interchange.MaxAssetPathLength value (160) is too high.',
    ]);
    expect(parsed.otherErrors).toEqual(['LogPython: Error: early engine noise']);
    expect(parsed.interchangeCompleted).toBe(true);
    expect(parsed.windowFound).toBe(true);
  });

  it('treats a log without the import markers as a failed window', () => {
    expect(parseUnrealLog('LogInit: Error: boom').windowFound).toBe(false);
  });
});

export const RAW: UnrealRawReport = {
  ok: true, engineVersion: '5.7.3-50162420+++UE5+Release-5.7', destination: '/Game/Verify/pip', importReturned: true,
  assets: [
    { path: '/Game/Verify/pip/pip/SkeletalMeshes/pip', class: 'SkeletalMesh' },
    { path: '/Game/Verify/pip/pip/SkeletalMeshes/pip_Skeleton', class: 'Skeleton' },
    { path: '/Game/Verify/pip/pip/SkeletalMeshes/pip_PhysicsAsset', class: 'PhysicsAsset' },
    { path: '/Game/Verify/pip/pip/Materials/Skin', class: 'MaterialInstanceConstant' },
    { path: '/Game/Verify/pip/pip/Textures/Albedo', class: 'Texture2D' },
  ],
  skeletalMeshes: [{
    path: '/Game/Verify/pip/pip/SkeletalMeshes/pip', skeleton: '/Game/Verify/pip/pip/SkeletalMeshes/pip_Skeleton',
    morphTargets: [...ARKIT_FACE_REQUIRED_MORPHS], bones: ['head', 'eye_L', 'eye_R'], lods: 1, vertices: [812], materialSlots: 2,
  }],
  staticMeshes: [],
};

describe('buildUnrealReport', () => {
  it('groups assets by class and merges parsed log findings', () => {
    const report = buildUnrealReport(RAW, parseUnrealLog(LOG), { input: 'C:/a/pip.glb', editor: 'C:/UE/UnrealEditor-Cmd.exe', version: '5.7.3', exitCode: 0, logFile: 'C:/l.log', elapsedMs: 1234 });
    expect(report.assetsByClass).toEqual({
      SkeletalMesh: ['/Game/Verify/pip/pip/SkeletalMeshes/pip'], Skeleton: ['/Game/Verify/pip/pip/SkeletalMeshes/pip_Skeleton'],
      PhysicsAsset: ['/Game/Verify/pip/pip/SkeletalMeshes/pip_PhysicsAsset'], MaterialInstanceConstant: ['/Game/Verify/pip/pip/Materials/Skin'],
      Texture2D: ['/Game/Verify/pip/pip/Textures/Albedo'],
    });
    expect(report.summary).toEqual({ skeletalMeshes: 1, skeletons: 1, materials: 1, textures: 1, animations: 0, staticMeshes: 0 });
    expect(report.morphTargets).toEqual([...ARKIT_FACE_REQUIRED_MORPHS]);
    expect(report.bones).toEqual(['head', 'eye_L', 'eye_R']);
    expect(report.log).toMatchObject({ file: 'C:/l.log', importErrors: ['LogInterchangeImport: Error: Invalid morph target data.'] });
    expect(report.importer).toBe('Interchange');
    expect(report.verified).toMatch(/import only/);
  });
});

describe('checkUnrealReport', () => {
  const clean: ParsedUnrealLog = { importErrors: [], importWarnings: [], otherErrors: [], interchangeCompleted: true, windowFound: true };
  const build = (raw: UnrealRawReport, log = clean, exitCode = 0) => buildUnrealReport(raw, log, { input: 'x.glb', editor: 'e', version: '5.7.3', exitCode, logFile: 'l', elapsedMs: 1 });
  const contract = contractExpectations('arkit-face/1');

  it('passes a clean arkit-face import', () => {
    expect(checkUnrealReport(build(RAW), { ...contract, requireSkeletalMesh: true })).toEqual([]);
  });

  it('lists every missing morph and bone, pointing out case-only renames', () => {
    const raw = structuredClone(RAW);
    raw.skeletalMeshes[0].morphTargets = raw.skeletalMeshes[0].morphTargets.filter(n => n !== 'jawOpen' && n !== 'eyeBlinkLeft').concat('EyeBlinkLeft');
    raw.skeletalMeshes[0].bones = ['root', 'head', 'eye_L'];
    const failures = checkUnrealReport(build(raw), { ...contract, requireSkeletalMesh: true });
    expect(failures).toEqual([
      'missing morph target "eyeBlinkLeft" (Unreal has "EyeBlinkLeft": names must survive verbatim)',
      'missing morph target "jawOpen"',
      'missing bone "eye_R"',
    ]);
  });

  it('fails when no SkeletalMesh was created, on import errors, script errors and a bad exit code', () => {
    const raw = { ...structuredClone(RAW), skeletalMeshes: [], assets: [{ path: '/Game/Verify/pip/pip', class: 'StaticMesh' }] };
    const log = { ...clean, importErrors: ['LogInterchangeImport: Error: bad'] };
    expect(checkUnrealReport(build(raw, log, 1), { morphs: [], bones: [], requireSkeletalMesh: true })).toEqual([
      'Unreal exited with code 1', 'no SkeletalMesh was created (assets: StaticMesh)', '1 import error(s): LogInterchangeImport: Error: bad',
    ]);
    const failedScript = { ...structuredClone(RAW), ok: false, error: 'Traceback: boom' };
    expect(checkUnrealReport(build(failedScript), { morphs: [], bones: [], requireSkeletalMesh: false })).toEqual(['import script failed: Traceback: boom']);
    expect(checkUnrealReport(build(RAW, { ...clean, windowFound: false }), { morphs: [], bones: [], requireSkeletalMesh: false })).toEqual(['the import script never ran (no AGENT_MESHES_IMPORT_BEGIN/END in the log)']);
    const slow = buildUnrealReport(RAW, { ...clean, windowFound: false }, { input: 'x.glb', editor: 'e', version: '5.7.3', exitCode: -1, logFile: 'l.log', elapsedMs: 1, timeoutMs: 2000 });
    expect(checkUnrealReport(slow, { morphs: [], bones: [], requireSkeletalMesh: true })).toEqual(['Unreal did not finish within 2 s and was stopped; see l.log']);
  });

  it('checks arbitrary expectations without a contract', () => {
    expect(checkUnrealReport(build(RAW), { morphs: ['jawOpen', 'smile'], bones: ['head', 'spine'], requireSkeletalMesh: true }))
      .toEqual(['missing morph target "smile"', 'missing bone "spine"']);
  });
});
