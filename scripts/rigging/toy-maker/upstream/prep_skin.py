"""Stable-venv: transfer per-sampled-point weights to per-mesh-vertex weights."""
import os
import numpy as np
import trimesh

sp = os.path.dirname(os.path.abspath(__file__))
GLB = os.environ["SRC_GLB"]

m = trimesh.load(GLB, force="mesh")
V = np.asarray(m.vertices, np.float32)
F = np.asarray(m.faces, np.int64)

# carry UV + baked texture through so the animated toy keeps its look
uv = getattr(m.visual, "uv", None)
if uv is not None:
    uv = np.asarray(uv, np.float32).copy()
    uv[:, 1] = 1.0 - uv[:, 1]     # trimesh flips V on glTF import; flip back for re-export
tex_png = None
_mat = getattr(m.visual, "material", None)
if _mat is not None:
    _img = getattr(_mat, "baseColorTexture", None) or getattr(_mat, "image", None)
    if _img is not None:
        from io import BytesIO
        _b = BytesIO(); _img.save(_b, "PNG"); tex_png = np.frombuffer(_b.getvalue(), np.uint8)

r = np.load(os.environ.get("RIG_NPZ", os.path.join(sp, "rig_result2.npz")), allow_pickle=True)
center = r["norm_center"].astype(np.float32)
scale = float(r["norm_scale"])
Vn = (V - center) / scale                        # normalize like the rig did
samp = r["sampled_vertices"].astype(np.float32)  # normalized 2048 pts
W = r["skin_weights"].astype(np.float32)         # (2048, J) learned weights
Jn = W.shape[1]
BACKEND = str(r["skin_backend"]) if "skin_backend" in r.files else "unirig"

if BACKEND == "skintokens":
    # SkinTokens weights are already per-mesh-vertex and joint-aware. The
    # transfer/anatomy/rebalance steps below exist to compensate UniRig's
    # sampled-point bleed and measurably HURT these weights (R4 eval) — pass
    # them through untouched.
    assert len(W) == len(Vn), f"skintokens weights {W.shape} vs mesh {len(Vn)} verts"
    Wv = W / (W.sum(1, keepdims=True) + 1e-8)
    print(f"skintokens passthrough: {Wv.shape} weights, filters skipped")
else:
    # Transfer UniRig's learned per-point weights to mesh vertices by blending the
    # K nearest sampled points (inverse-distance). Blending avoids hard weight
    # seams -> smooth bending at joints instead of stretching.
    K = 8
    from scipy.spatial import cKDTree
    d, idx = cKDTree(samp).query(Vn, k=K)          # (V,K)
    d = np.maximum(d, 1e-5)
    w_inv = 1.0 / (d * d)
    # cap the blend radius: at sparsely-sampled extremities (hands, feet) far
    # neighbors sit up the limb and drag in wrong-bone weights -> tearing/spikes
    w_inv[d > 2.5 * d[:, :1]] = 0.0
    w_inv /= w_inv.sum(1, keepdims=True)
    Wv = np.einsum("vk,vkj->vj", w_inv.astype(np.float32), W[idx])  # (V,J)
    # prune rogue small influences, then renormalize
    Wv[Wv < 0.1 * Wv.max(axis=1, keepdims=True)] = 0.0
    Wv = Wv / (Wv.sum(1, keepdims=True) + 1e-8)

    # anatomical sanity filter: a vertex may only follow bones whose segment passes
    # near it. Kills cross-limb contamination (left-foot verts weighted to right-leg
    # bones tear apart when the legs swing opposite ways) and noisy far-bone weights.
    jn = r["joints"].astype(np.float32)
    par = [(-1 if p is None else int(p)) for p in r["parents"]]
    kids = {j: [c for c in range(Jn) if par[c] == j] for j in range(Jn)}
    seg_d = np.full((len(Vn), Jn), np.inf, np.float32)
    for j in range(Jn):
        a = jn[j]
        ends = [jn[c] for c in kids[j]] or [a]
        dj = np.full(len(Vn), np.inf, np.float32)
        for b in ends:
            ab = b - a; L2 = float(ab @ ab)
            if L2 < 1e-12:
                dd = np.linalg.norm(Vn - a, axis=1)
            else:
                t = np.clip(((Vn - a) @ ab) / L2, 0, 1)
                dd = np.linalg.norm(Vn - (a + t[:, None] * ab), axis=1)
            dj = np.minimum(dj, dd)
        seg_d[:, j] = dj
    near = seg_d.min(1, keepdims=True)
    allowed = seg_d <= np.maximum(2.0 * near, 0.15)      # local bones only (~7% of height)
    before = int((Wv > 0).sum())
    Wv = np.where(allowed, Wv, 0.0)
    empty = Wv.sum(1) < 1e-8
    Wv[np.where(empty)[0], np.argmin(seg_d[empty], axis=1)] = 1.0
    Wv = Wv / (Wv.sum(1, keepdims=True) + 1e-8)
    print(f"anatomy filter: removed {before - int((Wv > 0).sum())} cross-limb influences; "
          f"{int(empty.sum())} verts snapped to nearest bone")

    # A bone must not skin vertices that lie PAST its distal joint. Otherwise a static
    # parent (e.g. a held clavicle) keeps gripping the child limb's skin, so when the
    # child bends the mesh breaks at the joint instead of following it. For each
    # unambiguous limb link (single child) hand the parent's weight on past-the-joint
    # vertices to the child, ramped over the last 15% before the joint so the handoff
    # is smooth (this also feathers the bend). Proximal->distal so it cascades down.
    # Fraction of the past-joint weight to hand off. Full (1.0) welds the whole upper
    # arm to the shoulder -> no break but the bend concentrates at one joint and LBS
    # pumps the arm volume ~+-17% under run's big swing. 0 leaves the shoulder break.
    # 0.6 keeps the arm following the shoulder (no break) while blending some clavicle
    # weight back in, which spreads the bend and roughly halves the volume pump.
    REBALANCE_STRENGTH = float(os.environ.get("REBALANCE_STRENGTH", "0.6"))
    root_j = par.index(-1)
    order = []; stack = [root_j]
    while stack:
        n = stack.pop(); order.append(n); stack.extend(kids[n])
    for j in order:
        kc = kids[j]
        if len(kc) != 1:                 # skip torso / hand branches, only limb links
            continue
        c = kc[0]
        ab = jn[c] - jn[j]; L2 = float(ab @ ab)
        if L2 < 1e-12:
            continue
        t = ((Vn - jn[j]) @ ab) / L2     # projection param along the bone (0=head,1=joint)
        frac = np.clip((t - 0.85) / 0.15, 0.0, 1.0)
        move = Wv[:, j] * frac * REBALANCE_STRENGTH
        Wv[:, c] += move; Wv[:, j] -= move
    Wv = Wv / (Wv.sum(1, keepdims=True) + 1e-8)

extra = {"skin_backend": np.str_(BACKEND)}
if uv is not None and len(uv) == len(V):
    extra["uv"] = uv
if tex_png is not None:
    extra["texture_png"] = tex_png
np.savez(os.environ.get("OUT_RIGGED", os.path.join(sp, "rigged_input.npz")),
         vertices=Vn, faces=F, weights=Wv.astype(np.float32),
         joints=r["joints"], parents=r["parents"], names=r["names"], tails=r["tails"], **extra)
print(f"prepped: {len(Vn)} verts, weights {Wv.shape}, {Jn} joints; "
      f"uv={'yes' if 'uv' in extra else 'no'} texture={'yes' if 'texture_png' in extra else 'no'}")
