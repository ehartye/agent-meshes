"""Small compatibility checks for the face helper component boundaries; no Blender."""
import importlib
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
LIB = Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'
sys.path.insert(0, str(LIB))


EXPECTED_EXPORTS = [
    'ARKIT_REQUIRED',
    'ARKIT_OPTIONAL',
    'ARKIT_GAZE',
    'ARKIT_NAMES',
    'CANONICAL_EMOTIONS',
    'DEFAULT_LID_FOLLOW',
    'lid_geometry',
    'shutter_geometry',
    'lid_clearance',
    'COVERAGE_STATES',
    'eye_coverage',
    'eye_coverage_problems',
    'eyeball_geometry',
    'socket_geometry',
    'recommended_gaze',
    'eye_window',
    'lash_faces',
    'lash_geometry',
    'eye_hole',
    'eye_holes',
    'continuous_lid_edges',
    'lid_poses',
    'CONTINUOUS_OPTIONS',
    'eye_hole_mask',
    'shutter_hole',
    'EYE_MATERIALS',
    'EXPOSED_TEETH_MATERIAL',
    'skin_brow_geometry',
    'dome_brow_geometry',
    'JawHinge',
    'SEAM_TOLERANCE',
    'chin_drop',
    'front_surface',
    'cut_hole',
    'exposed_teeth_geometry',
    'brow_ridge_geometry',
    'brow_plate_geometry',
    'split_plates',
    'rubber_mouth_geometry',
    'teeth_row_geometry',
    'mouth_cavity_geometry',
    'tongue_geometry',
    'soft_offset',
    'symmetric_offsets',
    'smooth_surface',
    'smooth_skin',
    'nose_geometry',
    'sculpt_skin',
    'sculpt_lips',
    'sdf_blank',
    'ellipsoid_sdf',
    'smooth_min',
    'smooth_max',
    'skin_tints',
    'tint_for',
    'outward_faces',
    'paint_vertices',
    'use_vertex_colors',
    'PAINT_LAYER',
    'ATTACH_TOLERANCE',
    'attach_to_skin',
    'follow_skin',
    'skin_contact',
    'mirror_x',
    'cut_faces',
    'ellipsoid_geometry',
    'folded_faces',
    'join_geometry',
    'join_face_parts',
    'face_contract_extras',
    'validate_face_contract_extras',
    'merge_glb_node_extras',
    'prune_glb_morphs',
    'MORPH_POSITION_EPSILON',
    'MORPH_NORMAL_EPSILON',
    'face_skeleton',
    'add_eye_bones',
    'bind_rigid',
    'build_eye',
    'add_jaw_open',
    'slit_mouth',
    'mesh_from_geometry',
    'lip_lining_geometry',
    'curved_mouth_pocket_geometry',
    'build_lip_lining',
    'collect_morph_names',
    'SEAM_ATTRIBUTE',
    'set_face_contract',
    'face_contract',
    'EXTRAS_PROPERTY',
    'mark_face_region',
]



class FaceComponents(unittest.TestCase):
    def test_historical_public_export_list_stays_available(self):
        face = importlib.import_module('agent_meshes_face')
        self.assertTrue(set(EXPECTED_EXPORTS) <= set(face.__all__))

    def test_components_import_independently_without_blender_or_author(self):
        # Separate interpreters catch cycles hidden by an already imported facade.
        for name in ('geometry', 'contract', 'blender'):
            with self.subTest(component=name):
                code = f'''
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, {str(LIB)!r})
sys.modules['bpy'] = None
sys.modules['bmesh'] = None
sys.modules['mathutils'] = None
import agent_meshes_face_{name} as component
assert 'agent_meshes_face' not in sys.modules
assert 'agent_meshes_author' not in sys.modules
'''
                result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_facade_reexports_the_real_implementations_and_author_wildcard(self):
        face = importlib.import_module('agent_meshes_face')
        author = importlib.import_module('agent_meshes_author')
        geometry = importlib.import_module('agent_meshes_face_geometry')
        contract = importlib.import_module('agent_meshes_face_contract')
        blender = importlib.import_module('agent_meshes_face_blender')
        for name in face.__all__:
            with self.subTest(name=name):
                self.assertIs(getattr(author, name), getattr(face, name))
                owners = [m for m in (geometry, contract, blender) if hasattr(m, name)]
                self.assertTrue(owners)
                for owner in owners:
                    self.assertIs(getattr(face, name), getattr(owner, name))
        for owner, names in (
            (geometry, ('ellipsoid_geometry', 'JawHinge', '_clip', '_SkinIndex', '_snap_to_plane', '_sharp_edges')),
            (contract, ('face_contract_extras', 'prune_glb_morphs', '_read_glb', '_write_glb')),
            (blender, ('build_eye', 'mark_face_region', '_PointLookup', '_material')),
        ):
            for name in names:
                self.assertIs(getattr(face, name), getattr(owner, name))

    def test_geometry_output_and_contract_data_agree_through_both_paths(self):
        from agent_meshes_face import ellipsoid_geometry, face_contract_extras
        from agent_meshes_face_geometry import ellipsoid_geometry as geometry
        from agent_meshes_face_contract import ARKIT_REQUIRED, face_contract_extras as extras
        args = ((0, 0, .12), (.08, .09, .11))
        direct = geometry(*args, rings=4, segments=8)
        self.assertAlmostEqual(min(v[2] for v in direct['vertices']), .01)
        self.assertAlmostEqual(max(v[2] for v in direct['vertices']), .23)
        self.assertTrue(direct['faces'])
        self.assertEqual(extras(ARKIT_REQUIRED, 25, 18)['arkitFace']['contract'], 'arkit-face/1')
        with self.assertRaisesRegex(ValueError, 'Missing required morphs'):
            extras([], 25, 18)


if __name__ == '__main__':
    unittest.main()
