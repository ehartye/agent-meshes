import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Puppet } from '../render/puppet.ts';
import { applyIdMaterials, idColor, resolveIdColors } from '../render/id-render.ts';
import type { IdImage, IdRenderColors, IdTarget } from '../render/id-render.ts';

/** GLB bytes, or the GLB as a base64 string (works from file:// where fetch does not). */
export type GlbInput = ArrayBuffer | Uint8Array | string;
export function bytesOf(glb: GlbInput): ArrayBuffer {
  if (typeof glb === 'string') return Uint8Array.from(atob(glb), char => char.charCodeAt(0)).buffer as ArrayBuffer;
  if (glb instanceof Uint8Array) return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  if (glb instanceof ArrayBuffer) return glb;
  throw new Error('glb must be an ArrayBuffer, a Uint8Array or a base64 string');
}

/** The viewer's renderer: antialiased, ACES tone mapped, soft shadows, and a readable drawing buffer for screenshots. */
export function createRenderer(container: HTMLElement, transparent: boolean): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  container.append(renderer.domElement);
  return renderer;
}

/** Image-based light from a procedural room (soft fill, believable speculars, no assets), a hemisphere, key and fill. */
export function addRoomLights(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 1.3));
  const key = new THREE.DirectionalLight('#fff2d8', 3.7); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.normalBias = 0.025; scene.add(key);
  const fill = new THREE.DirectionalLight('#b2e2f0', 1.2); fill.position.set(-5, 3, -3); scene.add(fill);
}

/** A large floor that matches the background, or catches shadows only when the background is transparent. */
export function addFloor(scene: THREE.Scene, background: string | null): THREE.Mesh {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), background ? new THREE.MeshStandardMaterial({ color: background, roughness: 1 }) : new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.receiveShadow = true; scene.add(floor);
  return floor;
}

/** Inverted-hull ink outlines behind every part; hiding a part also hides its hull. Returns the hulls. */
export function addOutlines(puppet: Puppet, thickness: number, color = '#111111'): THREE.Mesh[] {
  const hulls = new Map<string, THREE.Mesh>(), ink = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  for (const name of puppet.parts) {
    const mesh = puppet.object(name);
    // The same geometry pushed out along its normals, drawn back-face only.
    const source = mesh.geometry.clone(); if (!source.getAttribute('normal')) source.computeVertexNormals();
    const pos = source.getAttribute('position'), nor = source.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) + nor.getX(i) * thickness, pos.getY(i) + nor.getY(i) * thickness, pos.getZ(i) + nor.getZ(i) * thickness);
    pos.needsUpdate = true;
    let hull: THREE.Mesh;
    if (mesh instanceof THREE.SkinnedMesh) { const skinned = new THREE.SkinnedMesh(source, ink); mesh.parent!.add(skinned); skinned.bind(mesh.skeleton, mesh.bindMatrix); hull = skinned; }
    else { hull = new THREE.Mesh(source, ink); mesh.parent!.add(hull); hull.position.copy(mesh.position); hull.quaternion.copy(mesh.quaternion); hull.scale.copy(mesh.scale); }
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
export function captureId(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, targets: readonly IdTarget[], options: IdRenderColors & { width?: number; height?: number }, alsoHide: readonly THREE.Object3D[]): IdImage {
  const size = renderer.getSize(new THREE.Vector2());
  const width = pixelSize(options.width, Math.max(1, Math.round(size.x)), 'width'), height = pixelSize(options.height, Math.max(1, Math.round(size.y)), 'height');
  const { width: _w, height: _h, ...colorOptions } = options;
  const colors = resolveIdColors(targets, colorOptions);
  const background = idColor(options.background ?? '#000000');
  const saved = { background: scene.background, environment: scene.environment, fog: scene.fog, aspect: camera.aspect, target: renderer.getRenderTarget() };
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 0, depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
  const restore = applyIdMaterials(targets, colors, alsoHide);
  const pixels = new Uint8Array(width * height * 4);
  try {
    scene.background = background; scene.environment = null; scene.fog = null;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    renderer.setRenderTarget(saved.target);
    scene.background = saved.background; scene.environment = saved.environment; scene.fog = saved.fog;
    camera.aspect = saved.aspect; camera.updateProjectionMatrix();
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
