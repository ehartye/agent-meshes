"""A continuous eye keeps its anatomy, masks and motion in a declared frame."""
import copy
import math
from pathlib import Path
import sys
import unittest
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
import agent_meshes_author as author
from agent_meshes_face import ellipsoid_geometry, eye_hole, eye_hole_mask, eyeball_geometry


class OrientedEyes(unittest.TestCase):
    def api(self, name):
        self.assertTrue(callable(getattr(author, name, None)), name+' must be a supported authoring helper')
        return getattr(author, name)

    def test_supported_eye_and_ball_helpers_exist(self):
        self.api('oriented_eye_hole')
        self.api('oriented_eyeball_geometry')

    def test_eye_bone_frame_has_local_up_and_optical_axes(self):
        build=self.api('eye_bone_frame')
        center=np.array([.1,-.2,1.4]);forward=np.array([.5,-math.sqrt(.75),0])
        matrix=np.array(build(center.tolist(),forward=forward.tolist()))
        np.testing.assert_allclose(matrix[:3,3],center,atol=1e-14)
        np.testing.assert_allclose(matrix[:3,1],[0,0,1],atol=1e-14)
        np.testing.assert_allclose(matrix[:3,2],forward,atol=1e-14)
        np.testing.assert_allclose(matrix[:3,:3].T@matrix[:3,:3],np.eye(3),atol=1e-14)
        self.assertAlmostEqual(np.linalg.det(matrix[:3,:3]),1)

    def test_eyeball_materials_and_pupil_axis_follow_frame(self):
        build = self.api('oriented_eyeball_geometry')
        base = eyeball_geometry((0,0,0), .02, iris=32, pupil=15)
        center = np.array([.4,-.7,1.2])
        a = math.pi/6
        rotation = np.array([[math.cos(a),-math.sin(a),0],[math.sin(a),math.cos(a),0],[0,0,1]])
        result = build(center.tolist(), .02, forward=(rotation @ [0,-1,0]).tolist(), iris=32, pupil=15)
        np.testing.assert_allclose(result['vertices'], np.asarray(base['vertices']) @ rotation.T+center, atol=1e-14)
        self.assertEqual(result['faces'], base['faces'])
        self.assertEqual(result['material_indices'], base['material_indices'])

    def test_invalid_frames_reject_without_mutation(self):
        build = self.api('oriented_eye_hole')
        vertices,faces = [[0,0,0],[1,0,0],[0,1,0]],[(0,1,2)]
        before=copy.deepcopy((vertices,faces))
        for forward,up in [([0,0,0],[0,0,1]),([0,0,1],[0,0,2]),([0,float('nan'),0],[0,0,1]),
                           ([False,-1,0],[0,0,1]),([1,-1],[0,0,1]),([0,-1,0],[0,0,float('inf')])]:
            with self.subTest(forward=forward,up=up), self.assertRaises(ValueError):
                build(vertices,faces,[0,0,0],.02,forward=forward,up=up)
        self.assertEqual((vertices,faces),before)

    def test_normalizes_direction_scale_and_orthogonalizes_up(self):
        build=self.api('oriented_eyeball_geometry')
        canonical=build([0,0,0],.02,slit=.5)
        scaled=build([0,0,0],.02,forward=[0,-1e308,0],up=[0,4e307,1e308],slit=.5)
        np.testing.assert_allclose(scaled['vertices'],canonical['vertices'],atol=1e-15)
        self.assertEqual(scaled['material_indices'],canonical['material_indices'])

    def test_rejects_construction_modes_that_assume_global_symmetry(self):
        build=self.api('oriented_eye_hole')
        for options in [{'style':'shells'},{'twin':True}]:
            with self.subTest(options=options),self.assertRaises(ValueError):
                build([],[],[0,0,0],.02,**options)

    def test_continuous_eye_geometry_motion_paint_and_masks_share_frame(self):
        build = self.api('oriented_eye_hole')
        blank=ellipsoid_geometry((-.045,.052,-.062),(.11,.085,.10),rings=56,segments=72)
        options={'opening':(48,36,28)}
        local=eye_hole(blank['vertices'],blank['faces'],(0,0,0),.02,**options)
        # A rolled, vertically directed eye catches implementations that only yaw.
        rotation=np.array([[0,0,1],[1,0,0],[0,1,0]],float)
        center=np.zeros(3)
        vertices=(np.asarray(blank['vertices'])@rotation.T+center).tolist()
        faces=copy.deepcopy(blank['faces']);before=copy.deepcopy((vertices,faces))
        world=build(vertices,faces,center.tolist(),.02,forward=(rotation@[0,-1,0]).tolist(),
                    up=(rotation@[0,0,1]).tolist(),**options)
        self.assertEqual((vertices,faces),before)
        self.assertEqual(len(world['motion']),len(local['motion']))
        for (p,targets),(q,expected) in zip(world['motion'],local['motion']):
            np.testing.assert_allclose(p,np.array(q)@rotation.T+center,atol=1e-11)
            for name in targets:np.testing.assert_allclose(targets[name],np.array(expected[name])@rotation.T+center,atol=1e-11)
        for key in ['upper','lower']:
            np.testing.assert_allclose(world['lash'][key],np.asarray(local['lash'][key])@rotation.T+center,atol=1e-11)
        np.testing.assert_allclose(world['lining_points'],np.asarray(local['lining_points'])@rotation.T+center,atol=1e-11)
        a,b=eye_hole_mask(local),eye_hole_mask(world)
        rng=np.random.default_rng(42)
        for point in rng.uniform(-.09,.09,(100,3)):
            transformed=point@rotation.T+center
            self.assertAlmostEqual(a(point),b(transformed),places=10)
            for key in ['still']:
                self.assertAlmostEqual(local[key](point),world[key](transformed),places=9)
            self.assertAlmostEqual(local['window']['level'](point),world['window']['level'](transformed),places=9)
        self.assertAlmostEqual(world['lids']['min_clearance'],local['lids']['min_clearance'],places=12)
        np.testing.assert_allclose(world['lids']['center'],center,atol=1e-14)
        np.testing.assert_allclose(world['window']['center'],center,atol=1e-14)


if __name__ == '__main__': unittest.main()
