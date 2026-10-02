"""Expression fields stay anatomical when a sculpt is translated or rescaled."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
import agent_meshes_sculpt_face as sculpt
from agent_meshes_sculpt_face import expression_fields, performance_samples


class SculptFaceTests(unittest.TestCase):
    def test_follow_skin_finds_a_coarse_triangle_crossing_the_search_box(self):
        from agent_meshes_face import follow_skin
        vertices=[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]]
        skin={'vertices':vertices,'faces':[[0,1,2]],
              'morphs':{'mouthFunnel':[[x,y,z+.003] for x,y,z in vertices]}}
        part={'vertices':[[.25,.25,.002]]}
        result=follow_skin(part,skin,.01)
        self.assertIn('mouthFunnel',result['morphs'],'Crossing donor triangle was discarded')
        np.testing.assert_allclose(result['morphs']['mouthFunnel'],[[.25,.25,.005]],atol=1e-12)

    def transfer_fixture(self):
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        matrix=np.array([[0.,-2.,0.],[2.,0.,0.],[0.,0.,2.]])
        shift=np.array([3.,-4.,5.])
        target=donor @ matrix.T + shift
        points=np.array([[.25,.25,0.],[.20,.20,0.],[10.,10.,10.]]) @ matrix.T + shift
        return donor,target,points,matrix,shift

    def test_transfer_transports_motion_without_replacing_rest_or_fixed_regions(self):
        self.assertTrue(hasattr(sculpt,'transfer_sculpt_morphs'),'Reusable sculpt morph transfer is missing')
        donor,target,points,matrix,_=self.transfer_fixture()
        delta=np.array([.01,.02,.03]);original=points.copy()
        result=sculpt.transfer_sculpt_morphs(points,donor,[[0,1,2],[0,1,3],[0,2,3],[1,2,3]],
            {'mouthFunnel':donor+delta},donor,target,face_vertices=[0,1],fixed_vertices=[1],reach=.1)
        np.testing.assert_allclose(result['mouthFunnel'][0]-points[0],matrix @ delta,atol=1e-10)
        np.testing.assert_array_equal(result['mouthFunnel'][1:],points[1:])
        np.testing.assert_array_equal(points,original)

    def test_transfer_rejects_invalid_correspondence_before_mutating_inputs(self):
        self.assertTrue(hasattr(sculpt,'transfer_sculpt_morphs'),'Reusable sculpt morph transfer is missing')
        donor,target,points,_,_=self.transfer_fixture()
        kwargs=dict(face_vertices=[0,1],reach=.1)
        for source_landmarks in [donor[:3],np.zeros((4,3)),donor*np.nan]:
            with self.assertRaises(ValueError):sculpt.transfer_sculpt_morphs(points,donor,[[0,1,2]],
                {'mouthFunnel':donor+.01},source_landmarks,target,**kwargs)
        with self.assertRaises(ValueError):sculpt.transfer_sculpt_morphs(points,donor,[[0,1,2]],
            {'mouthFunnel':donor+.01},donor,target,face_vertices=[0,99],reach=.1)
        with self.assertRaises(ValueError):sculpt.transfer_sculpt_morphs(points,donor,[[0,1,2]],
            {'mouthFunnel':donor},donor,target,**kwargs)

    def test_transfer_rejects_motion_outside_the_selected_donor_surface(self):
        donor,target,points,_,_=self.transfer_fixture()
        moved=donor.copy();moved[3,2]+=.01
        with self.assertRaisesRegex(ValueError,'No transferred motion'):
            sculpt.transfer_sculpt_morphs(points,donor,[[0,1,2]],{'mouthFunnel':moved},
                donor,target,face_vertices=[0],reach=.1)

    def test_transfer_transports_nonuniform_motion_through_nonlinear_registration(self):
        from agent_meshes_reproportion import tps_fit,tps_apply
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.],[.25,.25,.25]])
        target=donor.copy();target[4,2]+=.2
        model=tps_fit(donor,target)
        rest=tps_apply(model,donor[:3])
        moved=donor.copy();moved[:,2]+=.01
        expected=tps_apply(model,moved[:3])-rest
        self.assertGreater(np.ptp(expected[:,2]),.0005,'Fixture must exercise a nonlinear warp')
        result=sculpt.transfer_sculpt_morphs(rest,donor,[[0,1,2]],{'browOuterUpLeft':moved},
            donor,target,face_vertices=[0,1,2],reach=.1)
        np.testing.assert_allclose(result['browOuterUpLeft']-rest,expected,atol=1e-10)
        np.testing.assert_array_equal(target[4],[.25,.25,.45])

    def test_expression_fields_follow_translated_and_scaled_landmarks(self):
        eyes=np.array([[.05,-.1,1.6],[-.05,-.1,1.6]])
        mouth=np.array([0,-.18,1.5])
        vertices=np.array([[.042,-.18,1.5],[-.042,-.18,1.5],[.04,-.145,1.65],[0,0,.4]])
        original=expression_fields(vertices,eyes,[.05,.05],mouth)
        shift=np.array([.7,-.3,2.1]);scale=1.8
        transformed=expression_fields(vertices*scale+shift,eyes*scale+shift,[.09,.09],mouth*scale+shift)
        for name,delta in original.items():
            np.testing.assert_allclose(transformed[name],delta*scale,atol=1e-12)
            np.testing.assert_equal(delta[-1],0)
        self.assertGreater(original['mouthSmileLeft'][0,0],0)
        self.assertLess(original['mouthSmileRight'][1,0],0)

    def test_performance_includes_closed_blink_and_neutral_loop_endpoints(self):
        for end in [4,30,93.5]:
            for phase in [.1,.63,.95]:
                samples=performance_samples(0,end,30,phase)
                self.assertEqual(samples[0],(0.,0.,0.))
                self.assertEqual(samples[-1],(end,0.,0.))
                self.assertEqual(max(b for _,b,_ in samples),1)
                self.assertTrue(all(0<=t<=end and 0<=b<=1 and 0<=e<=1 for t,b,e in samples))
                self.assertEqual(len(samples),len(set(t for t,_,_ in samples)))

    def test_invalid_anatomy_and_timing_reject(self):
        for eyes in [[[0,0,1],[0,0,1]],[[1,2,3]],[[np.nan,0,1],[-1,0,1]]]:
            with self.assertRaises(ValueError):expression_fields([[0,0,0]],eyes,[.05,.05],[0,0,0])
        for args in [(0,0,30,.5),(2,1,30,.5),(0,10,0,.5),(0,10,30,1)]:
            with self.assertRaises(ValueError):performance_samples(*args)


if __name__=='__main__':unittest.main()
