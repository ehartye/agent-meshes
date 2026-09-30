"""Measured sculpt sections must distinguish hanging arms from the trunk/legs."""
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_landmarks import section, humanoid_landmarks


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


if __name__=='__main__': unittest.main()
