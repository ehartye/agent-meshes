"""Measured sculpt sections must distinguish hanging arms from the trunk/legs."""
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_landmarks import section, humanoid_landmarks
import agent_meshes_landmarks as landmarks


def figure():
    points=[]
    for z in np.linspace(0,2,201):
        rings=[(0,.16)] if z>.8 else [(-.09,.045),(.09,.045)]
        if .7<z<1.6: rings += [(-.38,.035),(.38,.035)]
        for cx,r in rings:
            for a in np.linspace(0,2*np.pi,24,endpoint=False):
                points.append((cx+r*np.cos(a),r*np.sin(a),z))
    return np.array(points)


PROFILE={'crotch':.83,'neck':1.7,'chin':1.75,'shoulder':[.2,0,1.55],
         'legs':{'ankle':.1,'calf':.3,'knee':.45,'thigh':.65,'hip':.75},
         'arms':{'upperarm':1.4,'elbow':1.2,'forearm':1.05,'wrist':.9,'hand':.8},
         'torso':{'hips':.85,'waist':1,'chest':1.25,'upperchest':1.5},
         'head':{'brow':1.9,'cheek':1.85,'jaw':1.8},'fingertip_x':.3}


class Sections(unittest.TestCase):
    def test_inner_and_outer_do_not_mix_limbs(self):
        v=figure()
        self.assertGreater(section(v,1.2,side=1,part='outer')[:,0].min(),.3)
        self.assertLess(section(v,1.2,side=1,part='inner')[:,0].max(),.2)
        self.assertLess(section(v,1.2,side=-1,part='outer')[:,0].max(),-.3)

    def test_missing_section_and_unseparated_arm_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError,'section'): section(figure(),3)
        with self.assertRaisesRegex(ValueError,'separat'): section(figure(),1.9,side=1,part='outer')

    def test_profile_excludes_low_hands_from_hip_landmarks(self):
        landmarks=humanoid_landmarks(figure(),PROFILE)
        self.assertLess(abs(landmarks['hip_L'].p[0]),.2)
        self.assertGreater(landmarks['wrist_L'].p[0],.3)
        self.assertAlmostEqual(landmarks['crown'].p[2],2)
        np.testing.assert_allclose(landmarks['shoulder_R'].p,[-.2,0,1.55])
        self.assertEqual(landmarks['thigh_out_L'].axis,('ankle_L','hip_L'))

    def test_nonfinite_geometry_is_rejected(self):
        v=figure();v[0,0]=np.nan
        with self.assertRaisesRegex(ValueError,'finite'): humanoid_landmarks(v,PROFILE)



class SurfaceChords(unittest.TestCase):
    # A tapered prism: at z=.5 its X walls are -.75 and 1.5.
    def shape(self):
        v=np.array([[-1,-1,0],[2,-1,0],[2,1,0],[-1,1,0],
                    [-.5,-1,1],[1,-1,1],[1,1,1],[-.5,1,1]],float)
        quads=[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
        f=np.array([(q[0],q[1],q[2]) for q in quads]+[(q[0],q[2],q[3]) for q in quads])
        return v,f

    def chord(self,*args,**kwargs):
        self.assertTrue(hasattr(landmarks,'surface_chord'),'Missing exact surface chord measurement')
        return landmarks.surface_chord(*args,**kwargs)

    def test_measures_actual_faces_between_vertex_rows(self):
        v,f=self.shape()
        lo,hi=self.chord(v,f,[.2,0,.5],[3,0,0])
        np.testing.assert_allclose([lo,hi],[[-.75,0,.5],[1.5,0,.5]],atol=1e-12)
        np.testing.assert_allclose((lo+hi)/2,[.375,0,.5],atol=1e-12)

    def test_rotated_and_translated_geometry_and_shared_edges(self):
        v,f=self.shape();r=np.array([[0,-1,0],[0,0,1],[-1,0,0]],float);t=np.array([2,3,4])
        # z=0.5,y=0 follows shared triangle edges on both side walls.
        a,b=self.chord(v@r.T+t,f,np.array([0,0,.5])@r.T+t,np.array([1,0,0])@r.T)
        np.testing.assert_allclose([a,b],np.array([[-.75,0,.5],[1.5,0,.5]])@r.T+t,atol=1e-12)

    def test_open_missed_or_ambiguous_sections_fail(self):
        v,f=self.shape()
        for point,direction,verts,faces in [([0,0,2],[1,0,0],v,f),
            ([3,0,.5],[1,0,0],v,f),([0,0,.5],[1,0,0],v,f[[i for i in range(12) if i not in (3,9)]]),
            ([0,0,.5],[1,0,0],np.vstack([v,v+[5,0,0]]),np.vstack([f,f+8]))]:
            with self.subTest(point=point,faces=len(faces)):
                with self.assertRaisesRegex(ValueError,'crossings|bracket'):
                    self.chord(verts,faces,point,direction)

    def test_invalid_input_is_rejected(self):
        v,f=self.shape()
        for direction in ([0,0,0],[float('nan'),0,1]):
            with self.assertRaises(ValueError):self.chord(v,f,[0,0,.5],direction)
        with self.assertRaises(ValueError):self.chord(v,np.array([[0,1,99]]),[0,0,.5],[1,0,0])

    def test_line_running_in_boundary_surface_is_not_a_depth_measurement(self):
        v,f=self.shape()
        with self.assertRaisesRegex(ValueError,'coplanar'):
            self.chord(v,f,[0,1,.5],[1,0,0])

if __name__=='__main__': unittest.main()
