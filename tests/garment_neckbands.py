"""Closed crew-neck and open jacket stand construction, without Blender."""
import sys,unittest
from pathlib import Path
from collections import Counter
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_neckbands import neckband_mesh


class Neckbands(unittest.TestCase):
    def rings(self,closed=True):
        t=np.linspace(0 if closed else .6,2*np.pi if closed else 2*np.pi-.6,96,endpoint=not closed)
        lower=np.column_stack((.07*np.sin(t),-.06*np.cos(t),np.full(len(t),1.4)))
        upper=lower.copy();upper[:,2]+=.016;upper[:,:2]*=.96
        return lower,upper

    def check_closed_surface(self,vertices,faces,euler):
        edges=Counter(tuple(sorted((a,b))) for f in faces for a,b in zip(f,(*f[1:],f[0])))
        self.assertTrue(all(n==2 for n in edges.values()))
        self.assertEqual(len(vertices)-len(edges)+len(faces),euler)
        for f in faces:
            p=np.array([vertices[i] for i in f]);self.assertGreater(np.linalg.norm(np.cross(p[1]-p[0],p[2]-p[0])),1e-12)

    def test_crew_neck_is_one_continuous_ring(self):
        v,f=neckband_mesh(*self.rings(),thickness=.002,ribs=16,rib_depth=.0007)
        self.check_closed_surface(v,f,0)
        self.assertTrue(np.isfinite(v).all())

    def test_open_jacket_stand_has_closed_end_faces(self):
        v,f=neckband_mesh(*self.rings(False),thickness=.003,closed=False)
        self.check_closed_surface(v,f,2)

    def test_ribbing_runs_in_the_same_direction_at_both_heights(self):
        lower,upper=self.rings();plain,_=neckband_mesh(lower,upper,thickness=.002)
        ribbed,_=neckband_mesh(lower,upper,thickness=.002,ribs=16,rib_depth=.0007)
        delta=(np.array(ribbed)-plain).reshape(96,-1,3)
        # The lower and upper outer walls share the rib phase; the inner wall stays smooth.
        np.testing.assert_allclose(delta[:,2],delta[:,3],atol=1e-12)
        self.assertGreater(np.linalg.norm(delta[:,2],axis=1).max(),.0006)
        np.testing.assert_allclose(delta[:,6:],0,atol=1e-12)

    def test_rejects_mismatched_or_aliased_rings(self):
        a,b=self.rings()
        for args in [(a[:-1],b,{}),(a,a,{}),(a,b,{'ribs':40}),(a,b,{'thickness':0}),(a,b,{'rib_depth':-1})]:
            with self.assertRaises(ValueError):neckband_mesh(args[0],args[1],**args[2])

if __name__=='__main__':unittest.main()
