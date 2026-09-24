import { Color, LinearSRGBColorSpace, Mesh, MeshBasicMaterial } from 'three';
import type { Material, Object3D } from 'three';

/**
 * ID rendering: every surface drawn in one exact, unlit color chosen by material name or by part
 * (and slot), so pixel checks can count what is visible. This module is renderer-free: it plans
 * and swaps materials; the web viewer renders the result into a non-multisampled target.
 */
export interface IdRenderColors {
  /** Material name → `#rrggbb`. In a stage, `model/material` limits the key to one model. */
  materials?: Record<string, string>;
  /** Part name, or `part#slot` for one zero-based material slot → `#rrggbb`. In a stage, `model/part` or `model/part#slot`. */
  parts?: Record<string, string>;
  /** The clear color behind everything. Default `#000000`. */
  background?: string;
  /** Color for surfaces no key matches (default: the background color, so they still occlude), or `null` to hide them. */
  other?: string | null;
}
export interface IdRenderOptions extends IdRenderColors {
  /** Output size in pixels. Default: the viewer's current CSS size. */
  width?: number;
  height?: number;
  /** Stage only: render just these models; the others are hidden for this render. Default all. */
  models?: string[];
}
/** Top-row-first RGBA pixels. */
export interface IdImage { width: number; height: number; data: Uint8ClampedArray }
export interface IdTarget { model: string | null; mesh: Mesh; part: string; slot: number; material: string }

const colorPattern = /^#[0-9a-f]{6}$/i;
/** Parse an exact `#rrggbb` color into 0..255 channels; anything else throws naming `label`. */
export function parseIdColor(value: unknown, label: string): [number, number, number] {
  if (typeof value !== 'string' || !colorPattern.test(value)) throw new Error(`${label} must be a #rrggbb color: ${JSON.stringify(value)}`);
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}
const canonical = (value: string, label: string) => `#${parseIdColor(value, label).map(v => v.toString(16).padStart(2, '0')).join('')}`;

/** Every drawable mesh slot under the given roots, skipping outline hulls. */
export function collectIdTargets(roots: readonly { model: string | null; root: Object3D }[]): IdTarget[] {
  const targets: IdTarget[] = [];
  for (const { model, root } of roots) root.traverse(object => {
    if (!(object instanceof Mesh) || object.userData.outline) return;
    const slots = Array.isArray(object.material) ? object.material : [object.material];
    slots.forEach((material: Material, slot) => targets.push({ model, mesh: object, part: object.name, slot, material: material.name }));
  });
  return targets;
}

const optionKeys = ['materials', 'parts', 'background', 'other', 'width', 'height', 'models'];
/**
 * Choose each target's color (null = hidden). Precedence: `part#slot`, then `part`, then material;
 * at each level a `model/` key beats an unscoped one. Keys that match nothing throw, listing the names.
 */
export function resolveIdColors(targets: readonly IdTarget[], options: IdRenderColors): Map<IdTarget, string | null> {
  for (const key of Object.keys(options)) if (!optionKeys.includes(key)) throw new Error(`Unknown idRender option "${key}"; use ${optionKeys.join(', ')}`);
  const background = canonical(options.background ?? '#000000', 'background');
  const other = options.other === null ? null : canonical(options.other ?? background, 'other');
  const table = (kind: 'materials' | 'parts') => {
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(options[kind] ?? {})) map.set(key, canonical(value, `${kind}.${key}`));
    return map;
  };
  const materials = table('materials'), parts = table('parts');
  const keysOf = (target: IdTarget) => {
    const scoped = (name: string) => (target.model === null ? [name] : [`${target.model}/${name}`, name]);
    return { parts: [...scoped(`${target.part}#${target.slot}`), ...scoped(target.part)], materials: scoped(target.material) };
  };
  const used = new Set<string>(), result = new Map<IdTarget, string | null>();
  for (const target of targets) {
    const keys = keysOf(target);
    for (const key of keys.parts) if (parts.has(key)) used.add(`p:${key}`);
    for (const key of keys.materials) if (materials.has(key)) used.add(`m:${key}`);
    const part = keys.parts.find(key => parts.has(key)), material = keys.materials.find(key => materials.has(key));
    result.set(target, part !== undefined ? parts.get(part)! : material !== undefined ? materials.get(material)! : other);
  }
  const known = (values: Iterable<string>) => [...new Set(values)].filter(Boolean).sort().join(', ');
  for (const key of materials.keys()) if (!used.has(`m:${key}`)) throw new Error(`Unknown material "${key}" in idRender; materials: ${known(targets.map(t => t.material))}`);
  for (const key of parts.keys()) if (!used.has(`p:${key}`)) throw new Error(`Unknown part "${key}" in idRender; parts: ${known(targets.flatMap(t => [t.part, `${t.part}#${t.slot}`]))}`);
  return result;
}

/** The linear-space color whose 8-bit output is exactly `hex` when rendered without color conversion. */
export function idColor(hex: string): Color {
  const [r, g, b] = parseIdColor(hex, 'color');
  return new Color().setRGB(r / 255, g / 255, b / 255, LinearSRGBColorSpace);
}

/**
 * Swap every target to an unlit MeshBasicMaterial of its color (hiding null targets and `alsoHide`),
 * keeping face side, morphs and skinning. Returns an idempotent restore that puts back the original
 * material objects and visibility and disposes the temporary materials.
 */
export function applyIdMaterials(targets: readonly IdTarget[], colors: ReadonlyMap<IdTarget, string | null>, alsoHide: readonly Object3D[]): () => void {
  const saved = new Map<Mesh, Mesh['material']>(), visibility = new Map<Object3D, boolean>(), created: MeshBasicMaterial[] = [];
  const hide = (object: Object3D) => { if (!visibility.has(object)) visibility.set(object, object.visible); object.visible = false; };
  for (const target of targets) if (!saved.has(target.mesh)) saved.set(target.mesh, target.mesh.material);
  const byMesh = new Map<Mesh, IdTarget[]>();
  for (const target of targets) byMesh.set(target.mesh, [...byMesh.get(target.mesh) ?? [], target]);
  for (const [mesh, slots] of byMesh) {
    const original = saved.get(mesh)!, originals = Array.isArray(original) ? original : [original];
    if (slots.every(target => colors.get(target) === null)) { hide(mesh); continue; }
    const swapped = slots.map(target => {
      const color = colors.get(target) ?? null;
      const material = new MeshBasicMaterial({ color: color === null ? 0 : idColor(color), side: originals[target.slot].side, toneMapped: false, fog: false, transparent: false, opacity: 1, depthWrite: true, depthTest: true });
      // A hidden slot inside a visible mesh must not draw at all.
      if (color === null) material.visible = false;
      created.push(material); return material;
    });
    mesh.material = Array.isArray(original) ? swapped : swapped[0];
  }
  for (const object of alsoHide) hide(object);
  let restored = false;
  return () => {
    if (restored) return; restored = true;
    for (const [mesh, material] of saved) mesh.material = material;
    for (const [object, visible] of visibility) object.visible = visible;
    for (const material of created) material.dispose();
  };
}

/** Pixel counts by `#rrggbb` (alpha ignored). */
export function countColors(image: IdImage): Record<string, number> {
  const counts = new Map<number, number>(), { data } = image;
  for (let i = 0; i < data.length; i += 4) { const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const result: Record<string, number> = {};
  for (const [key, count] of counts) result[`#${key.toString(16).padStart(6, '0')}`] = count;
  return result;
}
