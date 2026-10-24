"""Reference body rhythms keep one phase frame, symmetry and periodic seams."""
import sys
from pathlib import Path
import unittest
import copy
import warnings
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
import agent_meshes_digitigrade_gait as gait

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

def legacy_periodic_curve(values,harmonics=5):
    """The sampler before the Nyquist and overflow fixes, kept as the regression reference."""
    c=np.fft.rfft(values[:-1])/len(values[:-1]);count=min(harmonics,len(c)-1)
    return lambda phase:float(c[0].real+2*sum((c[k]*np.exp(2j*np.pi*k*phase)).real for k in range(1,count+1)))

def closed(values):return np.append(values,values[0])

def alternating(n,magnitude=1.):return closed(magnitude*np.tile([1.,-1.],n//2))

def large_curve(n,magnitude):
    """Peak equals magnitude and every sample survives the default fit: the Nyquist term up to n=10, harmonic two above."""
    return alternating(n,magnitude) if n<=10 else closed(magnitude*np.cos(4*np.pi*np.arange(n)/n))

class PeriodicCurve(unittest.TestCase):
    CASES=[(4,5),(6,5),(8,5),(10,5),(12,6)]
    def body_report(self,n,**curves):
        p=np.arange(n)/n
        base={'pelvisHeight':np.cos(4*np.pi*p),'pelvisRoll':np.sin(2*np.pi*p),
              'chestPitch':np.cos(4*np.pi*p)+3,'headPitch':np.cos(4*np.pi*p)};base.update(curves)
        return {'format':'agent-meshes/gait-curves/1','samples':n,'clip':'Walk',
                'source':{'sha256':'synthetic-test','license':'CC0-1.0'},
                'curves':{name:np.asarray(v,float).tolist() for name,v in base.items()}}
    def attempt(self,n,magnitude):
        """Fit large_curve: samples at j/n, or None when rejected; never a leaked warning."""
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            try:wave=gait.periodic_curve(large_curve(n,magnitude));got=np.array([wave(j/n) for j in range(n)])
            except ValueError:got=None
        self.assertEqual([str(w.message) for w in caught if issubclass(w.category,RuntimeWarning)],[],f'n={n} magnitude={magnitude}')
        return got
    def test_alternating_curve_keeps_the_nyquist_harmonic_at_unit_weight(self):
        for n,harmonics in self.CASES:
            wave=gait.periodic_curve(alternating(n),harmonics)
            np.testing.assert_allclose([wave(j/n) for j in range(n)],alternating(n)[:-1],rtol=0,atol=1e-9,err_msg=f'n={n} harmonics={harmonics}')
    def test_random_curves_reproduce_their_own_samples_when_every_harmonic_is_kept(self):
        rng=np.random.default_rng(20261024)
        for n,harmonics in self.CASES+[(5,5),(7,5),(9,5),(11,5)]:
            values=rng.normal(size=n);wave=gait.periodic_curve(closed(values),harmonics)
            np.testing.assert_allclose([wave(j/n) for j in range(n)],values,rtol=0,atol=1e-9,err_msg=f'n={n} harmonics={harmonics}')
    def test_body_timing_keeps_the_nyquist_component_the_symmetry_filter_leaves(self):
        for n,curves in [(8,lambda p,alt:{'pelvisHeight':np.cos(4*np.pi*p)+.5*alt}),
                         (10,lambda p,alt:{'pelvisRoll':np.sin(2*np.pi*p)+.5*alt})]:
            p=np.arange(n)/n;report=self.body_report(n,**curves(p,(-1.)**np.arange(n)))
            sample,_=gait.body_timing(report)
            for name,values in report['curves'].items():
                values=np.array(values);v=(values+(-1 if name=='pelvisRoll' else 1)*np.roll(values,-n//2))/2;want=v-v.mean()
                got=np.array([sample(name,j/n) for j in range(n)]);scale=got@want/(want@want)
                self.assertGreater(scale,0,f'n={n} {name}')
                np.testing.assert_allclose(got,scale*want,rtol=0,atol=1e-9,err_msg=f'n={n} {name}')
                probe=np.array([sample(name,q) for q in np.arange(1024)/1024])
                self.assertAlmostEqual(float(np.ptp(probe)),1. if name=='pelvisHeight' else 2.,delta=1e-9,msg=f'n={n} {name}')
    def test_curves_without_a_nyquist_term_equal_the_legacy_formula(self):
        rng=np.random.default_rng(7)
        for n in (12,64,120):
            for scale in (1e-3,1,3e4):
                values=closed(scale*rng.normal(size=n));wave=gait.periodic_curve(values);old=legacy_periodic_curve(values)
                bound=1e-12*max(1,float(np.max(np.abs(values))))
                for q in np.linspace(-1.3,1.7,41):self.assertLessEqual(abs(wave(q)-old(q)),bound,f'n={n} scale={scale} phase={q}')
    def test_input_too_large_to_transform_is_rejected(self):
        for magnitude in (1.7e308,1.79e308):
            for n in (8,10,64):
                self.assertIsNone(self.attempt(n,magnitude),f'n={n} magnitude={magnitude} must raise ValueError')
    def test_large_input_keeps_its_exact_samples_at_any_sample_count(self):
        for magnitude in (1e300,1e307):
            for n in (8,10,64):
                got=self.attempt(n,magnitude)
                self.assertIsNotNone(got,f'n={n} magnitude={magnitude}')
                np.testing.assert_allclose(got,large_curve(n,magnitude)[:-1],rtol=0,atol=1e-12*magnitude,err_msg=f'n={n} magnitude={magnitude}')
    def test_geometric_magnitude_sweep_never_yields_non_finite_samples_without_an_error(self):
        accepted=rejected=0
        for n in (8,10,64):
            for magnitude in np.geomspace(1e290,1.79e308,80):
                got=self.attempt(n,float(magnitude))
                if got is None:rejected+=1;continue
                accepted+=1;self.assertTrue(np.isfinite(got).all(),f'n={n} magnitude={magnitude}')
                np.testing.assert_allclose(got,large_curve(n,float(magnitude))[:-1],rtol=0,atol=1e-12*magnitude,err_msg=f'n={n} magnitude={magnitude}')
        self.assertGreater(accepted,0);self.assertGreater(rejected,0)
    def test_body_timing_with_a_huge_amplitude_is_rejected_or_finite(self):
        p=np.arange(64)/64;report=self.body_report(64,pelvisHeight=1e307*np.cos(4*np.pi*p))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            try:sample,_=gait.body_timing(report);got=np.array([sample(name,q) for name in report['curves'] for q in np.linspace(0,1,50)])
            except ValueError:got=np.zeros(1)
        self.assertEqual([str(w.message) for w in caught if issubclass(w.category,RuntimeWarning)],[])
        self.assertTrue(np.isfinite(got).all())

if __name__=='__main__':unittest.main()
