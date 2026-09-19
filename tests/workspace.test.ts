import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspace } from '../src/workspace.ts';

const directories: string[] = [];
const stores: Workspace[] = [];
afterEach(async () => { stores.splice(0).forEach(s => s.close()); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() { const directory = await mkdtemp(join(tmpdir(), 'mesh-workspace-')); directories.push(directory); const store = new Workspace(directory); stores.push(store); return { directory, store }; }

it('persists project and undo/redo across fresh workspace connections', async () => {
  const { directory, store } = await setup();
  expect(store.read().revision).toBe(0);
  store.transact(e => e.apply({ op: 'add', part: { name: 'body' } }));
  store.close(); const reopened = new Workspace(directory); stores.push(reopened);
  expect(reopened.read().project.parts.map(p => p.name)).toEqual(['body']);
  reopened.transact(e => e.undo()); expect(reopened.read().project.parts).toHaveLength(0);
  reopened.close(); const again = new Workspace(directory); stores.push(again);
  again.transact(e => e.redo()); expect(again.read().project.parts).toHaveLength(1);
  expect(again.read().revision).toBe(3);
});

it('rolls back validation and actual database write failures without consuming history', async () => {
  const { directory, store } = await setup();
  store.transact(e => e.apply({ op: 'add', part: { name: 'body' } }));
  const before = store.read();
  expect(() => store.transact(e => { e.apply({ op: 'add', part: { name: 'leg' } }); e.apply({ op: 'remove', name: 'absent' }); })).toThrow('Unknown part');
  expect(store.read()).toEqual(before);
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  db.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON workspace BEGIN SELECT RAISE(FAIL, 'simulated storage failure'); END");
  expect(() => store.transact(e => e.apply({ op: 'remove', name: 'body' }))).toThrow('simulated storage failure');
  expect(store.read()).toEqual(before); db.exec('DROP TRIGGER reject_write'); db.close();
  store.transact(e => e.undo()); expect(store.read().project.parts).toHaveLength(0);
});

it('serializes independent writers and rejects stale expected revisions', async () => {
  const { directory, store } = await setup(); const other = new Workspace(directory); stores.push(other);
  store.transact(e => e.apply({ op: 'add', part: { name: 'first' } }), 0);
  expect(() => other.transact(e => e.apply({ op: 'add', part: { name: 'stale' } }), 0)).toThrow(/revision/i);
  other.transact(e => e.apply({ op: 'add', part: { name: 'second' } }), 1);
  expect(store.read().project.parts.map(p => p.name)).toEqual(['first', 'second']);
});

it('recovers the last committed state after a process exits during a transaction', async () => {
  const { directory, store } = await setup(); store.transact(e => e.apply({ op: 'add', part: { name: 'confirmed' } })); store.close();
  const script = `import {Workspace} from ${JSON.stringify(pathToFileURL(resolve('src/workspace.ts')).href)}; const w=new Workspace(${JSON.stringify(directory)}); w.transact(e=>{e.apply({op:'remove',name:'confirmed'});process.exit(23)});`;
  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true })).rejects.toMatchObject({ code: 23 });
  const reopened = new Workspace(directory); stores.push(reopened);
  expect(reopened.read().revision).toBe(1); expect(reopened.read().project.parts[0].name).toBe('confirmed');
  reopened.transact(e => e.undo()); expect(reopened.read().project.parts).toHaveLength(0);
});

it('preserves corrupt workspace files instead of replacing them with an empty project', async () => {
  const { directory, store } = await setup(); store.close();
  const file = join(directory, 'workspace.sqlite'); await writeFile(file, 'corrupt database');
  await expect(Promise.resolve().then(() => new Workspace(directory))).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('corrupt database');
});
