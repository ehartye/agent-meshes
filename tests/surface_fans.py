"""Small folded fans must not survive decimation as offset-surface defects."""
import copy
import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_surface_fans import repair_folded_fans


class FoldedFans(unittest.TestCase):
    def fixture(self,center=(.6,.6,.0001)):
        return [[0.,0,0],[1.,0,0],[0.,1,0],list(center),[0.,0,-1]],[(0,1,3),(1,2,3),(2,0,3),(1,0,4),(2,1,4),(0,2,4)]

    def test_replaces_shallow_fold_preserving_closed_oriented_boundary_and_attributes(self):
        v,f=self.fixture();before=copy.deepcopy((v,f))
        result=repair_folded_fans(v,f,max_distance=.2)
        self.assertEqual(result['removed_vertices'],[3])
        self.assertEqual(result['source_vertices'],[0,1,2,4])
        np.testing.assert_array_equal(result['vertices'],np.array(v)[[0,1,2,4]])
        self.assertEqual(len(result['faces']),4)
        edges={}
        for t in result['faces']:
            for a,b in zip(t,t[1:]+t[:1]):edges.setdefault(tuple(sorted((a,b))),[]).append((a,b))
        self.assertTrue(all(len(e)==2 and e[0]==e[1][::-1] for e in edges.values()))
        self.assertEqual((v,f),before)

    def test_preserves_ordinary_curved_fan_and_limits_large_or_steep_changes(self):
        for center,limit in [((.2,.2,.1),.2),((.6,.6,.0001),.01),((.6,.6,.7),1.)]:
            v,f=self.fixture(center);r=repair_folded_fans(v,f,max_distance=limit)
            self.assertEqual(r['removed_vertices'],[])
            np.testing.assert_array_equal(r['vertices'],v);self.assertEqual(r['faces'],f)

    def test_actual_pip_elbow_patch_and_distance_bound(self):
        v=[[-.21422754228115082,.023354971781373024,.9096195101737976],[-.2208258956670761,.019461967051029205,.9169673919677734],[-.2123110443353653,.022949712350964546,.9291293621063232],[-.2199709415435791,.020863614976406097,.9083125591278076]]
        f=[(0,1,3),(3,1,2),(3,2,0)]
        r=repair_folded_fans(v,f,max_distance=.01)
        self.assertEqual(r['removed_vertices'],[3]);self.assertEqual(r['faces'],[(0,1,2)])
        self.assertLess(r['repairs'][0]['distance'],.01)

    def test_scale_and_rigid_transform_do_not_change_selection(self):
        v,f=self.fixture();v=np.array(v)
        rotation=np.array([[0,0,1],[1,0,0],[0,1,0]])
        for scale in [.01,100.]:
            r=repair_folded_fans(v@rotation*scale+[2,3,4],f,max_distance=.2*scale)
            self.assertEqual(r['removed_vertices'],[3])

    def test_open_boundary_vertex_and_existing_replacement_face_are_not_removed(self):
        v,f=self.fixture();r=repair_folded_fans(v,f[:2],max_distance=.2)
        self.assertEqual(r['removed_vertices'],[])
        # A tetrahedron surface cannot lose one corner and leave duplicate faces.
        r=repair_folded_fans(v[:4],f[:3]+[(2,1,0)],max_distance=.2)
        self.assertEqual(r['removed_vertices'],[])

    def test_rejects_bad_parameters_and_nonmanifold_input(self):
        v,f=self.fixture()
        for limit in [0,-1,float('nan'),True]:
            with self.assertRaises(ValueError):repair_folded_fans(v,f,max_distance=limit)
        for faces in [f+[f[0]],[(0,1,9)],[(0,0,1)],[(0,1,2,3)],[(True,1,2)]]:
            with self.assertRaises(ValueError):repair_folded_fans(v,faces,max_distance=.2)
        for points in [[],[[float('nan'),0,0]],[[0,1]]]:
            with self.assertRaises(ValueError):repair_folded_fans(points,[(0,1,2)],max_distance=.2)

if __name__=='__main__':unittest.main()
