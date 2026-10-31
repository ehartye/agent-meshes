/**
 * The look of a sprite bake: how the model is lit before it is rendered into cells.
 *
 * Contract for the bake harness (`src/sprite-bake.ts`). After `MeshViewer.mount(...)` has resolved and `window.viewer` is
 * set, and before the rest fit, run the text `lookScript(look, bands)` returns in the page:
 *
 *   const script = lookScript(look, bands);               // undefined for `lit`
 *   if (script) await page.evaluate(script);              // a self-contained expression; it reads `window.viewer`
 *
 * `lit` returns undefined and the render is untouched, so a bake without a look is the room-lit render of 0.37.0. The
 * other looks edit the mounted scene in place and need nothing from the viewer bundle, which does not export three.js:
 * they remove every light and the environment, and change the standard material the glTF loader made for each mesh (so the
 * colour, texture, vertex colours, side, alpha mode and skinning stay exactly as authored) to take `diffuseColor`, which
 * is colour times map times vertex colour with its alpha, as the final colour instead of lit PBR, with tone mapping off
 * for that material so the renderer's sRGB output conversion is the only step left.
 *
 *   unlit   the final colour is `diffuseColor`: a single-colour part renders as exactly its sRGB colour.
 *   banded  the final colour is `diffuseColor` times one of `bands` brightness levels, from the ambient floor
 *           (`BANDED_FLOOR`) up to 1, chosen by a hard step of the angle between the surface and one key light. This is
 *           a toon ramp with a nearest-filtered gradient of `bands` steps, evaluated in the shader.
 *
 * The banded key light is a direction in camera space, up and to the left of the camera and toward the model
 * (`BANDED_LIGHT_FROM_CAMERA`, aimed at the model centre because a directional light has only a direction). The shader
 * works on the view-space normal, so the light is fixed relative to the camera by construction: the bake moves the camera
 * for every cell and nothing has to be updated per view, and the highlight stays on the same side of the sprite in
 * every direction. A material the puppet clones later (a material setter) loses the look; the bake sets none.
 */

export const SPRITE_LOOKS = ['lit', 'unlit', 'banded'] as const;
export type SpriteLook = (typeof SPRITE_LOOKS)[number];
export const BANDS_DEFAULT = 3;
export const BANDS_LIMITS = [2, 8] as const;
/** Brightness of the darkest band: the ambient floor, so a surface turned away from the key light is not black. */
export const BANDED_FLOOR = 0.35;
/** Direction to the key light in camera space: left (-x), up (+y) and toward the viewer (+z, the camera looks down -z). */
export const BANDED_LIGHT_FROM_CAMERA = [-1, 1, 1] as const;

const code = (message: string, errorCode: string) => Object.assign(new Error(message), { code: errorCode });

/** The bands count as an integer from 2 to 8; undefined means the default. Strings pass so command-line values go straight through. Raises `CLI_ARGUMENT_ERROR`. */
export function parseBands(value: number | string | undefined): number {
  if (value === undefined) return BANDS_DEFAULT;
  const [min, max] = BANDS_LIMITS;
  const number = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(number) || number < min || number > max) throw code(`--bands must be an integer from ${min} to ${max}, got ${value}`, 'CLI_ARGUMENT_ERROR');
  return number;
}

/** The look as one of `lit`, `unlit` or `banded`; undefined means `lit`. Raises `CLI_ARGUMENT_ERROR`. */
export function parseLook(value: string | undefined): SpriteLook {
  if (value === undefined) return 'lit';
  if (!(SPRITE_LOOKS as readonly string[]).includes(value)) throw code(`--look must be one of ${SPRITE_LOOKS.join(', ')}, got ${value}`, 'CLI_ARGUMENT_ERROR');
  return value as SpriteLook;
}

/** The brightness of each band, darkest first: the floor, then equal steps up to 1. */
export function bandLevels(bands: number): number[] {
  const count = parseBands(bands);
  return Array.from({ length: count }, (_, i) => BANDED_FLOOR + (1 - BANDED_FLOOR) * i / (count - 1));
}

const glsl = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));

/** The GLSL that sets `outgoingLight` before the fragment is written; `normal` is the view-space normal. */
function fragmentPatch(look: 'unlit' | 'banded', bands: number): string {
  if (look === 'unlit') return 'outgoingLight = diffuseColor.rgb;';
  const [x, y, z] = BANDED_LIGHT_FROM_CAMERA, steps = glsl(bands);
  return [
    `vec3 keyFromCamera = normalize(vec3(${glsl(x)}, ${glsl(y)}, ${glsl(z)}));`,
    `float lightFacing = clamp(dot(normalize(normal), keyFromCamera) * 0.5 + 0.5, 0.0, 1.0);`,
    `float band = min(floor(lightFacing * ${steps}), ${steps} - 1.0);`,
    `outgoingLight = diffuseColor.rgb * (${glsl(BANDED_FLOOR)} + ${glsl(1 - BANDED_FLOOR)} * band / (${steps} - 1.0));`,
  ].join('\n');
}

/**
 * The script the bake harness runs after mount for a look, or undefined for `lit` (nothing to run). `bands` applies to
 * `banded` only (2 to 8, default 3) and is checked for every look, so a wrong value fails before a browser is started.
 * The text is one expression that reads `window.viewer` and returns nothing. Raises `CLI_ARGUMENT_ERROR`.
 */
export function lookScript(look: SpriteLook, bands?: number | string): string | undefined {
  parseLook(look);
  const count = bands === undefined ? BANDS_DEFAULT : parseBands(bands);
  if (look === 'lit') return undefined;
  return `((viewer) => {
  const scene = viewer.scene;
  const lights = [];
  scene.traverse(object => { if (object.isLight) lights.push(object); });
  for (const light of lights) light.removeFromParent();
  if (scene.environment) scene.environment.dispose();
  scene.environment = null;
  const patch = ${JSON.stringify(fragmentPatch(look, count))};
  const done = new Set();
  scene.traverse(object => {
    if (!object.material) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (done.has(material)) continue;
      done.add(material);
      material.toneMapped = false;
      if (material.isMeshStandardMaterial) {
        material.onBeforeCompile = shader => {
          const marker = '#include <opaque_fragment>';
          if (!shader.fragmentShader.includes(marker)) throw new Error('The standard material shader has no ' + marker + ' to take over');
          shader.fragmentShader = shader.fragmentShader.replace(marker, patch + '\\n' + marker);
        };
        material.customProgramCacheKey = () => 'sprite-look-${look}-${count}';
      }
      material.needsUpdate = true;
    }
  });
})(window.viewer)`;
}
