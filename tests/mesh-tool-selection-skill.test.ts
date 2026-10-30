/** @lane merge
 * @subject skills/mesh-tool-selection
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The mesh-tool-selection skill must answer "does a 2D engine need a mesh at all?" without the reader opening
// another plugin. These checks pin the routing text, the evidence labels and the links, so the answer cannot
// drift or go stale unnoticed.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'skills/mesh-tool-selection/SKILL.md');
const REFERENCE = join(ROOT, 'skills/mesh-tool-selection/references/two-d-engines.md');
const CLI = join(ROOT, 'src/cli.ts');
const DESCRIPTION_CAP = 1536;
const REFERENCE_BYTE_BUDGET = 3500;

const read = (file: string) => readFileSync(file, 'utf8');
const linesOf = (file: string) => read(file).split(/\r?\n/);

function description(): string {
  const lines = linesOf(SKILL);
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(1);
  const found = lines.slice(1, end).filter(line => line.startsWith('description:'));
  expect(found).toHaveLength(1);
  const quoted = found[0].slice('description:'.length).trim();
  expect(quoted).toMatch(/^".*"$/); // a double-quoted scalar, so colons and commas inside stay valid YAML
  return JSON.parse(quoted) as string; // fails on an unescaped inner quote, which YAML would also reject
}

function routeTable(): { header: string; rows: string[] } {
  const lines = linesOf(SKILL);
  const start = lines.findIndex(line => line.startsWith('| Route |'));
  expect(start).toBeGreaterThanOrEqual(0);
  const blank = lines.findIndex((line, index) => index > start && line.trim() === '');
  const block = lines.slice(start, blank === -1 ? lines.length : blank);
  return { header: block[0], rows: block.slice(2) }; // block[1] is the |---| rule
}
const firstCell = (row: string) => row.split('|')[1].trim();

function decisionQuestion(number: number): string {
  const lines = linesOf(SKILL);
  const start = lines.findIndex(line => line.startsWith(`${number}. **`));
  expect(start).toBeGreaterThanOrEqual(0);
  const next = lines.findIndex((line, index) => index > start && /^\d+\. \*\*/.test(line));
  const stop = lines.findIndex((line, index) => index > start && line.trim() === '');
  const end = [next, stop].filter(index => index !== -1).sort((a, b) => a - b)[0] ?? lines.length;
  return lines.slice(start, end).join(' ');
}

// GitHub-style heading anchors, enough for this repository's headings.
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const anchorsOf = (file: string) => linesOf(file).filter(line => /^#{1,6}\s/.test(line)).map(line => slug(line.replace(/^#{1,6}\s+/, '')));
function markdownLinks(file: string): string[] {
  const text = read(file).replace(/^(```|~~~)[\s\S]*?^\1/gm, ''); // links inside fenced examples are not links
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1]);
}
function brokenLinks(file: string): string[] {
  const broken: string[] = [];
  for (const target of markdownLinks(file)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http, https, mailto and other schemes
    const [path, fragment] = target.split('#');
    const destination = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(destination)) { broken.push(`${target} (no such file)`); continue; }
    if (fragment && destination.endsWith('.md') && !anchorsOf(destination).includes(fragment)) broken.push(`${target} (no such heading)`);
  }
  return broken;
}

describe('mesh-tool-selection description', () => {
  it('is a valid double-quoted scalar under the cap and names Phaser and 2D in its first sentence', () => {
    const text = description();
    expect(text.length).toBeLessThan(DESCRIPTION_CAP);
    expect(text).toContain('Phaser');
    expect(text).toContain('2D');
    const first = text.split('. ')[0]; // truncation takes from the end, so the trigger has to come early
    expect(first).toContain('Phaser');
    expect(first).toContain('2D');
  });
});

describe('mesh-tool-selection 2D route', () => {
  it('has exactly one 2D row that sends sprite work to agent-sprites and points at the bake command', () => {
    const { rows } = routeTable();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const twoD = rows.filter(row => /2D/.test(firstCell(row)));
    expect(twoD).toHaveLength(1);
    const row = twoD[0];
    expect(row.split('|')).toHaveLength(rows[0].split('|').length); // same column count as the other rows
    expect(row).toContain('agent-sprites');
    expect(row).toMatch(/recipes/);
    expect(row).toContain('GLB is not a runtime asset in Phaser');
    expect(row).toContain('agent-meshes bake');
    expect(row, 'the bake command ships: the row must not say no command exports sprite frames').not.toMatch(/no shipped command/i);
    // Two shipped capture paths are named as examples of review tools. Naming only one would make it look like the
    // only one, and ranking either as "nearest" is a claim nothing in the repository supports.
    expect(row).toContain('mesh preview --clip');
    expect(row).toContain('scripts/review-model.mjs');
    expect(row).toMatch(/review tools/);
    expect(row, 'do not rank the capture paths: they are examples of review tools, not a nearest feature').not.toMatch(/\bnearest\b/i);
    expect(row, 'the shipped captures are review renders: do not say the plugin gives no support for pre-rendering').not.toMatch(/no support/i);
    // A roadmap promise has no label and no evidence in this repository, so the row states only what exists.
    expect(row, 'the 2D row must not promise a future command; state only what the repository shows').not.toMatch(/\b(?:planned|upcoming|will ship|coming soon|on the roadmap)\b/i);
    expect(row).toMatch(/pre-render/i);
    expect(row).toContain('references/two-d-engines.md');
  });

  it('puts the 2D point in decision question 4 and the atlas verification limit in the rules', () => {
    expect(decisionQuestion(4)).toMatch(/a 2D engine does not draw 3D models/i);
    // Phaser 4.2.1 ships Mesh2D (textured triangles), so "no meshes" is false: the rule is about 3D models only.
    expect(decisionQuestion(4), 'a 2D engine can draw 2D meshes (Phaser Mesh2D): do not say it draws no meshes').not.toMatch(/not meshes|no meshes/i);
    const text = read(SKILL);
    expect(text).toContain('proves nothing about a sprite atlas');
    expect(text).toContain('sprite-verification');
  });

  it('keeps the skill short and the reference inside its byte budget', () => {
    expect(linesOf(SKILL).length).toBeLessThan(500);
    // A Windows checkout writes CRLF (git autocrlf), so count the file as if every line ended that way.
    expect(Buffer.byteLength(read(REFERENCE).replace(/\r?\n/g, '\r\n'))).toBeLessThan(REFERENCE_BYTE_BUDGET);
  });
});

describe('mesh-tool-selection links', () => {
  it('resolves every relative Markdown link and anchor in the skill and the 2D reference', () => {
    expect(brokenLinks(SKILL)).toEqual([]);
    expect(brokenLinks(REFERENCE)).toEqual([]);
  });

  it('links the 2D reference from the skill and keeps it one level deep', () => {
    expect(markdownLinks(SKILL)).toContain('references/two-d-engines.md');
    expect(markdownLinks(REFERENCE).filter(target => target.endsWith('.md'))).toEqual([]);
  });
});

// A bullet is its first line plus the indented lines that wrap under it.
const bullets = () => linesOf(REFERENCE).reduce<string[]>((found, line) => {
  if (/^\s*[-*]\s/.test(line)) found.push(line);
  else if (/^\s+\S/.test(line) && found.length > 0) found[found.length - 1] += ` ${line.trim()}`;
  return found;
}, []);

describe('mesh-tool-selection 2D reference evidence', () => {
  it('labels every bullet and names a file in every documented bullet', () => {
    const all = bullets();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const bullet of all) expect(bullet, bullet).toMatch(/^[-*] \[(?:tested|documented|general)\]/);
    const documented = all.filter(bullet => /^[-*] \[documented\]/.test(bullet));
    expect(documented.length).toBeGreaterThanOrEqual(4);
    for (const bullet of documented) expect(bullet, bullet).toMatch(/`[^`\s]+\.(?:md|js|ts|json)\b[^`]*`/);
    // A claim about another package or plugin carries the version that was read.
    for (const bullet of documented.filter(line => /\b(?:phaser|agent-engine|agent-sprites)\b/i.test(line))) expect(bullet, bullet).toMatch(/\b\d+\.\d+\.\d+\b/);
  });

  it('documents the shipped capture paths in one bullet that names their source files and what they lack', () => {
    const preview = bullets().filter(bullet => /^[-*] \[documented\]/.test(bullet) && bullet.includes('`src/preview.ts`') && bullet.includes('`scripts/blender-preview.py`'));
    expect(preview).toHaveLength(1);
    expect(preview[0]).toContain('film_transparent');
    expect(preview[0]).toContain('85 mm');
    expect(preview[0]).toContain('orthographic');
    expect(preview[0]).toContain('`scripts/review-model.mjs`');
    expect(preview[0]).toContain('`src/web/room.ts`');
    expect(preview[0]).toContain('PerspectiveCamera');
    expect(preview[0]).toMatch(/review tools/);
    // The image counts follow the loops in the two scripts (pinned by the tripwires below): the preview script draws
    // every selected view at every phase, and the review capture draws one image per azimuth for each pose and region.
    expect(preview[0]).toContain('renders each selected view at every phase');
    expect(preview[0]).toContain('one image per azimuth for each pose and region');
    expect(preview[0], 'src/preview.ts only builds the phases: do not say it renders an image per phase').not.toMatch(/one posed image per/);
  });

  it('does not rank one capture path as the nearest feature', () => {
    expect(read(REFERENCE)).not.toMatch(/\bnearest\b/i);
  });

  it('keeps location and project detail out of the reference', () => {
    const text = read(REFERENCE);
    expect(text).not.toMatch(/node_modules/);
    expect(text).not.toMatch(/\b[A-Za-z]:[\\/]/);
  });
});

describe('mesh-tool-selection pre-render tripwires', () => {
  it('fails when src/cli.ts stops registering a bake command, so the 2D route cannot point at a command that is gone', () => {
    const registered = /\.command\(\s*['"`]bake\b/.test(read(CLI));
    expect(registered, 'src/cli.ts no longer registers a bake command: update the 2D engine row in skills/mesh-tool-selection/SKILL.md and references/two-d-engines.md, which point at `agent-meshes bake`').toBe(true);
    expect(read(SKILL), 'the 2D engine row in skills/mesh-tool-selection/SKILL.md must name `agent-meshes bake`').toContain('`agent-meshes bake');
    expect(read(REFERENCE), 'references/two-d-engines.md must say that src/cli.ts registers `bake`').toMatch(/`src\/cli\.ts` registers `bake`/);
  });

  it('fails when the shipped preview render stops being an opaque, perspective review image', () => {
    const script = read(join(ROOT, 'scripts/blender-preview.py'));
    const message = 'scripts/blender-preview.py changed what mesh preview renders: re-read it and update the capture bullet in references/two-d-engines.md, which says it renders opaque, perspective images, and check the 2D row in SKILL.md, which calls it a review tool';
    expect(script, message).toMatch(/film_transparent\s*=\s*False/);
    expect(script, message).toMatch(/^LENS\s*=\s*85(?:\.0)?\s*$/m);
    expect(script, message).not.toMatch(/ORTHO/i);
    // Every selected view is drawn at every pose (phase), so a clip gives one image per view and shading per phase.
    expect(script, message).toMatch(/for pose in poses:[\s\S]*?for view in views:[\s\S]*?for shading in shadings:/);
  });

  it('fails when the review capture script or its viewer stops being an opaque, perspective render', () => {
    const capture = read(join(ROOT, 'scripts/review-model.mjs'));
    const viewer = read(join(ROOT, 'src/web/viewer.ts'));
    const room = read(join(ROOT, 'src/web/room.ts'));
    const message = 'scripts/review-model.mjs, src/web/viewer.ts or src/web/room.ts changed what the review capture renders: re-read them and update the capture bullet in references/two-d-engines.md, which says it renders opaque, perspective images, and check the 2D row in SKILL.md, which calls it a review tool';
    expect(capture, message).toMatch(/floor:\s*false/);
    expect(capture, message).toMatch(/background:\s*'#[0-9a-f]{6}'/i);
    expect(capture, message).toMatch(/for\(const pose of poses\)[\s\S]*?for\(const region of \[\{name:'body'\},\.\.\.selected\]\)[\s\S]*?for\(const azimuth of ring\)/);
    // The camera is built in room.ts: the perspective lens is the fallback branch of createCamera, and an omitted
    // projection option resolves to 'perspective'. viewer.ts must feed that parsed option straight to createCamera,
    // and the review capture must neither request a projection nor stop reading the perspective lens (`.fov`).
    expect(room, message).toMatch(/export function createCamera\([^)]*\)[^{]*\{[^}]*:\s*new THREE\.PerspectiveCamera\(/);
    expect(room, message).toMatch(/export function parseProjection\([^)]*\)[^{]*\{\s*if \(value === undefined\) return 'perspective';/);
    expect(viewer, message).toMatch(/const projection = parseProjection\(options\.projection\)/);
    expect(viewer, message).toMatch(/createCamera\(projection\)/);
    expect(capture, message).not.toMatch(/projection|orthographic/i);
    expect(capture, message).toMatch(/viewer\.camera\.fov/);
  });
});

// A sentence in the skill that says something is absent ("no shipped command", "not a runtime asset") is a factual claim
// about code or a package. Each one needs a [documented] or [tested] bullet in the evidence reference that names what
// was read, so a claim wider than the evidence (for example "no support" for engines that were never opened) cannot pass.
describe('mesh-tool-selection absence claims are paired with evidence', () => {
  const NEGATIVE = /\bno shipped\b|\bnot shipped\b|\bno support\b|\bnot supported\b|\bnot built yet\b|\bnot yet (?:built|shipped|supported)\b|\bnot a runtime asset\b|\bhas no\b|\bno loader\b/i;
  const sentencesOf = (file: string) => read(file).replace(/\r?\n(?!\r?\n)/g, ' ').split(/\r?\n\r?\n|\|\s*|(?<=[.;])\s+/).map(sentence => sentence.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const hasEvidence = (label: string, ...needles: RegExp[]) => bullets().some(bullet => bullet.startsWith(`- [${label}]`) && needles.every(needle => needle.test(bullet)));
  // Each claim lists the bullets that support it: a label and what the bullet must name.
  const CLAIMS: { say: RegExp; evidence: [label: string, ...needles: RegExp[]][] }[] = [
    { say: /A GLB is not a runtime asset in Phaser/, evidence: [['documented', /phaser \d+\.\d+\.\d+ \(`package\.json`\) has no glTF code/, /`src\/loader\/filetypes\/index\.js`/]] },
  ];

  it('pairs every absence claim in the skill with a documented or tested bullet that names what was read', () => {
    const claims = sentencesOf(SKILL).filter(sentence => NEGATIVE.test(sentence));
    expect(claims.length).toBeGreaterThanOrEqual(CLAIMS.length);
    const unpaired = claims.filter(sentence => !CLAIMS.some(({ say }) => say.test(sentence)));
    expect(unpaired, 'add a [documented] or [tested] bullet to references/two-d-engines.md that names the file read, then list the claim in CLAIMS; or drop the claim').toEqual([]);
    for (const { say, evidence } of CLAIMS) {
      expect(claims.some(sentence => say.test(sentence)), `the skill no longer says ${say}: remove it from CLAIMS`).toBe(true);
      for (const [label, ...needles] of evidence) expect(hasEvidence(label, ...needles), `${say} needs a [${label}] bullet matching ${needles.join(' and ')}`).toBe(true);
    }
  });

  it('claims nothing in the skill about an engine the evidence says was not read', () => {
    // Only Phaser's package was read. Canvas and Pixi are on the route because they draw sprites, and the reference says so.
    const absent = /\b(?:no|not|never|without|cannot|lacks?)\b/i;
    expect(sentencesOf(SKILL).filter(sentence => /\b(?:Canvas|Pixi)\b/.test(sentence) && absent.test(sentence))).toEqual([]);
    const other = bullets().filter(bullet => /\b(?:Canvas|Pixi)\b/.test(bullet));
    expect(other.length).toBeGreaterThan(0);
    for (const bullet of other) {
      expect(bullet, bullet).toMatch(/^- \[general\]/);
      expect(bullet, bullet).toMatch(/\bnot read\b/);
    }
  });

  it('keeps absence claims out of the 2D reference prose, where they carry no label', () => {
    const prose = sentencesOf(REFERENCE).filter(sentence => !/^[-*] \[(?:tested|documented|general)\]/.test(sentence) && !/^#/.test(sentence) && NEGATIVE.test(sentence));
    expect(prose).toEqual([]);
  });
});
