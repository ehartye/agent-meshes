import { expect, it } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import { createCreature } from '../src/recipes/index.ts';
import { buildScene } from '../src/render/scene.ts';

const LEGS = ['leg_L_1', 'leg_L_2', 'leg_L_3', 'leg_R_1', 'leg_R_2', 'leg_R_3'];

/** Fewest feet on the ground at any moment of a clip. */
function fewestFeetDown(project: ReturnType<typeof createCreature>, clipName: string): number {
  const built = buildScene(project);
  try {
    const clip = built.clips.find(c => c.name === clipName)!;
    const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
    const feet = LEGS.map(leg => built.bones.get(`${leg}_ankle`)!);
    const ground = feet.map(f => f.getWorldPosition(new Vector3()).y);
    let fewest = 6;
    for (let frame = 0; frame < 120; frame++) {
      mixer.setTime(clip.duration * frame / 120); built.root.updateMatrixWorld(true);
      fewest = Math.min(fewest, feet.filter((f, i) => f.getWorldPosition(new Vector3()).y < ground[i] + 0.0001).length);
    }
    return fewest;
  } finally { built.dispose(); }
}

it('insectoid leg phases produce one clip per timing pattern, in leg order L1 L2 L3 R1 R2 R3', () => {
  const project = createCreature('insectoid', { legPhases: { together: [0, 0, 0, 0, 0, 0], ripple: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], tripod: [0, 0.5, 0, 0.5, 0, 0.5] } });
  expect(project.clips.map(c => c.name)).toEqual(['together', 'ripple', 'tripod']);
  // All legs lifting together leaves the beast in the air; the tripod always keeps three feet down.
  expect(fewestFeetDown(project, 'together')).toBe(0);
  expect(fewestFeetDown(project, 'tripod')).toBe(3);
  expect(fewestFeetDown(project, 'ripple')).toBeGreaterThanOrEqual(3);
  // The default recipe is unchanged.
  expect(createCreature('insectoid').clips.map(c => c.name)).toEqual(['tripod']);
});

it('rejects leg phase lists of the wrong length or for the wrong creature', () => {
  expect(() => createCreature('insectoid', { legPhases: { odd: [0, 0.5] } })).toThrow(/6 phases/);
  expect(() => createCreature('biped', { legPhases: { x: [0, 0] } })).toThrow(/insectoid/);
});
