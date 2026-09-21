"""Pure-Python authoring geometry checks; Blender is not required."""
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
from agent_meshes_author import fuse_meshes, sweep_mesh, topology_report


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


class TopologyTests(unittest.TestCase):
    tetra_vertices = [(0,0,0), (1,0,0), (0,1,0), (0,0,1)]
    tetra_faces = [(0,2,1), (0,1,3), (1,2,3), (2,0,3)]

    def test_closed_connected_and_disconnected_surfaces(self):
        self.assertEqual(topology_report(self.tetra_vertices, self.tetra_faces),
                         {'components': 1, 'boundary_edges': 0, 'nonmanifold_edges': 0})
        vertices = self.tetra_vertices + [(x+3,y,z) for x,y,z in self.tetra_vertices]
        faces = self.tetra_faces + [tuple(i+4 for i in face) for face in self.tetra_faces]
        self.assertEqual(topology_report(vertices, faces),
                         {'components': 2, 'boundary_edges': 0, 'nonmanifold_edges': 0})

    def test_boundary_and_overused_edges_are_counted_separately(self):
        self.assertEqual(topology_report(self.tetra_vertices, [(0,1,2,3)]),
                         {'components': 1, 'boundary_edges': 4, 'nonmanifold_edges': 0})
        vertices = self.tetra_vertices + [(0,-1,0)]
        self.assertEqual(topology_report(vertices, [(0,1,2), (1,0,3), (0,1,4)]),
                         {'components': 1, 'boundary_edges': 6, 'nonmanifold_edges': 1})

    def test_isolated_vertices_count_and_empty_mesh_is_not_a_surface(self):
        self.assertEqual(topology_report(self.tetra_vertices + [(4,4,4)], self.tetra_faces)['components'], 2)
        self.assertEqual(topology_report([], []), {'components': 0, 'boundary_edges': 0, 'nonmanifold_edges': 0})

    def test_rejects_malformed_geometry(self):
        for faces in [[(0,1)], [(0,1,1)], [(0,1,4)], [(0,1,-1)], [(0,1,True)], [(0,1,2.0)]]:
            with self.subTest(faces=faces), self.assertRaises(ValueError):
                topology_report(self.tetra_vertices, faces)
        with self.assertRaises(ValueError):
            topology_report([(float('nan'),0,0)], [])

    def test_fusion_parameters_reject_before_requiring_blender(self):
        for arguments in [
            dict(voxel_size=0), dict(voxel_size=-.1), dict(voxel_size=float('nan')), dict(voxel_size=float('inf')),
            dict(smooth_passes=-1), dict(smooth_passes=51), dict(smooth_passes=1.5), dict(smooth_passes=True),
            dict(expected_components=0), dict(expected_components=257), dict(expected_components=1.5), dict(expected_components=True),
            dict(objects=[]), dict(objects=[object()]*257), dict(name=''),
        ]:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                fuse_meshes(**(dict(objects=[object()], name='Form', voxel_size=.1) | arguments))


if __name__ == '__main__':
    unittest.main()
