"""Garment boundaries preserve interpolation, seams and export-safe skinning."""
from pathlib import Path
import sys
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_garments import cut_surface


class GarmentCuts(unittest.TestCase):
    def setUp(self):
        self.v=np.array([[-1,0,0],[1,0,0],[1,0,1],[-1,0,1]],float)
        self.n=np.tile([0,-1,0],(4,1))
        self.w=[{'a':1},{'b':1},{'b':1},{'a':1}]

    def cut(self,fields,**kwargs):
        return cut_surface(self.v,[(0,1,2,3)],self.n,self.w,fields,**kwargs)

    def test_clipped_rim_interpolates_weights_and_does_not_hide_exposed_skin(self):
        out=self.cut([self.v[:,0]],offset=.01)
        self.assertEqual(len(out['faces']),1)
        self.assertEqual(out['covered_faces'],[])
        edge=[i for i,p in enumerate(out['vertices']) if p[0]==0]
        self.assertEqual(len(edge),2)
        for i in edge:
            self.assertEqual(out['weights'][i],{'a':.5,'b':.5})
            self.assertAlmostEqual(out['vertices'][i][1],-.01)

    def test_only_fully_covered_faces_are_removable(self):
        self.assertEqual(self.cut([self.v[:,0]+2])['covered_faces'],[0])
        self.assertEqual(len(self.cut([-self.v[:,0]-2])['faces']),0)

    def test_coincident_skinning_seams_are_not_welded(self):
        v=np.vstack([self.v,self.v]);n=np.vstack([self.n,self.n])
        out=cut_surface(v,[(0,1,2,3),(4,5,6,7)],n,self.w+[{'c':1}]*4,[])
        self.assertEqual(len(out['vertices']),8)
        self.assertEqual(out['weights'][4],{'c':1})

    def test_four_influence_limit_is_normalized(self):
        out=cut_surface(self.v,[(0,1,2,3)],self.n,[dict.fromkeys('abcdef',1)]*4,[])
        for row in out['weights']:
            self.assertEqual(len(row),4);self.assertAlmostEqual(sum(row.values()),1)

    def test_bad_weights_or_fields_reject(self):
        with self.assertRaises(ValueError): self.cut([[1,2]])
        with self.assertRaises(ValueError): cut_surface(self.v,[(0,1,2,3)],self.n,[{}]*4,[])
        with self.assertRaises(ValueError): self.cut([self.v[:,0]],shape=lambda p,n:[np.nan,0,0])

    def test_large_finite_weights_do_not_overflow(self):
        out=cut_surface(self.v,[(0,1,2,3)],self.n,[{'a':1e308,'b':1e308}]*4,[])
        self.assertEqual(out['weights'][0],{'a':.5,'b':.5})

    def test_intersecting_cuts_share_the_authored_corner_and_skin_weights(self):
        out=self.cut([self.v[:,0],self.v[:,2]-.5],shape=lambda p,n:p+n*.02)
        self.assertEqual(len(out['faces']),1)
        corner=[i for i,p in enumerate(out['vertices']) if np.allclose(p,[0,-.02,.5])]
        self.assertEqual(len(corner),1)
        self.assertEqual(out['weights'][corner[0]],{'a':.5,'b':.5})
        self.assertTrue(all(p[0]>=0 and p[2]>=.5 for p in out['vertices']))


if __name__=='__main__': unittest.main()
