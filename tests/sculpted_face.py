"""Expression fields stay anatomical when a sculpt is translated or rescaled."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_sculpt_face import expression_fields, performance_samples


class SculptFaceTests(unittest.TestCase):
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
