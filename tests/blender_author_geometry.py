"""Pure-Python authoring geometry checks; Blender is not required."""
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
from agent_meshes_author import sweep_mesh


class SweepGeometryTests(unittest.TestCase):
    def test_curved_variable_sections_are_closed_and_outward(self):
        centers = [(.2 * math.sin(i / 12), 0, i / 6) for i in range(13)]
        radii = [(.2 + .04 * math.sin(i), .1) for i in range(13)]
        vertices, faces = sweep_mesh(centers, radii, 16, twist=[i*.03 for i in range(13)])
        edges, volume = {}, 0
        for face in faces:
            for a, b in zip(face, face[1:] + face[:1]):
                edges.setdefault(tuple(sorted((a, b))), []).append((a, b))
            a = vertices[face[0]]
            for i in range(1, len(face)-1):
                b, c = vertices[face[i]], vertices[face[i+1]]
                volume += sum(a[k]*(b[(k+1)%3]*c[(k+2)%3]-b[(k+2)%3]*c[(k+1)%3]) for k in range(3))/6
        self.assertTrue(all(len(e) == 2 and e[0] == e[1][::-1] for e in edges.values()))
        self.assertEqual(len(vertices)-len(edges)+len(faces), 2)
        self.assertGreater(volume, 0)

    def test_transport_does_not_flip_when_curve_crosses_an_axis(self):
        centers = [(math.sin(t), 0, math.cos(t)) for t in [i*.08 for i in range(30)]]
        vertices, _ = sweep_mesh(centers, [(.1,.05)]*30, 12)
        previous = None
        for i, center in enumerate(centers):
            offset = tuple(vertices[i*12][k]-center[k] for k in range(3))
            if previous:
                self.assertGreater(sum(a*b for a,b in zip(previous,offset)), 0)
            self.assertAlmostEqual(math.hypot(*offset), .1)
            previous = offset

    def test_seed_twist_and_radii_define_expected_sections(self):
        vertices, _ = sweep_mesh([(0,0,0),(0,0,1)],[(.2,.1),(.4,.3)],8,
                                  twist=[0,math.pi/2],initial_normal=(1,0,0))
        self.assertEqual(vertices[0],(.2,0,0))
        self.assertAlmostEqual(vertices[2][1],.1)
        self.assertAlmostEqual(vertices[8][0],0)
        self.assertAlmostEqual(vertices[8][1],.4)
        self.assertAlmostEqual(vertices[8][2],1)

    def test_parameter_changes_keep_topology_and_explicit_frame_orientation(self):
        first, faces = sweep_mesh([(0,0,0),(0,0,1),(0,0,2)],[(.2,.1)]*3,12,initial_normal=(0,1,0))
        second, other_faces = sweep_mesh([(0,0,0),(.1,0,1),(.4,0,3)],[(.2,.1),(.3,.2),(.05,.03)],12,initial_normal=(0,1,0))
        self.assertEqual(faces,other_faces)
        self.assertEqual(len(first),len(second))
        self.assertEqual(first[0],second[0])

    def test_rejects_invalid_input_before_generating_geometry(self):
        valid_centers, valid_radii = [(0,0,0),(0,0,1)],[(1,1),(1,1)]
        cases = [
            dict(centers=[]),dict(centers=[(0,0,0)]),dict(centers=[(0,0),(0,0,1)]),
            dict(centers=[(0,0,0),(0,0,float('nan'))]),dict(centers=[(0,0,0),(0,0,float('inf'))]),
            dict(centers=[(0,0,0),(0,0,0)]),dict(centers=[(0,0,0),(0,0,1),(0,0,0)],radii=[(1,1)]*3),
            dict(radii=[(1,1)]),dict(radii=[(0,1),(1,1)]),dict(radii=[(-1,1),(1,1)]),
            dict(radii=[(1,float('nan')),(1,1)]),dict(radii=[(1,1,1),(1,1)]),
            dict(radial_segments=2),dict(radial_segments=3.5),dict(radial_segments=True),
            dict(twist=[0]),dict(twist=[0,float('inf')]),
            dict(initial_normal=(0,0,0)),dict(initial_normal=(0,0,1)),dict(initial_normal=(0,float('nan'),0)),
        ]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                sweep_mesh(**dict(centers=valid_centers,radii=valid_radii,**{}) | changes)


if __name__ == '__main__':
    unittest.main()
