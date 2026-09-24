/**
 * The `arkit-face/1` face-rig contract names, used by `verify-unreal` and exported for
 * reuse so every verifier shares one copy. Keep this the single copy.
 */
export const ARKIT_FACE_CONTRACT = 'arkit-face/1';

/** The 21 morph targets every arkit-face/1 head carries, spelled exactly as ARKit does. */
export const ARKIT_FACE_REQUIRED_MORPHS = Object.freeze([
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawOpen',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthFunnel',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekSquintLeft', 'cheekSquintRight',
] as const);

/** Morphs a head carries only when it has the feature (Bolt has no nose). */
export const ARKIT_FACE_OPTIONAL_MORPHS = Object.freeze(['noseSneerLeft', 'noseSneerRight', 'mouthPucker', 'tongueOut', 'cheekPuff'] as const);

/** `head` is the skin root; the eye bones pivot at each eyeball center. Left is the character's left (+X). */
export const ARKIT_FACE_REQUIRED_BONES = Object.freeze(['head', 'eye_L', 'eye_R'] as const);

export interface ContractExpectations { morphs: string[]; bones: string[] }

/** Names a destination must preserve verbatim for the given contract. Throws for an unknown contract. */
export function contractExpectations(contract: string): ContractExpectations {
  if (contract !== ARKIT_FACE_CONTRACT) throw Object.assign(new Error(`Unknown contract "${contract}"; known: ${ARKIT_FACE_CONTRACT}`), { code: 'CLI_ARGUMENT_ERROR' });
  return { morphs: [...ARKIT_FACE_REQUIRED_MORPHS], bones: [...ARKIT_FACE_REQUIRED_BONES] };
}
