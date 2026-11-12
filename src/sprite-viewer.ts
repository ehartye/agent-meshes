import { SPRITE_PIVOT_SLICE, type Atlas, type SlicePivot, type SpriteManifest } from './sprite-atlas.ts';

/**
 * The review page of a baked sprite sheet, with no renderer, no file access and no clock: the atlas, the manifest, the
 * sheet's file name and its SHA-256 go in, one HTML string comes out, and the same inputs give the same bytes. The page
 * draws `sheet.png` by its relative name, so it plays from `file://` with the sheet beside it, and it carries the atlas
 * and the manifest as JSON. It holds no font, no style import and no network request, and no version stamp, so the bytes
 * do not change with a release. The only free text in the data is the clip name, which comes from the GLB: the embedded
 * JSON escapes `<`, `>`, `&` and the two line separators, and the page writes every value with `textContent`.
 */
const FOOTER_SHA_LENGTH = 12;
const SAFE_SHEET_NAME = /^[^/\\:?#\0]+$/;

function viewerError(message: string): Error {
  return Object.assign(new Error(message), { code: 'SPRITE_VIEWER_INVALID' });
}

/** JSON that is safe inside a script element: no raw `<`, `>`, `&`, U+2028 or U+2029 can end the element or the string. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The cell pixel of the pivot slice (the slice named `pivot`, else the first slice with a pivot), or undefined without one. */
export function viewerPivot(atlas: Atlas): SlicePivot | undefined {
  const slices = atlas.meta.slices ?? [];
  const slice = slices.find(candidate => candidate.name === SPRITE_PIVOT_SLICE) ?? slices[0];
  const pivot = slice?.keys?.[0]?.pivot;
  return pivot && Number.isFinite(pivot.x) && Number.isFinite(pivot.y) ? { x: pivot.x, y: pivot.y } : undefined;
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent meshes bake viewer</title>
<style>
:root{--paper:#f5f2e8;--ink:#202b2a;--cobalt:#2e4be8;--leaf:#d8e7a1;--muted:#65706b;--line:#d1d3c8;--panel:#fbf9f2;--stage:#e6e2d2;--mono:ui-monospace,'Cascadia Mono',Consolas,'Liberation Mono',monospace;--pixel:'Pixelify Sans',ui-monospace,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme: dark){:root{--paper:#161c1b;--ink:#ece8da;--cobalt:#8a9bff;--leaf:#d8e7a1;--muted:#a3ada7;--line:#303a38;--panel:#1d2423;--stage:#252e2d;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 var(--mono)}
/* Whole-pixel line heights and a page that sits on a whole-pixel left margin put every canvas on a whole CSS pixel, so at a whole device pixel ratio the sprites are not resampled; at a fractional ratio the browser still resamples them, and image-rendering:pixelated keeps the edges hard. The page is centred by flooring half the spare width to a whole pixel (margin-inline:auto would leave a half pixel at an odd window width); a browser that cannot round() keeps the page left-aligned, which is whole-pixel too. */
.page{max-width:1240px;margin:0;padding:0 20px}
@supports (margin-left:round(down,1.5px,1px)){.page{margin-left:max(0px,round(down,calc((100% - 1240px) / 2),1px))}}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px}
.brand svg{display:block;width:28px;height:28px}
.cube-top{fill:var(--leaf)}.cube-left{fill:var(--cobalt)}.cube-right{fill:var(--ink)}
.word{font-family:var(--pixel);font-size:21px;line-height:32px;font-weight:600;letter-spacing:.01em}
.status{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
.dot{display:inline-block;width:9px;height:9px;background:var(--cobalt)}
.dot[data-state=paused]{background:transparent;box-shadow:inset 0 0 0 2px var(--muted)}
.head{padding:30px 0 20px}
.eyebrow{margin:0 0 6px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
h1{margin:0;font-family:var(--pixel);font-weight:500;font-size:40px;line-height:48px;overflow-wrap:anywhere}
.meta{margin:10px 0 0;color:var(--muted);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.notice{margin:14px 0 0;padding:10px 12px;border:1px solid var(--cobalt);background:var(--leaf);color:#202b2a;font-size:13px;line-height:20px}
.panel{border:1px solid var(--line);background:var(--panel);padding:16px;margin:0 0 16px}
h2{display:flex;align-items:center;gap:8px;margin:0 0 12px;color:var(--muted);font-size:12px;font-weight:400;text-transform:uppercase;letter-spacing:.1em}
h2::before{content:"";width:8px;height:8px;background:var(--cobalt)}
h2 .hint{margin-left:6px;text-transform:none;letter-spacing:0}
.controls{display:flex;flex-wrap:wrap;gap:14px 20px;align-items:flex-end}
.field{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.1em}
.field.check{flex-direction:row;align-items:center;gap:8px;padding-bottom:7px}
select,button{font:inherit;font-size:13px;color:var(--ink);background:var(--paper);border:1px solid var(--ink);border-radius:0;padding:6px 10px;min-height:34px}
select{text-transform:none;letter-spacing:0}
button{cursor:pointer}
button:hover,select:hover{background:var(--leaf);color:#202b2a}
button.primary{background:var(--cobalt);border-color:var(--cobalt);color:var(--paper)}
button.primary:hover{background:var(--ink);border-color:var(--ink);color:var(--paper)}
input[type=checkbox]{accent-color:var(--cobalt);width:16px;height:16px;margin:0}
:focus-visible{outline:2px solid var(--cobalt);outline-offset:2px}
.keys{margin-left:auto;color:var(--muted);font-size:12px;text-transform:none;letter-spacing:0}
.stage{display:flex;flex-wrap:wrap;gap:24px 36px;align-items:flex-start;overflow-x:auto}
.readout{display:flex;flex-direction:column;gap:6px;min-width:180px}
.readout .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.1em}
.counter{display:flex;align-items:baseline;gap:10px;height:56px;font-family:var(--pixel);font-size:54px;line-height:56px}
.counter small{font-size:20px;line-height:56px;color:var(--muted)}
.readout .line{color:var(--muted);font-size:13px;line-height:20px}
.note{margin:0;color:var(--muted);font-size:13px;line-height:20px;max-width:60ch}
.plate{padding:12px;flex:none}
.cellbox{position:relative;flex:none;display:block;line-height:0;background:var(--stage)}
canvas{display:block;max-width:none;image-rendering:pixelated}
.plate .cellbox::before,.plate .cellbox::after{content:"";position:absolute;width:14px;height:14px;border:2px solid var(--cobalt);pointer-events:none}
.plate .cellbox::before{left:-8px;top:-8px;border-right:0;border-bottom:0}
.plate .cellbox::after{right:-8px;bottom:-8px;border-left:0;border-top:0}
body[data-backdrop=green] .cellbox{background:#7bbf6a}
body[data-backdrop=grey] .cellbox{background:#c9c9c9}
body[data-backdrop=dark] .cellbox{background:#101010}
body[data-backdrop=checker] .cellbox{background:repeating-conic-gradient(#b4b4b4 0 25%,#8a8a8a 0 50%) 0 0/16px 16px}
.pivot{position:absolute;background:var(--cobalt);box-shadow:0 0 0 2px var(--leaf);pointer-events:none}
.tiles{display:flex;flex-wrap:wrap;gap:22px}
.tile{margin:0}
.tile figcaption,.seam figcaption{margin-top:6px;color:var(--muted);font-size:12px;line-height:16px}
.strip{display:flex;flex-wrap:wrap;gap:12px}
.strip button{display:flex;flex-direction:column;align-items:center;gap:6px;padding:0;min-height:0;border:0;background:none;color:var(--muted);font-size:12px}
.strip button:hover{background:none;color:var(--ink)}
.strip .cellbox{outline:2px solid transparent;outline-offset:3px}
.strip button[aria-current=true]{color:var(--cobalt);font-weight:700}
.strip button[aria-current=true] .cellbox{outline-color:var(--cobalt)}
.seam{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
.seam figure{margin:0}
.seam figure.lead{display:grid;grid-template-columns:auto auto;column-gap:10px}
.seam figure.lead>.cellbox,.seam figure.lead>figcaption{grid-column:2}
.loopmark{grid-column:1;grid-row:1 / span 2;display:flex;align-items:flex-end;padding-left:8px;border-left:2px solid var(--cobalt);color:var(--cobalt);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.1em;writing-mode:vertical-rl}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 20px;margin-top:24px;padding:16px 0 28px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.sha{background:var(--leaf);color:#202b2a;padding:0 6px}
@media (max-width:640px){.page{padding:0 16px}.keys{margin-left:0;flex-basis:100%}.counter{font-size:42px;height:44px;line-height:44px}.counter small{line-height:44px}h1{font-size:28px;line-height:36px}}
</style></head>
<body data-backdrop="neutral">
<div class="page">
<header class="bar">
<div class="brand"><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><path class="cube-top" d="M12 2 21 7 12 12 3 7z"/><path class="cube-left" d="M3 7 12 12V22L3 17z"/><path class="cube-right" d="M21 7V17L12 22V12z"/></svg><span class="word">agent meshes</span></div>
<div class="status"><span class="dot" data-role="status-dot" data-state="playing"></span><span data-role="status">playing</span></div>
</header>
<section class="head">
<p class="eyebrow">Bake loop viewer</p>
<h1 data-role="clip-name"></h1>
<p class="meta" data-role="meta"></p>
<p class="notice" data-role="notice" hidden></p>
</section>
<main>
<section class="panel controls" aria-label="Controls">
<label class="field">Facing<select data-role="facing"></select></label>
<label class="field">Scale<select data-role="scale"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option></select></label>
<label class="field">Speed<select data-role="speed"><option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option></select></label>
<label class="field">Backdrop<select data-role="backdrop"><option value="neutral">Neutral</option><option value="green">Green</option><option value="grey">Light grey</option><option value="dark">Near black</option><option value="checker">Checker</option></select></label>
<button type="button" class="primary" data-role="play">Pause</button>
<button type="button" data-role="step-back" aria-label="Previous frame">&larr; Step</button>
<button type="button" data-role="step-forward" aria-label="Next frame">Step &rarr;</button>
@@PIVOT_TOGGLE@@<span class="keys">Space pauses. Left and right arrows step. 1 to 8 pick a facing.</span>
</section>
<section class="panel" aria-label="Playback">
<div class="stage">
<div class="plate" data-role="single"><div class="cellbox" data-role="sprite-box"><canvas data-role="sprite" role="img" aria-label="Sprite preview of the chosen facing and frame"></canvas></div></div>
<div class="tiles" data-role="tiles" hidden></div>
<div class="readout">
<span class="label">Frame</span>
<div class="counter" data-role="counter" aria-live="off" aria-atomic="true"><span data-role="frame-index">0</span> <small>of <span data-role="frame-count">0</span></small></div>
<span class="line" data-role="facing-label"></span>
<span class="line"><span data-role="frame-ms">0</span> ms for this frame</span>
<p class="note" data-role="all-note" hidden>All facings plays every facing at the chosen scale. The frame strip and the loop seam show one facing, so pick a facing to see them.</p>
</div>
</div>
</section>
<div data-role="strips">
<section class="panel" aria-label="Frames of this facing">
<h2>Frames <span class="hint">click a frame to hold it</span></h2>
<div class="strip" data-role="strip"></div>
</section>
<section class="panel" aria-label="Loop seam">
<h2>Loop seam <span class="hint">the last two frames, then the first two: the step across the line is the one that can pop</span></h2>
<div class="seam" data-role="seam"></div>
</section>
</div>
</main>
<footer><span>Made with agent meshes</span><span>sheet sha-256 <span class="sha" data-role="footer-sha">@@SHA@@</span></span></footer>
</div>
<script type="application/json" id="viewer-data">@@DATA@@</script>
<script>
(function () {
'use strict';
var DATA = JSON.parse(document.getElementById('viewer-data').textContent);
var atlas = DATA.atlas, manifest = DATA.manifest || {}, pivot = DATA.pivot;
var role = function (name) { return document.querySelector('[data-role="' + name + '"]'); };
var make = function (tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; };
var frames = Array.isArray(atlas.frames) ? atlas.frames : Object.values(atlas.frames || {});
var tags = ((atlas.meta && atlas.meta.frameTags) || []).filter(function (t) { return /^dir-/.test(t.name); });
if (!tags.length) tags = [{ name: 'dir-0', from: 0, to: frames.length - 1 }];
var cell = manifest.cell || frames[0].frame.w;
var clipName = manifest.clip && manifest.clip.name ? String(manifest.clip.name) : 'untitled clip';
var SCALES = [1, 2, 4, 8];
var scale = 1;
SCALES.forEach(function (s) { if (cell * s <= 256) scale = s; });
// A viewer who asks the system for reduced motion gets a still page on frame 0; Play still works. The signal is read once, at load.
var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var st = { facing: tags[0].name, scale: scale, speed: 1, playing: !reduceMotion, t: 0, held: null, pivotOn: true };

var facingSel = role('facing'), scaleSel = role('scale'), speedSel = role('speed'), backdropSel = role('backdrop');
var playBtn = role('play'), sprite = role('sprite'), spriteBox = role('sprite-box'), single = role('single'), tilesBox = role('tiles');
var stripsBox = role('strips'), stripBox = role('strip'), seamBox = role('seam'), notice = role('notice'), allNote = role('all-note');
var pivotToggle = role('pivot-toggle'), counterBox = role('counter');
var degrees = function (k) { return Math.round(k * 3600 / tags.length) / 10; };
var tagLabel = function (t, k) { return t.name + ' (' + degrees(k) + ' deg)'; };

role('clip-name').textContent = clipName;
document.title = clipName + ' - agent meshes';
var bits = [tags.length + (tags.length === 1 ? ' facing' : ' facings'), (manifest.phases || (tags[0].to - tags[0].from + 1)) + ' phases', cell + ' px cells'];
if (manifest.clip && manifest.clip.durationMs) bits.push(manifest.clip.durationMs + ' ms loop');
if (manifest.look) bits.push('look ' + manifest.look);
if (manifest.palette && manifest.palette.colors) bits.push(manifest.palette.colors + ' colour palette');
if (manifest.outline) bits.push('outline ' + manifest.outline);
if (manifest.anchor && manifest.anchor.name) bits.push('anchor ' + manifest.anchor.name);
role('meta').textContent = bits.join(' / ');

facingSel.add(new Option('All facings', 'all'));
tags.forEach(function (t, k) { facingSel.add(new Option(tagLabel(t, k), t.name)); });
facingSel.value = st.facing;
scaleSel.value = String(st.scale);

var img = new Image();
var ready = false, dirty = true;
img.addEventListener('load', function () { ready = true; dirty = true; notice.hidden = true; });
img.addEventListener('error', function () { notice.textContent = 'Could not load ' + DATA.sheet + '. Keep this page in the same folder as the sheet.'; notice.hidden = false; });
img.src = encodeURIComponent(DATA.sheet);

var dur = function (f) { return f && f.duration > 0 ? f.duration : 150; };
var count = function (t) { return t.to - t.from + 1; };
var tagByName = function (name) { return tags.filter(function (t) { return t.name === name; })[0]; };
var refTag = function () { return tagByName(st.facing) || tags[0]; };
function relAt(tag, time) {
  var n = count(tag), total = 0, i;
  for (i = 0; i < n; i++) total += dur(frames[tag.from + i]);
  var m = ((time % total) + total) % total;
  for (i = 0; i < n; i++) { var d = dur(frames[tag.from + i]); if (m < d) return i; m -= d; }
  return n - 1;
}
function startOf(tag, rel) { var s = 0; for (var i = 0; i < rel; i++) s += dur(frames[tag.from + i]); return s; }
var relOf = function (tag) { return st.held !== null ? st.held % count(tag) : relAt(tag, st.t); };
var wrap = function (i, n) { return ((i % n) + n) % n; };

// A slice key holds from its frame until the next key, so a bake that anchors each direction separately has one key per
// direction and the pivot shown follows the facing.
var pivotKeys = (function () {
  var slices = (atlas.meta && atlas.meta.slices) || [], slice = slices.filter(function (s) { return s.name === 'pivot'; })[0] || slices[0];
  return ((slice && slice.keys) || []).filter(function (k) { return k && k.pivot && isFinite(k.pivot.x) && isFinite(k.pivot.y); }).sort(function (a, b) { return a.frame - b.frame; });
})();
function pivotFor(index) {
  var found = pivot;
  for (var i = 0; i < pivotKeys.length; i++) if (pivotKeys[i].frame <= index) found = pivotKeys[i].pivot;
  return found;
}

function drawCell(canvas, index, overlayPivot) {
  var f = frames[index];
  if (!f) return;
  var fr = f.frame, w = fr.w * st.scale, h = fr.h * st.scale;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var x = canvas.getContext('2d');
  x.clearRect(0, 0, w, h);
  x.imageSmoothingEnabled = false;
  if (ready) x.drawImage(img, fr.x, fr.y, fr.w, fr.h, 0, 0, w, h);
  var pivot = pivotFor(index);
  if (overlayPivot && pivot && st.pivotOn) {
    x.fillStyle = '#d8e7a1'; x.fillRect(pivot.x * st.scale - 1, pivot.y * st.scale - 1, st.scale + 2, st.scale + 2);
    x.fillStyle = '#2e4be8'; x.fillRect(pivot.x * st.scale, pivot.y * st.scale, st.scale, st.scale);
  }
}

var pivotEl = null;
function syncPivot() {
  var pivot = pivotFor(refTag().from);
  var want = pivot && st.pivotOn && st.facing !== 'all';
  if (!want) { if (pivotEl) { pivotEl.remove(); pivotEl = null; } return; }
  if (!pivotEl) { pivotEl = make('span', 'pivot'); pivotEl.setAttribute('data-role', 'pivot'); pivotEl.setAttribute('aria-hidden', 'true'); spriteBox.appendChild(pivotEl); }
  pivotEl.style.left = pivot.x * st.scale + 'px'; pivotEl.style.top = pivot.y * st.scale + 'px';
  pivotEl.style.width = st.scale + 'px'; pivotEl.style.height = st.scale + 'px';
  pivotEl.setAttribute('data-x', String(pivot.x)); pivotEl.setAttribute('data-y', String(pivot.y));
}

var stripButtons = [], seamCells = [], tiles = [];
function buildFrames() {
  var all = st.facing === 'all';
  stripBox.textContent = ''; seamBox.textContent = ''; stripButtons = []; seamCells = [];
  stripsBox.hidden = all; single.hidden = all; tilesBox.hidden = !all; allNote.hidden = !all;
  tilesBox.textContent = ''; tiles = [];
  if (all) {
    tags.forEach(function (t, k) {
      var fig = make('figure', 'tile'), box = make('div', 'cellbox'), c = make('canvas'), cap = make('figcaption');
      c.setAttribute('data-role', 'facing-tile'); cap.textContent = tagLabel(t, k);
      box.appendChild(c); fig.appendChild(box); fig.appendChild(cap); tilesBox.appendChild(fig);
      tiles.push({ tag: t, canvas: c, last: -1 });
    });
    return;
  }
  var tag = refTag(), n = count(tag), i;
  for (i = 0; i < n; i++) {
    var b = make('button'), box2 = make('span', 'cellbox'), c2 = make('canvas'), num = make('span');
    b.type = 'button'; b.setAttribute('data-role', 'strip-frame'); b.setAttribute('data-frame', String(i));
    b.setAttribute('aria-label', 'Hold frame ' + i); num.textContent = String(i);
    b.addEventListener('click', (function (index) { return function () { holdAt(index); }; })(i));
    box2.appendChild(c2); b.appendChild(box2); b.appendChild(num); stripBox.appendChild(b);
    stripButtons.push({ button: b, canvas: c2, index: tag.from + i, rel: i });
  }
  [n - 2, n - 1, 0, 1].forEach(function (p, k) {
    var rel = wrap(p, n), fig = make('figure', k === 2 ? 'lead' : ''), box3 = make('div', 'cellbox'), c3 = make('canvas'), cap = make('figcaption');
    // The loop point mark is a child of the figure for frame 0, so it stays directly before that frame whether the strip wraps or not.
    if (k === 2) { var mark = make('div', 'loopmark'); mark.setAttribute('data-role', 'loop-mark'); mark.setAttribute('aria-hidden', 'true'); mark.textContent = 'loop point'; fig.appendChild(mark); }
    fig.setAttribute('data-role', 'seam-frame'); fig.setAttribute('data-frame', String(rel));
    cap.textContent = 'frame ' + rel + (k < 2 ? (k === 1 ? ' (last)' : '') : (k === 2 ? ' (first)' : ''));
    box3.appendChild(c3); fig.appendChild(box3); fig.appendChild(cap); seamBox.appendChild(fig);
    seamCells.push({ canvas: c3, index: tag.from + rel });
  });
  dirty = true;
}

var shown = { rel: -1, status: '' };
// The frame readout is a polite live region only while paused or stepping, so a screen reader hears each step but not every playing frame.
// The attribute changes only when playback starts or stops (and once at load), never on an animation frame.
function setLive() {
  var want = st.playing ? 'off' : 'polite';
  if (counterBox.getAttribute('aria-live') !== want) counterBox.setAttribute('aria-live', want);
}
// The deferred write reads the current state when it runs, not what was true when it was queued.
function writeReadout() {
  var ref = refTag(), rel = relOf(ref);
  role('frame-index').textContent = String(rel);
  role('frame-count').textContent = String(count(ref));
  role('frame-ms').textContent = String(dur(frames[ref.from + rel]));
}
var lastIdx = -1;
function paint(deferReadout) {
  var all = st.facing === 'all', ref = refTag(), rel = relOf(ref);
  if (all) {
    tiles.forEach(function (tile) {
      var idx = tile.tag.from + relOf(tile.tag);
      if (dirty || idx !== tile.last) { drawCell(tile.canvas, idx, true); tile.last = idx; }
    });
  } else {
    var idx = ref.from + rel;
    if (dirty || idx !== lastIdx) { drawCell(sprite, idx, false); lastIdx = idx; }
    if (dirty) {
      stripButtons.forEach(function (s) { drawCell(s.canvas, s.index, true); });
      seamCells.forEach(function (s) { drawCell(s.canvas, s.index, true); });
    }
  }
  syncPivot();
  dirty = false;
  if (rel !== shown.rel) {
    shown.rel = rel;
    // A Step that ends playback opens the live region first and writes the frame in a later task, so a screen reader hears the new frame.
    if (deferReadout) setTimeout(writeReadout, 0); else writeReadout();
    stripButtons.forEach(function (s) { if (s.rel === rel) s.button.setAttribute('aria-current', 'true'); else s.button.removeAttribute('aria-current'); });
  }
  var status = st.playing ? 'playing' : 'paused';
  if (status !== shown.status) {
    shown.status = status;
    role('status').textContent = status; role('status-dot').setAttribute('data-state', status);
    playBtn.textContent = st.playing ? 'Pause' : 'Play';
  }
}

function setFacing(name) {
  st.facing = name; facingSel.value = name; buildFrames();
  var k = tags.indexOf(refTag());
  role('facing-label').textContent = name === 'all' ? 'all facings' : tagLabel(refTag(), k);
  shown.rel = -1; lastIdx = -1; dirty = true;
  paint();
}
function togglePlay() {
  if (st.playing) { st.playing = false; setLive(); paint(); return; }
  if (st.held !== null) { st.t = startOf(refTag(), st.held % count(refTag())); st.held = null; }
  st.playing = true;
  setLive();
  paint();
}
function holdAt(rel) { var wasPlaying = st.playing; st.playing = false; st.held = rel; setLive(); paint(wasPlaying); }
function step(delta) { var ref = refTag(); holdAt(wrap(relOf(ref) + delta, count(ref))); }

playBtn.addEventListener('click', togglePlay);
role('step-back').addEventListener('click', function () { step(-1); });
role('step-forward').addEventListener('click', function () { step(1); });
facingSel.addEventListener('change', function () { setFacing(facingSel.value); });
scaleSel.addEventListener('change', function () { st.scale = +scaleSel.value; dirty = true; paint(); });
speedSel.addEventListener('change', function () { st.speed = +speedSel.value; });
backdropSel.addEventListener('change', function () { document.body.setAttribute('data-backdrop', backdropSel.value); });
if (pivotToggle) pivotToggle.addEventListener('change', function () { st.pivotOn = pivotToggle.checked; dirty = true; paint(); });
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var tagName = e.target && e.target.tagName;
  if (tagName === 'SELECT' || tagName === 'INPUT') return;
  // Only the play button handles Space itself (it clicks on keyup); on any other focus, a button included, Space toggles play.
  // A held key repeats keydown: the repeats only cancel the default (so the page does not scroll) and do not toggle again.
  if (e.code === 'Space') { if (e.target === playBtn) return; e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (/^[1-8]$/.test(e.key) && tags[+e.key - 1]) setFacing(tags[+e.key - 1].name);
});

// A focused button would also click on the Space keyup, so that keyup is cancelled too (the play button keeps its own click).
document.addEventListener('keyup', function (e) {
  var tagName = e.target && e.target.tagName;
  if (e.code === 'Space' && e.target !== playBtn && tagName !== 'SELECT' && tagName !== 'INPUT' && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
});

setLive();
setFacing(st.facing);
paint();
var last = performance.now();
function tick(now) {
  var dt = now - last; last = now;
  if (st.playing) st.t += dt * st.speed;
  paint();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
})();
</script>
</body></html>
`;

/** Where `viewerPivot` finds a pivot the page gets a toggle, checked by default; without one there is no control at all. */
const PIVOT_TOGGLE = '<label class="field check"><input type="checkbox" data-role="pivot-toggle" checked>Show pivot</label>\n';

/**
 * The viewer page. `sheetFile` is the sheet's name beside the page (a bare file name), and `sheetSha256` its 64 hex
 * digits, of which the footer shows the first 12.
 */
export function composeViewer(atlas: Atlas, manifest: SpriteManifest, sheetFile: string, sheetSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sheetSha256)) throw viewerError(`The sheet SHA-256 must be 64 lowercase hex digits, got "${sheetSha256}"`);
  if (!sheetFile || !SAFE_SHEET_NAME.test(sheetFile)) throw viewerError(`The sheet must be a bare file name beside the page, got "${sheetFile}"`);
  if (!Array.isArray(atlas.frames) || atlas.frames.length === 0) throw viewerError('The atlas holds no frames');
  const pivot = viewerPivot(atlas);
  const data = jsonForScript({ atlas, manifest, sheet: sheetFile, pivot: pivot ?? null });
  return PAGE
    .replace('@@PIVOT_TOGGLE@@', () => (pivot ? PIVOT_TOGGLE : ''))
    .replace('@@SHA@@', () => sheetSha256.slice(0, FOOTER_SHA_LENGTH))
    .replace('@@DATA@@', () => data);
}
