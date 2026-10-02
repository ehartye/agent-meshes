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
    def test_path_field_does_not_falsely_converge_on_a_stiff_short_edge(self):
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        v=np.array([[0.,0.,0.],[1.,0.,0.],[1.,1e-9,0.],[0.,1.,0.],[0.,0.,1.]])
        # Its exact solution is .001, but a billion-to-one edge ratio is outside
        # the supported numerical domain. Fail closed, never return 1e-12.
        with self.assertRaisesRegex(ValueError,'ill-conditioned'):
            sculpt.transfer_sculpt_paths(v,[[0,1,2],[0,3,4]],donor,
                {'funnel':donor+[0,0,.001]},donor,donor,paths=[([0,3],[0,2])],
                face_vertices=[0,1,2,3],reach=2.)

    def test_path_field_rejects_a_stiff_component_that_masks_another_component(self):
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        v=np.array([[0.,0.,0.],[.01,0.,0.],[.01,.01,0.],[0.,.01,0.],[0.,0.,.01],
                    [2.,0.,0.],[2.,1e-12,0.],[2.+1e-12,0.,0.]])
        with self.assertRaisesRegex(ValueError,'ill-conditioned'):
            sculpt.transfer_sculpt_paths(v,[[0,1,2],[0,3,4],[5,6,7]],donor,
                {'funnel':donor+[0,0,.001]},donor,donor,
                paths=[([0,3],[0,2]),([5,6],[0,1])],
                face_vertices=[0,1,2,3,5,6,7],reach=.1)

    def test_paths_transport_nonlinear_motion_without_crossing_disconnected_geometry(self):
        from agent_meshes_reproportion import tps_fit,tps_apply
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.],[.25,.25,.25]])
        anchors=donor.copy();anchors[4,2]+=.2
        fit=tps_fit(donor,anchors);rest=tps_apply(fit,donor[:3]);moved=donor+[0,0,.01]
        v=np.concatenate([rest,rest,[[7.,8.,9.]]])
        result=sculpt.transfer_sculpt_paths(v,[[0,1,2],[3,4,5]],donor,
            {'funnel':moved},donor,anchors,paths=[([0,1,2],[0,1,2])],
            face_vertices=list(range(7)),reach=2.)['funnel']
        np.testing.assert_allclose(result[:3],tps_apply(fit,moved[:3]),atol=1e-10)
        np.testing.assert_array_equal(result[3:],v[3:])

    def test_paths_reject_a_quad_diagonal_shortcut(self):
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        v=np.array([[0.,0.,0.],[1.,0.,0.],[1.,1.,0.],[0.,1.,0.]])
        with self.assertRaisesRegex(ValueError,'mesh edges'):
            sculpt.transfer_sculpt_paths(v,[[0,1,2,3]],donor,{'funnel':donor+.01},
                donor,donor,paths=[([0,2],[0,1])],face_vertices=range(4),reach=2.)

    def test_explicit_paths_preserve_protected_vertices_and_carry_rim_followers(self):
        self.assertTrue(hasattr(sculpt,'transfer_sculpt_paths'),'Anatomical path transfer is missing')
        donor=np.array([[0.,0.,0.],[2.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        moved=donor.copy();moved[0,2]+=.001;moved[1,2]+=.003
        v=np.array([[x,y,0.] for y in range(4) for x in [0.,.5,2.]]+[[10.,10.,10.]])
        faces=[[3*y+x,3*y+x+1,3*(y+1)+x+1,3*(y+1)+x] for y in range(3) for x in range(2)]
        original=v.copy()
        result=sculpt.transfer_sculpt_paths(v,faces,donor,{'mouthFunnel':moved},donor,donor,
            paths=[([0,1,2],[0,1])],followers={6:0,7:1,8:2},
            face_vertices=list(range(12)),fixed_vertices=[9,10,11],reach=5.)
        delta=result['mouthFunnel']-v
        np.testing.assert_allclose(delta[:3,2],[.001,.0015,.003],atol=1e-12)
        np.testing.assert_allclose(delta[6:9],delta[:3],atol=1e-12)
        np.testing.assert_array_equal(result['mouthFunnel'][9:],v[9:])
        np.testing.assert_array_equal(v,original)
        # Free middle row solves a weighted graph field, rather than copying a
        # nearest donor point through the gap between anatomical surfaces.
        adjacency=[set() for _ in v]
        for f in faces:
            for a,b in zip(f,f[1:]+f[:1]):adjacency[a].add(b);adjacency[b].add(a)
        for i in [3,4,5]:
            neighbors=sorted(adjacency[i]);w=1/np.linalg.norm(v[neighbors]-v[i],axis=1)
            np.testing.assert_allclose(delta[i],np.average(delta[neighbors],axis=0,weights=w),atol=1e-9)

    def test_ordered_motion_avoids_the_archived_half_funnel_triangle_reversal(self):
        self.assertTrue(hasattr(sculpt,'transfer_sculpt_paths'),'Anatomical path transfer is missing')
        from agent_meshes_face import folded_faces
        # Reduced numeric counterexample from the archived Mara triangle8570.
        v=np.array([[-.038539983332157135,-.17144425213336945,1.367285966873169],
                    [-.037054404616355896,-.17232736945152283,1.3688493967056274],
                    [-.039269011467695236,-.16834791004657745,1.3694443702697754],
                    [0.,0.,0.]])
        old=np.array([[.004065987449827899,-.006183348803911627,.0008707967468981458],
                      [.0020685236697495194,-.008510775325148882,-.002345881890833607],
                      [.002319176486288013,-.008438541834202104,-.0022401492096704393],[0.,0.,0.]])
        self.assertTrue(folded_faces(v,v+.5*old,[[0,1,2]]),'Fixture must reproduce the old half-funnel reversal')
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        moved=donor+np.array([.002,-.008,0.])
        result=sculpt.transfer_sculpt_paths(v,[[0,1,2]],donor,{'mouthFunnel':moved},donor,donor,
            paths=[([0,1,2],[0,1])],face_vertices=[0,1,2],reach=.04)
        for phase in [.25,.5,.75,1.]:self.assertFalse(folded_faces(v,v+(result['mouthFunnel']-v)*phase,[[0,1,2]]))
        np.testing.assert_array_equal(result['mouthFunnel'][3],v[3])

    def test_path_transfer_rejects_conflicting_pins_and_invalid_or_unordered_topology(self):
        self.assertTrue(hasattr(sculpt,'transfer_sculpt_paths'),'Anatomical path transfer is missing')
        donor=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]])
        kwargs=dict(face_vertices=[0,1,2],reach=2.)
        for paths in [[([0,0],[0,1])],[([0,9],[0,1])],[([0,1],[0,1]),([0,2],[2,3])]]:
            with self.assertRaises(ValueError):sculpt.transfer_sculpt_paths(donor,[[0,1,2]],donor,
                {'funnel':donor+[[0,0,.01],[0,0,.01],[0,0,-.01],[0,0,-.01]]},donor,donor,paths=paths,**kwargs)
        with self.assertRaises(ValueError):sculpt.transfer_sculpt_paths(donor,[[0,1,2]],donor,
            {'funnel':donor+.01},donor,donor,paths=[([0,1],[0,1])],followers={2:99},**kwargs)

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
