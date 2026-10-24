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
  it('has exactly one 2D row that sends sprite work to agent-sprites and says what is not shipped', () => {
    const { rows } = routeTable();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const twoD = rows.filter(row => /2D/.test(firstCell(row)));
    expect(twoD).toHaveLength(1);
    const row = twoD[0];
    expect(row.split('|')).toHaveLength(rows[0].split('|').length); // same column count as the other rows
    expect(row).toContain('agent-sprites');
    expect(row).toMatch(/recipes/);
    expect(row).toContain('GLB is not a runtime asset in Phaser');
    expect(row).toContain('no shipped command exports sprite frames');
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

describe('mesh-tool-selection 2D reference evidence', () => {
  // A bullet is its first line plus the indented lines that wrap under it.
  const bullets = () => linesOf(REFERENCE).reduce<string[]>((found, line) => {
    if (/^\s*[-*]\s/.test(line)) found.push(line);
    else if (/^\s+\S/.test(line) && found.length > 0) found[found.length - 1] += ` ${line.trim()}`;
    return found;
  }, []);

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
    expect(preview[0]).toContain('`src/web/viewer.ts`');
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
  it('fails when src/cli.ts registers a bake command, so the "no shipped command" text cannot go stale silently', () => {
    const registered = /\.command\(\s*['"`]bake\b/.test(read(CLI));
    expect(registered, 'src/cli.ts now registers a bake command: update the 2D engine row in skills/mesh-tool-selection/SKILL.md and references/two-d-engines.md, which say no shipped command exports sprite frames, then remove this tripwire. This check sees only a command named bake: a sprite-frame export under another name is not caught, so re-read the registered commands whenever either file is edited').toBe(false);
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
    const message = 'scripts/review-model.mjs or src/web/viewer.ts changed what the review capture renders: re-read them and update the capture bullet in references/two-d-engines.md, which says it renders opaque, perspective images, and check the 2D row in SKILL.md, which calls it a review tool';
    expect(capture, message).toMatch(/floor:\s*false/);
    expect(capture, message).toMatch(/background:\s*'#[0-9a-f]{6}'/i);
    expect(capture, message).toMatch(/for\(const pose of poses\)[\s\S]*?for\(const region of \[\{name:'body'\},\.\.\.selected\]\)[\s\S]*?for\(const azimuth of ring\)/);
    expect(viewer, message).toMatch(/new THREE\.PerspectiveCamera\(/);
    expect(viewer, message).not.toMatch(/OrthographicCamera/);
  });
});
