"""Curved, nonplanar mouth boundaries remain welded and follow exact motion."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
import unittest
import numpy as np
import agent_meshes_face as face


class CurvedMouth(unittest.TestCase):
    def setUp(self):
        # Nonplanar rim and outward exterior skirt. Upper/lower share corners.
        self.rim = np.array([[1, .2, 0], [.5, 0, .15], [0, -.1, .2],
                             [-.5, .05, .15], [-1, .2, 0], [0, -.08, -.1]], float)
        self.vertices = np.concatenate([self.rim, self.rim * [1.5, 1, 2]])
        self.faces = [(i, (i+1)%6, (i+1)%6+6, i+6) for i in range(6)]
        self.target = self.vertices.copy()
        self.target[5, 2] -= .3
        self.skin = dict(vertices=self.vertices.tolist(), faces=self.faces,
                         morphs={'jawOpen': self.target.tolist()})

    def test_welded_curved_boundary_and_exact_partial_motion(self):
        pocket = face.curved_mouth_pocket_geometry(
            self.skin, [0, 1, 2, 3, 4], [0, 5, 4],
            rings=[(.3, .85, .1), (.6, .7, .2)])
        ids = pocket['boundary']
        self.assertEqual(len(ids), 6)
        self.assertEqual(set(ids), set(range(6)))
        v = np.array(pocket['vertices']); target = np.array(pocket['morphs']['jawOpen'])
        np.testing.assert_array_equal(v[:6], self.vertices[ids])
        np.testing.assert_array_equal(target[:6], self.target[ids])
        for phase in [.125, .5, 1.]:
            np.testing.assert_allclose((v+(target-v)*phase)[:6],
                                       (self.vertices+(self.target-self.vertices)*phase)[ids], atol=1e-15)
        for ring in range(3):
            np.testing.assert_allclose((target-v)[ring*6:(ring+1)*6],
                                       (self.target-self.vertices)[ids], atol=1e-15)
        edges = {}
        for f in pocket['faces']:
            for a, b in zip(f, f[1:]+f[:1]):
                edges.setdefault(tuple(sorted((a,b))), []).append((a,b))
        expected = {tuple(sorted((i,(i+1)%6))) for i in range(6)}
        self.assertEqual({e for e, owners in edges.items() if len(owners)==1}, expected)
        self.assertTrue(all(len(owners)<=2 for owners in edges.values()))
        self.assertTrue(all(len(owners)==1 or owners[0]==tuple(reversed(owners[1])) for owners in edges.values()))
        self.assertEqual(len(v)-len(edges)+len(pocket['faces']), 1)
        for i, j in zip(ids, ids[1:]+ids[:1]):
            owner = next((a,b) for f in self.faces for a,b in zip(f,f[1:]+f[:1]) if {a,b}=={i,j})
            edge = (ids.index(owner[1]), ids.index(owner[0]))
            self.assertIn(edge, edges[tuple(sorted(edge))])

    def test_rejects_nonboundary_and_wrong_shared_corners(self):
        with self.assertRaises(ValueError):
            face.curved_mouth_pocket_geometry(self.skin, [0,1,2,3,4], [0,5,3], rings=[(.3,.8,.1)])
        with self.assertRaises(ValueError):
            face.curved_mouth_pocket_geometry({**self.skin, 'faces': self.faces+[(0,1,2)]},
                                             [0,1,2,3,4], [0,5,4], rings=[(.3,.8,.1)])


if __name__ == '__main__': unittest.main()
