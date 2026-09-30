"""Nonhuman anatomical contract, independent of Blender and consumer identity."""
import math
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_sprout_kin import anatomy, geometry


class SproutKin(unittest.TestCase):
    def test_digitigrade_landmarks_and_nonhuman_silhouette(self):
        for age, height in [('adult', 1.7), ('child', 1.12)]:
            a=anatomy(height=height, age=age); p=a['joints']
            hip,knee,hock,toe=[np.array(p[n+'_l']) for n in ['hip','knee','hock','toe']]
            self.assertTrue(hip[2]>knee[2]>hock[2]>toe[2])
            self.assertLess(knee[1],hip[1])  # knee forward (-Y), hock behind
            self.assertGreater(hock[1],hip[1])
            self.assertLess(toe[1],hock[1])
            self.assertGreater(np.linalg.norm(toe-hock),height*.10)
            self.assertLess(p['head'][1],p['shoulder_l'][1])
            self.assertGreater(p['tail_tip'][1],p['hip_l'][1]+height*.2)
            self.assertGreater(a['head_radii'][0],a['head_radii'][2]*1.2)
            self.assertLess(p['hand_l'][2],hip[2])

    def test_geometry_has_separate_digits_grounded_toes_and_age_specific_crest(self):
        for age,count in [('adult',5),('child',3)]:
            parts=geometry(age=age); by={p['name']:p for p in parts}
            self.assertEqual(len(parts),len(by))
            self.assertEqual(sum(n.startswith('crest-') for n in by),count)
            self.assertAlmostEqual(max(v[2] for p in parts for v in p['vertices']),1.7,places=7)
            for side in ['l','r']:
                self.assertEqual(sum(n.startswith('finger_'+side) for n in by),2)
                self.assertIn('thumb_'+side,by)
                self.assertEqual(sum(n.startswith('toe_'+side) for n in by),3)
                toes=np.concatenate([p['vertices'] for n,p in by.items() if n.startswith('toe_'+side)])
                self.assertAlmostEqual(toes[:,2].min(),0,places=7)
            for part in parts:
                self.assertTrue(np.isfinite(part['vertices']).all())
                self.assertTrue(all(0<=i<len(part['vertices']) for f in part['faces'] for i in f))
            self.assertEqual(parts,geometry(age=age))

    def test_relaxed_three_digit_hands_have_forward_thumbs_and_inward_curl(self):
        for age,height in [('adult',1.7),('child',1.12)]:
            parts={p['name']:np.array(p['vertices']) for p in geometry(age=age,height=height)}
            for side,sign in [('l',1),('r',-1)]:
                palm=parts['palm_'+side].mean(axis=0)
                thumb=parts['thumb-tip_'+side].mean(axis=0)-palm
                self.assertGreater(-thumb[1],abs(thumb[0])*1.3)
                finger=(parts['digit-tip_'+side+'0'].mean(axis=0)+parts['digit-tip_'+side+'1'].mean(axis=0))/2-palm
                joints=anatomy(age=age,height=height)['joints']
                axis=np.array(joints['wrist_'+side])-joints['elbow_'+side];axis/=np.linalg.norm(axis)
                curl=finger-axis*np.dot(finger,axis)
                self.assertLess(sign*curl[0],-.008*height/1.7)

    def test_child_is_not_a_uniformly_scaled_adult_and_inputs_are_bounded(self):
        adult=anatomy(height=1.7); child=anatomy(height=1.12,age='child')
        self.assertGreater(child['head_radii'][0]/1.12,adult['head_radii'][0]/1.7)
        for args in [{'height':True},{'height':math.nan},{'height':.1},{'age':'infant'}]:
            with self.assertRaises(ValueError): anatomy(**args)


if __name__=='__main__': unittest.main()
