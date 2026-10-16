"""Edge-stretch metric for an animated GLB: numpy-skin N frames, count edges
stretched beyond a ratio vs rest. The tear gate for skinning changes.

usage: python measure_stretch.py <glb> [ratio=1.6]
"""
import sys

import numpy as np
from pygltflib import GLTF2


def measure(path, ratio=1.6):
    g = GLTF2().load(path)
    blob = g.binary_blob()

    def acc(ai):
        a = g.accessors[ai]; bv = g.bufferViews[a.bufferView]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a.componentType]
        nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a.type]
        arr = np.frombuffer(blob, dt, count=a.count * nc,
                            offset=(bv.byteOffset or 0) + (a.byteOffset or 0))
        return arr.reshape(a.count, nc) if nc > 1 else arr

    prim = g.meshes[0].primitives[0]
    P = acc(prim.attributes.POSITION).astype(np.float64)
    JI = acc(prim.attributes.JOINTS_0).astype(int)
    JW = acc(prim.attributes.WEIGHTS_0).astype(np.float64)
    F = acc(prim.indices).astype(int).reshape(-1, 3)
    skin = g.skins[0]; jn = skin.joints
    parent = {}
    for i, n in enumerate(g.nodes):
        for c in (n.children or []):
            parent[c] = i
    loc_t = {j: np.array(g.nodes[j].translation or [0, 0, 0]) for j in jn}
    anim = g.animations[0]; rot = {}; tr = {}
    for ch in anim.channels:
        s = anim.samplers[ch.sampler]; out = acc(s.output)
        (rot if ch.target.path == "rotation" else tr)[ch.target.node] = out
    NF = len(next(iter(rot.values())))

    def qm(q):
        x, y, z, w = q; n = x * x + y * y + z * z + w * w
        s = 2.0 / n if n > 1e-12 else 0
        return np.array([[1 - s * (y * y + z * z), s * (x * y - w * z), s * (x * z + w * y)],
                         [s * (x * y + w * z), 1 - s * (x * x + z * z), s * (y * z - w * x)],
                         [s * (x * z - w * y), s * (y * z + w * x), 1 - s * (x * x + y * y)]])

    def wm(k):
        W = {}
        def go(j):
            R = qm(rot[j][k]) if j in rot else np.eye(3)
            t = tr[j][k] if j in tr else loc_t[j]
            M = np.eye(4); M[:3, :3] = R; M[:3, 3] = t
            W[j] = (W[parent[j]] if parent.get(j) in W else np.eye(4)) @ M
            for c in (g.nodes[j].children or []):
                go(c)
        for r0 in [j for j in jn if parent.get(j) not in jn]:
            go(r0)
        return W

    ibm = acc(skin.inverseBindMatrices).reshape(-1, 4, 4).transpose(0, 2, 1)
    jidx = {n: i for i, n in enumerate(jn)}
    e0 = np.linalg.norm(P[F[:, 0]] - P[F[:, 1]], axis=1) + 1e-9
    worst, total = 0, 0
    for k in range(0, NF, max(1, NF // 8)):
        W = wm(k); mats = np.stack([W[n] @ ibm[jidx[n]] for n in jn])
        out = np.zeros_like(P)
        for c in range(4):
            M = mats[JI[:, c]]
            out += JW[:, c, None] * (np.einsum("vij,vj->vi", M[:, :3, :3], P) + M[:, :3, 3])
        e1 = np.linalg.norm(out[F[:, 0]] - out[F[:, 1]], axis=1)
        n = int((e1 / e0 > ratio).sum())
        worst = max(worst, n); total += n
    return worst, total


if __name__ == "__main__":
    w, t = measure(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 1.6)
    print(f"worst-frame edges>{sys.argv[2] if len(sys.argv) > 2 else 1.6}x: {w}  (sum across sampled frames: {t})")
