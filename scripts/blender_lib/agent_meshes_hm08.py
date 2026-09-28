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


def smooth_deltas(deltas, edges, iterations=10, amount=.5):
    """Per-vertex deltas averaged with their mesh neighbours' `iterations` times (each step moves `amount` of the way)."""
    d = np.asarray(deltas, dtype=np.float64).copy()
    degree = np.maximum(np.bincount(edges.ravel(), minlength=len(d)), 1).astype(np.float64)[:, None]
    for _ in range(iterations):
        around = np.zeros_like(d)
        np.add.at(around, edges[:, 0], d[edges[:, 1]]); np.add.at(around, edges[:, 1], d[edges[:, 0]])
        d += amount * (around / degree - d)
    return d


def _corner_triangles(faces):
    """Every triangle a quad can split into (both diagonals), so a check holds whichever way an exporter splits it."""
    f = np.asarray(faces)
    tris = [f[:, [0, 1, 2]]]
    quads = f[f[:, 3] >= 0] if f.shape[1] > 3 else f[:0]
    if len(quads): tris += [quads[:, [0, 2, 3]], quads[:, [0, 1, 3]], quads[:, [1, 2, 3]]]
    return np.concatenate(tris)


def flat_triangles(vertices, faces):
    """Quads (-1 padded) split into triangles along the diagonal that leaves the two halves flatter (the smaller
    turn between them). Returns (triangles padded to four columns, each triangle's source face)."""
    V, f = np.asarray(vertices), np.asarray(faces)
    out, source = [], []
    for k, face in enumerate(f):
        if face[3] < 0:
            out.append([face[0], face[1], face[2], -1]); source.append(k); continue
        a, b, c, d = (int(i) for i in face)

        def turn(t1, t2):
            n1 = np.cross(V[t1[1]] - V[t1[0]], V[t1[2]] - V[t1[0]]); n2 = np.cross(V[t2[1]] - V[t2[0]], V[t2[2]] - V[t2[0]])
            return (n1 @ n2) / max(np.linalg.norm(n1) * np.linalg.norm(n2), 1e-30)
        split = ((a, b, c), (a, c, d)) if turn((a, b, c), (a, c, d)) >= turn((a, b, d), (b, c, d)) else ((a, b, d), (b, c, d))
        for t in split: out.append(list(t) + [-1]); source.append(k)
    return np.array(out, dtype=np.int64), np.array(source, dtype=np.int64)


CREASE_ABOVE = tuple(range(50, 131, 5))
CREASE_BELOW = tuple(range(230, 311, 5))


def eye_crease_folds(vertices, faces, center, radius, reach=1.3, turn=20.0, span=.06, step_share=1 / 400):
    """The arkit-face/1 verifier's terraced-socket measure, in Blender's frame: along radial lines round an eye in a
    front view (above: 50-130 degrees, below: 230-310, 90 straight up), from the first skin past the eyeball out to
    `reach` radii, count the folds (the surface turning back toward the viewer by `turn` degrees within `span` radii
    of surface). Returns (median folds above, median folds below)."""
    c, r = np.asarray(center, dtype=np.float64), float(radius)
    R, step = reach * r, r * step_share
    box = (c[0] - R, c[0] + R, c[2] - R, c[2] + R)
    D = depth_map(np.asarray(vertices, dtype=np.float64), faces, box, step)
    H, W = D.shape
    d, sp = 3, span * r

    def count(angle):
        a = math.radians(angle)
        heights, started = [], False
        for k in range(int(R / step) + 1):
            x, z = c[0] + k * step * math.cos(a), c[2] + k * step * math.sin(a)
            i, j = int(round((x - box[0]) / step)), int(round((z - box[2]) / step))
            if not (0 <= i < W and 0 <= j < H): break
            y = D[j, i]
            q = (x - c[0]) ** 2 + (z - c[2]) ** 2
            ball = c[1] - math.sqrt(r * r - q) if q < r * r else math.inf
            on_ball = ball <= y
            if k == 0 and not on_ball: return None
            if not started:
                if on_ball or not np.isfinite(y): continue
                started = True
            if not np.isfinite(y) or on_ball or y > c[1]: break
            heights.append(-y)
        if len(heights) < 2 * d + 2: return None
        h = np.array(heights)
        arc = np.concatenate([[0], np.cumsum(np.hypot(step, np.diff(h)))])
        slope = [math.degrees(math.atan2(h[k + d] - h[k - d], 2 * d * step)) for k in range(d, len(h) - d)]
        folds, last = 0, -math.inf
        for k in range(len(slope)):
            low = slope[k]
            for m in range(k + 1, len(slope)):
                if arc[m + d] - arc[k + d] > sp: break
                if slope[m] - low >= turn:
                    if arc[k + d] - last > sp: folds += 1
                    last = arc[k + d]
                    break
                low = min(low, slope[m])
        return folds
    above = [n for n in (count(a) for a in CREASE_ABOVE) if n is not None]
    below = [n for n in (count(a) for a in CREASE_BELOW) if n is not None]
    median = lambda v: sorted(v)[len(v) // 2] if v else 0
    return median(above), median(below)


@lru_cache(maxsize=1)
def margin_vertices():
    """The left eye's lid margin on hm08's own topology: its corners and the vertices along its upper and lower margins
    (found once on the realistic base head, where the eye opening reads cleanly, and followed by index through every
    shape). Returns {'inner', 'outer', 'upper': [...], 'lower': [...]} vertex indices."""
    head = load_head()
    base = to_blender(head.rest)
    faces = head.kind_faces('body')
    marks = eye_landmarks(base, faces, hm08_eyes(head, base)[:1])
    skin = head.kind_vertices('body')
    nearest = lambda p: int(skin[np.argmin(np.linalg.norm(base[skin] - p, axis=1))])
    contour = marks['eye_margin_L']
    return {'inner': nearest(marks['eye_inner_L']), 'outer': nearest(marks['eye_outer_L']),
            'upper': [nearest(p) for p in contour[:, 0]], 'lower': [nearest(p) for p in contour[:, 1]]}


def eyeball_shows(vertices, faces, center, radius, rays=48, pitch=0.0, band=None):
    """How many of a grid of rays across an eyeball (a sphere) reach it before the skin: from the front, or seen from
    `pitch` degrees above (+) or below (-); `band` (eyeball radii) counts only rays that near the center's height."""
    c, r = np.asarray(center), float(radius)
    if pitch:
        # Seen from below is the head turned up: turn the skin about the eye's horizontal axis.
        vertices = _turn(np.asarray(vertices, dtype=np.float64), c, np.full(len(vertices), math.radians(-pitch)))
    pixel = 2 * r / rays
    box = (c[0] - r, c[0] + r, c[2] - r, c[2] + r)
    D = depth_map(np.asarray(vertices), faces, box, pixel)
    xs = box[0] + pixel * np.arange(D.shape[1]) - c[0]
    zs = box[2] + pixel * np.arange(D.shape[0]) - c[2]
    X, Z = np.meshgrid(xs, zs)
    inside = X * X + Z * Z < r * r
    if band is not None: inside &= np.abs(Z) < band * r
    front = c[1] - np.sqrt(np.clip(r * r - X * X - Z * Z, 0, None))
    return int((inside & (front < D - 1e-7)).sum())


def flipped(rest, moved, faces, triangles_=None):
    """Triangles (of both splits of every quad) that turn over, or collapse, between rest and moved positions."""
    T = _corner_triangles(faces) if triangles_ is None else triangles_
    n0 = np.cross(rest[T[:, 1]] - rest[T[:, 0]], rest[T[:, 2]] - rest[T[:, 0]])
    n1 = np.cross(moved[T[:, 1]] - moved[T[:, 0]], moved[T[:, 2]] - moved[T[:, 0]])
    a0 = np.linalg.norm(n0, axis=1)
    ok = a0 > 1e-14
    dot = (n0 * n1).sum(1)
    bad = ok & ((dot <= 0) | (np.linalg.norm(n1, axis=1) < .02 * a0))
    return T[bad]


def unfold_morphs(rest, faces, morphs, mixes=(), iterations=200, amount=.7, keep=(), pinned=None, calm=True, coherent=False):
    """Relax each morph's motion where it turns faces over: the flipped faces' vertices (and their neighbours) take
    their neighbours' mean motion and give up 3% of it, step by step, until nothing flips, alone and in each weighted
    mix of `mixes` ({morph: weight} dicts). Returns the morphs (new arrays) and how many of them and of the mixes still
    turn a face over. Morphs named in `keep` are left as they are, and vertices in `pinned` (a boolean mask: the lid
    margins, whose closure the contract checks) keep their motion."""
    rest = np.asarray(rest, dtype=np.float64)
    T = _corner_triangles(faces)
    edges = edges_of(faces)
    count = len(rest)
    degree = np.maximum(np.bincount(edges.ravel(), minlength=count), 1).astype(np.float64)[:, None]
    free = np.ones(count, dtype=bool) if pinned is None else ~np.asarray(pinned, dtype=bool)
    neighbours = [[] for _ in range(count)]
    for a, b in edges: neighbours[a].append(b); neighbours[b].append(a)
    out = {name: np.asarray(t, dtype=np.float64).copy() for name, t in morphs.items() if name not in keep}
    kept = {name: np.asarray(t, dtype=np.float64) for name, t in morphs.items() if name in keep}
    everything = {**out, **kept}
    mixes = [{n: w for n, w in mix.items() if n in everything} for mix in mixes]
    mixes = [mix for mix in mixes if any(n in out for n in mix)]

    def relax(names, bad):
        verts = set(bad.ravel().tolist())
        verts |= {n for v in list(verts) for n in neighbours[v]}
        idx = np.array(sorted(v for v in verts if free[v]), dtype=np.int64)
        if not len(idx): return
        for name in names:
            d = out[name] - rest
            around = np.zeros_like(d)
            np.add.at(around, edges[:, 0], d[edges[:, 1]]); np.add.at(around, edges[:, 1], d[edges[:, 0]])
            d[idx] += amount * (around[idx] / degree[idx] - d[idx])
            # A neighbourhood that turns over as one (a lip corner rolling past a right angle) is not a fold the mean
            # undoes: it moves a little less each step.
            d[idx] *= .97
            out[name] = rest + d
    def settle(names, weights):
        # Kept morphs in a mix count toward what flips; only the others give way.
        for _ in range(iterations):
            moved = rest + sum(w * ((out[n] if n in out else kept[n]) - rest) for n, w in zip(names, weights))
            bad = flipped(rest, moved, faces, T)
            if not len(bad): return True
            relax([n for n in names if n in out], bad)
        return False
    # Rounds: settling a mix can turn one of its morphs alone over again.
    for _ in range(3):
        clean = all([settle([name], [1.0]) for name in out])
        for mix in mixes:
            names = [n for n in mix if n in out]
            clean = settle(names, [mix[n] for n in names]) and clean
        if clean: break
    # Whatever still turns over, anywhere: calm every morph there together (halve their motion) until nothing does.
    checks = [({n: 1.0}) for n in out] + list(mixes)
    shape = lambda n: out[n] if n in out else kept[n]
    for _ in range(30 if calm else 0):
        bad = [flipped(rest, rest + sum(w * (shape(n) - rest) for n, w in mix.items()), faces, T) for mix in checks]
        involved = {n for mix, b in zip(checks, bad) if len(b) for n in mix if n in out}
        if not involved: break
        verts = {int(v) for b in bad for v in b.ravel()}
        verts |= {n for v in list(verts) for n in neighbours[v]}
        idx = np.array(sorted(v for v in verts if free[v]), dtype=np.int64)
        if not len(idx): break
        for n in involved:
            d = out[n] - rest
            d[idx] *= .5
            out[n] = rest + d
    # Last, any face still turning over moves as one: its corners share their mean motion (a translation cannot
    # turn a face), a few times over, pinned corners included (the change is local and small).
    for _ in range(12 if coherent else 0):
        bad = [(mix, flipped(rest, rest + sum(w * (shape(n) - rest) for n, w in mix.items()), faces, T)) for mix in checks]
        bad = [(mix, b) for mix, b in bad if len(b)]
        if not bad: break
        for mix, b in bad:
            for n in mix:
                if n not in out: continue
                d = out[n] - rest
                for tri in b: d[tri] = d[tri].mean(axis=0)
                out[n] = rest + d
    left = sum(bool(len(flipped(rest, out[n], faces, T))) for n in out)
    left += sum(bool(len(flipped(rest, rest + sum(w * (shape(n) - rest) for n, w in mix.items()), faces, T))) for mix in mixes)
    return {**out, **kept}, left


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
        # And the whole margin: the opening's top and bottom in 24 columns across (the landmarks' own resolution).
        contour = []
        for frac in np.linspace(.02, .98, 24):
            cx = xs[b] + frac * (xs[a] - xs[b])
            column = np.abs(xs - cx) < 1.5 * pixel
            if column.any(): contour.append((cx, zs[column].max(), zs[column].min()))

        def on_skin(x, z):
            j, i = int((z - box[2]) / pixel), int((x - box[0]) / pixel)
            patch = skin[max(0, j - 3):j + 4, max(0, i - 3):i + 4]
            return np.array([x, patch[np.isfinite(patch)].min(), z])
        for name, (x, z) in points.items(): out[f'eye_{name}_{side}'] = on_skin(x, z)
        out[f'eye_margin_{side}'] = np.array([[on_skin(x, top), on_skin(x, bottom)] for x, top, bottom in contour])
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
    names = ('subnasale', 'upper_lip', 'stomion', 'lower_lip')
    if [s for _, s in extremes[:4]] != [1, -1, 1, -1]:
        raise ValueError(f'The profile below the nose does not read as lips: {[(round(float(zs[down[k]]), 4), s) for k, s in extremes]}')
    for name, (k, _) in zip(names, extremes):
        out[name] = np.array([0, band[down[k]], zs[down[k]]])
    # The chin: walking down from the lower lip, the first crease (the mentolabial sulcus) and the first bulge after
    # it (the pogonion), found with a finer prominence (a child's chin is round and shallow). Without a crease, the
    # sulcus is the point where the profile turns most steeply back and the chin the most forward point below it.
    k_low = extremes[3][0]
    # Down to where the profile turns back under the chin (a fifth of the interocular distance behind the lip).
    tail = []
    for k in range(k_low + 1, len(profile)):
        if zs[down[k]] < zs[down[k_low]] - .9 * iod or profile[k] > profile[k_low] + .2 * iod: break
        tail.append(k)
    if len(tail) < 3: raise ValueError('No chin below the lower lip')
    fine = []
    for k in tail[w:-w] if len(tail) > 2 * w else tail:
        seg = profile[max(0, k - w):k + w + 1]
        if profile[k] == seg.max() and (not fine or fine[-1][1] != 1): fine.append((k, 1))
        elif profile[k] == seg.min() and fine and fine[-1][1] == 1: fine.append((k, -1)); break
    if len(fine) == 2: k_sul, k_pog = fine[0][0], fine[1][0]
    else:
        k_sul = max(tail[:len(tail) // 2], key=lambda k: profile[k])
        k_pog = min([k for k in tail if k > k_sul] or tail, key=lambda k: profile[k])
    out['sulcus'] = np.array([0, band[down[k_sul]], zs[down[k_sul]]])
    out['pogonion'] = np.array([0, band[down[k_pog]], zs[down[k_pog]]])
    extremes = extremes[:4] + [(k_sul, 1), (k_pog, -1)]
    # Parted lips show the mouth's inside through the slit: the stomion is on the lips' line, not deep in the mouth.
    lips = max(out['upper_lip'][1], out['lower_lip'][1])
    out['stomion'][1] = min(out['stomion'][1], lips + .06 * iod)
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


# ---------------------------------------------------------------- a character's head

# Shape controls -> (target stem, scale): a control's value v adds `-incr` at (v - neutral) * scale when positive and
# `-decr` at its size when negative. `l-`/`r-` stems apply to both sides.
FEATURES = {
    'eye_size': (('eyes/{s}-eye-scale', 4.0),),
    'eye_spacing': (('eyes/{s}-eye-trans', None),),   # handled below: in/out, not incr/decr
    'eye_tilt': (('eyes/{s}-eye-corner1', None),),
    'nose': (('nose/nose-scale-horiz', 1.2), ('nose/nose-scale-vert', 1.2), ('nose/nose-scale-depth', 1.2)),
    'nose_length': (('nose/nose-scale-vert', 2.0),),
    'nose_width': (('nose/nose-scale-horiz', 2.0), ('nose/nose-flaring', 1.0)),
    'nose_bridge': (('nose/nose-scale-depth', 2.0), ('nose/nose-hump', .6)),
    'mouth_width': (('mouth/mouth-scale-horiz', 2.5),),
    'lips': (('mouth/mouth-upperlip-volume', .6), ('mouth/mouth-lowerlip-volume', .6)),
    'jaw_width': (('head/head-square', None),),   # handled below: square out, inverted triangle in
    'chin': (('chin/chin-height', 2.5),),
    'chin_width': (('chin/chin-width', 2.5),),
    'cheeks': (('cheek/{s}-cheek-volume', .8), ('head/head-fat', .4)),
    'brow': (('eyebrows/eyebrows-trans', None),),   # forward/backward, not incr/decr
    'smile': (('mouth/mouth-angles', None),),
}


def feature_weights(shape, head=None):
    """Target weights for a character's shape controls: factors round 1 (eye_size, nose, mouth_width, lips,
    chin, chin_width, cheeks, brow, nose_length, jaw_width, nose_width, nose_bridge), eye_spacing (factor), eye_tilt (-1..1,
    up at the outer corner) and smile (0..1, the corners turned up)."""
    head = head or load_head()
    weights = {}

    def add(name, w):
        if name not in head.targets: raise ValueError(f'hm08 has no target {name}')
        weights[name] = weights.get(name, 0.0) + w

    def signed(stem, v):
        for s in ('l', 'r') if '{s}' in stem else (None,):
            base = stem.format(s=s) if s else stem
            if v > 0: add(base + '-incr', min(1.0, v))
            elif v < 0: add(base + '-decr', min(1.0, -v))
    for key, value in shape.items():
        if key not in FEATURES: raise ValueError(f'Unknown head shape control {key}')
        if key == 'eye_spacing':
            v = (value - 1) / .15
            for s in 'lr': add(f'eyes/{s}-eye-trans-{"out" if v > 0 else "in"}', min(1.0, abs(v)))
        elif key == 'eye_tilt':
            for s in 'lr': add(f'eyes/{s}-eye-corner1-{"up" if value > 0 else "down"}', min(1.0, abs(value)))
        elif key == 'brow':
            v = (value - 1) * .5
            if v: add(f'eyebrows/eyebrows-trans-{"forward" if v > 0 else "backward"}', min(1.0, abs(v)))
        elif key == 'jaw_width':
            # hm08's chin-bones drops the jawline rather than widening it; the head-shape targets move the gonial angles.
            v = (value - 1) * 2.5
            if v: add('head/head-square' if v > 0 else 'head/head-invertedtriangular', min(1.0, abs(v)))
        elif key == 'smile':
            if value > 0: add('mouth/mouth-angles-up', min(1.0, value))
        else:
            for stem, scale in FEATURES[key]: signed(stem, (value - 1) * scale)
    return {k: v for k, v in weights.items() if v}


def head_shape(years, gender, stylize=1.0, shape=None, races=None, head=None):
    """The hm08 head (MakeHuman units) for an age, gender (0 female, 1 male), stylize weight and shape controls."""
    head = head or load_head()
    weights = macro_weights(years, gender, races)
    weights.update(feature_weights(shape or {}, head))
    out = head.compose(weights)
    if stylize:
        index, delta = stylize_target(head)
        out[index] += stylize * delta
    return out


@lru_cache(maxsize=1)
def _stylize(path):
    return read_target(path)


def stylize_target(head=None):
    return _stylize(str(DATA / 'stylize01.target'))


def fit_to_envelope(points, marks, center, radii, eye_drop=.036):
    """Scale and move a head (Blender frame) so its cranium fills an ellipsoid envelope (center, radii (x, y, z)):
    crown to eye level fills the envelope's top down to `eye_drop` of its height below its center, the temples its
    width and the occiput-to-nasion depth its depth. Returns (points, scale (3,), offset (3,))."""
    rx, ry, rz = radii
    eye_z = (marks['eye_center_L'][2] + marks['eye_center_R'][2]) / 2
    sz = (rz * (1 + eye_drop) * .97) / (marks['crown'][2] - eye_z)
    sx = rx * .92 / max(marks['temple_L'][0], -marks['temple_R'][0])
    sy = 2 * ry * .86 / (marks['occiput'][1] - marks['nasion'][1])
    scale = np.array([sx, sy, sz])
    target_eye = center[2] - eye_drop * rz
    mid_y = (marks['occiput'][1] + marks['nasion'][1]) / 2
    offset = np.array([center[0], center[1] - sy * mid_y + .08 * ry, target_eye - sz * eye_z])
    return np.asarray(points) * scale + offset, scale, offset


# ---------------------------------------------------------------- a living face on the stylized head

# The face units a stylized character's face carries (the arkit-face/1 required set and the optional ones hm08 moves;
# gaze turns the eye bones, and tongueOut needs a tongue of the head's own).
FACE_UNITS = ('eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawOpen',
              'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight',
              'mouthFunnel', 'mouthPucker', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
              'cheekSquintLeft', 'cheekSquintRight', 'cheekPuff', 'noseSneerLeft', 'noseSneerRight')
LID_CLEARANCE = .0008
# Lid shapes character_face tries, in order (see lid_morphs): the first that folds no face and hides the eyeball when
# closed wins.
LID_CANDIDATES = tuple({'corner': .15, 'inner_corner': i, 'reach': r, 'overlap': o, 'fade': fade, 'proud': proud}
                       for fade, proud in ((.8, .04), (1.3, .02), (1.8, 0.0)) for r in (1.35, 1.3, 1.4, 1.25, 1.5)
                       for o in (.18, .26) for i in (.25, .15))


def _elevation(points, center):
    """Each point's angle above the forward axis (-Y) seen from an eye center, in the y-z plane (radians)."""
    d = np.asarray(points) - center
    return np.arctan2(d[..., 2], -d[..., 1])


def _turn(points, center, angles):
    """Points turned about the x axis through `center` by `angles` (radians; positive raises a point in front)."""
    d = np.asarray(points) - center
    c, s = np.cos(angles), np.sin(angles)
    # Forward is -y: raising a point in front turns it from -y toward +z.
    y = d[:, 1] * c + d[:, 2] * s
    z = d[:, 2] * c - d[:, 1] * s
    return np.stack([d[:, 0], y, z], axis=1) + center


def lid_morphs(rest, center, radius, margin, overlap=.18, clearance=LID_CLEARANCE, crease=.55, cheek=.4, wide=.22, reach=1.7, corner=.15, edges=None, almond=0.0, inner_corner=None,
              fade=.8, proud=.04):
    """Blink, squint and wide for one eye, as rolling curtains round its lid margins, and the rest-shape push that keeps
    the lids clear of the eyeball.

    `margin` holds the lid margin (Blender frame): its `inner` and `outer` corners and its `contour`, pairs of points on
    the upper and lower margin across the opening (the landmarks' `eye_margin`). From the eye center they give the
    upper and lower margins' elevation at each yaw, and the corners where they meet. Every vertex within `reach` eyeball radii of the
    center, in front of it and between the corners, belongs to the upper lid (above the meet line, three tenths up
    the opening) or the lower. It turns about the eye's horizontal axis by its margin's angle at its yaw times its
    share: 1 on the margin and inside it (the lid's rim and inner surface), easing to 0 at the crease, `crease` of the
    opening above the upper margin (the lower lid: `cheek` of it below). Each column's angle comes from its own margin:
    - blink: the upper margin down to `overlap` of the opening below the meet line, the lower lid up behind it by the
      wide lift less half the overlap (so blink + wide still closes);
    - squint: the upper margin down a sixth of the opening, the lower up a third;
    - wide: the upper margin up `wide` of the opening.
    At the corners the opening, and so every motion, is nothing. A morph moves a vertex on a straight chord, which dips
    toward the center by R (1 - cos(sweep / 2)), so each moving lid vertex is pushed out to at least
    (radius + clearance) / cos(sweep / 2) for its widest sweep, and the push is spread over the lid so it stays smooth.
    Returns ({'blink', 'squint', 'wide': targets}, push); the targets include the push.

    With `almond` (0..1) it returns the rest shape instead, its corners drawn to points: toward each corner (the
    fourth power of the way across) the margins close that share of the way to the meet line, so a round stylized
    opening becomes an almond whose lids can close at the corners without shearing."""
    rest = np.asarray(rest)
    d = rest - center
    dist = np.linalg.norm(d, axis=1)
    yaw = np.arctan2(d[:, 0], -d[:, 1])
    elev = _elevation(rest, center)
    angles = lambda p: (math.atan2(p[0] - center[0], -(p[1] - center[1])), float(_elevation(np.asarray(p)[None], center)[0]))
    inner, outer = angles(margin['inner']), angles(margin['outer'])
    ups = sorted([inner, outer] + [angles(p) for p in margin['contour'][:, 0]])
    lows = sorted([inner, outer] + [angles(p) for p in margin['contour'][:, 1]])
    lo_yaw, hi_yaw = min(inner[0], outer[0]), max(inner[0], outer[0])
    y = np.clip(yaw, lo_yaw, hi_yaw)
    e_up = np.interp(y, [a for a, _ in ups], [b for _, b in ups])
    e_low = np.interp(y, [a for a, _ in lows], [b for _, b in lows])
    gap = np.maximum(e_up - e_low, 0.0)
    # Past the corners the lids still ease out over a few degrees, so nothing tears at the canthus.
    beyond = np.maximum(lo_yaw - yaw, yaw - hi_yaw).clip(0)
    ease = np.clip(1 - beyond / math.radians(8), 0, 1)
    # The lids meet three tenths up the opening in its middle and halfway toward the corners, so near the corners
    # (where a round stylized eye is still tall) each lid travels half the way and neither shears against the corner.
    across = np.clip((yaw - (lo_yaw + hi_yaw) / 2) / max((hi_yaw - lo_yaw) / 2, 1e-6), -1, 1)
    meet = e_low + (.3 + .2 * across ** 2) * gap
    # Near the eye, fading out smoothly toward `reach` radii (a hard edge shears the skin round the corners).
    u = np.clip(((reach + .6) * radius - dist) / (.6 * radius), 0, 1)
    near = u * u * (3 - 2 * u) * (d[:, 1] < .15 * radius)
    upper_side = elev >= meet
    wide_lift = wide * gap
    # The falloffs span a share of the opening's full height (not the local one, which shrinks to nothing at the
    # corners and would crowd the whole curtain into a sliver there).
    tall = float(gap.max())
    up_share = np.where(elev <= e_up, 1.0, np.clip(1 - (elev - e_up) / max(crease * tall, 1e-6), 0, 1))
    low_share = np.where(elev >= e_low, 1.0, np.clip(1 - (e_low - elev) / max(cheek * tall, 1e-6), 0, 1))
    up_share = up_share * up_share * (3 - 2 * up_share)
    low_share = low_share * low_share * (3 - 2 * low_share)
    # Toward each corner the motion fades out over the last `corner` of the half-width, so the canthus stays put and
    # nothing at the corner shears against its neighbour.
    mid_yaw, half_yaw = (lo_yaw + hi_yaw) / 2, (hi_yaw - lo_yaw) / 2
    # (the inner corner, by the nose, may taper over a longer stretch: its pocket is deeper)
    toward_inner = np.sign(yaw - mid_yaw) == np.sign(inner[0] - mid_yaw)
    span = np.where(toward_inner, corner if inner_corner is None else inner_corner, corner)
    t = np.clip((half_yaw - np.abs(yaw - mid_yaw)) / (span * half_yaw), 0, 1)
    if almond:
        toward = np.where(upper_side, meet - e_up, meet - e_low)
        return _turn(rest, center, np.where(upper_side, up_share, low_share) * near * ease * almond * across ** 4 * toward)
    # Across the meet line the upper lid's motion hands over to the lower's smoothly (a hard switch sends neighbours
    # in opposite directions where the lids meet at the corners).
    hand = np.clip((elev - meet) / max(.12 * tall, 1e-6) + .5, 0, 1)
    hand = hand * hand * (3 - 2 * hand)
    mix = lambda a, b: hand * a + (1 - hand) * b
    share = mix(up_share, low_share) * near * ease * (t * t * (3 - 2 * t))
    blink_up = -(e_up - (meet - overlap * gap))
    blink_low = meet + wide_lift - e_low
    blink = share * mix(blink_up, blink_low)
    squint = share * mix(-gap / 6, gap / 3)
    # Wide opens the middle of the eye; toward the corners it fades (there the lids meet halfway and blink + wide must
    # still close).
    lift = share * hand * wide_lift * (1 - across ** 2) ** 2
    if edges is not None:
        # Spread each turn onto its neighbours (never less than a vertex's own turn), so no two neighbours turn so
        # differently that the face between them folds over; the margins keep their full closure.
        def spread(a):
            pos, neg = np.maximum(a, 0), np.minimum(a, 0)
            pos = np.maximum(pos, smooth_deltas(pos[:, None], edges, iterations=10)[:, 0])
            neg = np.minimum(neg, smooth_deltas(neg[:, None], edges, iterations=10)[:, 0])
            return np.where(np.abs(pos) >= np.abs(neg), pos, neg)
        blink, squint, lift = spread(blink), spread(squint), spread(lift)
    sweep = np.abs(blink) + np.abs(squint) + np.abs(lift)
    need = (radius + clearance) / np.cos(np.minimum(sweep, 2.5) / 2) + proud * radius * share * hand
    grow = np.where(sweep > 1e-6, np.maximum(need - dist, 0.0), 0.0)
    # Spread the push over the moving lid and a little past it, so the pushed lids blend into the skin.
    grow_near = grow.copy()
    ids = np.nonzero(grow > 0)[0]
    if len(ids):
        far, spread = np.full(len(rest), np.inf), np.zeros(len(rest))
        for i in ids:
            dd = np.linalg.norm(rest - rest[i], axis=1)
            closer = dd < far
            far, spread = np.where(closer, dd, far), np.where(closer, grow[i], spread)
        t = np.clip(1 - far / (fade * radius), 0, 1)
        grow_near = np.maximum(grow, spread * t * t * (3 - 2 * t) * (d[:, 1] < 0))
    push = d / np.maximum(dist, 1e-12)[:, None] * grow_near[:, None]
    pushed = rest + push
    return {'blink': _turn(pushed, center, blink), 'squint': _turn(pushed, center, squint), 'wide': _turn(pushed, center, lift)}, push


class RigidJaw:
    """jawOpen's motion for rigid mouth parts (lower teeth, tongue, the mouth's lower bag): the rigid transform that
    best fits the chin's face-unit motion. Duck-types `JawHinge` for `add_jaw_open`."""

    def __init__(self, rest, moved, gain=1.0):
        P, Q = np.asarray(rest), np.asarray(moved)
        cp, cq = P.mean(0), Q.mean(0)
        U, _, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
        D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
        R = Vt.T @ D @ U.T
        if gain != 1.0:
            # The same turn about the same axis, `gain` times as far, about the rest points' middle.
            angle = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2)))
            if angle > 1e-9:
                axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * math.sin(angle))
                K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
                a = gain * angle
                R = np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K
            cq = cp + gain * (cq - cp)
        self.rotation = R
        self.translation = cq - self.rotation @ cp

    def move(self, point, weight=1.0, rigid=False):
        p = np.asarray(point, dtype=np.float64)
        return tuple(p + weight * (self.rotation @ p + self.translation - p))

    def targets(self, vertices, weight=None, lower_lip=()):
        if weight is None: weight = 1.0
        if callable(weight): weights = [float(weight(v)) for v in vertices]
        elif isinstance(weight, (int, float)): weights = [float(weight)] * len(vertices)
        else: weights = [float(w) for w in weight]
        return [self.move(v, w) if w > 0 else tuple(v) for v, w in zip(vertices, weights)]


def character_face(years, gender, center, radii, shape=None, stylize=1.0, neck_z=None, neck=None, races=None, units=FACE_UNITS,
                   almond=.6, eye_scale=.95):
    """A stylized character's living face on the hm08 head in Blender's frame: the head fitted to the envelope
    (center, radii (x, y, z)) and cropped at `neck_z`, with its face-unit morphs (lids refitted to the stylized eyes).

    `neck` (the body neck's half width and depth at `neck_z`, centered on the head's axis) grafts the cropped neck onto
    the body's: the head's lowest rows ease onto that ellipse, just outside it. The cranium is kept inside the
    envelope (the hair is fitted to it).

    Returns {'vertices', 'faces', 'morphs': {unit: targets}, 'eyes': [(center, radius)] left then right, 'landmarks',
    'mouth_inside': face mask, 'mouth_box': (low, high) of the mouth's inside, 'lash': vertex ids, 'jaw': RigidJaw,
    'scale': (3,)}."""
    head = load_head()
    mh = head_shape(years, gender, stylize, shape, races, head)
    V = to_blender(mh)
    faces = head.kind_faces('body')
    marks = face_landmarks(V, faces, hm08_eyes(head, V))
    P, scale, offset = fit_to_envelope(V, marks, center, radii)
    fit = lambda mh_points: to_blender(mh_points) * scale + offset
    marks = face_landmarks(P, faces, hm08_eyes(head, P))
    deltas = {unit: fit(mh + head.dense(f'faceunits/{unit}')) - P for unit in units}
    # Shape moves (the morphs keep their deltas): the cranium inside the envelope, the neck onto the body's.
    shift = _cranium_inside(P, marks, center, radii)
    if neck_z == 'chin':
        # Cropped just under the chin: the face's lowest point is its chin (the contract's puppet jaw drops it), and
        # the body's neck carries on below.
        neck_z = marks['menton'][2] - .003 * scale[2]
    if neck is not None and neck_z is not None: shift += _neck_graft(P + shift, neck_z, neck, marks, scale[2])
    P = P + shift
    # Exactly symmetric (the stylize fit and the landmarks leave hundredths of a millimetre between the sides), so the
    # right side's morphs, mirrored from the left, fit it exactly.
    partner = np.where(head.mirror >= 0, head.mirror, np.arange(len(P)))
    flip = np.array([-1.0, 1.0, 1.0])
    P = .5 * (P + P[partner] * flip)
    marks = face_landmarks(P, faces, hm08_eyes(head, P))

    # The eyes: centers and sizes from hm08's eyeball helpers, as spheres just inside the lids resting on them.
    eyes, skin_ids = [], head.kind_vertices('body')
    for kind in ('helper-l-eye', 'helper-r-eye'):
        ids = head.kind_vertices(kind)
        lo, hi = P[ids].min(0), P[ids].max(0)
        c, r = (lo + hi) / 2, float(np.mean((hi - lo) / 2))
        d = np.linalg.norm(P[skin_ids] - c, axis=1)
        near = d < 1.6 * r
        if near.any(): r = min(r, float(d[near].min()) - LID_CLEARANCE)
        r *= eye_scale
        eyes.append((c, r))

    # Lids refitted to the stylized openings.
    morphs = {}
    skin_edges = edges_of(faces)
    (c, r) = eyes[0]
    lid_ids = margin_vertices()
    margin_of = lambda Q: {'inner': Q[lid_ids['inner']], 'outer': Q[lid_ids['outer']],
                           'contour': np.stack([Q[lid_ids['upper']], Q[lid_ids['lower']]], axis=1)}
    margin = margin_of(P)
    if almond:
        # Almond eyes: the opening's corners drawn to points (the rest shape; every morph builds on it), mirrored.
        shaped = lid_morphs(P, c, r, margin, almond=almond)
        P = P + (shaped - P) + (shaped - P)[partner] * flip
        marks = face_landmarks(P, faces, hm08_eyes(head, P))
        margin = margin_of(P)

    def build_lids(params):
        # The left eye's lids, pushed clear of the eyeball (the push mirrored onto the right eye), then built on the
        # pushed head; the right eye's lids are the left's, mirrored through hm08's mirror table (exactly symmetric).
        _, push = lid_morphs(P, c, r, margin, edges=skin_edges, **params)
        pushed = P + push + push[partner] * flip
        targets, _ = lid_morphs(pushed, c, r, margin, edges=skin_edges, **params)
        out = {}
        for name, t in targets.items():
            out[f'eye{name.capitalize()}Left'] = t
            out[f'eye{name.capitalize()}Right'] = pushed + (t - pushed)[partner] * flip
        return pushed, out

    def lid_trouble(pushed, lids):
        # Faces the lids turn over (alone and mixed as the contract mixes them) and eyeball the closed lids show.
        m = {k[:-4] if k.endswith('Left') else k: v for k, v in lids.items() if k.endswith('Left')}
        pose = lambda weights: pushed + sum(w * (m[n] - pushed) for n, w in weights.items())
        # The mixes the contract turns faces over in (each morph at half and full, the emotion presets' lid parts) and
        # the closed ones it looks for eyeball through.
        mixes = [{n: w} for n in ('eyeBlink', 'eyeSquint', 'eyeWide') for w in (.5, 1)]
        mixes += [{'eyeBlink': .35}, {'eyeSquint': .2}, {'eyeSquint': .45}, {'eyeBlink': .25, 'eyeSquint': .45}]
        closed = [{'eyeBlink': 1}, {'eyeBlink': 1, 'eyeSquint': 1}, {'eyeBlink': 1, 'eyeWide': 1}, {'eyeBlink': 1, 'eyeSquint': 1, 'eyeWide': 1}]
        tris = flat_triangles(pushed, faces)[0]   # the triangles the GLB will carry
        folds = sum(len(flipped(pushed, pose(mix), tris)) for mix in mixes)
        # (a little stricter than the contract, which samples coarser and from fewer pitches: a margin for its grid)
        shows = sum(eyeball_shows(pose(mix), faces, c, r, rays=64) for mix in closed)
        shows += sum(eyeball_shows(pose(mix), faces, c, r, rays=64, pitch=p, band=.7) for mix in closed for p in (-30, -25, -20, -15, -10, 15, 20))
        above, below = eye_crease_folds(pushed, faces, c, r)
        return folds + 5 * max(0, above - 1) + 5 * max(0, below - 1), shows
    # A few lid shapes, gentlest first: the first that folds nothing and hides the eyeball when closed wins (a round
    # stylized eye needs its corners tapered just so); failing that, the one that does least harm.
    best = None
    for params in LID_CANDIDATES:
        pushed, lids = build_lids(params)
        folds, shows = lid_trouble(pushed, lids)
        score = (shows > 0, folds + shows)
        if best is None or score < best[0]: best = (score, pushed, lids)
        if not folds and not shows: break
    _, P, lids = best
    morphs.update(lids)
    for unit in units:
        if unit not in morphs: morphs[unit] = P + deltas[unit]

    # jawOpen: the face unit's own jaw (it knows which rows are the lower lip), opened further (a puppet's chin
    # drops a tenth of the face), with the upper lip and everything above the mouth line held still. The rigid mouth
    # parts (lower teeth, tongue) follow its best rigid fit on the chin.
    mouth_z = marks['stomion'][2]
    jaw = morphs['jawOpen'] - P
    # Opened just far enough that the chin (the face's lowest point) drops 11% of the face's height, the contract's
    # puppet jaw (the face unit is a realistic jaw's travel; a stylized chin is short).
    kept = P[:, 2] >= (neck_z if neck_z is not None else -np.inf)   # (what the crop below keeps)
    height = P[kept, 2].max() - P[kept, 2].min()
    drop = P[kept, 2].min() - (P + jaw)[kept, 2].min()
    jaw *= float(np.clip(.11 * height / max(drop, 1e-9), .6, 1.5))
    hold = np.clip((P[:, 2] - mouth_z - .002 * scale[2]) / (.004 * scale[2]), 0, 1)
    jaw *= (1 - hold)[:, None]
    morphs['jawOpen'] = P + jaw
    move = np.linalg.norm(jaw, axis=1)
    chin = (move > .7 * move.max()) & (P[:, 2] < mouth_z)
    rigid = RigidJaw(P[chin], morphs['jawOpen'][chin])
    # The mouth's bag below the lips swings with the jaw as one piece (the face unit folds its floor).
    cx0 = abs(marks['mouth_corner_L'][0])
    t = np.clip((mouth_z - .002 * scale[2] - P[:, 2]) / (.006 * scale[2]), 0, 1)
    bag = (P[:, 1] > marks['stomion'][1] + .008 * scale[1]) & (np.abs(P[:, 0]) < 1.4 * cx0)         & (np.hypot(P[:, 0], P[:, 1] - center[1]) < 1.2 * (neck[0] if neck is not None else radii[0]))
    w = np.where(bag, t * t * (3 - 2 * t), 0.0)[:, None]
    swung = np.array([rigid.move(p) for p in P])
    morphs['jawOpen'] = morphs['jawOpen'] * (1 - w) + swung * w
    # The upper lip's inner edge (the rows just above the mouth line, in front) follows a little, so the faces that
    # close the lips' crack stretch open instead of turning over.
    edge = (P[:, 2] > mouth_z - .001 * scale[2]) & (P[:, 1] < marks['stomion'][1] + .008 * scale[1])         & (np.abs(P[:, 0]) < 1.1 * cx0)
    near_line = np.clip(1 - (P[:, 2] - mouth_z) / (.0025 * scale[2]), 0, 1)
    follow = np.where(edge, .12 * near_line, 0.0)[:, None]
    moved = np.linalg.norm(morphs['jawOpen'] - P, axis=1)[:, None] > 1e-9
    morphs['jawOpen'] = np.where(moved & (follow == 0), morphs['jawOpen'], morphs['jawOpen'] * (1 - follow) + swung * follow)

    # Crop at the neck, keeping the mouth's bag (it hangs down inside the neck).
    if neck_z is not None:
        cx0 = abs(marks['mouth_corner_L'][0])
        def kept(f):
            q = P[[i for i in f if i >= 0]]
            if q[:, 2].min() >= neck_z: return True
            return bool(np.all(np.abs(q[:, 0]) < 1.4 * cx0) and np.all(q[:, 1] > marks['stomion'][1]) and q[:, 2].min() > neck_z - .025 * scale[2]
                        and np.all(np.hypot(q[:, 0], q[:, 1] - center[1]) < .8 * (neck[0] if neck else 1)))
        faces = faces[np.array([kept(f) for f in faces])]
    used = np.unique(faces[faces >= 0])
    remap = -np.ones(len(P), dtype=np.int64); remap[used] = np.arange(len(used))
    faces = np.where(faces >= 0, remap[np.maximum(faces, 0)], -1)
    V = P[used]
    morphs = {k: v[used] for k, v in morphs.items()}

    # The mouth's inside: faces the front cannot see at rest (behind the lips, deeper than the skin in front of them),
    # and faces the open jaw shows between the lips (inside the opening, well behind the lips' front).
    iod = marks['eye_center_L'][0] - marks['eye_center_R'][0]
    cx = abs(marks['mouth_corner_L'][0])
    corners = [[i for i in f if i >= 0] for f in faces]
    cen = np.array([V[c].mean(0) for c in corners])
    region = (np.abs(cen[:, 0]) < 1.6 * cx) & (np.abs(cen[:, 2] - mouth_z) < .8 * iod) & (cen[:, 1] > marks['stomion'][1] + .001 * scale[1])
    box, pixel = (-1.7 * cx, 1.7 * cx, mouth_z - .9 * iod, mouth_z + .9 * iod), .0005 * scale[0]
    D = depth_map(V, faces, box, pixel)
    inside = np.zeros(len(faces), dtype=bool)
    for k in np.nonzero(region)[0]:
        i, j = int((cen[k, 0] - box[0]) / pixel), int((cen[k, 2] - box[2]) / pixel)
        if 0 <= j < D.shape[0] and 0 <= i < D.shape[1] and cen[k, 1] > D[j, i] + .002 * scale[1]: inside[k] = True
    opened = morphs['jawOpen']
    lower = np.argmin(np.linalg.norm(V - (np.asarray(marks['stomion']) - [0, 0, .002 * scale[2]]), axis=1))
    low_z = opened[lower, 2]
    cen_open = np.array([opened[c].mean(0) for c in corners])
    across = np.clip(np.abs(cen_open[:, 0]) / cx, 0, 1)
    floor = low_z + (mouth_z - low_z) * across ** 2
    gap = region & (np.abs(cen_open[:, 0]) < cx) & (cen_open[:, 2] < mouth_z - .001 * scale[2]) & (cen_open[:, 2] > floor + .001 * scale[2])
    inside |= gap

    # Inside the mouth, the expressions' motion is smoothed and halved: the face units crumple the mouth's inner corners.
    inner = np.unique(faces[inside][faces[inside] >= 0])
    edges = edges_of(faces)
    for name in morphs:
        if name == 'jawOpen' or name.startswith('eye'): continue
        d = morphs[name] - V
        d[inner] = .5 * smooth_deltas(d, edges, iterations=8)[inner]
        morphs[name] = V + d

    # Triangles, split along each quad's flatter diagonal: the morph checks below hold for exactly the triangles the
    # GLB carries (an exporter's own split of a folded quad at the lips' corners can turn over).
    faces, source = flat_triangles(V, faces)
    inside = inside[source]
    # No morph, alone or in an emotion preset, may turn a face over.
    from agent_meshes_face import CANONICAL_EMOTIONS
    mixes = [dict(p) for p in CANONICAL_EMOTIONS.values() if p] + [dict(p, jawOpen=1.0) for p in CANONICAL_EMOTIONS.values() if p]
    for side in ('Left', 'Right'):
        mixes += [{f'eyeBlink{side}': w} for w in (.25, .5, .75)] + [{f'eyeBlink{side}': w, f'eyeSquint{side}': 1.0} for w in (.25, .5, .75, 1.0)]
        mixes += [{f'eyeBlink{side}': 1.0, f'eyeWide{side}': 1.0}, {f'eyeBlink{side}': 1.0, f'eyeSquint{side}': 1.0, f'eyeWide{side}': 1.0}]
    # The jaw unfolds too, but only by relaxing its edges: the lips and chin (half its motion or more) keep theirs.
    jaw_move = np.linalg.norm(morphs['jawOpen'] - V, axis=1)
    unfolded, _ = unfold_morphs(V, faces, {'jawOpen': morphs['jawOpen']}, pinned=jaw_move > .85 * jaw_move.max(), calm=False, iterations=80,
                                coherent=True)
    morphs.update(unfolded)
    lids = [n for n in morphs if n.startswith(('eyeBlink', 'eyeSquint', 'eyeWide'))]
    morphs, _ = unfold_morphs(V, faces, morphs, mixes, keep=lids + ['jawOpen'])
    # Lids that still turn a face over (a twist in the inner corner's pocket) relax there, their margins pinned: the
    # first pin that leaves nothing turned over and the closed eye covered wins.
    if any(len(flipped(V, morphs[n], faces)) for n in lids):
        for threshold in (.8, .6, .4, .25):
            pinned = np.zeros(len(V), dtype=bool)
            for side in ('Left', 'Right'):
                m = np.linalg.norm(morphs[f'eyeBlink{side}'] - V, axis=1)
                pinned |= m > threshold * m.max()
            trial, _ = unfold_morphs(V, faces, {n: morphs[n] for n in lids}, [{n: .5} for n in lids], pinned=pinned, calm=False, iterations=60)
            closed_ok = all(eyeball_shows(V + sum(trial[f'{n}{side}'] - V for n in combo), faces, eye_c, eye_r, rays=64, pitch=p,
                                          band=None if p == 0 else .7) == 0
                            for side, (eye_c, eye_r) in (('Left', eyes[0]), ('Right', eyes[1]))
                            for combo in (('eyeBlink',), ('eyeBlink', 'eyeWide'), ('eyeBlink', 'eyeSquint', 'eyeWide'))
                            for p in (0, -30, -25, -20, -15, -10, 15, 20))
            if closed_ok and not any(len(flipped(V, trial[n], faces)) for n in lids):
                morphs.update(trial)
                break


    # The lash line: the upper lid's margin rows (the vertices blink moves at least 85% as far as its margin).
    lash = set()
    for suffix, (c, r) in (('Left', eyes[0]), ('Right', eyes[1])):
        m = np.linalg.norm(morphs[f'eyeBlink{suffix}'] - V, axis=1)
        lash |= set(np.nonzero((m > .85 * m.max()) & (V[:, 1] < c[1]) & (np.linalg.norm(V - c, axis=1) < 1.6 * r))[0].tolist())
    inner = np.unique(faces[inside][faces[inside] >= 0])
    box = (V[inner].min(0), V[inner].max(0)) if len(inner) else None
    return {'vertices': V, 'faces': faces, 'morphs': morphs, 'eyes': eyes, 'landmarks': marks, 'mouth_inside': inside, 'source': used,
            'mouth_box': box, 'lash': sorted(lash), 'jaw': rigid, 'scale': scale}


def _cranium_inside(P, marks, center, radii, fill=.975):
    """Moves that bring the cranium (above the brows, and behind the face) inside `fill` of the envelope, easing in
    from the brows up and fading to nothing on the face."""
    c, r = np.asarray(center, dtype=np.float64), np.asarray(radii, dtype=np.float64)
    rel = (P - c) / r
    level = np.linalg.norm(rel, axis=1)
    brow = marks['nasion'][2] + .3 * (marks['crown'][2] - marks['nasion'][2])
    up = np.clip((P[:, 2] - brow) / (.15 * (marks['crown'][2] - brow)), 0, 1)
    # Behind the ears (past the envelope's middle), above the jaw: the face in front may stand out of the envelope.
    back = np.clip((P[:, 1] - c[1]) / (.3 * r[1]), 0, 1) * (P[:, 2] > marks['stomion'][2])
    w = np.maximum(up, back)
    over = np.maximum(level / fill, 1.0)
    return (c + rel / over[:, None] * r - P) * w[:, None]


def _neck_graft(P, neck_z, neck, marks, scale=1.0):
    """Moves that ease the neck's rows (behind the chin, from a little above the chin's bottom down to the crop) onto
    the body's neck ellipse, 0.5 mm out."""
    ax, ay = neck
    top = marks['menton'][2] + .03 * scale
    w = np.clip((top - P[:, 2]) / max(1e-6, top - neck_z), 0, 1) ** 1.5
    behind = np.clip((P[:, 1] - marks['menton'][1] - .005 * scale) / (.02 * scale), 0, 1)
    w = w * behind * behind * (3 - 2 * behind)
    x, y = P[:, 0], P[:, 1]
    level = np.sqrt((x / ax) ** 2 + (y / ay) ** 2)
    target = (1 + .0005 / min(ax, ay)) / np.maximum(level, 1e-9)
    moved = np.stack([x * target, y * target, P[:, 2]], axis=1)
    return (moved - P) * w[:, None]
