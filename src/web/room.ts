import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Puppet } from '../render/puppet.ts';
import type { Quality } from '../render/quality.ts';
import { applyIdMaterials, idColor, resolveIdColors } from '../render/id-render.ts';
import { isGlassObject } from '../render/glass.ts';
import type { IdImage, IdRenderColors, IdTarget } from '../render/id-render.ts';

/** How the camera projects: `perspective` (the default, a 38 degree lens) or `orthographic` (parallel rays, so size does not change with distance). */
export type Projection = 'perspective' | 'orthographic';
export const projectionNames: readonly Projection[] = ['perspective', 'orthographic'];
/** The viewer camera: a perspective camera by default, an orthographic one when `projection: 'orthographic'`. */
export type ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** Resolve a `projection` option. Omitted means `perspective`; anything else must be a listed name, and nothing is created before it is checked. */
export function parseProjection(value: unknown): Projection {
  if (value === undefined) return 'perspective';
  if (typeof value === 'string' && (projectionNames as readonly string[]).includes(value)) return value as Projection;
  throw new Error(`Unknown projection ${JSON.stringify(value)}; use one of ${projectionNames.join(', ')}`);
}

/** The camera the viewer has always used for `perspective`; `orthographic` gets a unit half-height that the first fit replaces. */
export function createCamera(projection: Projection): ViewerCamera {
  return projection === 'orthographic' ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 200) : new THREE.PerspectiveCamera(38, 1, 0.01, 200);
}

/** Width over height of the camera's view. */
export function cameraAspect(camera: ViewerCamera): number {
  return camera instanceof THREE.OrthographicCamera ? (camera.right - camera.left) / (camera.top - camera.bottom) : camera.aspect;
}

/** Set the aspect and rebuild the projection. An orthographic camera keeps its half-height and widens or narrows. */
export function setCameraAspect(camera: ViewerCamera, aspect: number): void {
  if (camera instanceof THREE.OrthographicCamera) { const half = camera.top; camera.left = -half * aspect; camera.right = half * aspect; camera.bottom = -half; }
  else camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

/**
 * Size an orthographic camera so every corner of `box`, seen along `direction`, fits the frame with `padding` (> 1 leaves a
 * margin), and return the distance to stand back from the center. Distance does not change the image, so it only has to
 * clear the model: twice its half-diagonal. The zoom resets to 1 because a fit replaces any wheel zoom.
 */
export function fitOrthographic(camera: THREE.OrthographicCamera, box: THREE.Box3, direction: THREE.Vector3, padding: number): number {
  if (!(padding > 0) || !Number.isFinite(padding)) throw new Error(`padding must be a positive number: ${padding}`);
  const back = direction.clone().normalize(), right = new THREE.Vector3(0, 1, 0).cross(back).normalize(), up = back.clone().cross(right);
  const center = box.getCenter(new THREE.Vector3()), aspect = cameraAspect(camera), corner = new THREE.Vector3();
  let half = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corner.set(x, y, z).sub(center);
    half = Math.max(half, Math.abs(corner.dot(up)), Math.abs(corner.dot(right)) / aspect);
  }
  half = Math.max(half * padding, 1e-4);
  camera.zoom = 1; camera.top = half; camera.bottom = -half; camera.left = -half * aspect; camera.right = half * aspect;
  camera.updateProjectionMatrix();
  return Math.max(box.min.distanceTo(box.max), 1e-3);
}

/** GLB bytes, or the GLB as a base64 string (works from file:// where fetch does not). */
export type GlbInput = ArrayBuffer | Uint8Array | string;
export function bytesOf(glb: GlbInput): ArrayBuffer {
  if (typeof glb === 'string') return Uint8Array.from(atob(glb), char => char.charCodeAt(0)).buffer as ArrayBuffer;
  if (glb instanceof Uint8Array) return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  if (glb instanceof ArrayBuffer) return glb;
  throw new Error('glb must be an ArrayBuffer, a Uint8Array or a base64 string');
}

/** The viewer's renderer: ACES tone mapped, a readable drawing buffer for screenshots, and the chosen antialiasing, pixel ratio and (soft, filtered) shadows. */
export function createRenderer(container: HTMLElement, transparent: boolean, quality: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, alpha: transparent, preserveDrawingBuffer: true });
  renderer.setPixelRatio(quality.pixelRatio); renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // PCFShadowMap is three's filtered soft shadow (PCFSoftShadowMap is deprecated and warns).
  renderer.shadowMap.enabled = quality.shadows; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  container.append(renderer.domElement);
  return renderer;
}

/** Image-based light from a procedural room (soft fill, believable speculars, no assets), a hemisphere, key and fill. */
export function addRoomLights(renderer: THREE.WebGLRenderer, scene: THREE.Scene, quality: Quality): void {
  if (quality.environment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    scene.environmentIntensity = 0.55;
  }
  scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 1.3));
  const key = new THREE.DirectionalLight('#fff2d8', 3.7); key.position.set(4, 8, 5); key.castShadow = quality.shadows; key.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize); key.shadow.normalBias = 0.025; scene.add(key);
  const fill = new THREE.DirectionalLight('#b2e2f0', 1.2); fill.position.set(-5, 3, -3); scene.add(fill);
}

/** A large floor that matches the background, or catches shadows only when the background is transparent. */
export function addFloor(scene: THREE.Scene, background: string | null): THREE.Mesh {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), background ? new THREE.MeshStandardMaterial({ color: background, roughness: 1 }) : new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.receiveShadow = true; scene.add(floor);
  return floor;
}

/** A face's mouth inside (arkit-face/1 names: cavity, teeth, tongue): a hull there is ink floating in an open mouth. */
const MOUTH_INSIDE = /cavity|teeth|tooth|tongue/i;

/**
 * Inverted-hull ink outlines behind every opaque part (a hull would show through glass) but a mouth's inside; hiding a
 * part also hides its hull. A hull shares its part's morph weights, so it follows a blink or an open jaw. Returns the hulls.
 */
export function addOutlines(puppet: Puppet, thickness: number, color = '#111111'): THREE.Mesh[] {
  const hulls = new Map<string, THREE.Mesh>(), ink = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  for (const name of puppet.parts) {
    const mesh = puppet.object(name);
    if (isGlassObject(mesh)) continue;
    if ((Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(material => MOUTH_INSIDE.test(material.name))) continue;
    // The same geometry pushed out along its normals, drawn back-face only.
    const source = mesh.geometry.clone(); if (!source.getAttribute('normal')) source.computeVertexNormals();
    const pos = source.getAttribute('position'), nor = source.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) + nor.getX(i) * thickness, pos.getY(i) + nor.getY(i) * thickness, pos.getZ(i) + nor.getZ(i) * thickness);
    pos.needsUpdate = true;
    let hull: THREE.Mesh;
    // A skinned hull follows its part unculled, like the part itself (its rest sphere goes stale as it moves).
    if (mesh instanceof THREE.SkinnedMesh) { const skinned = new THREE.SkinnedMesh(source, ink); mesh.parent!.add(skinned); skinned.bind(mesh.skeleton, mesh.bindMatrix); skinned.frustumCulled = false; hull = skinned; }
    else { hull = new THREE.Mesh(source, ink); mesh.parent!.add(hull); hull.position.copy(mesh.position); hull.quaternion.copy(mesh.quaternion); hull.scale.copy(mesh.scale); }
    if (mesh.morphTargetInfluences) { hull.morphTargetInfluences = mesh.morphTargetInfluences; hull.morphTargetDictionary = mesh.morphTargetDictionary; }
    hull.name = `${name}_outline`; hull.userData.outline = true; hull.castShadow = false; hull.receiveShadow = false; hull.renderOrder = -1;
    hulls.set(name, hull);
  }
  const setVisible = puppet.setVisible.bind(puppet);
  puppet.setVisible = (name, visible) => { setVisible(name, visible); const hull = hulls.get(name); if (hull) hull.visible = visible; };
  return [...hulls.values()];
}

function pixelSize(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4096) throw new Error(`${label} must be an integer from 1 to 4096: ${value}`);
  return value as number;
}

/**
 * Render `scene` once with every target in its ID color: unlit, no tone mapping, no color-space
 * conversion, no fog or environment, into a single-sampled target so no edge blends two colors.
 * Morphs and skinning are the live ones. Everything is restored before returning, even on error.
 */
export function captureId(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: ViewerCamera, targets: readonly IdTarget[], options: IdRenderColors & { width?: number; height?: number }, alsoHide: readonly THREE.Object3D[]): IdImage {
  const size = renderer.getSize(new THREE.Vector2());
  const width = pixelSize(options.width, Math.max(1, Math.round(size.x)), 'width'), height = pixelSize(options.height, Math.max(1, Math.round(size.y)), 'height');
  const { width: _w, height: _h, ...colorOptions } = options;
  const colors = resolveIdColors(targets, colorOptions);
  const background = idColor(options.background ?? '#000000');
  const saved = { background: scene.background, environment: scene.environment, fog: scene.fog, aspect: cameraAspect(camera), target: renderer.getRenderTarget() };
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 0, depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
  const restore = applyIdMaterials(targets, colors, alsoHide);
  const pixels = new Uint8Array(width * height * 4);
  try {
    scene.background = background; scene.environment = null; scene.fog = null;
    setCameraAspect(camera, width / height);
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    renderer.setRenderTarget(saved.target);
    scene.background = saved.background; scene.environment = saved.environment; scene.fog = saved.fog;
    setCameraAspect(camera, saved.aspect);
    restore(); target.dispose();
  }
  // WebGL reads bottom row first; images are top row first.
  const data = new Uint8ClampedArray(pixels.length), row = width * 4;
  for (let y = 0; y < height; y++) data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, data };
}

/** Encode an ID image as a PNG data URL (lossless, so colors survive). */
export function idImageURL(image: IdImage): string {
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas.toDataURL('image/png');
}
