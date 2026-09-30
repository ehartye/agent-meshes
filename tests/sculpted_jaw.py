"""A sculpt's folded lip lining needs anatomical ownership, not a height comparison."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
from agent_meshes_face import JawHinge
from agent_meshes_sculpt_face import sculpt_jaw_weights, trace_quad_loop, faces_inside_loop


class QuadLoopTests(unittest.TestCase):
    def setUp(self):
        # Three cylindrical rows: the middle row is a closed regular quad loop.
        self.faces = [(r*6+i,r*6+(i+1)%6,(r+1)*6+(i+1)%6,(r+1)*6+i)
                      for r in range(2) for i in range(6)]

    def test_trace_preserves_start_and_direction_without_coordinates(self):
        self.assertEqual(trace_quad_loop(self.faces, 6, 7), list(range(6,12)))
        self.assertEqual(trace_quad_loop(self.faces, 6, 11), [6,11,10,9,8,7])

    def test_boundary_pole_nonmanifold_and_bad_seed_fail(self):
        for faces,a,b in [(self.faces,0,1), (self.faces,6,8),
                          (self.faces+[self.faces[0]],6,7),
                          (self.faces[:-1],6,7), (self.faces,True,7),
                          (self.faces+[(6,7,12)],6,7)]:
            with self.assertRaises(ValueError):trace_quad_loop(faces,a,b)

    def test_seed_selects_only_one_side_of_closed_loop(self):
        self.assertEqual(faces_inside_loop(self.faces,range(6,12),0),list(range(6)))
        self.assertEqual(faces_inside_loop(self.faces,range(6,12),6),list(range(6,12)))
        for loop,seed in [(range(6),0),([6,7,8,9,10],0),(range(6,12),True),(range(6,12),99)]:
            with self.assertRaises(ValueError):faces_inside_loop(self.faces,loop,seed)

    def test_nonseparating_loop_is_rejected(self):
        torus=[(r*4+c,r*4+(c+1)%4,((r+1)%4)*4+(c+1)%4,((r+1)%4)*4+c)
               for r in range(4) for c in range(4)]
        with self.assertRaises(ValueError):faces_inside_loop(torus,range(4),0)


class SculptJawTests(unittest.TestCase):
    def setUp(self):
        # The upper rim folds below the lower rim at rest, as interlocking lips do.
        self.vertices = np.array([[-.01,-.08,.099],[.01,-.08,.099],[0,-.09,.12],
                                  [-.01,-.08,.102],[.01,-.08,.102],[0,-.09,.08],
                                  [0,-.02,.055],[0,0,0],[0,-.075,.108]])
        self.faces = [(0,1,2),(3,5,4),(3,4,8),(5,6,4),(6,7,5)]
        self.jaw = JawHinge((0,.03,.1), mouth_z=.1, half_width=.025, drop=.02)

    def test_interlocking_lip_ownership_overrides_height_and_carries_connected_lining(self):
        v=self.vertices
        self.assertGreater(self.jaw.weight(v[0]),0)
        self.assertEqual(self.jaw.weight(v[3]),0)
        weights=sculpt_jaw_weights(v,self.faces,self.jaw,range(7),lower_lip=[3,4],upper_lip=[0,1],reach=.035)
        np.testing.assert_equal(weights[[0,1,2,7,8]],0)  # Body/excluded lining never moves.
        self.assertGreater(weights[3],.7)
        self.assertEqual(weights[6],self.jaw.weight(v[6]))  # Beyond the local solve.
        neighbours=[3,4,6,7]
        conductance=1/np.linalg.norm(v[neighbours]-v[5],axis=1)
        self.assertAlmostEqual(weights[5],np.dot(weights[neighbours],conductance)/conductance.sum(),places=6)
        carried=sculpt_jaw_weights(v,self.faces,self.jaw,range(9),lower_lip=[3,4],upper_lip=[0,1],reach=.025)
        self.assertGreater(carried[8],0)  # Topologically lower lining, despite its higher Z.
        self.assertTrue(np.all((carried>=0)&(carried<=1)))

    def test_invalid_selection_and_nonfinite_data_reject(self):
        args=(self.vertices,self.faces,self.jaw,range(7))
        for lower,upper in [([0],[0]),([3],[8]),([], [0]),([True],[0]),([99],[0])]:
            with self.assertRaises(ValueError):sculpt_jaw_weights(*args,lower_lip=lower,upper_lip=upper)
        for reach in [0,-1,float('nan')]:
            with self.assertRaises(ValueError):sculpt_jaw_weights(*args,lower_lip=[3],upper_lip=[0],reach=reach)
        for bad in [float('nan'),float('inf')]:
            v=self.vertices.copy();v[0,0]=bad
            with self.assertRaises(ValueError):sculpt_jaw_weights(v,self.faces,self.jaw,range(7),lower_lip=[3],upper_lip=[0])
        class BadJaw:
            def weight(self,point,lower_lip=False):return float('nan')
        with self.assertRaises(ValueError):
            sculpt_jaw_weights(self.vertices,self.faces,BadJaw(),range(7),lower_lip=[3],upper_lip=[0])

    def test_uniform_scale_and_translation_preserve_weights(self):
        args=dict(lower_lip=[3,4],upper_lip=[0,1],reach=.035)
        expected=sculpt_jaw_weights(self.vertices,self.faces,self.jaw,range(9),**args)
        offset=np.array([2.,-3.,4.]);scale=2.7
        class TransformedJaw:
            def weight(_,point,lower_lip=False):
                return self.jaw.weight((point-offset)/scale,lower_lip=lower_lip)
        args['reach']*=scale
        actual=sculpt_jaw_weights(self.vertices*scale+offset,self.faces,TransformedJaw(),range(9),**args)
        np.testing.assert_allclose(actual,expected,atol=1e-10)

    def test_fixed_region_holds_skull_even_inside_relaxation_reach(self):
        args=dict(lower_lip=[3,4],upper_lip=[0,1],reach=.035)
        old=sculpt_jaw_weights(self.vertices,self.faces,self.jaw,range(9),**args)
        self.assertGreater(old[5],0)
        fixed=sculpt_jaw_weights(self.vertices,self.faces,self.jaw,range(9),fixed_vertices=[5],**args)
        self.assertEqual(fixed[5],0)
        np.testing.assert_equal(fixed[[3,4]],old[[3,4]])
        for invalid in [[3],[True],[99]]:
            with self.assertRaises(ValueError):sculpt_jaw_weights(self.vertices,self.faces,self.jaw,range(9),fixed_vertices=invalid,**args)


if __name__=='__main__':unittest.main()
