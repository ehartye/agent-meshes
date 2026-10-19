import { expect, it } from 'vitest';
import { classifyReadAudit } from '../src/build-read-audit.ts';

const base = 'C:/project';
const observation = (reads: string[], extra = {}) => ({ schema: 1, installed: true, reads, runtimeRoots: ['C:/tools/blender'], unresolvedEvents: 0, truncated: false, ...extra });
const context = { base, inputs: [{ path: 'asset.py', sha256: '0'.repeat(64) }, { path: 'lib/shape.py', sha256: '0'.repeat(64) }], helperRoot: 'C:/plugin', helpers: [{ path: 'scripts/blender_lib/helper.py', sha256: '0'.repeat(64) }] };

it('reports excluded project reads and separately discloses external reads outside its scope', () => {
  const result = classifyReadAudit(observation(['C:/project/asset.py', 'C:/project/lib/shape.py', 'C:/project/lib/excluded.json', 'C:/outside/data.bin', 'C:/plugin/scripts/blender_lib/helper.py', 'C:/tools/blender/5.2/python/lib.py']), context);
  expect(result.status).toBe('undeclared');
  expect(result.undeclaredReads).toEqual(['lib/excluded.json']);
  expect(result.reads).toEqual(['asset.py', 'lib/excluded.json', 'lib/shape.py']);
  expect(result.externalReads).toEqual(['../outside/data.bin']);
});

it('accepts exact covered files and rejects prefix lookalikes rather than ignoring directories', () => {
  expect(classifyReadAudit(observation(['C:/project/asset.py', 'C:/project/lib/shape.py']), context).status).toBe('clean');
  expect(classifyReadAudit(observation(['C:/tools/blender-extra/data', 'C:/plugin/scripts/blender_lib/unhashed.py']), context).externalReads).toHaveLength(2);
});

it('fails closed for missing, uninstalled, malformed, truncated and unresolved observations', () => {
  for (const report of [undefined, {}, observation([], { installed: false }), observation([], { truncated: true }), observation([], { unresolvedEvents: 1 }), observation([42 as unknown as string])]) {
    expect(classifyReadAudit(report, context).status).toBe('incomplete');
  }
});
