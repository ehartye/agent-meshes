"""Hanging cloth must clear sampled obstacles without limb-weight collapse."""
import sys,unittest,math
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_cloth_flap import clearance_angle, conservative_smooth

class ClothFlap(unittest.TestCase):
    def test_lifts_over_forward_obstacle(self):
        points=np.array([[0,-.1,-.2],[0,.05,-.1],[.5,-.5,-.1],[0,-.4,-.8]])
        angle=clearance_angle(points,[0,0,0],.3,.2,-1,gap=.01)
        self.assertAlmostEqual(angle,math.atan2(.11,.2))
        # Plane rotated forward by angle leaves every relevant point behind it.
        self.assertGreaterEqual(.2*math.sin(angle)-.1*math.cos(angle),.008)
    def test_back_panel_and_invalid_inputs(self):
        self.assertAlmostEqual(clearance_angle([[0,.1,-.2]],[0,0,0],.3,.2,1,gap=.01),math.atan2(.11,.2))
        self.assertEqual(clearance_angle([[0,.1,-.2]],[0,0,0],.3,.2,-1),0)
        for kwargs in [{'length':0},{'half_width':-1},{'direction':0},{'gap':-1}]:
            args=dict(length=.3,half_width=.2,direction=-1,gap=.01);args.update(kwargs)
            with self.assertRaises(ValueError):clearance_angle([[0,0,-.1]],[0,0,0],**args)
        with self.assertRaises(ValueError):clearance_angle([[0,float('nan'),0]],[0,0,0],.3,.2,-1)
    def test_smoothing_never_lowers_clearance_and_closes_loop(self):
        wave=np.maximum(0,np.sin(np.linspace(0,2*np.pi,61)))
        result=conservative_smooth(wave,loop=True)
        self.assertTrue(np.all(result>=wave-1e-12));self.assertEqual(result[0],result[-1])
        pulse=np.zeros(61);pulse[30]=1
        smoothed=conservative_smooth(pulse)
        self.assertTrue(np.all(smoothed>=pulse));self.assertLess(np.max(abs(np.diff(smoothed))),1)
if __name__=='__main__':unittest.main()
