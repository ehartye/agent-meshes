import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProject, Editor } from './core/model.ts';

export class RevisionConflict extends Error {
  readonly code = 'REVISION_CONFLICT';
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Workspace revision changed: expected ${expected}, actual ${actual}. Inspect again before retrying.`);
    this.expected = expected; this.actual = actual;
  }
}

/** One canonical state, transactional across CLI processes and a live server. */
export class Workspace {
  readonly directory: string;
  private db: DatabaseSync;
  private closed = false;
  constructor(directory: string) {
    if (!directory.trim()) throw new Error('A workspace directory is required');
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, 'workspace.sqlite'), { timeout: 5000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL)');
      this.db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, 1, 0, ?)').run(JSON.stringify(new Editor(createProject('Untitled')).snapshot()));
      this.read(); // Refuse unknown/corrupt state; never silently replace it.
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  private state() {
    const row = this.db.prepare('SELECT version, revision, state FROM workspace WHERE id=1').get();
    if (!row || row.version !== 1 || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.state !== 'string') throw new Error('Unsupported or corrupt workspace state');
    return { editor: Editor.restore(JSON.parse(row.state)), revision: row.revision };
  }
  read() {
    const { editor, revision } = this.state(), state = editor.snapshot();
    return { project: state.project, revision, undo: state.past.length, redo: state.future.length };
  }
  revision(): number { return this.db.prepare('SELECT revision FROM workspace WHERE id=1').get()!.revision as number; }
  transact(action: (editor: Editor) => unknown, expectedRevision?: number) {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('Expected revision must be a nonnegative safe integer');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { editor, revision } = this.state();
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new RevisionConflict(expectedRevision, revision);
      const result = action(editor);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Workspace mutations must be synchronous; prepare external input before the transaction');
      const state = editor.snapshot();
      // Bound persisted undo cost for dense clips: at most 20 steps and 16 MiB of history.
      state.past = state.past.slice(-20); state.future = state.future.slice(-20);
      let historyBytes = 0;
      for (const key of ['past', 'future'] as const) {
        const kept = [];
        for (const project of [...state[key]].reverse()) {
          const bytes = Buffer.byteLength(JSON.stringify(project));
          if (historyBytes + bytes > 16 * 1024 * 1024) break;
          historyBytes += bytes; kept.unshift(project);
        }
        state[key] = kept;
      }
      this.db.prepare('UPDATE workspace SET revision=?, state=? WHERE id=1').run(revision + 1, JSON.stringify(state));
      this.db.exec('COMMIT');
      return { project: state.project, revision: revision + 1, undo: state.past.length, redo: state.future.length };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
