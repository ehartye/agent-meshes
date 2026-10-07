"""Reference body rhythms keep one phase frame, symmetry and periodic seams."""
import sys
from pathlib import Path
import unittest
import copy
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
import agent_meshes_sprout_gait as gait

class BodyTiming(unittest.TestCase):
    def report(self):
        p=np.arange(64)/64
        return {'format':'agent-meshes/gait-curves/1','samples':64,'clip':'Walk',
                'source':{'sha256':'synthetic-test','license':'CC0-1.0'},
                'curves':{'pelvisHeight':(.04*np.cos(4*np.pi*(p-.1))).tolist(),
                          'pelvisRoll':(4*np.sin(2*np.pi*(p-.2))).tolist(),
                          'chestPitch':(8+3*np.sin(4*np.pi*(p-.3))).tolist(),
                          'headPitch':(4+1.5*np.sin(4*np.pi*(p-.4))).tolist()}}
    def test_independent_rhythms_retain_relative_phase_and_share_one_phase_shift(self):
        report=self.report();frozen=copy.deepcopy(report)
        self.assertTrue(callable(getattr(gait,'body_timing',None)),'Shared body_timing API is missing')
        sample,receipt=gait.body_timing(report,phase_shift=.125)
        self.assertEqual(report,frozen)
        self.assertEqual(receipt['clip'],'Walk');self.assertEqual(receipt['source'],report['source'])
        self.assertEqual(receipt['phaseShift'],.125)
        self.assertAlmostEqual(sample('pelvisHeight',-.025),.5,delta=.001)
        self.assertAlmostEqual(sample('pelvisRoll',.075),0.,places=7)
        self.assertAlmostEqual(sample('chestPitch',.3),1.,delta=.001)
        self.assertAlmostEqual(sample('headPitch',.4),1.,delta=.001)
        for name in report['curves']:
            self.assertAlmostEqual(sample(name,0),sample(name,1),places=10)
            self.assertAlmostEqual(sample(name,.27),sample(name,1.27),places=10)
            left=(sample(name,0)-sample(name,-1e-5))/1e-5
            right=(sample(name,1e-5)-sample(name,0))/1e-5
            self.assertLess(abs(left-right),.01)
    def test_asymmetric_reference_drift_is_removed_without_averaging_out_roll(self):
        report=self.report();p=np.arange(64)/64
        report['curves']['pelvisHeight']=(np.array(report['curves']['pelvisHeight'])+.1*np.sin(2*np.pi*p)).tolist()
        report['curves']['pelvisRoll']=(np.array(report['curves']['pelvisRoll'])+2*np.cos(4*np.pi*p)).tolist()
        sample,_=gait.body_timing(report)
        for p in [.03,.21,.47]:
            self.assertAlmostEqual(sample('pelvisHeight',p),sample('pelvisHeight',p+.5),places=8)
            self.assertAlmostEqual(sample('pelvisRoll',p),-sample('pelvisRoll',p+.5),places=8)
    def test_invalid_or_flat_reference_rejects_before_blender_use(self):
        self.assertTrue(callable(getattr(gait,'body_timing',None)),'Shared body_timing API is missing')
        for name in ['pelvisHeight','pelvisRoll','chestPitch','headPitch']:
            for bad in [[],[0]*64,[float('nan')]*64,[0]*63]:
                report=self.report();report['curves'][name]=bad
                with self.assertRaises(ValueError):gait.body_timing(report)
        for bad in [True,float('nan'),float('inf'),'0']:
            with self.assertRaises(ValueError):gait.body_timing(self.report(),phase_shift=bad)
        report=self.report();report['format']='other'
        with self.assertRaises(ValueError):gait.body_timing(report)

if __name__=='__main__':unittest.main()
