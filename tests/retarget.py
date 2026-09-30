"""Rigging from a reference: the numpy parts (limb cross-sections, bone distances, surface labels).

Blender is not required. Blender frame: Z up.
"""
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
import numpy as np

import agent_meshes_retarget as rt


def tube(x=0.0, radius=0.05, z0=0.0, z1=0.5, rings=30, segments=16):
    verts, faces = [], []
    for r in range(rings + 1):
        z = z0 + (z1 - z0) * r / rings
        for s in range(segments):
            a = 2 * np.pi * s / segments
            verts.append((x + radius * np.cos(a), radius * np.sin(a), z))
    for r in range(rings):
        for s in range(segments):
            a, b = r * segments + s, r * segments + (s + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    return np.array(verts), faces


def edges_of(faces):
    out = set()
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            out.add((min(a, b), max(a, b)))
    return sorted(out)


class Sections(unittest.TestCase):
    def test_ring_points_are_the_limb_extremes_at_the_asked_fraction(self):
        V, _ = tube(radius=.05)
        pts = rt.ring_points(V, (0, 0, 0), (0, 0, .5), t=.5)
        self.assertEqual(len(pts), 4)
        for p in pts:
            self.assertAlmostEqual(abs(p[2] - .25), 0, delta=.02)
            self.assertAlmostEqual(np.hypot(p[0], p[1]), .05, places=6)

    def test_a_section_ignores_a_body_beside_the_limb(self):
        limb, _ = tube(x=0.0, radius=.04)
        torso, _ = tube(x=.3, radius=.12)
        pts = rt.ring_points(np.vstack([limb, torso]), (0, 0, 0), (0, 0, .5), t=.5, radius=.1)
        self.assertTrue(all(abs(p[0]) < .05 for p in pts))

    def test_limb_rings_pair_matching_sections_on_two_meshes(self):
        a, _ = tube(radius=.04)
        b, _ = tube(radius=.08)
        J = {'hip': np.array([0, 0, .5]), 'knee': np.array([0, 0, 0])}
        src, dst = rt.limb_rings(a, b, J, J, [('hip', 'knee')])
        self.assertEqual(src.shape, dst.shape)
        self.assertEqual(len(src), 8)
        np.testing.assert_allclose(np.hypot(dst[:, 0], dst[:, 1]) / np.hypot(src[:, 0], src[:, 1]), 2.0, rtol=1e-6)


class Distances(unittest.TestCase):
    def test_segment_distance_clamps_to_the_ends(self):
        D = rt.segment_distance([(0, 1, 0), (0, 0, 2)], [(0, 0, 0)], [(0, 0, 1)])
        np.testing.assert_allclose(D[:, 0], [1.0, 1.0])


class Labels(unittest.TestCase):
    def test_region_masks_keep_trunk_weights_only_near_the_attachment(self):
        V = [(0, 0, z) for z in (0, .02, .04, .06, .08, .10)]
        edges = [(i, i + 1) for i in range(5)]
        masks = rt.region_masks(V, edges, [None, None, 0, 0, 0, 0], transition=.05)
        self.assertEqual(masks[None][0], 1)
        self.assertGreater(masks[None][2], 0)
        self.assertLess(masks[None][2], 1)
        self.assertEqual(masks[None][-1], 0, 'The middle of an arm must not follow the spine')
        self.assertEqual(masks[0][-1], 1)

    def test_region_masks_do_not_cross_a_gap_between_touching_limbs(self):
        masks = rt.region_masks([(0, 0, 0), (0, 0, .1), (.001, 0, 0), (.001, 0, .1)],
                                [(0, 1), (2, 3)], [0, 0, 1, 1], transition=.05)
        np.testing.assert_array_equal(masks[0], [1, 1, 0, 0])
        np.testing.assert_array_equal(masks[1], [0, 0, 1, 1])

    def test_labels_spread_along_the_surface_not_through_space(self):
        # Two tubes side by side, joined only at their tops by a bridge: a label seeded at the bottom of one tube
        # must not jump the small gap to the other tube's bottom.
        a, fa = tube(x=0.0, radius=.03)
        b, fb = tube(x=.07, radius=.03)
        V = np.vstack([a, b])
        n = len(a)
        edges = edges_of(fa) + [(i + n, j + n) for i, j in edges_of(fb)]
        top_a = [i for i in range(n) if a[i][2] > .49]
        top_b = [i + n for i in range(n) if b[i][2] > .49]
        edges += [(top_a[k], top_b[k]) for k in range(min(len(top_a), len(top_b)))]
        seeds = {0: 'thigh', n + len(b) - 1: 'hand'}           # thigh seed at a's bottom, hand seed at b's top
        labels = rt.surface_labels(V, edges, seeds)
        bottom_b = [i + n for i in range(n) if b[i][2] < .01]
        self.assertTrue(all(labels[i] == 'hand' for i in bottom_b))
        self.assertTrue(all(labels[i] == 'thigh' for i in range(n) if a[i][2] < .2))


if __name__ == '__main__':
    unittest.main()
