/**
 * The animation library page: import Mixamo downloads, browse the clip cards, tag and title them, copy a move set for
 * an agent, and Sync the library repository. It talks to `src/animation-server.ts` (HTTP API version 1) and builds its
 * DOM with plain TypeScript, like the workbench, on the workbench's base styles.
 */
import './style.css';
import './animations.css';
import type { MixamoEntry, MixamoImportResult } from '../../scripts/mixamo-library.mjs';
import type { DownloadFile, ImportProgress } from '../animation-server.ts';
import type { SyncResult, SyncStatus } from '../library-sync.ts';

type Entry = MixamoEntry & { previewUrl: string | null };
interface LibraryResponse { directory: string; sync: { available: boolean; reason?: string }; entries: Entry[] }
interface DownloadsResponse { directory: string; files: DownloadFile[] }
type RowStatus = 'queued' | MixamoImportResult['status'] | 'failed';
interface ImportRow { key: string; name: string; status: RowStatus; id?: string; reason?: string }

declare global { interface Window { __lastCopied?: string } }

const MOVE_SET_INTRO = "Mixamo clips from the agent-meshes animation library. Load each by id with `agent_meshes_mixamo.import_fbx('<id>')`, or get its path with `node <runtime>/scripts/mixamo-library.mjs path <id>`.";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (name === 'class') node.className = value; else if (name === 'text') node.textContent = value; else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

const status = (message: string, error = false) => { el('status').textContent = message; el('status').classList.toggle('error', error); };
async function request<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const options: RequestInit = body === undefined ? init : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init };
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result as T;
}
const action = (fn: () => unknown | Promise<unknown>) => async () => { try { await fn(); } catch (error) { status((error as Error).message, true); } };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

// ----- formatting -----

/** The length of an entry in seconds: its motion summary's, else its longest take's. */
const secondsOf = (entry: Entry): number | null => entry.motion?.seconds ?? entry.clips.reduce<number | null>((longest, clip) => clip.seconds === null ? longest : Math.max(longest ?? 0, clip.seconds), null);
const travelText = (entry: Entry) => entry.motion ? (entry.motion.inPlace ? 'in place' : `root motion, travels ${entry.motion.travelMeters.toFixed(1)} m`) : null;

/** One move-set bullet, as decision 13 sets out: title, id, the note when set, tags, length and travel. */
export function moveSetBullet(entry: Entry): string {
  let line = `- ${entry.title} (\`${entry.id}\`): `;
  const note = entry.note.trim().replace(/\.+$/, '');
  if (note) line += `${note}. `;
  if (entry.tags.length) line += `${entry.tags.join(', ')}. `;
  const seconds = secondsOf(entry), travel = travelText(entry);
  if (seconds !== null) line += `${seconds.toFixed(1)} s${travel ? `, ${travel}` : ''}.`;
  return line.trimEnd();
}
export function moveSetText(name: string, entries: Entry[]): string {
  return [`## ${name.trim() || 'Move set'}`, MOVE_SET_INTRO, ...entries.map(moveSetBullet)].join('\n');
}

const sizeText = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const dateText = (ms: number) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function copyText(text: string): Promise<void> {
  window.__lastCopied = text;
  try { await navigator.clipboard.writeText(text); return; } catch { /* no permission or no secure context */ }
  const area = h('textarea', { 'aria-hidden': 'true', class: 'copy-buffer' });
  area.value = text;
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('The browser refused the clipboard; the move set is in window.__lastCopied');
}

// ----- state -----

let entries: Entry[] = [];
let downloads: DownloadFile[] = [];
const checked = new Set<string>();
const selected = new Set<string>();
let anchor: string | null = null, focusId: string | null = null, editingId: string | null = null;
const tagFilter = new Set<string>();
const rows = new Map<string, ImportRow>();
let syncAvailable = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const byId = (id: string) => entries.find(entry => entry.id === id);
const allTags = () => [...new Set(entries.flatMap(entry => entry.tags))].sort();
function visible(): Entry[] {
  const words = el<HTMLInputElement>('filter-text').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if ([...tagFilter].some(tag => !entry.tags.includes(tag))) return false;
    const haystack = [entry.title, entry.id, entry.note, ...entry.tags].join(' ').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}
const selection = () => visibleOrder(entries).filter(entry => selected.has(entry.id));
/** The grid order: by title, then id. */
const visibleOrder = (list: Entry[]) => [...list].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

/** Merge changed entries from an edit response into the library. */
function merge(changed: Entry[]) {
  for (const entry of changed) { const at = entries.findIndex(item => item.id === entry.id); if (at >= 0) entries[at] = entry; else entries.push(entry); }
  renderLibrary();
}

// ----- tabs -----

const tabs = [el<HTMLButtonElement>('tab-import'), el<HTMLButtonElement>('tab-library')];
function showTab(tab: HTMLButtonElement, focus = false) {
  for (const item of tabs) {
    const on = item === tab;
    item.classList.toggle('active', on);
    item.setAttribute('aria-selected', String(on));
    item.tabIndex = on ? 0 : -1;
    el(item.getAttribute('aria-controls')!).hidden = !on;
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => showTab(tab));
  tab.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    showTab(tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!, true);
  });
}

// ----- library grid -----

const grid = el('card-grid');
const cards = new Map<string, HTMLElement>();

/** Show the preview's first frame on a canvas (reduced motion) until the card is hovered or focused. */
function stillFrame(preview: HTMLElement, image: HTMLImageElement) {
  const canvas = preview.querySelector('canvas')!;
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  preview.classList.toggle('still', reducedMotion.matches);
}
function setPreview(card: HTMLElement, entry: Entry) {
  const preview = card.querySelector<HTMLElement>('.card-preview')!;
  if (preview.dataset.src === (entry.previewUrl ?? '')) return;
  preview.dataset.src = entry.previewUrl ?? '';
  preview.replaceChildren();
  preview.classList.remove('missing', 'still');
  const placeholder = () => { preview.classList.add('missing'); preview.replaceChildren(h('span', { text: entry.kind === 'character' ? 'Character' : 'No preview' })); };
  if (!entry.previewUrl) { placeholder(); return; }
  const image = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
  image.addEventListener('load', () => stillFrame(preview, image));
  image.addEventListener('error', placeholder);
  image.src = entry.previewUrl;
  preview.append(image, h('canvas', { 'aria-hidden': 'true' }));
}

function makeCard(entry: Entry): HTMLElement {
  const card = h('div', { class: 'card', role: 'option', 'data-card': entry.id, tabindex: '-1' },
    h('div', { class: 'card-preview' }),
    h('div', { class: 'card-body' }, h('div', { class: 'card-title' }), h('div', { class: 'card-meta subtle' }), h('div', { class: 'card-summary' }), h('div', { class: 'chip-row card-tags' })));
  card.addEventListener('click', event => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-tag]');
    if (chip) { toggleTagFilter(chip.dataset.tag!); return; }
    choose(entry.id, event);
  });
  card.addEventListener('focus', () => { focusId = entry.id; for (const other of cards.values()) other.tabIndex = other === card ? 0 : -1; });
  const animate = (on: boolean) => { const preview = card.querySelector('.card-preview')!; if (preview.querySelector('canvas')?.width) preview.classList.toggle('still', !on && reducedMotion.matches); };
  card.addEventListener('mouseenter', () => animate(true));
  card.addEventListener('mouseleave', () => animate(card.contains(document.activeElement)));
  card.addEventListener('focusin', () => animate(true));
  card.addEventListener('focusout', () => animate(card.matches(':hover')));
  return card;
}
function updateCard(card: HTMLElement, entry: Entry) {
  setPreview(card, entry);
  card.querySelector('.card-title')!.textContent = entry.title;
  const seconds = secondsOf(entry);
  card.querySelector('.card-meta')!.textContent = [seconds === null ? null : `${seconds.toFixed(1)} s`, entry.kind === 'clip' ? null : entry.kind, entry.id].filter(Boolean).join(' · ');
  card.querySelector('.card-summary')!.textContent = entry.motion?.summary ?? 'No motion summary';
  card.querySelector('.card-tags')!.replaceChildren(...entry.tags.map(tag => h('span', { class: `chip${tagFilter.has(tag) ? ' active' : ''}`, 'data-tag': tag, title: `Filter by ${tag}`, text: tag })));
  card.title = entry.note || entry.title;
  const on = selected.has(entry.id);
  card.setAttribute('aria-selected', String(on));
  card.classList.toggle('selected', on);
}

function renderLibrary() {
  const shown = visibleOrder(visible());
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  for (const [id, card] of cards) if (!byId(id)) { card.remove(); cards.delete(id); }
  const nodes = shown.map(entry => {
    let card = cards.get(entry.id);
    if (!card) { card = makeCard(entry); cards.set(entry.id, card); }
    updateCard(card, entry);
    return card;
  });
  if (nodes.length !== grid.children.length || nodes.some((node, index) => grid.children[index] !== node)) {
    const focused = document.activeElement instanceof HTMLElement && grid.contains(document.activeElement) ? document.activeElement : null;
    grid.replaceChildren(...nodes);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
  if (!shown.some(entry => entry.id === focusId)) focusId = shown[0]?.id ?? null;
  for (const [id, card] of cards) card.tabIndex = id === focusId ? 0 : -1;
  el('library-count').textContent = entries.length ? String(entries.length) : '';
  const empty = el('library-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = entries.length ? 'No clips match the filter.' : 'The library is empty. Import Mixamo downloads from the Import tab.';
  renderTagFilter();
  renderSelection();
}

function renderTagFilter() {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const tag of [...tagFilter]) if (!counts.has(tag)) tagFilter.delete(tag);
  el('tag-filter').replaceChildren(...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => {
    const button = h('button', { type: 'button', class: `chip${tagFilter.has(tag) ? ' active' : ''}`, 'aria-pressed': String(tagFilter.has(tag)) }, tag, h('small', { text: String(count) }));
    button.addEventListener('click', () => toggleTagFilter(tag));
    return button;
  }));
  el('tag-options').replaceChildren(...allTags().map(tag => h('option', { value: tag })));
}
function toggleTagFilter(tag: string) {
  if (tagFilter.has(tag)) tagFilter.delete(tag); else tagFilter.add(tag);
  renderLibrary();
}

function renderSelection() {
  const list = selection();
  const bar = el('bulk-bar');
  bar.hidden = list.length === 0;
  el('selection-count').textContent = `${list.length} selected`;
  const union = [...new Set(list.flatMap(entry => entry.tags))].sort();
  el('remove-tags').replaceChildren(...(union.length ? union.map(tag => {
    const button = h('button', { type: 'button', class: 'chip removable', 'aria-label': `Remove tag ${tag} from the selection` }, tag, h('span', { 'aria-hidden': 'true', text: '×' }));
    button.addEventListener('click', action(() => editTags([], [tag])));
    return button;
  }) : [h('span', { class: 'subtle', text: 'No tags' })]));
  const form = el<HTMLFormElement>('single-edit');
  const single = list.length === 1 ? list[0]! : null;
  form.hidden = !single;
  if (single && single.id !== editingId) {
    el<HTMLInputElement>('edit-title').value = single.title;
    el<HTMLInputElement>('edit-note').value = single.note;
  }
  editingId = single?.id ?? null;
}

/** Click selects one, ctrl/cmd-click toggles one, shift-click selects the range from the last clicked card. */
function choose(id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  const toggle = event.ctrlKey || event.metaKey;
  if (event.shiftKey && anchor && byId(anchor)) {
    const order = visibleOrder(visible()).map(entry => entry.id);
    const from = order.indexOf(anchor), to = order.indexOf(id);
    if (!toggle) selected.clear();
    if (from >= 0 && to >= 0) for (const item of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(item);
    else selected.add(id);
  } else if (toggle) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchor = id;
  } else {
    selected.clear(); selected.add(id); anchor = id;
  }
  focusId = id;
  renderLibrary();
}

grid.addEventListener('keydown', event => {
  const order = visibleOrder(visible()).map(entry => entry.id);
  if (!order.length) return;
  const at = Math.max(0, order.indexOf(focusId ?? ''));
  const first = cards.get(order[0]!)!;
  const columns = Math.max(1, order.filter(id => cards.get(id)!.offsetTop === first.offsetTop).length);
  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -at, End: order.length - 1 - at };
  if (event.key in moves) {
    event.preventDefault();
    const next = order[Math.min(order.length - 1, Math.max(0, at + moves[event.key]!))]!;
    if (event.shiftKey) choose(next, { shiftKey: true, ctrlKey: false, metaKey: false });
    focusId = next;
    cards.get(next)!.focus();
  } else if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    choose(order[at]!, { shiftKey: event.shiftKey, ctrlKey: event.key === ' ' || event.ctrlKey, metaKey: event.metaKey });
  } else if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    selectVisible();
  } else if (event.key === 'Escape') {
    selected.clear(); renderLibrary();
  }
});

function selectVisible() {
  for (const entry of visible()) selected.add(entry.id);
  renderLibrary();
}
el('select-visible').addEventListener('click', selectVisible);
el('clear-selection').addEventListener('click', () => { selected.clear(); renderLibrary(); });
el('filter-text').addEventListener('input', renderLibrary);

// ----- edits -----

async function editTags(add: string[], remove: string[]) {
  const ids = selection().map(entry => entry.id);
  if (!ids.length || (!add.length && !remove.length)) return;
  const { entries: changed } = await request<{ entries: Entry[] }>('/api/tags', { ids, add, remove });
  merge(changed);
  status(add.length ? `Added ${add.join(', ')} to ${plural(ids.length, 'clip')}` : `Removed ${remove.join(', ')} from ${plural(ids.length, 'clip')}`);
  void loadSync();
}
const addTags = el<HTMLInputElement>('add-tags');
const commitTags = (value: string) => editTags(value.split(',').map(tag => tag.trim()).filter(Boolean), []);
addTags.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = addTags.value; addTags.value = '';
  void action(() => commitTags(value))();
});
addTags.addEventListener('input', () => {
  const at = addTags.value.lastIndexOf(',');
  if (at < 0) return;
  const value = addTags.value.slice(0, at); addTags.value = addTags.value.slice(at + 1).trimStart();
  void action(() => commitTags(value))();
});

el('single-edit').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const entry = editingId ? byId(editingId) : undefined;
    if (!entry) return;
    const title = el<HTMLInputElement>('edit-title').value.trim(), note = el<HTMLInputElement>('edit-note').value.trim();
    if (!title) throw new Error('A title cannot be empty');
    if (title !== entry.title) merge((await request<{ entries: Entry[] }>('/api/title', { id: entry.id, title })).entries);
    if (note !== entry.note) merge((await request<{ entries: Entry[] }>('/api/note', { id: entry.id, note })).entries);
    status(`Saved ${entry.id}`);
    void loadSync();
  })();
});

const moveDialog = el<HTMLDialogElement>('move-set-dialog');
el('copy-move-set').addEventListener('click', () => {
  const list = selection();
  if (!list.length) return;
  el<HTMLInputElement>('move-set-name').value = 'Move set';
  el('move-set-summary').textContent = `${plural(list.length, 'clip')}, in grid order.`;
  moveDialog.returnValue = '';
  moveDialog.showModal();
  el<HTMLInputElement>('move-set-name').select();
});
moveDialog.addEventListener('close', action(async () => {
  if (moveDialog.returnValue !== 'copy') return;
  const list = selection();
  await copyText(moveSetText(el<HTMLInputElement>('move-set-name').value, list));
  status(`Copied a move set of ${plural(list.length, 'clip')}`);
}));

const removeDialog = el<HTMLDialogElement>('remove-dialog');
el('remove-selected').addEventListener('click', () => {
  const list = selection();
  if (!list.length) return;
  el('remove-summary').textContent = `Remove ${list.length === 1 ? list[0]!.title : plural(list.length, 'clip')} from the library?`;
  removeDialog.returnValue = '';
  removeDialog.showModal();
});
removeDialog.addEventListener('close', action(async () => {
  if (removeDialog.returnValue !== 'remove') return;
  const ids = selection().map(entry => entry.id);
  const { removed } = await request<{ removed: string[] }>('/api/remove', { ids });
  for (const id of removed) selected.delete(id);
  status(`Removed ${plural(removed.length, 'clip')}`);
  await Promise.all([loadLibrary(), loadDownloads(), loadSync()]);
}));

// ----- sync -----

async function loadSync() {
  const button = el<HTMLButtonElement>('sync'), label = el('sync-status');
  try {
    const sync = await request<SyncStatus>('/api/sync');
    syncAvailable = sync.available;
    label.textContent = sync.available ? `${plural(sync.changed.length, 'change')} · ahead ${sync.ahead} · behind ${sync.behind}` : `Sync unavailable: ${sync.reason}`;
  } catch (error) {
    syncAvailable = false;
    label.textContent = `Sync unavailable: ${(error as Error).message}`;
  }
  button.disabled = !syncAvailable;
}
el('sync').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('sync');
  button.disabled = true;
  status('Syncing…');
  try {
    const result = await request<SyncResult>('/api/sync', {});
    if (result.error) status(`${result.error}${result.conflicts?.length && !result.error.includes(result.conflicts[0]!) ? ` Conflicts: ${result.conflicts.join(', ')}` : ''}`, true);
    else status(`Synced: ${[result.committed ? 'committed' : 'nothing to commit', result.pulled ? 'pulled' : null, result.pushed ? 'pushed' : null].filter(Boolean).join(', ')}${result.message ? ` — ${result.message.split('\n')[0]}` : ''}`);
  } catch (error) { status((error as Error).message, true); }
  await Promise.all([loadLibrary(), loadSync()]);
});

// ----- import -----

const downloadList = el('download-list'), selectAll = el<HTMLInputElement>('select-all-downloads');
function renderDownloads() {
  for (const path of [...checked]) if (!downloads.some(file => file.path === path)) checked.delete(path);
  downloadList.replaceChildren(...downloads.map((file, index) => {
    const box = h('input', { type: 'checkbox', 'aria-labelledby': `download-${index}` });
    box.checked = checked.has(file.path);
    box.addEventListener('change', () => { if (box.checked) checked.add(file.path); else checked.delete(file.path); renderDownloadControls(); });
    return h('li', {}, h('label', { class: 'download-row' }, box,
      h('span', { class: 'download-name', id: `download-${index}`, text: file.name }),
      h('span', { class: 'subtle', text: sizeText(file.bytes) }),
      h('time', { class: 'subtle', datetime: new Date(file.mtimeMs).toISOString(), text: dateText(file.mtimeMs) }),
      file.inLibrary ? h('span', { class: 'badge', text: `in library · ${file.inLibrary}` }) : h('span')));
  }));
  el('downloads-empty').hidden = downloads.length > 0;
  renderDownloadControls();
}
function renderDownloadControls() {
  selectAll.checked = downloads.length > 0 && checked.size === downloads.length;
  selectAll.indeterminate = checked.size > 0 && checked.size < downloads.length;
  el<HTMLButtonElement>('import-selected').disabled = checked.size === 0;
}
selectAll.addEventListener('change', () => {
  if (selectAll.checked) for (const file of downloads) checked.add(file.path); else checked.clear();
  renderDownloads();
});

const importRows = el('import-rows');
const STATUS_TEXT: Record<RowStatus, string> = { queued: 'Waiting', imported: 'Imported', duplicate: 'Already in library', rejected: 'Rejected', failed: 'Failed' };
function renderRows() {
  importRows.replaceChildren(...[...rows.values()].map(row => h('li', { class: 'import-row', 'data-import-row': '', 'data-status': row.status },
    h('span', { class: 'import-name', text: row.name }),
    h('span', { class: 'import-status', text: STATUS_TEXT[row.status] }),
    h('span', { class: 'subtle', text: [row.id ? `id ${row.id}` : '', row.reason ?? ''].filter(Boolean).join(' · ') }))));
  el('import-empty').hidden = rows.size > 0;
  const finished = [...rows.values()].filter(row => row.status !== 'queued').length;
  el('import-count').textContent = rows.size ? `${finished} / ${rows.size}` : '';
}
/** Which row shows each source's result, so a result reported by both its event and its response fills one row. */
const rowOf = new Map<string, string>();
/** Record a result in its row: the row it already has, else the row waiting for it (the same source, or the zip or
 *  folder it came from), else a new row. */
function record(result: MixamoImportResult) {
  const waiting = [...rows.values()].find(row => row.status === 'queued' && (result.source === row.key || result.source.startsWith(`${row.key}/`) || result.source.startsWith(`${row.key}\\`)));
  const key = rowOf.get(result.source) ?? waiting?.key ?? result.source;
  rowOf.set(result.source, key);
  rows.set(key, { key, name: baseName(result.source), status: result.status, id: result.id, reason: result.reason ?? (result.previewError ? `no preview: ${result.previewError}` : undefined) });
  renderRows();
}
const queue = (key: string, name: string) => {
  for (const [source, row] of rowOf) if (row === key || source === key) rowOf.delete(source);
  rows.delete(key); rows.set(key, { key, name, status: 'queued' }); renderRows();
};
/** Rows still waiting after their import answered (a zip with no FBX inside) are closed with this reason. */
function settle(keys: string[], reason: string) {
  for (const key of keys) { const row = rows.get(key); if (row?.status === 'queued') rows.set(key, { ...row, status: 'failed', reason }); }
  renderRows();
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Refresh the library soon, once for a burst of progress events. */
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void loadLibrary(); void loadSync(); }, 120); };

el('import-selected').addEventListener('click', action(async () => {
  const paths = downloads.filter(file => checked.has(file.path)).map(file => file.path);
  if (!paths.length) return;
  const button = el<HTMLButtonElement>('import-selected');
  button.disabled = true;
  for (const path of paths) queue(path, baseName(path));
  status(`Importing ${plural(paths.length, 'file')}…`);
  try {
    const { results } = await request<{ results: MixamoImportResult[] }>('/api/import', { paths });
    for (const result of results) record(result);
    finished(results);
  } catch (error) { settle(paths, (error as Error).message); throw error; }
  finally { checked.clear(); await Promise.all([loadLibrary(), loadDownloads(), loadSync()]); }
}));

async function upload(files: File[]) {
  const accepted = files.filter(file => /\.(fbx|zip)$/i.test(file.name));
  if (!accepted.length) { status('Drop or choose .fbx or .zip files', true); return; }
  showTab(tabs[0]!);
  for (const file of accepted) queue(file.name, file.name);
  const all: MixamoImportResult[] = [];
  for (const file of accepted) {
    status(`Uploading ${file.name}…`);
    try {
      const { results } = await request<{ results: MixamoImportResult[] }>(`/api/upload?name=${encodeURIComponent(file.name)}`, undefined, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      for (const result of results) record(result);
      all.push(...results);
    } catch (error) { settle([file.name], (error as Error).message); status((error as Error).message, true); }
  }
  finished(all);
  await Promise.all([loadLibrary(), loadDownloads(), loadSync()]);
}
function finished(results: MixamoImportResult[]) {
  const count = (state: string) => results.filter(result => result.status === state).length;
  const parts = [`${count('imported')} imported`, count('duplicate') ? `${count('duplicate')} already in library` : '', count('rejected') ? `${count('rejected')} rejected` : ''].filter(Boolean);
  status(`Import finished: ${parts.join(', ')}`, count('rejected') > 0 && count('imported') === 0);
}
const picker = el<HTMLInputElement>('file-picker');
picker.addEventListener('change', () => { const files = [...picker.files ?? []]; picker.value = ''; void upload(files); });
const dropZone = el('drop-zone');
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dropZone.classList.add('dragging'); } });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) dropZone.classList.remove('dragging'); });
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  dropZone.classList.remove('dragging');
  void upload([...event.dataTransfer.files]);
});
el('refresh-downloads').addEventListener('click', action(loadDownloads));

// ----- loading and live events -----

async function loadLibrary() {
  try {
    const library = await request<LibraryResponse>('/api/library');
    entries = library.entries;
    el('library-dir').textContent = `LIBRARY ${library.directory}`;
    renderLibrary();
  } catch (error) { status(`Could not read the library: ${(error as Error).message}`, true); }
}
async function loadDownloads() {
  try {
    const list = await request<DownloadsResponse>('/api/downloads');
    downloads = list.files;
    el('downloads-dir').textContent = list.directory;
    renderDownloads();
  } catch (error) { status(`Could not list Downloads: ${(error as Error).message}`, true); }
}

function connect() {
  const events = new EventSource('/api/events');
  const dot = el('connection-dot'), label = el('connection');
  events.addEventListener('open', () => { dot.classList.add('online'); label.textContent = 'Live'; });
  events.addEventListener('error', () => { dot.classList.remove('online'); label.textContent = 'Reconnecting'; });
  events.addEventListener('import-progress', event => {
    const progress = JSON.parse((event as MessageEvent<string>).data) as ImportProgress;
    record(progress);
    status(`Importing ${progress.done} of ${progress.total}: ${baseName(progress.source)} ${STATUS_TEXT[progress.status].toLowerCase()}${progress.reason ? ` (${progress.reason})` : ''}`);
    if (progress.status === 'imported') refreshSoon();
  });
}

reducedMotion.addEventListener('change', () => {
  for (const preview of document.querySelectorAll<HTMLElement>('.card-preview')) if (preview.querySelector('canvas')?.width) preview.classList.toggle('still', reducedMotion.matches);
});

connect();
renderRows();
void Promise.all([loadLibrary(), loadDownloads(), loadSync()]).then(() => {
  if (!el('status').classList.contains('error')) status(`${plural(entries.length, 'clip')} in the library`);
  if (entries.length && !downloads.some(file => !file.inLibrary)) showTab(tabs[1]!);
});
