"""Landmark reproportioning: a smooth (thin-plate spline) warp that changes a body's proportions without ripples.

numpy only; Blender is not required. Blender frame: Z up, meters, the figure faces -Y, its left is +X.
"""
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
import numpy as np

import agent_meshes_reproportion as rp


def tube(radius=0.1, height=1.0, rings=40, segments=24, x=0.0):
    """A closed-ish vertical tube: vertices plus quad faces, for deformation tests."""
    verts, faces = [], []
    for r in range(rings + 1):
        z = height * r / rings
        for s in range(segments):
            a = 2 * np.pi * s / segments
            verts.append((x + radius * np.cos(a), radius * np.sin(a), z))
    for r in range(rings):
        for s in range(segments):
            a, b = r * segments + s, r * segments + (s + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    return np.array(verts), faces


def figure():
    """A tiny landmark set for a standing figure: 4 heads tall, legs at half height, arms hanging."""
    L = {
        'sole': ((0, 0, 0), 'leg'),
        'ankle_L': ((0.1, 0, 0.05), 'leg'), 'ankle_R': ((-0.1, 0, 0.05), 'leg'),
        'knee_L': ((0.1, 0, 0.25), 'leg'), 'knee_R': ((-0.1, 0, 0.25), 'leg'),
        'crotch': ((0, 0, 0.5), 'torso'),
        'waist': ((0, 0, 0.6), 'torso'),
        'shoulder_L': ((0.2, 0, 0.7), 'torso'), 'shoulder_R': ((-0.2, 0, 0.7), 'torso'),
        'neck': ((0, 0, 0.75), 'torso'),
        'chin': ((0, -0.05, 0.75), 'head'),
        'crown': ((0, 0, 1.0), 'head'),
        'head_back': ((0, 0.12, 0.88), 'head'),
        'elbow_L': ((0.25, 0, 0.55), 'arm_L'), 'wrist_L': ((0.27, 0, 0.42), 'arm_L'),
        'elbow_R': ((-0.25, 0, 0.55), 'arm_R'), 'wrist_R': ((-0.27, 0, 0.42), 'arm_R'),
        'thigh_out_L': ((0.17, 0, 0.38), 'leg', ('knee_L', 'crotch')),
    }
    return {k: rp.Landmark(np.array(v[0], float), v[1], v[2] if len(v) > 2 else None) for k, v in L.items()}


class Warp(unittest.TestCase):
    def test_landmarks_land_exactly_on_their_targets(self):
        src = np.random.default_rng(1).uniform(-1, 1, (12, 3))
        dst = src * 1.3 + 0.2
        out = rp.warp_points(src, dst, src)
        np.testing.assert_allclose(out, dst, atol=1e-3)

    def test_identity_targets_leave_the_mesh_alone(self):
        verts, _ = tube()
        pts = verts[::37]
        np.testing.assert_allclose(rp.warp_points(pts, pts, verts), verts, atol=1e-6)


class Ripple(unittest.TestCase):
    def test_a_smooth_warp_scores_low_and_a_banded_warp_scores_high(self):
        verts, faces = tube(rings=60)
        # Smooth: thicken the tube gradually along its height through a spline.
        src = verts[::11]
        dst = src.copy()
        dst[:, :2] *= (1 + 0.4 * src[:, 2:3])
        smooth = rp.warp_points(src, dst, verts)
        # Banded: the kind of piecewise edit that ripples (thicker only between 0.4 and 0.6, hard edges).
        banded = verts.copy()
        band = (verts[:, 2] > 0.4) & (verts[:, 2] < 0.6)
        banded[band, :2] *= 1.3
        self.assertLess(rp.ripple_score(verts, smooth, faces), 0.1)
        self.assertGreater(rp.ripple_score(verts, banded, faces), 0.2)


class Targets(unittest.TestCase):
    def test_head_count_and_leg_share_are_met(self):
        L = figure()
        T = rp.proportion_targets(L, heads=3.0, leg_share=0.40)
        height = T['crown'].p[2] - T['sole'].p[2]
        head = T['crown'].p[2] - T['chin'].p[2]
        self.assertAlmostEqual(height / head, 3.0, places=6)
        self.assertAlmostEqual((T['crotch'].p[2] - T['sole'].p[2]) / height, 0.40, places=6)
        self.assertAlmostEqual(T['sole'].p[2], 0.0)

    def test_the_head_scales_uniformly_so_its_depth_keeps_pace_with_its_height(self):
        L = figure()
        T = rp.proportion_targets(L, heads=3.0, leg_share=0.40)
        s_height = (T['crown'].p[2] - T['chin'].p[2]) / (L['crown'].p[2] - L['chin'].p[2])
        s_depth = (T['head_back'].p[1] - T['chin'].p[1]) / (L['head_back'].p[1] - L['chin'].p[1])
        self.assertAlmostEqual(s_height, s_depth, places=6)

    def test_arms_stay_attached_to_their_shoulders(self):
        L = figure()
        T = rp.proportion_targets(L, heads=3.0, leg_share=0.40, arm_scale=0.8)
        for side in 'LR':
            upper = np.linalg.norm(T[f'elbow_{side}'].p - T[f'shoulder_{side}'].p)
            self.assertAlmostEqual(upper, 0.8 * np.linalg.norm(L[f'elbow_{side}'].p - L[f'shoulder_{side}'].p), places=6)

    def test_girth_landmarks_move_out_from_their_limb_axis(self):
        L = figure()
        T = rp.proportion_targets(L, heads=4.0, leg_share=0.5, limb_thicken=1.5)
        def off(M):
            a, b = M['knee_L'].p, M['crotch'].p
            p = M['thigh_out_L'].p
            u = (b - a) / np.linalg.norm(b - a)
            return np.linalg.norm((p - a) - np.dot(p - a, u) * u)
        self.assertAlmostEqual(off(T) / off(L), 1.5, places=6)


if __name__ == '__main__':
    unittest.main()
