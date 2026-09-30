"""Shared cut boundaries remain coincident under arbitrary affine bone motion."""
from pathlib import Path
import sys,unittest,copy
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))
from agent_meshes_garment_partition import partition_surface

class SharedCuts(unittest.TestCase):
    def setUp(self):
        self.v=np.array([[-1,0,0],[1,0,0],[1,0,1],[-1,0,1]],float)
        self.f=[(0,1,2),(0,2,3)];self.n=np.tile([0,-1,0],(4,1))
        self.w=[{'a':1},{'b':1},{'b':1},{'a':1}]
    def split(self,fields,**options):
        return partition_surface(self.v,self.f,self.n,self.w,fields,**options)
    def area(self,result):
        v=result['vertices']
        return sum(np.linalg.norm(np.cross(v[b]-v[a],v[c]-v[a]))/2 for a,b,c in result['faces'])
    def test_whole_donor_surface_is_retained_and_shared_vertices_follow_bones(self):
        p=self.split([self.v[:,0]-.2,self.v[:,2]-.15]);source=p['source'];cut=p['garment']
        self.assertAlmostEqual(self.area(source),2);self.assertAlmostEqual(self.area(cut),.8*.85)
        np.testing.assert_array_equal(source['vertices'][:4],self.v)
        self.assertEqual(source['weights'][:4],self.w)
        for t in np.linspace(-1,1,13):
            M={'a':np.eye(4),'b':np.array([[np.cos(t),-np.sin(t),0,.2*t],[np.sin(t),np.cos(t),0,0],[0,0,1,.1*t],[0,0,0,1]])}
            def skin(obj):return np.array([sum((w*(M[n]@np.r_[v,1])[:3] for n,w in row.items()),np.zeros(3)) for v,row in zip(obj['vertices'],obj['weights'])])
            np.testing.assert_allclose(skin(cut),skin(source)[cut['source_vertices']],atol=1e-14)
        self.assertTrue(all(face in source['faces'] for face in [tuple(cut['source_vertices'][i] for i in f) for f in cut['faces']]))
    def test_multifield_split_has_no_t_junctions_or_flipped_faces(self):
        s=self.split([self.v[:,0],self.v[:,2]-.3,self.v[:,0]+self.v[:,2]-.4])['source']
        vertices=s['vertices'];edges={}
        for face in s['faces']:
            a,b,c=vertices[list(face)];self.assertLess(np.cross(b-a,c-a)[1],0)
            for a,b in zip(face,face[1:]+face[:1]):edges.setdefault(tuple(sorted((a,b))),[]).append((a,b))
        for (a,b),uses in edges.items():
            boundary=(abs(vertices[a,0])==1 and vertices[a,0]==vertices[b,0]) or (vertices[a,2] in (0,1) and vertices[a,2]==vertices[b,2])
            self.assertEqual(len(uses),1 if boundary else 2)
            if not boundary:self.assertEqual(uses[0],tuple(reversed(uses[1])))
    def test_provenance_reconstructs_positions_and_maps_original_faces(self):
        s=self.split([self.v[:,0]-.2])['source']
        for point,weights in zip(s['vertices'],s['provenance']):
            np.testing.assert_allclose(point,sum((self.v[i]*t for i,t in weights.items()),np.zeros(3)),atol=1e-14)
        self.assertEqual(set(s['source_faces']),{0,1})
    def test_empty_full_and_zero_fields(self):
        for fields,count in [([np.ones(4)],2),([np.zeros(4)],2),([-np.ones(4)],0),([],2)]:
            p=self.split(fields);self.assertEqual(len(p['garment']['faces']),count);self.assertAlmostEqual(self.area(p['source']),2)
    def test_inputs_immutable_and_coincident_seams_distinct(self):
        v=np.r_[self.v,self.v];n=np.r_[self.n,self.n];w=self.w+[{'c':1}]*4;f=self.f+[tuple(i+4 for i in face) for face in self.f]
        before=copy.deepcopy((v,n,w,f));p=partition_surface(v,f,n,w,[v[:,0]])
        self.assertEqual(p['source']['weights'][4],{'c':1})
        self.assertEqual(len(p['garment']['vertices']),2*len(self.split([self.v[:,0]])['garment']['vertices']))
        np.testing.assert_array_equal(v,before[0]);np.testing.assert_array_equal(n,before[1]);self.assertEqual((w,f),(before[2],before[3]))
    def test_largest_keeps_donor_complete(self):
        v=np.r_[self.v,self.v*.2+[3,0,0]];n=np.r_[self.n,self.n];f=self.f+[tuple(i+4 for i in face) for face in self.f]
        p=partition_surface(v,f,n,self.w*2,[],component='largest')
        self.assertAlmostEqual(self.area(p['source']),2.08);self.assertAlmostEqual(self.area(p['garment']),2)
    def test_invalid_input_rejects(self):
        for faces in [[(0,1,2,3)],[(0,1,1)],[(0,1,20)],[(True,1,2)]]:
            with self.assertRaises(ValueError):partition_surface(self.v,faces,self.n,self.w,[])
        with self.assertRaises(ValueError):self.split([[1,2]])
        with self.assertRaises(ValueError):self.split([[]])
        with self.assertRaises(ValueError):self.split([],component='random')
    def test_rounding_boundary_does_not_split_shared_edge(self):
        v=np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],float)
        p=partition_surface(v,self.f,np.tile([0,0,1],(4,1)),self.w,[v[:,0]-.1234567890125])
        self.assertAlmostEqual(self.area(p['source']),1)
        self.assertAlmostEqual(self.area(p['garment']),1-.1234567890125)
        s=p['source'];edges={}
        for face in s['faces']:
            for a,b in zip(face,face[1:]+face[:1]):edges.setdefault(tuple(sorted((a,b))),[]).append((a,b))
        for (a,b),uses in edges.items():
            boundary=any(s['vertices'][a,k] in (0,1) and s['vertices'][a,k]==s['vertices'][b,k] for k in (0,1))
            self.assertEqual(len(uses),1 if boundary else 2)
            if not boundary:self.assertEqual(uses[0],tuple(reversed(uses[1])))
    def test_large_finite_field_values_preserve_cut(self):
        p=self.split([[1e308,-1e308,-1e308,1e308]])
        self.assertAlmostEqual(self.area(p['garment']),1)
    def test_near_coincident_fields_never_return_cracked_source(self):
        rng=np.random.default_rng(769);a=rng.normal(size=4);b=rng.normal(size=4)
        p=self.split([a,a+1e-13*b,b])
        self.assertAlmostEqual(self.area(p['source']),2)

if __name__=='__main__':unittest.main()
