/**
 * The page that renders animation previews (see `src/animation-preview.ts`, which bundles this file as an IIFE assigned
 * to `window.AnimationPreview`). It loads one binary FBX with three's FBXLoader, hides any skinned meshes, and builds a
 * mannequin from the skeleton: a capsule per bone between its joint and each child joint, and a sphere for the head,
 * in flat tints of the workbench ink. The scene has the workbench stage colour and a ground grid in the line colour.
 * The orthographic camera looks from a three-quarter front view and is fitted to the whole clip: the clip is sampled and
 * every joint, padded by its capsule radius, is kept in frame. For root motion the camera follows the hips' straight
 * path from the first frame to the last, so the figure stays in frame and the grid scrolls under it.
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const INK = new THREE.Color('#213844'), STAGE = '#dce7eb', LINE = '#d6e0e4';
const AZIMUTH = 35 * Math.PI / 180, ELEVATION = 12 * Math.PI / 180, PADDING = 1.12, FIT_SAMPLES = 48;
/** Unit vector from the subject towards the camera: three-quarter front (Mixamo characters face +Z), a little above. */
const VIEW = new THREE.Vector3(Math.sin(AZIMUTH) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(AZIMUTH) * Math.cos(ELEVATION));
/** Root motion is assumed when the hips travel more than this share of the figure's height (0.15 m of 1.7 m). */
const ROOT_TRAVEL = 0.09;

interface State {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mixer: THREE.AnimationMixer | null;
  duration: number;
  /** The camera centre at time t. */
  centre(t: number): THREE.Vector3;
}
let state: State | null = null;
/** One WebGL context for the page, reused by every load. */
let existingRenderer: THREE.WebGLRenderer | null = null;

const tint = (amount: number) => INK.clone().lerp(new THREE.Color('#ffffff'), amount);

function decode(data: ArrayBuffer | string): ArrayBuffer {
  if (typeof data !== 'string') return data;
  const text = atob(data), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

/** The bone name from its first body word on, lower case: `mixamorig1:LeftUpLeg` gives `leftupleg`. */
const short = (bone: THREE.Object3D) => (/(hips|spine|neck|head|left|right).*/i.exec(bone.name)?.[0] ?? bone.name).toLowerCase();

/** Capsule radius as a share of the figure height, from the name of the bone the segment starts at and the one it ends at. */
function segmentRadius(from: string, to: string, length: number, height: number): number {
  const share = (() => {
    if (/hips/.test(from)) return /spine/.test(to) ? 0.07 : 0.045;
    if (/spine/.test(from)) return /spine/.test(to) ? 0.075 : /neck/.test(to) ? 0.055 : 0.035;
    if (/neck/.test(from)) return 0.03;
    if (/shoulder|clavicle/.test(from)) return 0.03;
    if (/forearm/.test(from)) return 0.025;
    if (/arm$/.test(from)) return 0.03;
    if (/upleg|thigh/.test(from)) return 0.045;
    if (/leg$|calf|shin/.test(from)) return 0.035;
    if (/foot/.test(from)) return 0.025;
    if (/toe/.test(from)) return 0.018;
    if (/hand|thumb|index|middle|ring|pinky/.test(from)) return 0.009;
    return Math.min(0.04, Math.max(0.01, length / height * 0.25));
  })();
  return share * height;
}

const sideTint = (name: string) => /left/.test(name) ? tint(0.3) : /right/.test(name) ? tint(0.08) : tint(0.16);

/** Load an FBX (bytes or base64) and set up the scene for `size` pixel frames. Returns the longest take's length. */
export function load(data: ArrayBuffer | string, size = 192): { duration: number; clip: string | null; bones: number; rootMotion: boolean } {
  dispose();
  const group = new FBXLoader().parse(decode(data), '');
  const bones: THREE.Bone[] = [];
  group.traverse(object => {
    if ((object as THREE.Bone).isBone) bones.push(object as THREE.Bone);
    // Hidden by layer, not by `visible`, which would also hide any bones parented under a mesh.
    if ((object as THREE.Mesh).isMesh || (object as THREE.Line).isLine || (object as THREE.Points).isPoints) object.layers.set(31);
  });
  if (!bones.length) throw new Error('The FBX has no skeleton to draw');
  const clip = group.animations.reduce<THREE.AnimationClip | null>((best, take) => (!best || take.duration > best.duration ? take : best), null);
  const duration = clip && clip.duration > 0 ? clip.duration : 0;
  const mixer = clip ? new THREE.AnimationMixer(group) : null;
  if (mixer && clip) mixer.clipAction(clip).play();
  const pose = (t: number) => { mixer?.setTime(t); group.updateMatrixWorld(true); };

  // The figure height at the first frame sets every proportion.
  pose(0);
  const joint = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
  const box = new THREE.Box3();
  for (const bone of bones) box.expandByPoint(joint(bone));
  const extent = box.getSize(new THREE.Vector3());
  const height = Math.max(extent.y, extent.x, extent.z, 1e-3);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(STAGE);
  scene.add(group);
  const material = (color: THREE.Color) => { return new THREE.MeshLambertMaterial({ color, flatShading: true }); };
  /** Points the fit keeps in frame: a bone and an offset in its space, padded by a radius. */
  const marks: { bone: THREE.Object3D; offset: THREE.Vector3; radius: number }[] = [];
  const boneSet = new Set<THREE.Object3D>(bones);
  for (const bone of bones) {
    const name = short(bone);
    const children = bone.children.filter(child => boneSet.has(child));
    const isHead = /head$/.test(name) || (/head/.test(name) && !/end|top/.test(name));
    if (isHead) {
      const top = children[0];
      let centre: THREE.Vector3, radius: number;
      if (top && top.position.length() > 1e-6) { centre = top.position.clone().multiplyScalar(0.5); radius = top.position.length() * 0.55; }
      else {
        // No head-top joint: put the head above the joint, along the neck's direction.
        radius = height * 0.065;
        const along = bone.position.length() > 1e-6 ? bone.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
        centre = along.multiplyScalar(radius * 0.9);
      }
      const geometry = new THREE.SphereGeometry(radius, 16, 12);
      const head = new THREE.Mesh(geometry, material(tint(0.16)));
      head.position.copy(centre); bone.add(head);
      marks.push({ bone, offset: centre, radius });
      continue;
    }
    marks.push({ bone, offset: new THREE.Vector3(), radius: height * 0.02 });
    for (const child of children) {
      const offset = child.position.clone(), length = offset.length();
      if (length < height * 1e-3) continue;
      const radius = Math.min(segmentRadius(name, short(child), length, height), length * 0.9);
      const geometry = new THREE.CapsuleGeometry(radius, Math.max(length - radius, 1e-4), 4, 10);
      const capsule = new THREE.Mesh(geometry, material(sideTint(/left|right/.test(name) ? name : short(child))));
      capsule.position.copy(offset).multiplyScalar(0.5);
      capsule.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), offset.clone().normalize());
      bone.add(capsule);
      marks.push({ bone: child, offset: new THREE.Vector3(), radius });
    }
    if (!children.length && /(hand|foot)$/.test(name)) {
      // A hand or foot with no finger or toe joints gets a knob, so the limb does not end in a stump.
      const radius = height * (/hand/.test(name) ? 0.03 : 0.025);
      bone.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), material(sideTint(name))));
      marks.push({ bone, offset: new THREE.Vector3(), radius });
    }
  }
  scene.add(new THREE.HemisphereLight(0xffffff, new THREE.Color(STAGE), 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(Math.sin(AZIMUTH + 0.6) * 2, 3, Math.cos(AZIMUTH + 0.6) * 2);
  scene.add(sun);

  // Sample the clip: the hips path and every mark's world position.
  const hips = bones.find(bone => /hips$/.test(short(bone))) ?? bones.find(bone => !boneSet.has(bone.parent!)) ?? bones[0]!;
  const samples = duration > 0 ? FIT_SAMPLES : 1;
  const times = Array.from({ length: samples }, (_, i) => (samples === 1 ? 0 : duration * i / (samples - 1)));
  const sampled = times.map(t => {
    pose(Math.min(t, duration > 0 ? duration - 1e-4 : 0));
    return { hips: joint(hips), points: marks.map(mark => ({ at: mark.bone.localToWorld(mark.offset.clone()), radius: mark.radius })) };
  });
  const start = sampled[0]!.hips, end = sampled.at(-1)!.hips;
  const travel = new THREE.Vector3(end.x - start.x, 0, end.z - start.z);
  const rootMotion = travel.length() > height * ROOT_TRAVEL;
  const follow = (t: number) => (rootMotion && duration > 0 ? travel.clone().multiplyScalar(t / duration) : new THREE.Vector3());

  const forward = VIEW.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ground = Infinity;
  sampled.forEach(({ points }, i) => {
    const shift = follow(times[i]!);
    for (const { at, radius } of points) {
      const q = at.clone().sub(shift), x = q.dot(right), y = q.dot(up);
      x0 = Math.min(x0, x - radius); x1 = Math.max(x1, x + radius); y0 = Math.min(y0, y - radius); y1 = Math.max(y1, y + radius);
      ground = Math.min(ground, at.y - radius);
    }
  });
  const half = Math.max(x1 - x0, y1 - y0, 1e-3) / 2 * PADDING;
  const offset = right.clone().multiplyScalar((x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2);
  const distance = height * 4 + travel.length();
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, distance * 0.01, distance * 3);

  // The grid spacing divides the travel evenly along its main axis, so the loop does not jump.
  const main = Math.max(Math.abs(travel.x), Math.abs(travel.z));
  let spacing = height / 3;
  if (rootMotion && main > height / 6) spacing = main / Math.max(1, Math.round(main / spacing));
  const reach = travel.length() + height * 6, divisions = Math.ceil(reach / spacing);
  const grid = new THREE.GridHelper(divisions * spacing, divisions, LINE, LINE);
  const middle = start.clone().addScaledVector(travel, 0.5);
  grid.position.set(Math.round(middle.x / spacing) * spacing, ground - height * 1e-3, Math.round(middle.z / spacing) * spacing);
  if (divisions % 2) grid.position.x += spacing / 2, grid.position.z += spacing / 2;
  scene.add(grid);

  const renderer = existingRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  state = { renderer, scene, camera, mixer, duration, centre: t => follow(t).add(offset) };
  return { duration, clip: clip?.name ?? null, bones: bones.length, rootMotion };
}

/** Pose the clip at `t` seconds (wrapping at the end), render, and return the frame as a PNG data URL. */
export function frame(t: number): string {
  if (!state) throw new Error('Load an FBX before rendering a frame');
  const { renderer, scene, camera, mixer, duration } = state;
  const time = duration > 0 ? ((t % duration) + duration) % duration : 0;
  mixer?.setTime(time);
  const centre = state.centre(time);
  const distance = camera.far / 3;
  camera.position.copy(centre).addScaledVector(VIEW, distance);
  camera.lookAt(centre);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

/** Release the loaded scene: the mannequin, the grid and everything the FBX brought. The renderer is kept for the next load. */
export function dispose(): void {
  if (!state) return;
  state.mixer?.stopAllAction();
  state.scene.traverse(object => {
    const { geometry, material } = object as THREE.Mesh;
    geometry?.dispose();
    for (const item of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(item)) if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
      item.dispose();
    }
  });
  state = null;
}
