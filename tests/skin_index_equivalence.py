# @lane merge
# @subject scripts/blender_lib/agent_meshes_face_geometry.py
"""The fast skin queries give the results of the plain forms they replaced, to the last bit; no Blender required.

`_closest_on_triangle` writes its vector arithmetic out on floats and `_SkinIndex.nearest` skips triangles by a
bounding sphere. Both are the innermost loops of every face build, and neither may change a single output coordinate:
the reference forms below are the code as it stood before, kept here as the oracle.
"""
import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
from agent_meshes_face_geometry import _SkinIndex, _add, _closest_on_triangle, _dot, _mul, _sub, ellipsoid_geometry


def reference_closest(p, a, b, c):
    ab, ac, ap = _sub(b, a), _sub(c, a), _sub(p, a)
    d1, d2 = _dot(ab, ap), _dot(ac, ap)
    if d1 <= 0 and d2 <= 0: return a, (1.0, 0.0, 0.0)
    bp = _sub(p, b)
    d3, d4 = _dot(ab, bp), _dot(ac, bp)
    if d3 >= 0 and d4 <= d3: return b, (0.0, 1.0, 0.0)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        v = d1 / (d1 - d3)
        return _add(a, _mul(ab, v)), (1 - v, v, 0.0)
    cp = _sub(p, c)
    d5, d6 = _dot(ab, cp), _dot(ac, cp)
    if d6 >= 0 and d5 <= d6: return c, (0.0, 0.0, 1.0)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        w = d2 / (d2 - d6)
        return _add(a, _mul(ac, w)), (1 - w, 0.0, w)
    va = d3 * d6 - d5 * d4
    if va <= 0 and d4 - d3 >= 0 and d5 - d6 >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return _add(b, _mul(_sub(c, b), w)), (0.0, 1 - w, w)
    denominator = 1 / (va + vb + vc)
    v, w = vb * denominator, vc * denominator
    return _add(a, _add(_mul(ab, v), _mul(ac, w))), (1 - v - w, v, w)


def reference_nearest(index, point, limit=.012):
    """The grid walk as it was: every triangle of every visited cell is measured."""
    vertices = index.vertices
    c = [math.floor(point[k] / index.cell) for k in range(3)]
    best, seen = None, set()
    for ring in range(int(limit / index.cell) + 2):
        if best is not None and best[0] <= (ring - 1) * index.cell: break
        for i in range(c[0] - ring, c[0] + ring + 1):
            for j in range(c[1] - ring, c[1] + ring + 1):
                edge = abs(i - c[0]) == ring or abs(j - c[1]) == ring
                for k in (range(c[2] - ring, c[2] + ring + 1) if edge else (c[2] - ring, c[2] + ring)):
                    for triangle in index.grid.get((i, j, k), ()):
                        if triangle in seen: continue
                        seen.add(triangle)
                        a, b, cc = (vertices[v] for v in index.triangles[triangle])
                        q, weights = reference_closest(point, a, b, cc)
                        d = math.dist(point, q)
                        if best is None or d < best[0]: best = (d, q, triangle, weights)
    if best is None or best[0] > limit: return None
    d, q, triangle, weights = best
    return (-d if _dot(_sub(point, q), index.normals[triangle]) < 0 else d), q, triangle, weights


def bits(value):
    """Exact identity, sign of zero included (0.0 == -0.0 would hide a changed operation order)."""
    if isinstance(value, float): return value.hex()
    if isinstance(value, (tuple, list)): return tuple(bits(item) for item in value)
    return value


class ClosestOnTriangle(unittest.TestCase):
    def test_every_region_matches_the_reference_bit_for_bit(self):
        rng = random.Random(20261111)
        regions = set()
        for _ in range(20000):
            scale = rng.choice((1e-4, .01, 1.0))
            a, b, c = (tuple(rng.uniform(-scale, scale) for _ in range(3)) for _ in range(3))
            # Points spread wide round the triangle reach all seven regions (three corners, three edges, the face).
            p = tuple(rng.uniform(-3 * scale, 3 * scale) for _ in range(3))
            expected, actual = reference_closest(p, a, b, c), _closest_on_triangle(p, a, b, c)
            self.assertEqual(bits(actual), bits(expected))
            regions.add(tuple(weight == 0 for weight in expected[1]))
        self.assertEqual(len(regions), 7, 'the sample reached every region of the triangle')

    def test_points_on_corners_edges_and_axis_planes_match(self):
        a, b, c = (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, -0.0)
        cases = [a, b, c, (.5, 0.0, 0.0), (0.0, .5, 0.0), (.5, .5, 0.0), (.25, .25, 0.0), (.25, .25, 1.0),
                 (-1.0, -1.0, 0.0), (2.0, -1.0, 0.0), (-1.0, 2.0, 0.0), (-0.0, -0.0, -0.0), (1.0, 1.0, -2.0)]
        for p in cases:
            self.assertEqual(bits(_closest_on_triangle(p, a, b, c)), bits(reference_closest(p, a, b, c)), p)


class SkinIndexNearest(unittest.TestCase):
    def test_the_sphere_bound_never_changes_a_hit(self):
        rng = random.Random(7)
        skin = ellipsoid_geometry((0.0, 0.0, 0.0), (.09, .11, .1), segments=40, rings=20)
        index = _SkinIndex(skin['vertices'], skin['faces'])
        self.assertEqual(len(index.centers), len(index.triangles))
        hits = misses = 0
        for _ in range(3000):
            # From deep inside to well outside the skin, so some queries stop at the first ring and some find nothing.
            direction = [rng.gauss(0, 1) for _ in range(3)]
            length = math.hypot(*direction)
            reach = rng.uniform(.6, 1.35)
            point = tuple(direction[k] / length * (.09, .11, .1)[k] * reach for k in range(3))
            for limit in (.012, .004):
                expected = reference_nearest(index, point, limit)
                self.assertEqual(bits(index.nearest(point, limit)), bits(expected))
                if expected is None: misses += 1
                else: hits += 1
        self.assertGreater(hits, 1000)
        self.assertGreater(misses, 1000)

    def test_the_bound_is_used(self):
        # The control for the test above: with the spheres made useless the query measures more triangles.
        skin = ellipsoid_geometry((0.0, 0.0, 0.0), (.09, .11, .1), segments=120, rings=60)
        index = _SkinIndex(skin['vertices'], skin['faces'])
        import agent_meshes_face_geometry as module
        original, calls = module._closest_on_triangle, [0]
        def counted(*args):
            calls[0] += 1
            return original(*args)
        module._closest_on_triangle = counted
        try:
            point = (.09 + .006, .001, .002)   # 6 mm off the skin: the walk visits several rings of cells
            index.nearest(point)
            pruned = calls[0]
            calls[0] = 0
            index.radii = [math.inf] * len(index.radii)
            index.nearest(point)
            self.assertLess(pruned, calls[0])
        finally:
            module._closest_on_triangle = original


if __name__ == '__main__':
    unittest.main()
