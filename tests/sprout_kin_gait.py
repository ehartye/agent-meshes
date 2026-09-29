"""Contact trajectories and digitigrade IK contract, independent of Blender."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_sprout_gait import foot_path, two_bone, periodic_curve

class SproutGait(unittest.TestCase):
    def test_contact_velocity_and_loop(self):
        for stance in [.62,.42]:
            stride=.30;lift=.10
            for phase in np.linspace(.001,stance-.001,30):
                p=foot_path(phase,stance,stride,lift)
                self.assertEqual(p[1],0.)
                derivative=(foot_path(phase+1e-6,stance,stride,lift)-foot_path(phase-1e-6,stance,stride,lift))/2e-6
                np.testing.assert_allclose(derivative,[stride/stance,0],atol=1e-6)
            np.testing.assert_allclose(foot_path(0,stance,stride,lift),foot_path(1,stance,stride,lift),atol=1e-12)
            for boundary in [0,stance]:
                p=foot_path(boundary,stance,stride,lift)
                left=(p-foot_path(boundary-1e-6,stance,stride,lift))/1e-6
                right=(foot_path(boundary+1e-6,stance,stride,lift)-p)/1e-6
                np.testing.assert_allclose(left,right,atol=1e-4)
            self.assertAlmostEqual(foot_path((1+stance)/2,stance,stride,lift)[1],lift)

    def test_walk_stays_grounded_and_jog_has_flight(self):
        for stance,lift,flight in [(.62,.09,False),(.36,.16,True)]:
            both_airborne=sum(all(foot_path(p+offset,stance,.34,lift)[1]>.005 for offset in [0,.5]) for p in np.linspace(0,1,240,endpoint=False))
            self.assertEqual(both_airborne>0,flight)

    def test_reference_curve_is_periodic_and_smooth_at_the_seam(self):
        phase=np.linspace(0,1,121)
        wave=periodic_curve(np.sin(2*np.pi*phase)+.1*np.sin(20*np.pi*phase),harmonics=5)
        for p in [.1,.37,.8]:self.assertAlmostEqual(wave(p),np.sin(2*np.pi*p),places=7)
        self.assertAlmostEqual(wave(0),wave(1),places=10)
        left=(wave(0)-wave(-1e-5))/1e-5;right=(wave(1e-5)-wave(0))/1e-5
        self.assertAlmostEqual(left,right,places=5)

    def test_foot_keeps_ground_speed_until_clear_of_contact(self):
        for u in [.02,.98]:
            stance=.62;phase=stance+(1-stance)*u
            derivative=(foot_path(phase+1e-6,stance,.49,.09)[0]-foot_path(phase-1e-6,stance,.49,.09)[0])/2e-6
            self.assertAlmostEqual(derivative,.49/stance,places=6)

    def test_leg_lengths_and_pole(self):
        hip=np.array([.08,.025,.7]);hock=np.array([.12,.105,.25])
        knee=two_bone(hip,hock,.23,.33,[0,-1,0])
        self.assertAlmostEqual(np.linalg.norm(knee-hip),.23)
        self.assertAlmostEqual(np.linalg.norm(hock-knee),.33)
        self.assertLess(knee[1],min(hip[1],hock[1]))
        with self.assertRaises(ValueError):two_bone(hip,hip+[0,0,2],.23,.33,[0,-1,0])
        with self.assertRaises(ValueError):foot_path(0,1,.3,.1)

if __name__=='__main__':unittest.main()
