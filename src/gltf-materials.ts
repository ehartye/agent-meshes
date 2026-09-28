import { readGLB } from './gltf-read.ts';

/**
 * Glass in a GLB, read without a renderer: every material that is see-through, by alphaMode BLEND with a base color
 * alpha below 1 or by KHR_materials_transmission above 0. verify-unreal checks each one imports translucent.
 */
export interface GlassMaterial {
  material: number; name: string | null;
  alphaMode: 'BLEND' | 'OPAQUE' | 'MASK'; opacity: number; transmission: number; ior: number | null; doubleSided: boolean;
}
export function auditGlass(bytes: Uint8Array): GlassMaterial[] {
  const { json } = readGLB(bytes);
  return (json.materials ?? []).flatMap((m, material) => {
    const alphaMode = (m.alphaMode ?? 'OPAQUE') as GlassMaterial['alphaMode'];
    const opacity = alphaMode === 'BLEND' ? m.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1 : 1;
    const extensions = (m.extensions ?? {}) as { KHR_materials_transmission?: { transmissionFactor?: number }; KHR_materials_ior?: { ior?: number } };
    const transmission = extensions.KHR_materials_transmission?.transmissionFactor ?? 0;
    if (!(opacity < 1 || transmission > 0)) return [];
    return [{ material, name: m.name ?? null, alphaMode, opacity, transmission, ior: extensions.KHR_materials_ior?.ior ?? null, doubleSided: m.doubleSided ?? false }];
  });
}
