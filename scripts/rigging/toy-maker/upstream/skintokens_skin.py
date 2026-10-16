"""SkinTokens skin backend (stable venv): skin OUR chosen candidate skeleton.

Flow (see rigging/skintokens/README.md for the sidecar + its gotchas):
  1. mesh.npz + cand.npz -> skeleton GLB with nearest-segment dummy weights
     (their trim_skeleton deletes skinless subtrees; all-root collapses to 1 bone)
  2. sidecar demo.py --use_skeleton -> skinned GLB (bpy export splits verts)
  3. exact nearest-position remap back to our mesh/bone order
  4. write a rig_result.npz-compatible artifact tagged skin_backend="skintokens"
     so prep_skin passes the weights through untouched and retarget_plan skips
     the UniRig-compensation filters (geodesic/unshred).

R4 eval (docs/specs/2026-07-06-skeleton-quality-2.md): these raw weights beat
the filtered UniRig skin on every bench (spider worst-frame stretch 183 vs 2157).
"""
import os
import subprocess

import numpy as np

SIDECAR = os.environ.get("SKINTOKENS_DIR", r"C:\Users\ehart\repos\SkinTokens")
VENV_PY = os.path.join(SIDECAR, ".venv", "Scripts", "python.exe")
CKPT = os.path.join(SIDECAR, "experiments",
                    "articulation_xl_quantization_256_token_4", "grpo_1400.ckpt")


def sidecar_available() -> bool:
    return os.path.exists(VENV_PY) and os.path.exists(CKPT)


def _normalize(verts):
    """Same normalization as unirig.direct.normalize_vertices ([-1,1] box)."""
    lo, hi = verts.min(0), verts.max(0)
    center = (lo + hi) / 2
    scale = float((hi - lo).max() / 2) or 1.0
    return ((verts - center) / scale).astype(np.float32), center.astype(np.float32), scale


def _load_cand(cand_npz):
    c = np.load(cand_npz, allow_pickle=True)
    joints = np.asarray(c["joints"], np.float32)
    parents = [(-1 if p is None else int(p)) for p in c["parents"]]
    names = [str(n) for n in c["names"]] if len(c["names"]) else \
            [f"bone_{i}" for i in range(len(joints))]
    return c, joints, parents, names


def build_skeleton_glb(mesh_npz, cand_npz, out_glb):
    """Mesh + candidate skeleton as a skinned glTF Blender imports as an armature."""
    from pygltflib import (
        GLTF2, Scene, Node, Mesh, Primitive, Attributes, Skin, Buffer, BufferView,
        Accessor, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT,
        UNSIGNED_SHORT, SCALAR, VEC3, VEC4, MAT4,
    )
    m = np.load(mesh_npz)
    verts, _, _ = _normalize(m["vertices"].astype(np.float32))
    faces = m["faces"].astype(np.uint32)
    _, joints, parents, names = _load_cand(cand_npz)
    J, V = len(joints), len(verts)
    root = parents.index(-1)
    children = {i: [] for i in range(J)}
    for i, p in enumerate(parents):
        if p >= 0:
            children[p].append(i)

    local_t = joints.copy()
    for i in range(J):
        if parents[i] >= 0:
            local_t[i] = joints[i] - joints[parents[i]]
    ibm = np.tile(np.eye(4, dtype=np.float32), (J, 1, 1))
    for i in range(J):
        ibm[i, 3, 0:3] = -joints[i]

    # nearest-bone-segment dummy weights: throwaway, but every bone's subtree
    # must carry skin or their trim_skeleton deletes it
    def seg_dist(p, a, b):
        ab = b - a
        t = np.clip(((p - a) @ ab) / (ab @ ab + 1e-12), 0, 1)
        return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)
    D = np.stack([seg_dist(verts, joints[parents[i]] if parents[i] >= 0 else joints[i],
                           joints[i]) for i in range(J)], axis=1)
    ji = np.zeros((V, 4), np.uint16)
    ji[:, 0] = D.argmin(1).astype(np.uint16)
    # guarantee EVERY bone owns at least one vertex — else a bone no vertex picks as
    # nearest (a buried leaf tip, or a short middle segment between close evenly-spaced
    # leg joints) carries no dummy skin and trim_skeleton deletes it, so extract_weights
    # sees N-k of N bones and the whole skin fails. Give each bone its nearest UNTAKEN
    # vertex — V >> J, so every bone is guaranteed a distinct anchor.
    taken = np.zeros(V, bool)
    for b in range(J):
        for v in np.argsort(D[:, b]):
            if not taken[v]:
                ji[v, 0] = b
                taken[v] = True
                break
    jw = np.tile(np.array([1, 0, 0, 0], np.float32), (V, 1))

    blob = bytearray(); bviews = []; accs = []
    def av(b, t=None):
        nonlocal blob
        blob += b"\x00" * (-len(blob) % 4); off = len(blob); blob += b
        bviews.append(BufferView(buffer=0, byteOffset=off, byteLength=len(b), target=t))
        return len(bviews) - 1
    def ac(v, ct, n, at, mn=None, mx=None):
        accs.append(Accessor(bufferView=v, componentType=ct, count=n, type=at, min=mn, max=mx))
        return len(accs) - 1

    pa = ac(av(verts.tobytes(), ARRAY_BUFFER), FLOAT, V, VEC3,
            verts.min(0).tolist(), verts.max(0).tolist())
    ja = ac(av(ji.tobytes(), ARRAY_BUFFER), UNSIGNED_SHORT, V, VEC4)
    wa = ac(av(jw.tobytes(), ARRAY_BUFFER), FLOAT, V, VEC4)
    ia = ac(av(faces.reshape(-1).tobytes(), ELEMENT_ARRAY_BUFFER), UNSIGNED_INT,
            faces.size, SCALAR)
    ibm_a = ac(av(ibm.tobytes()), FLOAT, J, MAT4)

    prim = Primitive(attributes=Attributes(POSITION=pa, JOINTS_0=ja, WEIGHTS_0=wa), indices=ia)
    base = 1
    nodes = [Node(mesh=0, skin=0, name="toy")]
    for i in range(J):
        nodes.append(Node(translation=local_t[i].tolist(), name=names[i]))
    for i in range(J):
        if children[i]:
            nodes[base + i].children = [base + k for k in children[i]]

    g = GLTF2()
    g.scenes = [Scene(nodes=[0, base + root])]; g.scene = 0; g.nodes = nodes
    g.meshes = [Mesh(primitives=[prim])]
    g.skins = [Skin(joints=[base + i for i in range(J)], inverseBindMatrices=ibm_a,
                    skeleton=base + root)]
    g.bufferViews = bviews; g.accessors = accs
    g.buffers = [Buffer(byteLength=len(blob))]; g.set_binary_blob(bytes(blob))
    g.save(str(out_glb))


def extract_weights(st_glb, mesh_npz, cand_npz):
    """(V, J) weights from the SkinTokens output, in OUR vertex + bone order."""
    from pygltflib import GLTF2
    from scipy.spatial import cKDTree
    g = GLTF2().load(str(st_glb))
    blob = g.binary_blob()

    def acc(ai):
        a = g.accessors[ai]; bv = g.bufferViews[a.bufferView]
        dt = {5126: np.float32, 5121: np.uint8, 5123: np.uint16, 5125: np.uint32}[a.componentType]
        nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a.type]
        arr = np.frombuffer(blob, dt, count=a.count * nc,
                            offset=(bv.byteOffset or 0) + (a.byteOffset or 0))
        return arr.reshape(a.count, nc) if nc > 1 else arr

    P_all, JI_all, JW_all = [], [], []
    skin = g.skins[0]
    for mesh in g.meshes:
        for prim in mesh.primitives:
            if prim.attributes.JOINTS_0 is None:
                continue
            P_all.append(acc(prim.attributes.POSITION).astype(np.float64))
            JI_all.append(acc(prim.attributes.JOINTS_0).astype(int))
            JW_all.append(acc(prim.attributes.WEIGHTS_0).astype(np.float64))
    P = np.concatenate(P_all); JI = np.concatenate(JI_all); JW = np.concatenate(JW_all)
    names_out = [g.nodes[n].name for n in skin.joints]

    m = np.load(mesh_npz)
    verts, _, _ = _normalize(m["vertices"].astype(np.float64))
    _, joints, _, names_ours = _load_cand(cand_npz)
    J = len(joints)
    col = {k: names_ours.index(nm) for k, nm in enumerate(names_out) if nm in names_ours}
    # SkinTokens sampling is un-seeded, so it occasionally trims a few bones it gives
    # ~0 weight (their verts redistribute to neighbours). Tolerate a handful — hard-
    # failing sends the whole rig to the incompatible UniRig skinner. Only a wholesale
    # collapse (skeleton renamed/lost) is a real error.
    if len(col) < J - 6:
        raise RuntimeError(f"skintokens returned {len(col)}/{J} of our bones "
                           f"(skeleton collapsed or renamed)")

    d, idx = cKDTree(P).query(verts)
    if d.max() > 1e-3:      # bpy round-trip should be an exact vertex superset
        raise RuntimeError(f"vertex remap too far off (max dist {d.max():.4f})")
    W = np.zeros((len(verts), J))
    for slot in range(JW.shape[1]):
        ji, jw = JI[idx, slot], JW[idx, slot]
        for k, our in col.items():
            sel = ji == k
            W[sel, our] += jw[sel]
    rs = W.sum(1, keepdims=True)
    if (rs[:, 0] == 0).sum() > 0.01 * len(verts):
        raise RuntimeError(f"{int((rs[:,0]==0).sum())} verts got no weight")
    return np.divide(W, rs, out=np.zeros_like(W), where=rs > 0).astype(np.float32)


def _smooth_weights(W, faces, iters, lam=0.5):
    """Laplacian-smooth skin weights over the mesh graph: blend each vertex's
    weight row toward its edge-neighbours' mean, then renormalize. Softens the
    hard per-bone segment boundaries that make a multi-jointed limb read as rigid
    faceted shards (candy-wrapper) — used for the procedural spider legs."""
    from scipy.sparse import coo_matrix, diags
    V = W.shape[0]
    e = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    i = np.r_[e[:, 0], e[:, 1]]
    j = np.r_[e[:, 1], e[:, 0]]
    A = coo_matrix((np.ones(len(i), np.float32), (i, j)), shape=(V, V)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()
    deg[deg == 0] = 1.0
    An = diags(1.0 / deg) @ A
    for _ in range(iters):
        W = (1 - lam) * W + lam * (An @ W)
    rs = W.sum(1, keepdims=True)
    rs[rs == 0] = 1.0
    return (W / rs).astype(np.float32)


def skin_to_rig_result(mesh_npz, cand_npz, out_npz, work_dir, timeout=600):
    """Run the sidecar and write a rig_result.npz-compatible artifact
    (skin_weights per FULL-MESH vertex + skin_backend tag for prep_skin)."""
    work_dir = os.path.abspath(str(work_dir))     # sidecar resolves paths against ITS cwd
    skel_glb = os.path.join(work_dir, "st_skeleton.glb")
    out_glb = os.path.join(work_dir, "st_skinned.glb")
    build_skeleton_glb(mesh_npz, cand_npz, skel_glb)
    # SkinTokens is un-seeded; a run occasionally collapses a few bones (esp. the
    # close, evenly-spaced spider leg joints). Retry — a fresh sample usually keeps
    # them all — before giving up to the (incompatible) UniRig fallback.
    W = None
    for attempt in range(4):
        if os.path.exists(out_glb):
            os.remove(out_glb)
        r = subprocess.run([VENV_PY, "demo.py", "--input", skel_glb, "--output", out_glb,
                            "--use_skeleton"],
                           cwd=SIDECAR, capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, "HF_HUB_OFFLINE": "1"})
        if not os.path.exists(out_glb):
            raise RuntimeError("skintokens sidecar produced no GLB:\n" +
                               (r.stderr or r.stdout or "")[-800:])
        try:
            W = extract_weights(out_glb, mesh_npz, cand_npz)
            break
        except RuntimeError as e:
            if attempt == 3:
                raise
            print(f"skintokens attempt {attempt + 1} rejected ({e}); re-sampling")
    W = W if W is not None else extract_weights(out_glb, mesh_npz, cand_npz)

    m = np.load(mesh_npz)
    # optional weight smoothing (procedural spider legs stamp leg_smooth) — softens
    # the rigid per-segment faceting a multi-jointed limb otherwise shows
    cc = np.load(cand_npz, allow_pickle=True)
    sm = int(cc["leg_smooth"]) if "leg_smooth" in cc.files else 0
    if sm:
        W = _smooth_weights(W, m["faces"].astype(np.int64), sm)
    norm_v, center, scale = _normalize(m["vertices"].astype(np.float32))
    c, joints, parents, names = _load_cand(cand_npz)
    tails = c["tails"] if "tails" in c.files else joints
    np.savez(str(out_npz), joints=joints, parents=c["parents"],
             names=np.array(names, dtype=object), tails=tails,
             skin_weights=W, sampled_vertices=norm_v,
             norm_center=center, norm_scale=np.float32(scale),
             skin_backend=np.str_("skintokens"))
    print(f"skintokens skin: {W.shape} weights, rowsum ok, saved {out_npz}")
    return out_npz
