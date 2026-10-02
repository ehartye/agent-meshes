import { Euler, MathUtils } from 'three';
import type { Bone, Object3D, SkinnedMesh } from 'three';
import type { Puppet } from '../render/puppet.ts';
import { morphControls } from './preview-morphs.ts';

/** Preview gaze for arkit-face/1 or an explicit eye-gaze/1 declaration: eye-local +Z is forward. */
export function previewGaze(source: Puppet) {
  const declarations: { root: Object3D; contract: Object3D['userData']; partial: boolean }[] = [], eyes: Bone[] = [];
  source.root.traverse(node => {
    if (node.userData.arkitFace) declarations.push({ root: node, contract: node.userData.arkitFace, partial: false });
    if (node.userData.eyeGaze) declarations.push({ root: node, contract: node.userData.eyeGaze, partial: true });
    if ((node as Bone).isBone && ['eye_L', 'eye_R'].includes(node.name)) eyes.push(node as Bone);
  });
  if (declarations.length !== 1 || eyes.length !== 2 || new Set(eyes.map(eye => eye.name)).size !== 2) return null;
  const { root: face, contract, partial } = declarations[0];
  const within = (node: Object3D): boolean => node === face || !!node.parent && within(node.parent);
  if (contract.contract !== (partial ? 'eye-gaze/1' : 'arkit-face/1') || partial && contract.forward !== '+Z' || !eyes.every(within)) return null;
  const valid = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
  if (!valid(contract.gaze?.yawMax, 90) || !valid(contract.gaze?.pitchMax, 90) || !contract.gaze.yawMax || !contract.gaze.pitchMax) return null;
  const limits = { yaw: contract.gaze.yawMax as number, pitch: contract.gaze.pitchMax as number };
  const follow = { up: !partial && valid(contract.lidFollow?.up, 1) ? contract.lidFollow.up as number : 0, down: !partial && valid(contract.lidFollow?.down, 1) ? contract.lidFollow.down as number : 0 };
  const controls = morphControls(source);
  // Face meshes can be siblings of the armature. Their skin identifies the rig they belong to.
  const belongs = (owner: string) => {
    let result = false;
    source.root.getObjectByName(owner)?.traverse(node => {
      if (within(node) || (node as SkinnedMesh).skeleton?.bones.some(bone => eyes.includes(bone))) result = true;
    });
    return result;
  };
  const owners = new Set(controls.targets.filter(control => /^eye(Blink|Wide)(Left|Right)$/.test(control.target))
    .flatMap(control => control.owners.filter(belongs)));
  let yaw = 0, pitch = 0;
  const layers = (partial ? [] : [...owners]).map(owner => source.addMorphTransform(owner, weights => {
    const derived: Record<string, number> = {};
    for (const side of ['Left', 'Right']) {
      const blink = `eyeBlink${side}`, wide = `eyeWide${side}`;
      if (pitch < 0 && blink in weights) derived[blink] = Math.max(weights[blink], -pitch / limits.pitch * follow.down);
      if (pitch > 0 && wide in weights) derived[wide] = Math.max(weights[wide], pitch / limits.pitch * follow.up) * (1 - Math.max(0, Math.min(1, weights[blink] ?? 0)));
    }
    return derived;
  }));
  function set(nextYaw: number, nextPitch: number) {
    if (!Number.isFinite(nextYaw) || !Number.isFinite(nextPitch)) throw new Error('Gaze angles must be finite');
    yaw = Math.max(-limits.yaw, Math.min(limits.yaw, nextYaw)); pitch = Math.max(-limits.pitch, Math.min(limits.pitch, nextPitch));
    // Compose yaw then pitch in each authored eye frame, matching aimBone, without replacing the clip pose.
    const euler = new Euler(-pitch * MathUtils.DEG2RAD, yaw * MathUtils.DEG2RAD, 0, 'YXZ').reorder('XYZ');
    const rotation: [number, number, number] = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as [number, number, number];
    for (const eye of eyes) source.setPose(eye.name, { rotation });
    for (const layer of layers) layer.refresh();
  }
  return {
    limits, get value() { return { yaw, pitch }; }, set, update: () => source.sync(), reset: () => set(0, 0),
    dispose() { for (const layer of layers) layer.dispose(); },
    setMorph(target: string, weight: number) {
      for (const owner of controls.targets.find(control => control.target === target)?.owners ?? []) source.setMorph(owner, target, weight);
    },
  };
}
