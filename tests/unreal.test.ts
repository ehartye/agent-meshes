import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARKIT_FACE_CONTRACT, ARKIT_FACE_REQUIRED_BONES, ARKIT_FACE_REQUIRED_MORPHS, contractExpectations } from '../src/arkit-face.ts';
import {
  acquireProjectLock, buildUnrealReport, checkUnrealReport, findUnreal, parseNameList, parseUnrealLog,
  scratchProject, unrealCommandLine, unrealImportName, type ParsedUnrealLog, type UnrealRawReport,
} from '../src/unreal.ts';
import { auditMorphNames } from '../src/gltf-morphs.ts';
import { auditSkins } from '../src/gltf-skins.ts';
import { readFileSync } from 'node:fs';
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

  it('does not start an UnrealTraceServer (TraceAuxiliary.cpp honors -notraceserver)', () => {
    expect(unrealCommandLine({ project: 'p', script: 's', log: 'l' })).toContain('-notraceserver');
  });

  it('imports under a sanitized name, because UE names meshes and fallback morphs after the file', () => {
    expect(unrealImportName('C:/a b/good head copy.glb')).toBe('good_head_copy');
    expect(unrealImportName('/x/1st-head.v2.glb')).toBe('_1st_head_v2');
    expect(unrealImportName('/x/.glb')).toBe('Model');
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

describe('checkUnrealReport: morph names Unreal threw away', () => {
  const clean: ParsedUnrealLog = { importErrors: [], importWarnings: [], otherErrors: [], interchangeCompleted: true, windowFound: true };
  const contract = { ...contractExpectations('arkit-face/1'), requireSkeletalMesh: true };
  const fallback = (count: number, meshes = 1) => Array.from({ length: meshes }, (_, m) => Array.from({ length: m ? 1 : count }, (_, i) => `good_mesh_${m}_${i}_MorphTarget`)).flat();
  const discarded = (names: string[]) => { const raw = structuredClone(RAW); raw.skeletalMeshes[0].morphTargets = names; return raw; };
  const build = (raw: UnrealRawReport, preflight?: Parameters<typeof buildUnrealReport>[2]['preflight'], log = clean, exitCode = 0) =>
    buildUnrealReport(raw, log, { input: 'good.glb', editor: 'e', version: '5.7.3', exitCode, logFile: 'l', elapsedMs: 1, ...(preflight ? { preflight } : {}) });

  it('reports one clear failure naming the cause, instead of a missing line per morph, for names shared across meshes', () => {
    const morphNames = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes' }));
    const report = build(discarded(fallback(21, 2)), { morphNames });
    const failures = checkUnrealReport(report, contract);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^Unreal renamed every morph target to <file>_mesh_<m>_<i>_MorphTarget \(for example "good_mesh_0_0_MorphTarget"\)/);
    expect(failures[0]).toContain('"jawOpen" (mesh 0 "Face", mesh 1 "Teeth")');
    expect(failures[0]).toMatch(/GLTFAsset\.cpp/);
    expect(failures[0]).toMatch(/one glTF mesh as separate primitives/);
    expect(failures.join(' | ')).not.toMatch(/missing morph target/);
  });

  it('still lists bones, and morphs the GLB never had, next to the rename failure', () => {
    const morphNames = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes', morphs: contract.morphs.filter(n => n !== 'mouthFunnel' && n !== 'jawOpen') }));
    const shared = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes', morphs: contract.morphs.filter(n => n !== 'mouthFunnel') }));
    expect(morphNames.issues).toEqual([]);
    const raw = discarded(fallback(19, 2)); raw.skeletalMeshes[0].bones = ['head', 'eye_L'];
    const failures = checkUnrealReport(build(raw, { morphNames: shared }), contract);
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatch(/^Unreal renamed every morph target/);
    expect(failures.slice(1)).toEqual(['missing morph target "mouthFunnel" (the GLB has no morph target with this name)', 'missing bone "eye_R"']);
  });

  it('explains the possible causes when the GLB could not be audited', () => {
    const failures = checkUnrealReport(build(discarded(fallback(21))), contract);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^Unreal renamed every morph target/);
    expect(failures[0]).toMatch(/repeats across glTF meshes/);
    expect(failures[0]).toMatch(/one glTF mesh as separate primitives/);
  });

  it('fails a rename even without expectations, since every name was lost', () => {
    const failures = checkUnrealReport(build(discarded(fallback(3))), { morphs: [], bones: [], requireSkeletalMesh: false });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^Unreal renamed every morph target/);
  });

  it('keeps a shared-name finding as a warning when Unreal kept the names after all', () => {
    const morphNames = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes' }));
    const report = build(RAW, { morphNames });
    expect(checkUnrealReport(report, contract)).toEqual([]);
    expect(report.warnings).toEqual([expect.stringContaining('"jawOpen" (mesh 0 "Face", mesh 1 "Teeth")')]);
  });

  it('reports only the import failure when Unreal imported nothing', () => {
    const nothing: UnrealRawReport = { ok: true, destination: '/Game/Verify/bad', importReturned: false, assets: [], skeletalMeshes: [], staticMeshes: [] };
    const log = { ...clean, importErrors: ["LogInterchangeEngine: Error: [ : '', Unknown] Invalid GLTF header!", 'LogInterchangeEngine: Error: There was no data to import in the provided source data.'] };
    const failures = checkUnrealReport(build(nothing, { error: 'not a GLB or glTF file (bad magic)' }, log, 1), contract);
    expect(failures).toEqual([
      "Unreal imported nothing (exit code 1): LogInterchangeEngine: Error: [ : '', Unknown] Invalid GLTF header! | LogInterchangeEngine: Error: There was no data to import in the provided source data.",
    ]);
  });
});

describe('checkUnrealReport: one SkeletalMesh must carry the whole contract', () => {
  const clean: ParsedUnrealLog = { importErrors: [], importWarnings: [], otherErrors: [], interchangeCompleted: true, windowFound: true };
  const contract = { ...contractExpectations('arkit-face/1'), contract: 'arkit-face/1', requireSkeletalMesh: true, singleSkeletalMesh: true };
  const head = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/heads/${name}`, import.meta.url)));
  const preflightOf = (bytes: Uint8Array) => ({ morphNames: auditMorphNames(bytes), skins: auditSkins(bytes) });
  const base = '/Game/Verify/partialskin/partialskin/SkeletalMeshes';
  const mesh = (name: string, morphTargets: string[], bones: string[]) =>
    ({ path: `${base}/${name}`, skeleton: `${base}/${name}_Skeleton`, morphTargets, bones, lods: 1, vertices: [100], materialSlots: 1 });
  // What UE 5.7 made of the critic's partialskin.glb (evidence P9a round 2): the eyes on the skin, the face on a made-up bone.
  const split = (): UnrealRawReport => {
    const meshes = [mesh('Eyeball_L', [], ['head', 'eye_L', 'eye_R']), mesh('Head_3459267b', [...ARKIT_FACE_REQUIRED_MORPHS], ['Head_3459267b'])];
    return { ...structuredClone(RAW), skeletalMeshes: meshes, assets: meshes.flatMap(m => [{ path: m.path, class: 'SkeletalMesh' }, { path: m.skeleton, class: 'Skeleton' }]) };
  };
  const build = (raw: UnrealRawReport, preflight?: Parameters<typeof buildUnrealReport>[2]['preflight']) =>
    buildUnrealReport(raw, clean, { input: 'partialskin.glb', editor: 'e', version: '5.7.3', exitCode: 0, logFile: 'l', elapsedMs: 1, ...(preflight ? { preflight } : {}) });

  it('fails when the morphs and the head/eye bones are on two different SkeletalMeshes, and names the unskinned glTF mesh', () => {
    const failures = checkUnrealReport(build(split(), preflightOf(head('partialskin.glb'))), contract);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^no single SkeletalMesh carries the arkit-face\/1 contract/);
    expect(failures[0]).toContain('SkeletalMesh "Head_3459267b"');
    expect(failures[0]).toContain('"Eyeball_L"');
    expect(failures[0]).toContain('the morph-bearing glTF mesh "Head" (node "Head") is not skinned');
    expect(failures[0]).toContain('bind it to the skin with those joints (skin 0 "HeadRig": "head", "eye_L", "eye_R")');
    expect(failures[0]).not.toMatch(/names must survive verbatim/);
  });

  it('fails the split even when the GLB could not be audited', () => {
    const failures = checkUnrealReport(build(split()), contract);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^no single SkeletalMesh carries the arkit-face\/1 contract/);
    expect(failures[0]).not.toMatch(/Cause:/);
  });

  it('fails the split for --expect names too, without a contract', () => {
    const failures = checkUnrealReport(build(split()), { morphs: ['jawOpen'], bones: ['eye_L'], requireSkeletalMesh: true });
    expect(failures).toEqual([expect.stringMatching(/^no single SkeletalMesh carries the expected names/)]);
  });

  it('blames a missing skin, not spelling, when Interchange made the only bone up from the mesh node', () => {
    const meshes = [{ ...mesh('Head', [...ARKIT_FACE_REQUIRED_MORPHS], ['Head']) }];
    const raw: UnrealRawReport = { ...structuredClone(RAW), skeletalMeshes: meshes, staticMeshes: [{ path: `${base}/Eyeball_L`, lods: 1, vertices: [10] }, { path: `${base}/Eyeball_R`, lods: 1, vertices: [10] }] };
    const failures = checkUnrealReport(build(raw, preflightOf(head('bl-noskin.glb'))), contract);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^missing bones "head", "eye_L", "eye_R": SkeletalMesh "Head" has only the bone "Head"/);
    expect(failures[0]).toContain('Cause: the GLB has no skin');
    expect(failures[0]).not.toMatch(/names must survive verbatim/);
  });

  it('flags more than one SkeletalMesh from a single-skin head even when one of them meets the contract', () => {
    const raw = structuredClone(RAW);
    raw.skeletalMeshes.push(mesh('Hat', [], ['Hat']));
    raw.assets.push({ path: `${base}/Hat`, class: 'SkeletalMesh' }, { path: `${base}/Hat_Skeleton`, class: 'Skeleton' });
    const failures = checkUnrealReport(build(raw), contract);
    expect(failures).toEqual([expect.stringMatching(/^Unreal created 2 SkeletalMeshes \("pip", "Hat"\) and 2 Skeletons, but the arkit-face\/1 contract needs one SkeletalMesh on one Skeleton/)]);
    expect(checkUnrealReport(build(raw), { ...contract, singleSkeletalMesh: false })).toEqual([]);
  });

  it('names the bones the GLB never had, from its skin joints', () => {
    const raw = structuredClone(RAW); raw.skeletalMeshes[0].bones = ['head', 'eye_L'];
    const failures = checkUnrealReport(build(raw, preflightOf(arkitFaceFixtureGLB({ bones: ['head', 'eye_L'] }))), contract);
    expect(failures).toEqual(['missing bone "eye_R" (the GLB has no skin joint with this name)']);
  });

  it('passes the good Blender head that imports as one SkeletalMesh', () => {
    expect(checkUnrealReport(build(RAW, preflightOf(head('bl-good.glb'))), contract)).toEqual([]);
  });

  it('shows the real timeout, not a rounded one', () => {
    const slow = buildUnrealReport(RAW, { ...clean, windowFound: false }, { input: 'x.glb', editor: 'e', version: '5.7.3', exitCode: -1, logFile: 'l.log', elapsedMs: 1, timeoutMs: 500 });
    expect(checkUnrealReport(slow, contract)).toEqual(['Unreal did not finish within 0.5 s and was stopped; see l.log']);
  });
});
