"""Portable CPU checks against the imported rigging code and real library GLBs."""
from pathlib import Path
import importlib.util
import json
import tempfile
import unittest
import sys
import hashlib

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('rig_library', ROOT / 'scripts/rigging/rig-tools/rig_library.py')
LIB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIB)
RECEIPTS = []
ARTIFACTS = None


class RigLibrary(unittest.TestCase):
    def test_all_nine_libraries_and_all_source_snapshots_verify(self):
        result = LIB.verify_payloads()
        self.assertEqual(result['libraries'], 9)
        self.assertEqual(result['sourceSnapshots'], 26)

    def test_real_biped_and_animal_extraction_and_cpu_retarget(self):
        with tempfile.TemporaryDirectory() as folder:
            out = ARTIFACTS or Path(folder)
            for library, clip in [('human-base', 'Walk_Loop'), ('fox', 'Walk'), ('spider', 'Walk')]:
                with self.subTest(library=library):
                    record = LIB.library(library)
                    chosen = next((c['name'] for c in record['clips'] if c['name'].lower() == clip.lower()),
                                  record['clips'][0]['name'])
                    extracted = LIB.extract(library, chosen, out / (library + '-clip.npz'))
                    self.assertGreater(extracted['frames'], 2)
                    self.assertGreater(extracted['maximumJointTravel'], .001)
                    # Reconstruct a simple target from the library's skin bind data.
                    rig = LIB.reference_target(library, out / (library + '-rig.npz'))
                    result = LIB.retarget(library, rig, out / (library + '-clip.npz'),
                                          out / (library + '-retarget.glb'))
                    self.assertGreater(result['frames'], 2)
                    self.assertGreater(result['maximumQuaternionChange'], .001)
                    RECEIPTS.append({'library': library, 'sourceSha256': record['sha256'],
                                     'rigSha256': LIB.digest(rig), 'extract': extracted, 'retarget': result})

    def test_missing_clip_and_unsupported_library_fail_before_output(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'missing.npz'
            with self.assertRaises(ValueError):
                LIB.extract('human-base', 'definitely-missing', target)
            with self.assertRaises(ValueError):
                LIB.library('../outside')
            self.assertFalse(target.exists())

    def test_existing_cpu_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'owner.npz'
            path.write_bytes(b'owner source')
            with self.assertRaises(FileExistsError):
                LIB.extract('human-base', 'Walk_Loop', path)
            self.assertEqual(path.read_bytes(), b'owner source')

    def test_readiness_requires_explicit_external_paths_and_never_falls_back(self):
        result = LIB.readiness()
        self.assertFalse(result['unirig']['configured'])
        self.assertFalse(result['skintokens']['configured'])
        self.assertFalse(result['automaticFallback'])
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                LIB.infer_unirig('absent.npz', Path(folder) / 'out.npz',
                                  comfy_root=folder, python=Path(folder) / 'absent-python')
            self.assertFalse((Path(folder) / 'out.npz').exists())

    def test_spider_template_fits_actual_eight_leg_geometry_and_rejects_box(self):
        import numpy as np
        import trimesh
        template = LIB.upstream('spider_template')
        plans = LIB.upstream('body_plans')
        body = trimesh.creation.icosphere(subdivisions=2, radius=.32)
        body.apply_scale((1., .55, 1.)); body.apply_translation((0, .22, 0))
        parts = [body]
        for k in range(8):
            angle = np.pi / 8 + k * np.pi / 4
            direction = np.array([np.cos(angle), 0, np.sin(angle)])
            parts.append(trimesh.creation.cylinder(radius=.06,
                         segment=[direction * .28 + [0, .18, 0], direction * 1.1 + [0, -.42, 0]],
                         sections=24).subdivide())
        with tempfile.TemporaryDirectory() as folder:
            path, output = Path(folder) / 'mesh.npz', Path(folder) / 'candidate.npz'
            mesh = trimesh.util.concatenate(parts)
            np.savez(path, vertices=mesh.vertices, faces=mesh.faces)
            self.assertIsNotNone(template.build(path, output))
            with np.load(output, allow_pickle=True) as data:
                info = plans.classify(data['joints'], data['parents'])
                self.assertEqual(info['plan'], 'many_legged')
                self.assertEqual(info['feet'], 8)
            box = trimesh.creation.box()
            np.savez(path, vertices=box.vertices, faces=box.faces)
            self.assertIsNone(template.build(path, Path(folder) / 'rejected.npz'))


if __name__ == '__main__':
    if '--artifacts' in sys.argv:
        ARTIFACTS = Path(sys.argv[sys.argv.index('--artifacts') + 1]).resolve()
        ARTIFACTS.mkdir(parents=True, exist_ok=False)
    result = unittest.main(argv=[sys.argv[0]], exit=False).result
    if ARTIFACTS:
        owned = ['scripts/rigging/rig-tools/rig_library.py', 'scripts/rigging/rig-tools/unirig_worker.py',
                 'scripts/reference-assets/rigs/catalog.json', 'scripts/rigging/rig-tools/inventory.json',
                 'tests/rig-tools-rig-library.py']
        report = {'ok': result.wasSuccessful(), 'testsRun': result.testsRun,
                  'scope': 'actual imported CPU extraction/retarget/template checks; no GPU or learned inference',
                  'python': sys.version, 'executable': sys.executable,
                  'sourceSha256': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in owned},
                  'jobs': RECEIPTS,
                  'errors': [{'test': str(test), 'traceback': trace} for test, trace in result.errors],
                  'failures': [{'test': str(test), 'traceback': trace} for test, trace in result.failures]}
        (ARTIFACTS/'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))
    if not result.wasSuccessful(): raise SystemExit(1)
