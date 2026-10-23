"""Stdlib-only wrapper tests: no NumPy, Blender, subprocess or USD execution."""
from pathlib import Path
import importlib.util
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('rig_library', ROOT / 'scripts/rigging/rig-tools/rig_library.py')
LIB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIB)


class Curve:
    """Stand-in for already validated quaternion curves; never runs numerical work."""
    def __len__(self): return 2
    def __getitem__(self, key): return self
    def __sub__(self, other): return self
    def __add__(self, other): return self
    def all(self): return True
    def max(self): return .1


NUMPY = types.SimpleNamespace(isfinite=lambda value: Curve(),
                              minimum=lambda left, right: Curve(),
                              linalg=types.SimpleNamespace(norm=lambda *args, **kwargs: Curve()))
ANIMATION = types.SimpleNamespace(
    samplers=[types.SimpleNamespace(output=0)],
    channels=[types.SimpleNamespace(sampler=0, target=types.SimpleNamespace(path='rotation'))])
GLB = types.SimpleNamespace(animations=[ANIMATION], binary_blob=lambda: b'')
GLTF = types.SimpleNamespace(GLTF2=lambda: types.SimpleNamespace(load=lambda path: GLB))


class OutputProtection(unittest.TestCase):
    def test_npz_appended_suffix_cannot_replace_precious_bytes(self):
        # Emulate only NumPy's pathname suffix rule at the external writer boundary.
        def writer(source, clip, output, fps):
            actual = Path(str(output) + ('' if str(output).endswith('.npz') else '.npz'))
            actual.write_bytes(b'new extraction')
            raise ValueError('fixture stops after the downstream write')

        with tempfile.TemporaryDirectory() as directory:
            for filename in ('walk', 'walk.other', 'upper-walk.NPZ'):
                with self.subTest(filename=filename):
                    precious = Path(directory) / (filename + '.npz')
                    precious.write_bytes(b'precious owner data')
                    with patch.dict(sys.modules, numpy=NUMPY), patch.object(
                            LIB, 'upstream', return_value=types.SimpleNamespace(extract=writer)):
                        with self.assertRaises(ValueError):
                            LIB.extract('human-base', 'Walk_Loop', Path(directory) / filename)
                    self.assertEqual(precious.read_bytes(), b'precious owner data')

    def retarget(self, directory, downstream, presentation='asset'):
        reader = types.SimpleNamespace(_accessor=lambda *args: Curve())
        with patch.dict(sys.modules, numpy=NUMPY, pygltflib=GLTF), patch.object(
                LIB, 'upstream', return_value=reader), patch.object(LIB, 'run_script', side_effect=downstream):
            return LIB.retarget('human-base', 'trusted-rig.npz', 'trusted-clip.npz',
                                Path(directory) / 'walk.glb', presentation=presentation)

    def test_asset_rejects_existing_sibling_without_changing_either_output(self):
        with tempfile.TemporaryDirectory() as directory:
            primary, precious = Path(directory) / 'walk.glb', Path(directory) / 'walk.usdz'
            precious.write_bytes(b'precious owner USDZ')

            def downstream(name, output, environment):
                Path(output).write_bytes(b'new GLB')
                Path(output).with_suffix('.usdz').write_bytes(b'new USDZ')
                return 'fixture export'

            error = None
            try:
                self.retarget(directory, downstream)
            except FileExistsError as exc:
                error = exc
            self.assertEqual(precious.read_bytes(), b'precious owner USDZ')
            self.assertFalse(primary.exists())
            self.assertIsNotNone(error)

    def test_failed_optional_export_does_not_report_unrelated_sibling(self):
        with tempfile.TemporaryDirectory() as directory:
            precious = Path(directory) / 'walk.usdz'

            def downstream(name, output, environment):
                Path(output).write_bytes(b'new GLB')
                # Another writer arrives after preflight; this job's USD export fails.
                precious.write_bytes(b'other job USDZ')
                return 'usdz skipped: optional backend unavailable'

            result = self.retarget(directory, downstream)
            self.assertIsNone(result['optionalUsdz'])
            self.assertEqual(precious.read_bytes(), b'other job USDZ')
            self.assertEqual((Path(directory) / 'walk.glb').read_bytes(), b'new GLB')

    def test_late_sibling_collision_cannot_replace_precious_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            precious = Path(directory) / 'walk.usdz'

            def downstream(name, output, environment):
                Path(output).write_bytes(b'new GLB')
                Path(output).with_suffix('.usdz').write_bytes(b'generated USDZ')
                precious.write_bytes(b'other job USDZ')
                return 'fixture export'

            with self.assertRaises(FileExistsError):
                self.retarget(directory, downstream)
            self.assertEqual(precious.read_bytes(), b'other job USDZ')
            self.assertFalse((Path(directory) / 'walk.glb').exists())

    def test_late_primary_collision_cannot_replace_precious_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            precious = Path(directory) / 'walk.glb'

            def downstream(name, output, environment):
                Path(output).write_bytes(b'generated GLB')
                Path(output).with_suffix('.usdz').write_bytes(b'generated USDZ')
                precious.write_bytes(b'other job GLB')
                return 'fixture export'

            with self.assertRaises(FileExistsError):
                self.retarget(directory, downstream)
            self.assertEqual(precious.read_bytes(), b'other job GLB')
            self.assertFalse((Path(directory) / 'walk.usdz').exists())

    def test_success_publishes_current_job_glb_and_optional_usdz(self):
        with tempfile.TemporaryDirectory() as directory:
            def downstream(name, output, environment):
                self.assertEqual(environment['OUT_GLB'], str(output))
                Path(output).write_bytes(b'new GLB')
                Path(output).with_suffix('.usdz').write_bytes(b'new USDZ')
                return 'fixture export'

            result = self.retarget(directory, downstream)
            self.assertEqual(Path(result['output']).read_bytes(), b'new GLB')
            self.assertEqual(Path(result['optionalUsdz']).read_bytes(), b'new USDZ')

    def test_diagnostic_does_not_claim_or_modify_existing_usdz(self):
        with tempfile.TemporaryDirectory() as directory:
            precious = Path(directory) / 'walk.usdz'
            precious.write_bytes(b'owner asset')

            def downstream(name, output, environment):
                Path(output).write_bytes(b'new diagnostic GLB')
                return 'fixture diagnostic'

            result = self.retarget(directory, downstream, presentation='diagnostic')
            self.assertIsNone(result['optionalUsdz'])
            self.assertEqual(precious.read_bytes(), b'owner asset')


if __name__ == '__main__':
    unittest.main()
