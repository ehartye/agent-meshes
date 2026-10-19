import { expect, it } from 'vitest';
import { classifyReadAudit, portableReadAudit } from '../src/build-read-audit.ts';

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

it('omits external machine paths from receipts without erasing their count or changing status', () => {
  const report = classifyReadAudit(observation(['C:/project/asset.py', 'C:/project/missed.py', 'C:/Users/One/cache/data']), context);
  const receipt = portableReadAudit(report);
  expect(receipt).toMatchObject({ schema: 2, status: 'undeclared', reads: ['asset.py','missed.py'], undeclaredReads: ['missed.py'], externalReads: { count: 1, paths: 'omitted', coverage: 'outside-enforced-scope' } });
  expect(JSON.stringify(receipt)).not.toContain('Users/One');
  expect(report.externalReads).toHaveLength(1);
  receipt.reads.push('receipt mutation'); expect(report.reads).not.toContain('receipt mutation');
});

it('writes identical audit receipts for equivalent reads at different machine roots', () => {
  const first = classifyReadAudit(observation(['C:/project/asset.py', 'C:/Users/One/cache/a']), context);
  const second = classifyReadAudit(observation(['C:/project/asset.py', 'D:/Users/Two/cache/a']), context);
  expect(first.externalReads).not.toEqual(second.externalReads);
  expect(portableReadAudit(first)).toEqual(portableReadAudit(second));
  expect(portableReadAudit(classifyReadAudit(undefined, context))).toMatchObject({status:'incomplete',installed:false});
});

it('enforces the explicit project-root scope using root-relative declarations', () => {
  const result = classifyReadAudit(observation(['C:/project/assets/asset.py','C:/project/lib/shared.py','C:/project/lib/missing.py']), { ...context, scope: 'project-root', inputs: [{path:'assets/asset.py'}, {path:'lib/shared.py'}] });
  expect(result.scope).toBe('project-root'); expect(result.undeclaredReads).toEqual(['lib/missing.py']);
  expect(portableReadAudit(result)).toMatchObject({scope:'project-root',status:'undeclared'});
});
