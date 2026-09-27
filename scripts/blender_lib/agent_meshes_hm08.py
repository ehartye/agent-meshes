"""MakeHuman hm08 heads as plain data: the CC0 base mesh's head, its targets, a stylize target, and the geometry tools
that fit and measure heads (front depth maps, facial landmarks, thin-plate warps, closest-point projection).

Everything here is numpy (Blender carries it); nothing needs Blender. The vendored data (`data/hm08/hm08_head.npz`,
rebuilt from pinned CC0 sources by `scripts/hm08-vendor.py`) keeps the hm08 body mesh's head and upper neck, its helper
geometry there (eyes, teeth, tongue, lashes), the joint helpers' centers, the mirror table and every vendored target
restricted to those vertices. No MakeHuman or MPFB program code is used.

Two frames: the data's own (MakeHuman: decimeters, Y up, the face looks down +Z) and Blender's (meters, Z up, the
face looks down -Y); `to_blender` maps points, `delta_to_blender` deltas. The character's left is +X in both.
"""
from functools import lru_cache
import math
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / 'data' / 'hm08'
KINDS = ('body', 'helper-l-eye', 'helper-r-eye', 'helper-upper-teeth', 'helper-lower-teeth', 'helper-tongue',
         'helper-l-eyelashes-1', 'helper-l-eyelashes-2', 'helper-r-eyelashes-1', 'helper-r-eyelashes-2')
RACES = ('african', 'asian', 'caucasian')
# MakeHuman's age slider: 0 is 1 year, 0.1875 is 11 years, 0.5 is 25 years, 1 is 90 years.
AGE_KEYS = ((0.0, 'baby'), (0.1875, 'child'), (0.5, 'young'))


# ---------------------------------------------------------------- data

class Hm08Head:
    """The vendored head: `rest` (N, 3) in MakeHuman units, quad `faces` (-1 pads triangles), each face's `kind`
    (an index into KINDS), the `mirror` partner of each vertex (-1 when none), `joints` by name, and `targets`:
    name -> (vertex indices, (k, 3) float deltas in MakeHuman units)."""

    def __init__(self, path=None):
        data = np.load(path or DATA / 'hm08_head.npz')
        self.rest = data['rest'].astype(np.float64)
        self.index = data['index']
        self.faces = data['faces']
        self.face_kind = data['face_kind']
        kinds = [str(k) for k in data['kind_names']]
        if tuple(kinds) != KINDS: raise ValueError(f'hm08_head.npz kinds {kinds} are not {KINDS}')
        self.mirror = data['mirror']
        self.joints = {str(n): data['joints'][i].astype(np.float64) for i, n in enumerate(data['joint_names'])}
        self.targets = {}
        for name in data['target_names']:
            name = str(name)
            self.targets[name] = (data[f't:{name}:i'].astype(np.int64), data[f't:{name}:d'].astype(np.float64) / 1000)
        self.local = {int(g): i for i, g in enumerate(self.index)}

    def kind_faces(self, kind):
        return self.faces[self.face_kind == KINDS.index(kind)]

    def kind_vertices(self, kind):
        f = self.kind_faces(kind)
        return np.unique(f[f >= 0])

    def dense(self, name, weight=1.0):
        """A target's deltas for every vertex (zeros where it does not move)."""
        out = np.zeros_like(self.rest)
        if weight == 0: return out
        index, delta = self.targets[name]
        out[index] = weight * delta
        return out

    def compose(self, weights):
        """The rest shape plus each named target at its weight."""
        out = self.rest.copy()
        for name, weight in weights.items():
            if name not in self.targets: raise ValueError(f'Unknown hm08 target {name}')
            if weight:
                index, delta = self.targets[name]
                out[index] += weight * delta
        return out


@lru_cache(maxsize=2)
def load_head(path=None):
    return Hm08Head(path)


def to_blender(points):
    """MakeHuman decimeters (Y up, face +Z) to Blender meters (Z up, face -Y)."""
    p = np.asarray(points, dtype=np.float64)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], axis=-1) * .1


def from_blender(points):
    p = np.asarray(points, dtype=np.float64)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], axis=-1) * 10


delta_to_blender = to_blender


def age_parameter(years):
    """MakeHuman's age slider value for an age in years (1 to 90)."""
    years = min(90.0, max(1.0, float(years)))
    if years < 11: return .1875 * (years - 1) / 10
    if years < 25: return .1875 + (.5 - .1875) * (years - 11) / 14
    return .5 + .5 * (years - 25) / 65


def macro_weights(years, gender, races=None):
    """The race-gender-age macro targets and their weights for an age in years and a gender (0 female, 1 male).

    Only the baby, child and young keys are vendored, so ages past 25 use the young shape."""
    if not 0 <= gender <= 1: raise ValueError('gender must be in 0..1 (0 female, 1 male)')
    races = races or {race: 1 / 3 for race in RACES}
    a = min(age_parameter(years), .5)
    ages = {}
    for (a0, k0), (a1, k1) in zip(AGE_KEYS, AGE_KEYS[1:]):
        if a0 <= a <= a1:
            t = (a - a0) / (a1 - a0)
            ages = {k0: 1 - t, k1: t}
            break
    weights = {}
    for race, rw in races.items():
        for sex, sw in (('female', 1 - gender), ('male', gender)):
            for age, aw in ages.items():
                w = rw * sw * aw
                if w > 1e-9: weights[f'macrodetails/{race}-{sex}-{age}'] = w
    return weights


def read_target(path, head=None):
    """A MakeHuman .target file (lines `index dx dy dz`, # comments) as (local indices, deltas) on the vendored head."""
    head = head or load_head()
    index, delta = [], []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        parts = line.split()
        if len(parts) != 4 or line.lstrip().startswith('#'): continue
        g = int(parts[0])
        if g not in head.local: raise ValueError(f'{path}: vertex {g} is outside the vendored head')
        index.append(head.local[g]); delta.append([float(v) for v in parts[1:]])
    return np.array(index, dtype=np.int64), np.array(delta, dtype=np.float64).reshape(-1, 3)


def write_target(path, head, deltas, header=()):
    """Write dense deltas (MakeHuman units) as a .target file, dropping vertices that move under 0.05 thousandths."""
    lines = [f'# {line}' for line in header]
    for i, d in enumerate(np.round(np.asarray(deltas), 3)):
        if np.abs(d).max() < 5e-4: continue
        lines.append(f'{int(head.index[i])} ' + ' '.join(_number(v) for v in d))
    Path(path).write_text('\n'.join(lines) + '\n', encoding='utf-8')


def _number(v):
    text = f'{v:.3f}'.rstrip('0').rstrip('.')
    text = text.replace('0.', '.', 1) if text.startswith('0.') else text.replace('-0.', '-.', 1)
    return '0' if text in ('', '-0', '-') else text


# ---------------------------------------------------------------- geometry

def triangles(faces):
    """Quads (-1 padded) as triangles."""
    f = np.asarray(faces)
    quads = f[:, 3] >= 0 if f.shape[1] > 3 else np.zeros(len(f), dtype=bool)
    return np.concatenate([f[:, [0, 1, 2]], f[quads][:, [0, 2, 3]]])


def edges_of(faces):
    pairs = set()
    for face in np.asarray(faces):
        face = [int(i) for i in face if i >= 0]
        for a, b in zip(face, face[1:] + face[:1]): pairs.add((min(a, b), max(a, b)))
    return np.array(sorted(pairs), dtype=np.int64)


def vertex_normals(vertices, faces):
    T = triangles(faces)
    n = np.cross(vertices[T[:, 1]] - vertices[T[:, 0]], vertices[T[:, 2]] - vertices[T[:, 0]])
    out = np.zeros_like(vertices)
    for j in range(3): np.add.at(out, T[:, j], n)
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


def depth_map(vertices, faces, box, pixel):
    """The nearest surface's y (Blender: the front is -y) per pixel of a front view over box (x0, x1, z0, z1)."""
    x0, x1, z0, z1 = box
    W, H = int((x1 - x0) / pixel) + 1, int((z1 - z0) / pixel) + 1
    D = np.full((H, W), np.inf)
    T = triangles(faces)
    for a, b, c in zip(vertices[T[:, 0]], vertices[T[:, 1]], vertices[T[:, 2]]):
        i0 = max(0, int((min(a[0], b[0], c[0]) - x0) / pixel)); i1 = min(W - 1, int((max(a[0], b[0], c[0]) - x0) / pixel) + 1)
        j0 = max(0, int((min(a[2], b[2], c[2]) - z0) / pixel)); j1 = min(H - 1, int((max(a[2], b[2], c[2]) - z0) / pixel) + 1)
        if i1 < i0 or j1 < j0: continue
        det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
        if abs(det) < 1e-14: continue
        gx, gz = np.meshgrid(x0 + pixel * np.arange(i0, i1 + 1), z0 + pixel * np.arange(j0, j1 + 1))
        l1 = ((b[2] - c[2]) * (gx - c[0]) + (c[0] - b[0]) * (gz - c[2])) / det
        l2 = ((c[2] - a[2]) * (gx - c[0]) + (a[0] - c[0]) * (gz - c[2])) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        sub = D[j0:j1 + 1, i0:i1 + 1]
        np.minimum(sub, np.where(inside, l1 * a[1] + l2 * b[1] + l3 * c[1], np.inf), out=sub)
    return D


def flood(mask, seed):
    """The 4-connected region of `mask` holding `seed` (row, column)."""
    out = np.zeros_like(mask, dtype=bool)
    if not mask[seed]: return out
    stack, (H, W) = [seed], mask.shape
    while stack:
        j, i = stack.pop()
        if out[j, i] or not mask[j, i]: continue
        out[j, i] = True
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = j + dj, i + di
            if 0 <= a < H and 0 <= b < W and mask[a, b] and not out[a, b]: stack.append((a, b))
    return out


def _smooth1(values, n):
    kernel = np.ones(n) / n
    padded = np.pad(values, (n // 2, n - 1 - n // 2), mode='edge')
    return np.convolve(padded, kernel, 'valid')


def similarity(source, target):
    """Scale s and translation t (no rotation) such that s * source + t fits target in least squares."""
    source, target = np.asarray(source), np.asarray(target)
    cs, ct = source.mean(0), target.mean(0)
    a, b = source - cs, target - ct
    s = (a * b).sum() / (a * a).sum()
    return s, ct - s * cs


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


def closest_points(points, vertices, faces, k=6):
    """The closest point on a mesh to each point (among the triangles round its k nearest vertices), its distance
    and triangle (an index into triangles(faces))."""
    X, V, T = np.asarray(points, dtype=np.float64), np.asarray(vertices, dtype=np.float64), triangles(faces)
    around = [[] for _ in range(len(V))]
    for t, tri in enumerate(T):
        for i in tri: around[int(i)].append(t)
    width = max(len(a) for a in around if a) * k
    cand = np.zeros((len(X), width), dtype=np.int64)
    for s in range(0, len(X), 512):
        d = np.linalg.norm(X[s:s + 512, None] - V[None], axis=2)
        near = np.argsort(d, axis=1)[:, :k]
        for r, row in enumerate(near):
            ids = [t for i in row for t in around[int(i)]] or [0]
            cand[s + r] = (ids * (width // len(ids) + 1))[:width]
    a, b, c = V[T[cand, 0]], V[T[cand, 1]], V[T[cand, 2]]
    p = X[:, None, :]
    ab, ac, ap = b - a, c - a, p - a
    d00, d01, d11 = (ab * ab).sum(-1), (ab * ac).sum(-1), (ac * ac).sum(-1)
    d20, d21 = (ap * ab).sum(-1), (ap * ac).sum(-1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-20, 1e-20, den)
    v, w = np.clip((d11 * d20 - d01 * d21) / den, 0, 1), np.clip((d00 * d21 - d01 * d20) / den, 0, 1)
    total = v + w
    over = total > 1
    v, w = np.where(over, v / np.maximum(total, 1e-12), v), np.where(over, w / np.maximum(total, 1e-12), w)
    q = a + v[..., None] * ab + w[..., None] * ac
    dist = np.linalg.norm(q - p, axis=-1)
    best = np.argmin(dist, axis=1)
    rows = np.arange(len(X))
    return q[rows, best], dist[rows, best], cand[rows, best]


def relax_field(values, weights, edges, count, strength=.6, iterations=400):
    """A smooth per-vertex field that follows `values` where `weights` are high and is relaxed along the mesh's
    edges elsewhere (a screened Laplacian, solved by Jacobi steps)."""
    values, weights = np.asarray(values, dtype=np.float64), np.asarray(weights, dtype=np.float64)[:, None]
    degree = np.bincount(edges.ravel(), minlength=count).astype(np.float64)[:, None]
    field = values * weights
    for _ in range(iterations):
        around = np.zeros_like(field)
        np.add.at(around, edges[:, 0], field[edges[:, 1]]); np.add.at(around, edges[:, 1], field[edges[:, 0]])
        field = (weights * values + strength * around) / np.maximum(weights + strength * degree, 1e-12)
    return field


# ---------------------------------------------------------------- landmarks (Blender frame: Z up, the face looks down -Y)

def eye_landmarks(vertices, faces, eyes, pixel=.00025):
    """The lid margin's corners and its top and bottom at the middle and a quarter and three quarters across, for each
    eye: where the eyeball shows past the skin in a front view. `eyes` is [(center, radius, eyeball vertices,
    eyeball faces)] for the left then the right eye."""
    out = {}
    for side, (E, r, EV, EF) in zip('LR', eyes):
        box = (E[0] - 2 * r, E[0] + 2 * r, E[2] - 1.5 * r, E[2] + 1.5 * r)
        skin, ball = depth_map(vertices, faces, box, pixel), depth_map(EV, EF, box, pixel)
        visible = np.isfinite(ball) & (ball < skin - 1e-5)
        cj, ci = int((E[2] - box[2]) / pixel), int((E[0] - box[0]) / pixel)
        if not visible[cj, ci]:
            js, is_ = np.nonzero(visible)
            if not len(js): raise ValueError(f'The {side} eyeball does not show through the skin')
            k = np.argmin((js - cj) ** 2 + (is_ - ci) ** 2); cj, ci = js[k], is_[k]
        js, is_ = np.nonzero(flood(visible, (cj, ci)))
        xs, zs = box[0] + pixel * is_, box[2] + pixel * js
        lateral = np.sign(E[0])
        a, b = np.argmax(xs * lateral), np.argmin(xs * lateral)
        points = {'outer': (xs[a], zs[a]), 'inner': (xs[b], zs[b])}
        for frac, label in ((.25, 'q1'), (.5, ''), (.75, 'q3')):
            cx = xs[b] + frac * (xs[a] - xs[b])
            column = np.abs(xs - cx) < 1.5 * pixel
            points['upper' + (f'_{label}' if label else '')] = (cx, zs[column].max())
            points['lower' + (f'_{label}' if label else '')] = (cx, zs[column].min())
        for name, (x, z) in points.items():
            j, i = int((z - box[2]) / pixel), int((x - box[0]) / pixel)
            patch = skin[max(0, j - 3):j + 4, max(0, i - 3):i + 4]
            out[f'eye_{name}_{side}'] = np.array([x, patch[np.isfinite(patch)].min(), z])
        out[f'eye_center_{side}'] = np.asarray(E, dtype=np.float64)
    return out


def profile_landmarks(vertices, faces, eye_left, eye_right, pixel=.0003):
    """Midline points: nose tip, nasion, then down from the tip the subnasale, upper lip, stomion, lower lip, the
    mentolabial sulcus, pogonion and menton (the profile's alternating creases and bulges)."""
    ez = (eye_left[2] + eye_right[2]) / 2
    iod = abs(eye_left[0] - eye_right[0])
    box = (-.004, .004, vertices[:, 2].min(), vertices[:, 2].max())
    D = depth_map(vertices, faces, box, pixel)
    band = np.where(np.isfinite(D), D, np.inf).min(axis=1)
    zs = box[2] + pixel * np.arange(len(band))
    ok = np.isfinite(band)

    def pick(lo, hi, sign):
        idx = np.nonzero(ok & (zs >= lo) & (zs <= hi))[0]
        if not len(idx): raise ValueError('No profile between those heights')
        return idx[np.argmin(sign * band[idx])]
    out = {}
    tip = pick(ez - 1.3 * iod, ez - .15 * iod, 1)
    out['nose_tip'] = np.array([0, band[tip], zs[tip]])
    nasion = pick(zs[tip], ez + .4 * iod, -1)
    out['nasion'] = np.array([0, band[nasion], zs[nasion]])
    down = np.nonzero(ok & (zs < zs[tip]))[0][::-1]
    profile = _smooth1(band[down], 5)
    w = max(3, int(.02 * iod / pixel))
    extremes = []
    for k in range(w, len(profile) - w):
        seg, wide = profile[k - w:k + w + 1], profile[max(0, k - 4 * w):k + 4 * w + 1]
        if profile[k] == seg.max() and profile[k] - wide.min() > 3e-4 and (not extremes or extremes[-1][1] != 1): extremes.append((k, 1))
        elif profile[k] == seg.min() and wide.max() - profile[k] > 3e-4 and (not extremes or extremes[-1][1] != -1): extremes.append((k, -1))
    names = ('subnasale', 'upper_lip', 'stomion', 'lower_lip', 'sulcus', 'pogonion')
    if [s for _, s in extremes[:6]] != [1, -1, 1, -1, 1, -1]:
        raise ValueError(f'The profile below the nose does not read as lips and chin: {[(round(float(zs[down[k]]), 4), s) for k, s in extremes]}')
    for name, (k, _) in zip(names, extremes):
        out[name] = np.array([0, band[down[k]], zs[down[k]]])
    pog = down[extremes[5][0]]
    below = [j for j in range(pog, -1, -1) if ok[j]]
    menton = next((j for j in below if band[j] > band[pog] + .12 * iod), below[-1])
    out['menton'] = np.array([0, band[menton], zs[menton]])
    return out


def mouth_corners(vertices, faces, profile, eye_left, eye_right, pixel=.00025):
    """The mouth's corners: the lip line (each column's deepest point between the lips) followed out from the
    stomion until it leaves the mouth line or its crease halves (a slit's end)."""
    iod = abs(eye_left[0] - eye_right[0]); z0 = profile['stomion'][2]
    h = abs(profile['upper_lip'][2] - profile['lower_lip'][2])
    box = (-.7 * iod, .7 * iod, z0 - 1.5 * h, z0 + 1.5 * h)
    D = depth_map(vertices, faces, box, pixel)
    H, W = D.shape
    xs, zs = box[0] + pixel * np.arange(W), box[2] + pixel * np.arange(H)
    out = {}
    for side, step in (('L', 1), ('R', -1)):
        i0 = int(-box[0] / pixel); zc, last, first = z0, None, None
        for i in (range(i0, W) if step > 0 else range(i0, -1, -1)):
            col = D[:, i]
            j0 = int((zc - box[2]) / pixel)
            j = max(range(max(1, j0 - 3), min(H - 1, j0 + 4)), key=lambda j: col[j] if np.isfinite(col[j]) else -1)
            hw = max(2, int(.5 * h / pixel))
            crease = col[j] - min(col[min(H - 1, j + hw)], col[max(0, j - hw)])
            if first is None: first = crease
            if abs(zs[j] - z0) > .12 * h or not np.isfinite(crease) or crease < .5 * first: break
            near = col[max(0, j - 3):j + 4]
            last = np.array([xs[i], near[np.isfinite(near)].min(), zs[j]]); zc = zs[j]
        if last is None: raise ValueError('No lip line at the stomion')
        out[f'mouth_corner_{side}'] = last
    return out


def outline_landmarks(vertices, profile, eye_left, eye_right):
    """Crown, occiput, temples, cheeks, jaw and neck points on the head's outline."""
    V = vertices
    iod = abs(eye_left[0] - eye_right[0]); ez = (eye_left[2] + eye_right[2]) / 2
    out = {}
    mid = np.abs(V[:, 0]) < .12 * iod
    out['crown'] = V[mid][np.argmax(V[mid][:, 2])]
    band = (np.abs(V[:, 0]) < .35 * iod) & (np.abs(V[:, 2] - (ez + .3 * iod)) < .2 * iod)
    back = V[band][np.argmax(V[band][:, 1])].copy(); back[0] = 0
    out['occiput'] = back
    for side, s in (('L', 1), ('R', -1)):
        for name, z, front in (('temple', profile['nasion'][2] + .9 * iod, None),
                               ('cheek', (profile['nose_tip'][2] + profile['nasion'][2]) / 2, profile['nasion'][1] + .5 * iod),
                               ('jaw', (profile['stomion'][2] + profile['menton'][2]) / 2, profile['stomion'][1] + .6 * iod)):
            b = (np.abs(V[:, 2] - z) < .05 * iod) & (V[:, 0] * s > 0)
            if front is not None: b &= V[:, 1] < front
            out[f'{name}_{side}'] = V[b][np.argmax(V[b][:, 0] * s)]
    zn = profile['menton'][2] - .45 * iod
    b = mid & (np.abs(V[:, 2] - zn) < .05 * iod)
    if b.sum() > 1:
        out['neck_front'] = V[b][np.argmin(V[b][:, 1])]
        out['neck_back'] = V[b][np.argmax(V[b][:, 1])]
    return out


def face_landmarks(vertices, faces, eyes):
    """Every landmark on a closed head: eyes (see eye_landmarks), profile, mouth corners and outline."""
    (eL, _, _, _), (eR, _, _, _) = eyes
    profile = profile_landmarks(vertices, faces, eL, eR)
    return {**eye_landmarks(vertices, faces, eyes), **profile, **mouth_corners(vertices, faces, profile, eL, eR),
            **outline_landmarks(vertices, profile, eL, eR)}


def hm08_eyes(head, shape):
    """The eyes of an hm08 head shape (Blender frame): [(center, radius, eyeball vertices, eyeball faces)], left then
    right, from the eye helper proxies."""
    out = []
    for kind in ('helper-l-eye', 'helper-r-eye'):
        ids = head.kind_vertices(kind)
        P = shape[ids]
        lo, hi = P.min(0), P.max(0)
        out.append(((lo + hi) / 2, float((hi - lo)[0] / 2), shape, head.kind_faces(kind)))
    return out
