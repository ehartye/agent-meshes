import sys,unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_skin_relax import relax_weights

class SkinRelax(unittest.TestCase):
    def test_relaxes_gradient_with_fixed_ends_and_normalized_weights(self):
        vertices=[[x,y,0] for x in [0,.01,.02,.03,.04] for y in [0,.01]]
        faces=[(2*i,2*i+1,2*i+3,2*i+2) for i in range(4)]
        weights=[{'body':1} if i<2 else {'arm':1} for i in range(10)]
        free=[False,False,True,True,True,True,True,True,False,False]
        out=relax_weights(vertices,faces,weights,free,iterations=150)
        self.assertEqual(out[0],weights[0]);self.assertEqual(out[-1],weights[-1])
        self.assertAlmostEqual(out[4]['arm'],.5,places=4)
        for row in out:self.assertAlmostEqual(sum(row.values()),1)
        self.assertLess(max(abs(out[i].get('arm',0)-out[i+2].get('arm',0)) for i in range(8)),.251)
    def test_short_edges_limit_weight_jumps_in_physical_space(self):
        xs=[0,.001,.01,.02,.03]
        vertices=[[x,y,0] for x in xs for y in [0,.01]]
        faces=[(2*i,2*i+1,2*i+3,2*i+2) for i in range(4)]
        rows=[{'a':1}]*2+[{'b':1}]*8
        free=[False,False]+[True]*6+[False,False]
        out=relax_weights(vertices,faces,rows,free,iterations=600)
        for i,x in enumerate(xs):self.assertAlmostEqual(out[2*i].get('b',0),x/.03,places=5)

    def test_nearby_disconnected_surfaces_do_not_exchange_weights(self):
        v=[[0,0,0],[1,0,0],[0,1,0],[0,0,.001],[1,0,.001],[0,1,.001]]
        w=[{'left':1}]*3+[{'right':1}]*3
        self.assertEqual(relax_weights(v,[(0,1,2),(3,4,5)],w,[True]*6),w)
    def test_unconnected_vertices_keep_normalized_weights(self):
        out=relax_weights([[0,0,0],[1,0,0]],[],[{'a':2,'b':2},{'a':1e308,'b':1e308}],[True,False])
        self.assertEqual(out,[{'a':.5,'b':.5}]*2)

    def test_influence_budget_remains_normalized(self):
        rows=[{'a':.4,'b':.3,'c':.2,'d':.07,'e':.03}]*3
        out=relax_weights([[0,0,0],[1,0,0],[0,1,0]],[(0,1,2)],rows,[True]*3,max_influences=2)
        for row in out:
            self.assertEqual(set(row),{'a','b'})
            self.assertAlmostEqual(sum(row.values()),1)
            self.assertAlmostEqual(row['a']/row['b'],4/3)

    def test_rejects_invalid_geometry_or_mask(self):
        with self.assertRaises(ValueError):relax_weights([[0,0,0]],[],[{'a':1}],[])
        with self.assertRaises(ValueError):relax_weights([[0,float('nan'),0]],[],[{'a':1}],[True])
        with self.assertRaises(ValueError):relax_weights([[0,0,0]],[(0,1,2)],[{'a':1}],[True])
if __name__=='__main__':unittest.main()
