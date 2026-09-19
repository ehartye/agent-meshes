import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

async function start() {
  const data = JSON.parse(document.getElementById('asset')!.textContent!);
  document.getElementById('title')!.textContent = data.name;
  const bytes = Uint8Array.from(atob(data.glb), char => char.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#dce7eb');
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.setSize(innerWidth, innerHeight);
  document.getElementById('stage')!.append(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 200);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  scene.add(gltf.scene); gltf.scene.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
  scene.add(new THREE.HemisphereLight('#ffffff', '#718794', 2.6));
  const key = new THREE.DirectionalLight('#fff2d8', 3.7); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.normalBias = 0.025; scene.add(key);
  const fill = new THREE.DirectionalLight('#b2e2f0', 1.2); fill.position.set(-5, 3, -3); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#dce7eb', roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; floor.receiveShadow = true; scene.add(floor);
  const box = new THREE.Box3().setFromObject(gltf.scene), center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(box.getSize(new THREE.Vector3()).length() * 1.8, 3);
  camera.far = Math.max(200, distance * 10); camera.updateProjectionMatrix();
  camera.position.copy(center).add(new THREE.Vector3(1, 0.65, 1.4).normalize().multiplyScalar(distance)); controls.target.copy(center); controls.update();
  const mixer = new THREE.AnimationMixer(gltf.scene);
  let action: THREE.AnimationAction | null = null, time = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const select = document.getElementById('clip') as HTMLSelectElement, scrub = document.getElementById('scrub') as HTMLInputElement, button = document.getElementById('play')!;
  for (const clip of gltf.animations) select.add(new Option(clip.name, clip.name));
  function choose(name: string) { mixer.stopAllAction(); const clip = gltf.animations.find(c => c.name === name); action = clip ? mixer.clipAction(clip).play() : null; time = 0; scrub.max = String(clip?.duration ?? 1); }
  choose(gltf.animations[0]?.name ?? '');
  select.onchange = () => choose(select.value);
  button.textContent = playing ? 'Pause' : 'Play';
  button.onclick = () => { playing = !playing; button.textContent = playing ? 'Pause' : 'Play'; };
  const seek = (value: number) => { time = value; mixer.setTime(time); gltf.scene.updateMatrixWorld(true); gltf.scene.traverse(object => { if (object instanceof THREE.SkinnedMesh) { object.skeleton.update(); object.computeBoundingSphere(); } }); scrub.value = String(time); };
  scrub.oninput = () => { playing = false; button.textContent = 'Play'; seek(Number(scrub.value)); };
  document.getElementById('download')!.onclick = () => { const a = document.createElement('a'); a.href = `data:model/gltf-binary;base64,${data.glb}`; a.download = `${data.name}.glb`; a.click(); };
  let last = performance.now();
  renderer.setAnimationLoop(now => { const dt = Math.min((now - last) / 1000, 0.1); last = now; if (playing && action) seek((time + dt) % action.getClip().duration); controls.update(); renderer.render(scene, camera); });
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  Object.assign(window, { meshPreview: { gltf, mixer, seek, renderer, scene, camera, setPlaying: (value: boolean) => { playing = value; } } });
  document.getElementById('status')!.textContent = `${gltf.animations.length} clips · Drag to orbit · Scroll to zoom`;
}
void start().catch(error => { document.getElementById('status')!.textContent = `Could not open model: ${error.message}`; console.error(error); });
