import { it } from 'vitest';
import { inspectBlender } from '../../src/refine.ts';

/**
 * The one Blender gate for tests that run a real Blender. It inspects instead of calling findBlender(), which throws on a
 * wrong series and would fail the whole file on import:
 *   - supported Blender found: the tests run;
 *   - no Blender found: the tests skip, as before;
 *   - an unsupported Blender found: each test fails with the findBlender message (the version found and the 5.2 series).
 */
const inspection = inspectBlender();

/** The supported Blender, or null when none is installed or the one found is not the supported series. */
export const blender = inspection.supported ? inspection.location : null;

/** True when any Blender is installed, supported or not (for tests of the "Blender is absent" path). */
export const blenderInstalled = inspection.location !== null;

const unsupportedMessage = inspection.message;

/** A registrar that fails each test with the version message instead of running its body. */
const failUnsupported = ((name: string) => it(name, () => { throw new Error(unsupportedMessage); })) as unknown as typeof it;

/**
 * `it` for tests that need a supported Blender, optionally also requiring `extra` (a detached launcher, Unreal, ...).
 * An unsupported Blender fails the test whatever `extra` says, so the message is never hidden behind a second skip.
 */
export function blenderGate(extra: unknown = true): typeof it {
  if (unsupportedMessage) return failUnsupported;
  return (blender && extra ? it : it.skip) as typeof it;
}

/** `it` that runs with a supported Blender, skips with none, and fails with the version message with an unsupported one. */
export const blenderIt: typeof it = blenderGate();
