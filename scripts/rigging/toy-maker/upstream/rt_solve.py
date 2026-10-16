"""Shared retarget machinery — chain-agnostic solve + bake, extracted verbatim from
retarget2.py so body-plan retargeting (retarget_plan.py) reuses the proven core.

The pieces here know nothing about bipeds or Mixamo: they take a PAIRING (list of
(our_chain_joint_ids, source_chain_ids)), per-frame source world positions, and the
toy rig arrays, and produce the same GLB/USDZ retarget2 always produced.

Everything below is a mechanical move of validated code — treat edits with the same
care as retarget2 itself (the biped path calls straight into this).
"""
import math
import os
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from pygltflib import (
    GLTF2, Scene, Node, Mesh, Primitive, Attributes, Skin, Buffer, BufferView,
    Accessor, Animation, AnimationChannel, AnimationChannelTarget, AnimationSampler,
    Material, PbrMetallicRoughness, Image, Sampler, Texture, TextureInfo,
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, UNSIGNED_SHORT,
    SCALAR, VEC2, VEC3, VEC4, MAT4,
)


# ---------- rest-pose hypothesis scoring helpers ----------
def resample(pts, k=5):
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)]); cum /= (cum[-1] or 1.0)
    return np.stack([np.interp(np.linspace(0, 1, k), cum, pts[:, d]) for d in range(3)], 1)


def chain_cost(o_pts_local, m_pts_local, R):
    """Squared distance between resampled our-chain and rotated source-chain rests."""
    a = resample(o_pts_local); b = resample((R @ np.asarray(m_pts_local, float).T).T)
    return float(((a - b) ** 2).sum())


# ---------- loop trim (validated: clean pose-return cycle) ----------
def trim_loop(mpos):
    F = mpos.shape[1]
    ref = mpos[:, 0]; MINP = max(20, F // 12)
    D = np.array([float(np.linalg.norm(mpos[:, t] - ref, axis=1).mean()) for t in range(F)])
    NFR = MINP + int(np.argmin(D[MINP:]))
    print(f"loop: {NFR} frames")
    return NFR


def trim_loop_or_full(mpos):
    """trim_loop for cyclic clips; full length for one-shot clips (roar, death…).
    A cycle exists when some later frame nearly returns to frame 0 — judged
    relative to how far the clip strays overall. (Separate function so the byte-
    frozen biped path keeps calling trim_loop unchanged.)"""
    F = mpos.shape[1]
    ref = mpos[:, 0]; MINP = max(20, F // 12)
    D = np.array([float(np.linalg.norm(mpos[:, t] - ref, axis=1).mean()) for t in range(F)])
    if MINP >= F or D.max() < 1e-9:
        print(f"loop: {F} frames (short clip, full)")
        return F
    dmin = float(D[MINP:].min())
    NFR = MINP + int(np.argmin(D[MINP:]))
    # A cycle STRAYS THEN RETURNS: its near-frame-0 minimum comes after the
    # farthest point. A slow-starting one-shot (zombie death idles ~20 frames
    # before dropping) also has a small early minimum — without the
    # returned-after-straying test it trimmed to 20 frames of wind-up.
    if dmin > 0.35 * float(D.max()) or NFR < int(np.argmax(D)):
        print(f"loop: {F} frames (one-shot clip, full)")
        return F
    print(f"loop: {NFR} frames")
    return NFR


def root_bob(mpos, mrest, hips_idx, NFR, toy_hip_h, loop):
    """Vertical root motion from the source hips, scaled to the toy (#14).

    Loops reference the hips' MEAN height (pure zero-mean bounce — footfalls
    read grounded, average stance height unchanged); one-shots reference frame
    0 (death/stand-up genuinely travel vertically — start exactly where the
    static-root version did and carry the full drop/rise). Scale = toy hip
    height over source hip height (both measured to their own ground)."""
    hy = mpos[hips_idx, :NFR, 1]
    src_hip_h = float(mrest[hips_idx, 1] - mrest[:, 1].min())
    ref = float(hy.mean()) if loop else float(hy[0])
    bob = (hy - ref) * (toy_hip_h / max(src_hip_h, 1e-6))
    print(f"root bob: +-{(bob.max() - bob.min()) / 2:.3f} toy units "
          f"({'loop/mean' if loop else 'one-shot/frame0'} ref)")
    return bob.astype(np.float32)


# ---------- per-frame aim targets ----------
def arc_fracs(pts):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    return cum / (cum[-1] or 1.0)


def dir_at(mpts, fr, u, Rm):
    """unit direction of the source chain at arc fraction u, frame fr (our frame)"""
    pts = mpts[:, fr]                       # (K,3)
    fr_ = arc_fracs(pts)
    k = int(np.clip(np.searchsorted(fr_, u, side="right") - 1, 0, len(pts) - 2))
    d = pts[k + 1] - pts[k]
    d = Rm @ d
    n = np.linalg.norm(d)
    return d / (n + 1e-12)


def dir_at_rest(mrest_pts, u):
    """unit direction of the source REST chain at arc fraction u (no Rm)."""
    fr_ = arc_fracs(mrest_pts)
    k = int(np.clip(np.searchsorted(fr_, u, side="right") - 1, 0, len(mrest_pts) - 2))
    d = mrest_pts[k + 1] - mrest_pts[k]
    n = np.linalg.norm(d)
    return d / (n + 1e-12)


def _min_rot(a, b):
    """minimal rotation taking unit vector a to unit vector b."""
    v = np.cross(a, b); c = float(np.clip(np.dot(a, b), -1, 1))
    if np.linalg.norm(v) < 1e-8:
        return Rot.identity() if c > 0 else Rot.from_rotvec(math.pi * np.array([0, 1, 0]))
    return Rot.from_rotvec(v / np.linalg.norm(v) * math.acos(c))


def target_dir(mpts, mrest_pts, fr, u, Rm, mode, rest_dir):
    """toy-space target direction for a bone at arc fraction u, frame fr.

    abs   -> aim straight along the source chain's per-frame direction (limbs:
             proven; toy limb and source limb share a direction family).
    delta -> apply the source direction's rotation FROM ITS OWN REST to the toy's
             rest direction (axial chains: preserves the toy's posture — a horse's
             upright neck vs a fox's flat one — while adding the clip's sway/bob;
             absolute aiming there slams mismatched proportions flat).
    """
    tgt = dir_at(mpts, fr, u, Rm)
    if mode == "abs" or mrest_pts is None:
        return tgt
    rest_src = Rm @ dir_at_rest(mrest_pts, u)
    return _min_rot(rest_src, tgt).apply(rest_dir)


def _norm_pairing(PAIRING):
    """accept (chain, m_ids) [abs] or (chain, m_ids, mode) entries"""
    return [(p[0], p[1], p[2] if len(p) > 2 else "abs") for p in PAIRING]


def aim_targets(joints, PAIRING, mpos, Rm, NFR, mrest=None):
    """desired world rotation per aimed joint per frame: {j: [Rot]*NFR}"""
    world_target = {}
    for o_chain, m_ids, mode in _norm_pairing(PAIRING):
        o_pts = joints[np.array(o_chain)]
        fr_o = arc_fracs(o_pts)
        mpts = mpos[np.array(m_ids)]           # (K,F,3)
        mrest_pts = mrest[np.array(m_ids)] if (mrest is not None and mode == "delta") else None
        for si in range(len(o_chain) - 1):
            j = o_chain[si]
            u = (fr_o[si] + fr_o[si + 1]) / 2
            rest_dir = o_pts[si + 1] - o_pts[si]; rest_dir /= (np.linalg.norm(rest_dir) + 1e-12)
            rots_j = []
            for fr in range(NFR):
                tgt = target_dir(mpts, mrest_pts, fr, u, Rm, mode, rest_dir)
                rots_j.append(_min_rot(rest_dir, tgt))
                # note: minimal rotation -> no twist; fine for toys
            world_target[j] = rots_j
    return world_target


# ---------- de-twist (roll removal along chain axes) ----------
def detwist_axes(joints, chains):
    """{joint: unit axis} for every bone of the given chains (twist removed there)."""
    axes = {}
    for o_chain in chains:
        o_pts = joints[np.array(o_chain)]
        for si in range(len(o_chain) - 1):
            ax = o_pts[si + 1] - o_pts[si]; n = np.linalg.norm(ax)
            if n > 1e-9:
                axes[o_chain[si]] = ax / n
    return axes


def _remove_twist(rot, axis):
    q = rot.as_quat()                        # xyzw
    proj = float(q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2])
    tw = np.array([proj * axis[0], proj * axis[1], proj * axis[2], q[3]])
    nn = np.linalg.norm(tw)
    if nn < 1e-9:
        return rot
    return rot * Rot.from_quat(tw / nn).inv()


# ---------- FK solve locals ----------
def solve_locals(J, parents, children, root, world_target, detwist_axis, NFR):
    order = []; stack = [root]
    while stack:
        n = stack.pop(); order.append(n); stack.extend(children[n])
    rots = np.zeros((J, NFR, 4), np.float32); rots[:, :, 3] = 1.0
    for fr in range(NFR):
        world = {}
        for j in order:
            pw = world[parents[j]] if parents[j] >= 0 else Rot.identity()
            if j in world_target:
                local = pw.inv() * world_target[j][fr]
                if j in detwist_axis:
                    local = _remove_twist(local, detwist_axis[j])
                rots[j, fr] = local.as_quat().astype(np.float32)
                world[j] = pw * local            # propagate de-twisted frame to children
            else:
                world[j] = pw
    for j in range(J):
        for k in range(1, NFR):
            if float(np.dot(rots[j, k], rots[j, k - 1])) < 0:
                rots[j, k] = -rots[j, k]
    return rots


# ---------- numerical self-check ----------
def self_check(joints, PAIRING, mpos, Rm, world_target, NFR, mrest=None):
    errs = []
    for o_chain, m_ids, mode in _norm_pairing(PAIRING):
        o_pts = joints[np.array(o_chain)]
        fr_o = arc_fracs(o_pts); mpts = mpos[np.array(m_ids)]
        mrest_pts = mrest[np.array(m_ids)] if (mrest is not None and mode == "delta") else None
        for si in range(len(o_chain) - 1):
            j = o_chain[si]
            if j not in world_target: continue
            rest_dir = o_pts[si + 1] - o_pts[si]; rest_dir /= (np.linalg.norm(rest_dir) + 1e-12)
            u = (fr_o[si] + fr_o[si + 1]) / 2
            for fr in range(0, NFR, 10):
                got = world_target[j][fr].apply(rest_dir)
                want = target_dir(mpts, mrest_pts, fr, u, Rm, mode, rest_dir)
                errs.append(math.degrees(math.acos(float(np.clip(np.dot(got, want), -1, 1)))))
    print(f"self-check: mean bone-direction error {np.mean(errs):.2f} deg (max {np.max(errs):.2f})")
    return float(np.mean(errs)), float(np.max(errs))


# ---------- author GLB (toy + skeleton overlay) + animated usdz ----------
def bake(out, verts, faces, weights, joints, parents, children, root,
         rots, root_trans, NFR, uv=None, tex_png=None, show_skeleton=False, msize=1.0):
    J = len(joints)
    times = (np.arange(NFR) / 60.0).astype(np.float32)
    order4 = np.argsort(-weights, axis=1)[:, :4]
    jw = np.take_along_axis(weights, order4, axis=1).astype(np.float32); jw /= (jw.sum(1, keepdims=True) + 1e-8)
    ji = order4.astype(np.uint16)
    DIA = np.array([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]], np.float32)
    DT = np.array([[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]], np.uint32)
    s = 0.018 * msize
    ovp, ovj, ovf = [], [], []
    for j in range(J):
        base = len(ovp)
        for d in DIA: ovp.append(joints[j] + s*d); ovj.append([j,0,0,0])
        for t in DT: ovf.append(t + base)
    ovp = np.asarray(ovp, np.float32); ovj = np.asarray(ovj, np.uint16); ovf = np.asarray(ovf, np.uint32)
    ovw = np.tile(np.array([1,0,0,0], np.float32), (len(ovp), 1))
    lnp, lnj = [], []
    for i in range(J):
        if parents[i] >= 0:
            lnp.append(joints[parents[i]]); lnj.append([parents[i],0,0,0]); lnp.append(joints[i]); lnj.append([i,0,0,0])
    lnp = np.asarray(lnp, np.float32); lnj = np.asarray(lnj, np.uint16)
    lnw = np.tile(np.array([1,0,0,0], np.float32), (len(lnp), 1)); lni = np.arange(len(lnp), dtype=np.uint32)
    ibm = np.tile(np.eye(4, dtype=np.float32), (J,1,1))
    for i in range(J): ibm[i,3,0:3] = -joints[i]
    local_t = joints.copy()
    for i in range(J):
        if parents[i] >= 0: local_t[i] = joints[i] - joints[parents[i]]

    blob = bytearray(); bviews=[]; accs=[]
    def av(b,t=None):
        nonlocal blob
        blob += b"\x00"*(-len(blob)%4); off=len(blob); blob+=b
        bviews.append(BufferView(buffer=0,byteOffset=off,byteLength=len(b),target=t)); return len(bviews)-1
    def ac(v,ct,n,at,mn=None,mx=None):
        accs.append(Accessor(bufferView=v,componentType=ct,count=n,type=at,min=mn,max=mx)); return len(accs)-1
    def prim(pos,jia,jwa,idx,mode=4):
        pa=ac(av(pos.tobytes(),ARRAY_BUFFER),FLOAT,len(pos),VEC3,pos.min(0).tolist(),pos.max(0).tolist())
        ja=ac(av(jia.tobytes(),ARRAY_BUFFER),UNSIGNED_SHORT,len(pos),VEC4)
        wa=ac(av(jwa.tobytes(),ARRAY_BUFFER),FLOAT,len(pos),VEC4)
        ia=ac(av(idx.tobytes(),ELEMENT_ARRAY_BUFFER),UNSIGNED_INT,len(idx),SCALAR)
        return Primitive(attributes=Attributes(POSITION=pa,JOINTS_0=ja,WEIGHTS_0=wa),indices=ia,mode=mode)
    toy=prim(verts,ji,jw,faces.reshape(-1)); toy.material=0
    jt=prim(ovp,ovj,ovw,ovf.reshape(-1)); jt.material=1
    bn=prim(lnp,lnj,lnw,lni,mode=1); bn.material=2
    ibm_a=ac(av(ibm.tobytes()),FLOAT,J,MAT4)
    time_a=ac(av(times.tobytes()),FLOAT,NFR,SCALAR,[float(times.min())],[float(times.max())])
    rot_accs=[ac(av(np.ascontiguousarray(rots[i]).tobytes()),FLOAT,NFR,VEC4) for i in range(J)]
    roott_a=ac(av(root_trans.tobytes()),FLOAT,NFR,VEC3)
    base=1
    nodes=[Node(mesh=0,skin=0,name="rig")]
    for i in range(J): nodes.append(Node(translation=local_t[i].tolist(),name=f"bone_{i}"))
    for i in range(J):
        ks=[base+c for c in children[i]]
        if ks: nodes[base+i].children=ks
    root_node=base+root
    samplers=[]; channels=[]
    for i in range(J):
        samplers.append(AnimationSampler(input=time_a,output=rot_accs[i],interpolation="LINEAR"))
        channels.append(AnimationChannel(sampler=len(samplers)-1,target=AnimationChannelTarget(node=base+i,path="rotation")))
    samplers.append(AnimationSampler(input=time_a,output=roott_a,interpolation="LINEAR"))
    channels.append(AnimationChannel(sampler=len(samplers)-1,target=AnimationChannelTarget(node=root_node,path="translation")))
    def matl(rgba,emit=(0,0,0),blend=False):
        mm=Material(pbrMetallicRoughness=PbrMetallicRoughness(baseColorFactor=list(rgba),metallicFactor=0.0,roughnessFactor=1.0),emissiveFactor=list(emit),doubleSided=True)
        if blend: mm.alphaMode="BLEND"
        return mm
    g=GLTF2(); g.scenes=[Scene(nodes=[0,root_node])]; g.scene=0; g.nodes=nodes
    if show_skeleton:
        toy.material=0
        g.meshes=[Mesh(primitives=[toy,jt,bn])]
        g.materials=[matl((0.55,0.55,0.62,0.22),blend=True),matl((1,0.75,0.1,1),emit=(1.0,0.55,0.0)),matl((0.2,1.0,0.5,1),emit=(0.1,1.0,0.4))]
    else:                                   # clean toy only (app output)
        if uv is not None and tex_png is not None and len(uv) == len(verts):
            toy.attributes.TEXCOORD_0 = ac(av(np.ascontiguousarray(uv).tobytes(), ARRAY_BUFFER), FLOAT, len(uv), VEC2)
            img_bv = av(tex_png)            # embed PNG as a bufferView (no target)
            g.images=[Image(bufferView=img_bv, mimeType="image/png")]
            g.samplers=[Sampler(wrapS=10497, wrapT=10497)]
            g.textures=[Texture(source=0, sampler=0)]
            g.materials=[Material(pbrMetallicRoughness=PbrMetallicRoughness(
                baseColorTexture=TextureInfo(index=0), metallicFactor=0.0, roughnessFactor=1.0), doubleSided=True)]
            toy.material=0
        else:
            toy.material=None
        g.meshes=[Mesh(primitives=[toy])]
    g.skins=[Skin(joints=[base+i for i in range(J)],inverseBindMatrices=ibm_a,skeleton=root_node)]
    g.animations=[Animation(name="walk",samplers=samplers,channels=channels)]
    g.bufferViews=bviews; g.accessors=accs; g.buffers=[Buffer(byteLength=len(blob))]; g.set_binary_blob(bytes(blob))
    g.save(out)
    print(f"saved {out}: {NFR} frames")

    # also emit an animated .usdz for iOS AR Quick Look (clean app output only)
    if not show_skeleton:
        try:
            import usdskel
            usdz_out = os.path.splitext(out)[0] + ".usdz"
            usdskel.write_animated_usdz(usdz_out, verts, faces, ji, jw, joints, parents,
                                        local_t, rots, root_trans, root, uv=uv, tex_png=tex_png)
            print(f"saved {usdz_out}")
        except Exception as e:
            print(f"usdz (AR) skipped: {e}")
