/** @lane merge
 * @subject scripts/blender_lib
 */
// Real Blender only. The six fixtures are split over three files so their builds run side by side.
import { faceRigFixtureTests } from './helpers/face-rig-fixture.ts';

faceRigFixtureTests(['test_lips_frog']);
