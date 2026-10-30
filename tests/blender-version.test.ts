import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlenderVersionError, SUPPORTED_BLENDER_SERIES, blenderVersionMessage, clearBlenderVersionCache, isSupportedBlenderVersion, parseBlenderVersion, readBlenderVersion } from '../src/blender-version.ts';

beforeEach(() => clearBlenderVersionCache());

describe('parseBlenderVersion', () => {
  it('reads the version from --version output and ignores the TBBmalloc line', () => {
    expect(parseBlenderVersion('Blender 5.2.2 LTS\n\tbuild date: 2026-09-15\n')).toBe('5.2.2');
    expect(parseBlenderVersion('Blender 4.2.3 LTS\n\tbuild date: 2024-10-15\n\nTBBmalloc: skip allocation functions replacement in ucrtbase.dll: unknown prologue for function _msize\n')).toBe('4.2.3');
    expect(parseBlenderVersion('Blender 3.4\n')).toBe('3.4');
  });
  it('returns null for output without a version', () => {
    expect(parseBlenderVersion('')).toBeNull();
    expect(parseBlenderVersion('TBBmalloc: skip allocation functions replacement\n')).toBeNull();
  });
});

describe('isSupportedBlenderVersion', () => {
  it('accepts every 5.2.x and nothing else', () => {
    expect(SUPPORTED_BLENDER_SERIES.label).toBe('5.2 LTS');
    for (const version of ['5.2.0', '5.2.2', '5.2.10', '5.2']) expect(isSupportedBlenderVersion(version)).toBe(true);
    for (const version of ['5.1.9', '5.3.0', '4.2.3', '3.4.1', '6.2.0', '15.2.0', '5.20.0', null, '']) expect(isSupportedBlenderVersion(version)).toBe(false);
  });
});

describe('readBlenderVersion', () => {
  const run = (stdout: string, stderr = '') => vi.fn(() => ({ status: 0, stdout, stderr }));
  it('runs --version once per executable path and modification time', () => {
    const runner = run('Blender 5.2.2 LTS\n');
    expect(readBlenderVersion(process.execPath, runner)).toBe('5.2.2');
    expect(readBlenderVersion(process.execPath, runner)).toBe('5.2.2');
    expect(runner).toHaveBeenCalledTimes(1);
    readBlenderVersion(`${process.execPath}-missing`, runner);
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it('treats a launcher that prints nothing, or a spawn failure, as unreadable', () => {
    expect(readBlenderVersion('launcher-a', run(''))).toBeNull();
    expect(readBlenderVersion('launcher-b', () => ({ status: null, stdout: '', stderr: '', error: new Error('EPERM') }))).toBeNull();
  });
});

describe('blenderVersionMessage', () => {
  it('names the version found, the series required and where to get it, in one message', () => {
    const message = blenderVersionMessage([{ command: 'C:/blender/blender.exe', version: '4.2.3' }], false);
    expect(message).toContain('Blender 4.2.3');
    expect(message).toContain('Blender 5.2 LTS (any 5.2.x)');
    expect(message).toContain('https://www.blender.org/download/');
    expect(new BlenderVersionError(message).code).toBe('BLENDER_UNSUPPORTED_VERSION');
  });
});
