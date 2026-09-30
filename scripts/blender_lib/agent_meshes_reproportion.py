"""Reproportion a body smoothly: move named landmarks to new positions and warp every vertex through a thin-plate
spline, the smoothest deformation that hits them. Nothing is edited band by band, so nothing ripples.

numpy only; usable inside Blender authoring sources and in plain Python tests.
Blender frame: Z up, meters, the figure faces -Y, its left is +X.

Landmarks carry a group that says how proportions move them:
  'leg'    scaled vertically from the sole (shorter or longer legs)
  'torso'  shifted with the crotch, widened about the body axis
  'head'   scaled uniformly about the neck (so the skull keeps its depth as it grows)
  'arm_L' / 'arm_R'  scaled about their shoulder, which moves with the torso
An optional axis (two landmark names) marks a girth landmark: after the move, its distance from that axis is
scaled by the limb or torso thickening.
"""
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class Landmark:
    p: np.ndarray
    group: str
    axis: Optional[tuple] = None


def tps_fit(points, targets, regularize=1e-4):
    """A 3-D thin-plate spline (phi(r) = r, plus an affine part) taking `points` to `targets`."""
    P, Q = np.asarray(points, dtype=np.float64), np.asarray(targets, dtype=np.float64)
    n = len(P)
    K = np.linalg.norm(P[:, None] - P[None], axis=2) + regularize * np.eye(n)
    Pa = np.hstack([np.ones((n, 1)), P])
    A = np.zeros((n + 4, n + 4)); A[:n, :n] = K; A[:n, n:] = Pa; A[n:, :n] = Pa.T
    b = np.zeros((n + 4, 3)); b[:n] = Q
    return P, np.linalg.solve(A, b)


def tps_apply(model, points):
    P, W = model
    X = np.asarray(points, dtype=np.float64)
    out = np.empty_like(X)
    for s in range(0, len(X), 4096):
        chunk = X[s:s + 4096]
        out[s:s + 4096] = np.linalg.norm(chunk[:, None] - P[None], axis=2) @ W[:len(P)] + np.hstack([np.ones((len(chunk), 1)), chunk]) @ W[len(P):]
    return out


def warp_points(sources, targets, points, regularize=1e-6):
    """Move `points` by the thin-plate spline that takes `sources` to `targets`."""
    return tps_apply(tps_fit(sources, targets, regularize), points)


def reproportion(vertices, source, target, regularize=1e-6):
    """Warp `vertices` so the landmarks in `source` land on `target` (dicts name -> Landmark; shared names only)."""
    names = [n for n in source if n in target]
    return warp_points([source[n].p for n in names], [target[n].p for n in names], vertices, regularize)


def _neighbours(faces, count):
    nb = [set() for _ in range(count)]
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            nb[a].add(b); nb[b].add(a)
    return [sorted(s) for s in nb]


def ripple_score(before, after, faces, percentile=99.0):
    """How unevenly a mesh was moved: the displacement's Laplacian relative to the local displacement.

    A smooth warp moves each vertex almost like the average of its neighbours (small score); a banded edit moves one
    ring and not the next (a score approaching 0.5 or more). Returns the given percentile over vertices.
    """
    B, A = np.asarray(before, float), np.asarray(after, float)
    D = A - B
    mag = np.linalg.norm(D, axis=1)
    floor = 0.05 * (mag.max() + 1e-12)
    nb = _neighbours(faces, len(B))
    scores = np.zeros(len(B))
    for i, n in enumerate(nb):
        if not n:
            continue
        lap = D[i] - D[n].mean(0)
        local = max(mag[i], mag[n].max()) + floor
        scores[i] = np.linalg.norm(lap) / local
    return float(np.percentile(scores, percentile))


def _perp_offset(p, a, b):
    u = (b - a) / np.linalg.norm(b - a)
    t = np.dot(p - a, u)
    return t / np.linalg.norm(b - a), (p - a) - t * u


def proportion_targets(source, heads, leg_share, arm_scale=1.0, torso_widen=1.0, limb_thicken=1.0):
    """Target landmarks for a body `heads` tall (height / (crown - chin)) with the crotch at `leg_share` of height.

    Needs landmarks named sole, crotch, neck, chin and crown; arm groups need shoulder_L / shoulder_R. The torso
    (crotch to neck) keeps its length; the legs and the head scale to meet both proportions.
    """
    z = lambda name: float(source[name].p[2])
    z0, zc, zn, zch, zt = z('sole'), z('crotch'), z('neck'), z('chin'), z('crown')
    head_unit = zt - zch
    total = (zn - zc) / (1 - leg_share - (zt - zn) / (heads * head_unit))
    head_s = total / (heads * head_unit)
    leg_s = leg_share * total / (zc - z0)
    axis_x, axis_y = float(source['crotch'].p[0]), float(source['crotch'].p[1])

    def torso(p):
        q = p.copy()
        q[2] = z0 + (zc - z0) * leg_s + (p[2] - zc)
        q[0] = axis_x + (p[0] - axis_x) * torso_widen
        q[1] = axis_y + (p[1] - axis_y) * torso_widen
        return q

    neck2 = torso(source['neck'].p)

    def move(name, lm):
        p = lm.p.astype(float)
        if lm.group == 'leg':
            q = p.copy(); q[2] = z0 + (p[2] - z0) * leg_s
            return q
        if lm.group == 'torso':
            return torso(p)
        if lm.group == 'head':
            return neck2 + (p - source['neck'].p) * head_s
        if lm.group in ('arm_L', 'arm_R'):
            shoulder = source['shoulder_' + lm.group[-1]].p
            return torso(shoulder) + (p - shoulder) * arm_scale
        raise ValueError(f'unknown landmark group {lm.group!r} on {name}')

    moved = {n: Landmark(move(n, lm), lm.group, lm.axis) for n, lm in source.items()}
    for name, lm in source.items():
        if not lm.axis:
            continue
        a, b = (source[n].p.astype(float) for n in lm.axis)
        a2, b2 = (moved[n].p for n in lm.axis)
        t, perp = _perp_offset(lm.p.astype(float), a, b)
        u2 = (b2 - a2) / np.linalg.norm(b2 - a2)
        new_perp = perp - np.dot(perp, u2) * u2
        norm = np.linalg.norm(new_perp)
        factor = torso_widen if lm.group == 'torso' else limb_thicken
        if norm > 1e-12:
            new_perp *= np.linalg.norm(perp) * factor / norm
        moved[name] = Landmark(a2 + t * (b2 - a2) + new_perp, lm.group, lm.axis)
    return moved


def _rotation_between(u, v):
    """The minimal rotation matrix taking unit vector u to unit vector v."""
    u, v = u / np.linalg.norm(u), v / np.linalg.norm(v)
    c = float(np.dot(u, v))
    axis = np.cross(u, v)
    s = np.linalg.norm(axis)
    if s < 1e-12:
        if c > 0:
            return np.eye(3)
        ortho = np.array([1.0, 0, 0]) if abs(u[0]) < 0.9 else np.array([0, 1.0, 0])
        axis = np.cross(u, ortho); axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    k = axis / s
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


def pose_segments(landmarks, joints, segments):
    """Repose a landmark set: move `joints` (name -> position) and carry each segment's member landmarks along.

    segments: (start_joint, end_joint, [member names]). A member keeps its place along the segment and its offset
    from it, rotated with the segment and scaled by the segment's length change. Joints not listed stay put;
    landmarks outside every segment are unchanged.
    """
    out = {n: Landmark(lm.p.astype(float).copy(), lm.group, lm.axis) for n, lm in landmarks.items()}
    for n, p in joints.items():
        out[n].p = np.asarray(p, float)
    for a, b, members in segments:
        A, B = landmarks[a].p.astype(float), landmarks[b].p.astype(float)
        A2, B2 = out[a].p, out[b].p
        R = _rotation_between(B - A, B2 - A2)
        ratio = np.linalg.norm(B2 - A2) / np.linalg.norm(B - A)
        for m in members:
            out[m].p = A2 + R @ ((landmarks[m].p.astype(float) - A) * ratio)
    return out
