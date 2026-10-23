"""Body-plan retargeting: mesh2motion animal clips onto UniRig toys.

The biped path (retarget2.py) is untouched; this script handles the other body
plans using the same proven machinery (rt_solve) with plan-driven detection:

  1. Source chains come from body_plans.LIBRARIES[SOURCE_LIB] (fixed, known rigs).
  2. Toy chains are detected geometrically from the UniRig skeleton by ONE generic
     detector parameterized per plan: N legs (2/4/8) + optional lateral pair
     (arms or wings) + spine walk + optional tail from leftovers.
  3. Every ambiguity (yaw facing, which toy leg is which source leg, lateral L/R)
     is resolved NUMERICALLY: hypotheses scored against the two rest skeletons.

Aim modes: limbs absolute (proven), axial chains (spine/tail) by DELTA from source
rest — absolute aiming slams mismatched proportions flat (horse neck vs fox spine).

Failure = SystemExit("CANTMOVE <kid-friendly reason>") so mocap surfaces the
specific reason (e.g. "this toy doesn't seem to have four legs").

env: RIGGED_INPUT, CLIP_PATH, OUT_GLB, SHOW_SKELETON, SOURCE_LIB
"""
import itertools
import os
import numpy as np
from scipy.spatial.transform import Rotation as Rot

import rt_solve as rt
import body_plans

sp = os.path.dirname(os.path.abspath(__file__))

# ---------- our rig (same load as retarget2) ----------
r = np.load(os.environ.get("RIGGED_INPUT", os.path.join(sp, "rigged_input.npz")), allow_pickle=True)
verts = r["vertices"].astype(np.float32); faces = r["faces"].astype(np.uint32)
weights = r["weights"].astype(np.float32); joints = r["joints"].astype(np.float64)
parents = [(-1 if p is None else int(p)) for p in r["parents"]]
uv = r["uv"].astype(np.float32) if "uv" in r.files else None
tex_png = r["texture_png"].tobytes() if "texture_png" in r.files else None
# skin backend stamp (prep_skin): geodesic/unshred are UniRig-bleed compensations
# and measurably HURT SkinTokens weights -> they default OFF for that backend
SKIN_BACKEND = str(r["skin_backend"]) if "skin_backend" in r.files else "unirig"
_FILT = "0" if SKIN_BACKEND == "skintokens" else "1"
J = len(joints); msize = float((joints.max(0) - joints.min(0)).max())
children = {i: [] for i in range(J)}
for i, p in enumerate(parents):
    if p >= 0: children[p].append(i)
root = parents.index(-1)
leaves = [i for i in range(J) if not children[i]]
y = joints[:, 1]

def chain_up(leaf):
    ch, cur = [leaf], leaf
    while parents[cur] >= 0 and parents[cur] != root and len(children[parents[cur]]) == 1:
        cur = parents[cur]; ch.append(cur)
    return list(reversed(ch))

# ---------- source clip + config ----------
m = np.load(os.environ["CLIP_PATH"], allow_pickle=True)
mnames = [str(n) for n in m["names"]]
mix = {n: i for i, n in enumerate(mnames)}
mpos = m["pose_world"][:, :, :3, 3].astype(np.float64)   # (B,F,3)
mrest = m["rest_head"].astype(np.float64)

LIB = os.environ["SOURCE_LIB"]
cfg = body_plans.LIBRARIES[LIB]
PLAN = cfg["plan"]

def src(names):
    ids = body_plans.resolve(names, mix)
    if ids is None:
        raise SystemExit(f"SOURCE_CONFIG_MISMATCH {LIB}: missing joints in clip npz")
    return ids

S_SPINE = src(cfg["spine"])
S_LEGS = {k: src(v) for k, v in cfg.get("legs", {}).items()}
S_TAIL = src(cfg["tail"]) if "tail" in cfg else None

# scale source rest into toy size (same height-ratio scheme as the biped path)
m_root_pos = mrest[S_SPINE[0]]
scale = (np.ptp(y) or 1.0) / (np.ptp(mrest[:, 1]) or 1.0)
def m_rest_local(ids):
    return (mrest[ids] - m_root_pos) * scale
def o_rest_local(ids):
    return joints[np.array(ids)] - joints[root]
def cost(o_ids, s_ids, R):
    return rt.chain_cost(o_rest_local(o_ids), m_rest_local(s_ids), R)

def cantmove(msg):
    raise SystemExit(f"CANTMOVE {msg}")


# ---------- generic detector: N legs + optional lateral pair + spine + tail ----------
def detect_generic(n_legs, lateral_group=None):
    """lateral_group: cfg key ("arms"/"wings") for a left/right lateral chain pair."""
    S_SIDE = {k: src(v) for k, v in cfg.get(lateral_group, {}).items()} if lateral_group else None
    requires = cfg.get("requires", "the right body")

    # --- legs from low leaves ---
    band = (0.18 if n_legs == 2 else 0.25) * (y.max() - y.min())
    feet = [i for i in leaves if y[i] <= y.min() + band]
    # many-legged: UniRig fuses legs (the 8-legged spider rigged with 6 leg
    # chains) — accept >=6 and map what's there positionally per side
    min_feet = 6 if n_legs > 4 else n_legs
    if len(feet) < min_feet:
        cantmove(f"this toy doesn't seem to have {requires} (found {len(feet)} feet)")
    if len(feet) > n_legs:
        if n_legs == 2:      # a low tail tip can dip into the band: keep the symmetric pair
            feet = list(min(itertools.combinations(feet, 2),
                            key=lambda p: abs(joints[p[0], 0] + joints[p[1], 0]) + abs(y[p[0]] - y[p[1]])))
        else:
            feet = sorted(feet, key=lambda i: y[i])[:n_legs]
    legs = [chain_up(f) for f in feet]
    leg_set = set(sum(legs, []))

    # --- lateral axis (feet pair line when available, else minor PCA axis) ---
    center = joints.mean(0)
    P2 = joints[:, [0, 2]] - center[[0, 2]]
    _, _, vt = np.linalg.svd(P2, full_matrices=False)
    lateral = np.array([vt[1, 0], 0.0, vt[1, 1]])
    if n_legs == 2:
        fx = [joints[f, 0] for f in feet]
        fl, fr = feet[int(np.argmin(fx))], feet[int(np.argmax(fx))]
        lat = joints[fr] - joints[fl]; lat[1] = 0
        if np.linalg.norm(lat) > 1e-6:
            lateral = lat
    lateral /= (np.linalg.norm(lateral) + 1e-9)

    # --- optional lateral pair (arms / wings): most-lateral leaf chains, trimmed at
    # the first fan branch (fingers / feathers ride rigidly) ---
    side_chains = []
    if S_SIDE:
        cand = [i for i in leaves if i not in feet]
        lat_off = {i: float(np.dot(joints[i] - center, lateral)) for i in cand}
        halfw = max((abs(v) for v in lat_off.values()), default=1.0) or 1.0
        body_halfw = max((abs(float(np.dot(joints[j] - center, lateral))) for j in range(J)), default=1.0) or 1.0
        torso = {j for j in range(J) if parents[j] == -1 or
                 (len(children[j]) >= 3 and abs(np.dot(joints[j] - center, lateral)) < 0.3 * body_halfw)}
        def side_chain(leaf):
            path, cur = [leaf], leaf
            while parents[cur] >= 0 and parents[cur] not in torso:
                cur = parents[cur]; path.append(cur)
            path.reverse()
            hand = max((k for k, j in enumerate(path) if len(children[j]) > 1), default=len(path) - 1)
            return path[:hand + 1]
        shoulder_of = {}
        for lf in cand:
            if abs(lat_off[lf]) > 0.35 * halfw and lf not in leg_set:
                ch_ = side_chain(lf)
                if not (set(ch_) & leg_set):
                    shoulder_of.setdefault(ch_[0], []).append(lf)
        shoulders = sorted(shoulder_of, key=lambda s: -max(abs(lat_off[l]) for l in shoulder_of[s]))[:2]
        side_chains = [side_chain(max(shoulder_of[s], key=lambda l: abs(lat_off[l]))) for s in shoulders]
        if len(side_chains) < 2:
            what = "wings" if lateral_group == "wings" else "arms"
            cantmove(f"this toy doesn't seem to have two {what} (found {len(side_chains)})")
    side_set = set(sum(side_chains, []))

    # --- axial paths: ONE per non-limb child of root. A toy with a real tail has
    # two (root->head, root->tail); "most central" alone walked the fox spine
    # backwards INTO its tail (tail joints hug the centerline), leaving the neck
    # unanimated. Which path is the SPINE is resolved numerically below, jointly
    # with yaw; the losing path becomes the natural tail candidate. ---
    def axial_path(start):
        path, cur = [start], start
        while True:
            ks = [k for k in children[cur] if k not in leg_set and k not in side_set]
            if not ks: break
            nxt = min(ks, key=lambda k: abs(np.dot(joints[k] - center, lateral)))
            path.append(nxt); cur = nxt
        return path
    axials = [axial_path(c) for c in children[root]
              if c not in leg_set and c not in side_set]
    if not axials:
        axials = [[]]

    # --- resolve yaw x leg assignment x lateral L/R jointly, min rest residual ---
    def leg_assignment(Rmat):
        # globally-optimal toy-leg <-> source-leg matching on actual chain costs.
        # (A per-side front->back positional sort mismatched a spider's radially
        # splayed legs — wrong sockets, sheared mesh. Hungarian doesn't care how
        # the legs splay.) Handles uneven counts: extra source legs go unmapped.
        from scipy.optimize import linear_sum_assignment
        keys = list(S_LEGS)
        C = np.array([[cost(lg, S_LEGS[k], Rmat) for k in keys] for lg in legs])
        rows, cols = linear_sum_assignment(C)
        assign = {keys[j]: legs[i] for i, j in zip(rows, cols)}
        return float(C[rows, cols].sum()), assign

    best = None
    for yaw in (0, 90, 180, 270):
        R = Rot.from_euler("y", yaw, degrees=True).as_matrix()
        lc, assign = leg_assignment(R)
        pair, sc_side = None, 0.0
        if S_SIDE:
            c0 = cost(side_chains[0], S_SIDE["L"], R) + cost(side_chains[1], S_SIDE["R"], R)
            c1 = cost(side_chains[0], S_SIDE["R"], R) + cost(side_chains[1], S_SIDE["L"], R)
            pair = ("L", "R") if c0 <= c1 else ("R", "L")
            sc_side = min(c0, c1)
        for sp in axials:
            total = lc + sc_side + (cost([root] + sp, S_SPINE, R) if sp else 0.0)
            if best is None or total < best[0]:
                best = (total, yaw, R, assign, pair, sp)
    total, yaw, Rm, assign, side_pair, spine = best
    print(f"resolved: yaw={yaw}  legs->{ {k: v[0] for k, v in assign.items()} }"
          + (f"  {lateral_group}->{side_pair}" if side_pair else "")
          + f"  spine->{spine[:1]}..{spine[-1:]}  rest residual={total:.4f}")

    pairing = [(chain, S_LEGS[k], "abs") for k, chain in assign.items()]
    if S_SIDE:
        pairing += [(side_chains[0], S_SIDE[side_pair[0]], "abs"),
                    (side_chains[1], S_SIDE[side_pair[1]], "abs")]
    pairing.append(([root] + spine, S_SPINE, "delta"))

    # --- optional tail from leftovers: axial attach only, sane cost only ---
    tail_chain = None
    if S_TAIL is not None:
        used = leg_set | side_set | set(spine)
        # losing axial paths (e.g. the actual root->tail chain) are first-class
        # tail candidates; leftover leaf chains keep covering the rest
        cands = [a for a in axials if a and a is not spine and not (set(a) & used)]
        for lf in leaves:
            if lf in used or lf in feet: continue
            chn = chain_up(lf)
            if any(j in used for j in chn): continue
            if parents[chn[0]] >= 0 and parents[chn[0]] in (leg_set | side_set):
                continue   # a finger/feather fan hanging off a limb is not a tail
            if not any(chn == c for c in cands):
                cands.append(chn)
        if cands:
            tail_chain = min(cands, key=lambda chn: cost(chn, S_TAIL, Rm))
            if cost(tail_chain, S_TAIL, Rm) < 4.0 * max(total, 1e-6):
                pairing.append((tail_chain, S_TAIL, "delta"))
                print(f"tail: chain from joint {tail_chain[0]} ({len(tail_chain)} joints)")
            else:
                tail_chain = None
    if tail_chain is None:
        print("tail: none matched (ok)")

    # hip line for the root frame: the rearmost/only leg pair
    hp = cfg.get("hip_pair")
    hips = None
    if hp and len(assign) >= 2:
        # toy chains assigned to the source legs that hp names (by chain start)
        s_hipL, s_hipR = mix[hp[0]], mix[hp[1]]
        okeys = [k for k in assign if S_LEGS[k][0] in (s_hipL, s_hipR)]
        if len(okeys) == 2:
            hips = (assign[okeys[0]][0], assign[okeys[1]][0])
    return pairing, hips, spine, Rm


# ---------- plan: limbless (snake, shark) ----------
def detect_limbless():
    """Map the toy's longest body path onto the source's single axial chain.

    The toy root may sit mid-body, but one FK rotation can't serve two directions:
    each directional chain starts at the root's child (a static stub at the split,
    everything beyond aims). Head end + yaw are chosen numerically by rest cost."""
    # gate: an upright toy standing on legs is not a slitherer (without this the
    # android happily side-winds — funny once, then just broken)
    horiz = max(np.ptp(joints[:, 0]), np.ptp(joints[:, 2])) or 1.0
    low = [i for i in leaves if y[i] <= y.min() + 0.22 * (np.ptp(y) or 1.0)]
    if np.ptp(y) > 0.6 * horiz and len(low) >= 2:
        cantmove("this toy stands on legs, so it can't slither or swim like that")
    def fk_path(start):
        best = ([start], 0.0)
        def walk(j, path, dist):
            nonlocal best
            if dist > best[1]:
                best = (path[:], dist)
            for c in children[j]:
                walk(c, path + [c], dist + float(np.linalg.norm(joints[c] - joints[j])))
        walk(start, [start], 0.0)
        return best

    sides = sorted((fk_path(c) for c in children[root]), key=lambda t: -t[1])
    if not sides:
        cantmove("this toy doesn't have a bendy body to slither with")
    (pathA, lenA) = sides[0]
    (pathB, lenB) = sides[1] if len(sides) > 1 else ([], 0.0)
    total_len = lenA + lenB or 1.0
    if lenB < 0.15 * total_len:
        pathB = []          # root is effectively at one end: single chain

    s_pts = mrest[S_SPINE]
    s_arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(s_pts, axis=0), axis=1))])
    s_arc /= (s_arc[-1] or 1.0)

    def sub(frac_lo, frac_hi, reverse=False):
        i0 = int(np.searchsorted(s_arc, frac_lo)); i1 = int(np.searchsorted(s_arc, frac_hi))
        i0, i1 = max(0, min(i0, len(S_SPINE) - 2)), max(1, min(i1, len(S_SPINE) - 1))
        ids = S_SPINE[i0:i1 + 1]
        return list(reversed(ids)) if reverse else ids

    fB = lenB / total_len
    best = None
    for headA in (True, False):
        if not pathB and not headA:
            pairs = [(pathA, list(reversed(S_SPINE)))]
        elif not pathB:
            pairs = [(pathA, S_SPINE)]
        elif headA:
            fA = lenA / total_len
            pairs = [(pathA, sub(0.0, 1.0 - fA + 1e-9)[::-1]),   # split->head, walking outward
                     (pathB, sub(1.0 - fA, 1.0))]
        else:
            pairs = [(pathB, sub(0.0, fB + 1e-9)[::-1]),
                     (pathA, sub(fB, 1.0))]
        for yaw in (0, 90, 180, 270):
            R = Rot.from_euler("y", yaw, degrees=True).as_matrix()
            c = sum(cost(o, s, R) for o, s in pairs if len(o) >= 2 and len(s) >= 2)
            if best is None or c < best[0]:
                best = (c, yaw, R, pairs)
    total, yaw, Rm, pairs = best
    print(f"resolved: yaw={yaw}  chains={[(p[0][0], len(p[0])) for p in pairs]}  rest residual={total:.4f}")
    pairing = [(o, s, "delta") for o, s in pairs if len(o) >= 2 and len(s) >= 2]
    if not pairing:
        cantmove("this toy doesn't have a bendy body to slither with")
    return pairing, Rm


def subdivide_chains(pairing, sparse_only=False):
    """Midpoint-subdivide toy chains so the aim mapper has enough bones.

    Default (limbless E4): every chain, one round — UniRig gives a snake ~8
    joints for a body the source bends with 22; extra DOF halves the
    per-segment bend angle (resmooth_axial re-skins over the denser chain).

    sparse_only (#22): only "abs" limb chains with FEWER bones than their
    source chain, doubled until they have at least as many. The war horse's
    rear legs came out as 3 belly-anchored bones vs the fox's 6-bone
    digitigrade zigzag — aiming one giant thigh-fraction bone swept the whole
    hindquarter under the body. Weights are untouched: verts keep riding
    their original joints, the inserted joints only add articulation.
    """
    global joints, parents, children, J, weights
    joints = np.asarray(joints, np.float64)
    parents = list(parents)
    out = []
    for chain, src_ids, mode in pairing:
        if sparse_only and (mode != "abs" or len(chain) - 1 >= len(src_ids) - 1):
            out.append((chain, src_ids, mode))
            continue
        for _ in range(3):                       # doubling rounds (safety cap)
            new_chain = [chain[0]]
            for a, b in zip(chain[:-1], chain[1:]):
                mid = len(joints)
                joints = np.vstack([joints, (joints[a] + joints[b]) / 2.0])
                parents.append(a)
                parents[b] = mid
                weights = np.hstack([weights, np.zeros((len(verts), 1), np.float32)])
                new_chain += [mid, b]
            chain = new_chain
            if not sparse_only or len(chain) - 1 >= len(src_ids) - 1:
                break
        out.append((chain, src_ids, mode))
    J = len(joints)
    children = {i: [] for i in range(J)}
    for i, p in enumerate(parents):
        if p >= 0:
            children[p].append(i)
    print(f"subdivided {'sparse limb' if sparse_only else 'body'} chains: {J} joints total")
    return out


o_hips = None
spine = []
if PLAN == "quadruped":
    PAIRING, o_hips, spine, Rm = detect_generic(4)
elif PLAN == "biped_tail":
    PAIRING, o_hips, spine, Rm = detect_generic(2, "arms")
elif PLAN == "winged_biped":
    PAIRING, o_hips, spine, Rm = detect_generic(2, "wings")
elif PLAN == "winged_quadruped":
    PAIRING, o_hips, spine, Rm = detect_generic(4, "wings")
elif PLAN == "many_legged":
    PAIRING, o_hips, spine, Rm = detect_generic(len(cfg["legs"]))
elif PLAN == "limbless":
    PAIRING, Rm = detect_limbless()
    # E4: one round over every body chain (resmooth_axial re-skins below)
    PAIRING = subdivide_chains(PAIRING)
else:
    cantmove(f"animations for {LIB} aren't supported yet")

# #22: mis-anchored limbs — the horse's rear legs run belly->thigh->foot, half a
# body forward of a real pelvis. Absolute aiming reproduces the source leg's
# GEOMETRY from that wrong origin and the hindquarters fold under the body.
# Cure = the biped clavicle lesson (trim_to_shoulder): the proximal span whose
# rest direction diverges wildly from the source's is STRUCTURE — subdivide the
# chain for granularity, then hold the divergent leading bones at rest (no aim
# target -> they ride their parent rigidly) and aim the remainder, which now
# starts at a virtual hip above the feet.
# ONLY pathological chains are touched: subdividing well-anchored legs bends
# mid-bone where the skin is rigid and CREASES it (spider 150 -> 826 stretched
# edges when every sparse chain was subdivided). Calibration (fox/Walk rest):
# horse rear first bone 73deg; fox-toy rear 42deg, horse front 13-20deg (must
# stay aimed); foot TIPS hit ~66deg on good benches, so only the START trims.
if PLAN != "limbless":
    LIMB_TRIM_DEG = float(os.environ.get("LIMB_TRIM_DEG", "60"))

    def _first_bone_div(chain, src_ids):
        import math
        o_pts = joints[np.array(chain)]
        fr_o = rt.arc_fracs(o_pts)
        u = (fr_o[0] + fr_o[1]) / 2
        d_o = o_pts[1] - o_pts[0]
        d_o = d_o / (np.linalg.norm(d_o) + 1e-12)
        d_s = Rm @ rt.dir_at_rest(mrest[np.array(src_ids)], u)
        return math.degrees(math.acos(float(np.clip(d_o @ d_s, -1, 1))))

    _bad = [i for i, (chain, src_ids, mode) in enumerate(PAIRING)
            if mode == "abs" and len(chain) > 1 and len(src_ids) > 1
            and _first_bone_div(chain, src_ids) > LIMB_TRIM_DEG]
    if _bad:
        # subdivide just the pathological chains (granularity for the trim)
        fixed = subdivide_chains([PAIRING[i] for i in _bad], sparse_only=True)
        for k, i in enumerate(_bad):
            chain, src_ids, mode = fixed[k]
            trimmed = 0
            while len(chain) > 4 and _first_bone_div(chain, src_ids) > LIMB_TRIM_DEG:
                chain = chain[1:]                # structure, not leg
                trimmed += 1
            print(f"limb root trim: {trimmed} structural bone(s) held at rest "
                  f"(aimed chain starts at joint {chain[0]})")
            PAIRING[i] = (chain, src_ids, mode)

# unshred needs the LIMB chains regardless of the trim (the abs filter is
# really a not-the-spine filter; trimmed chains still own their leg's skin)
LIMB_CHAINS = [p[0] for p in PAIRING if p[2] == "abs"]

# ---------- un-shred off-limb appendages ----------
# UniRig gives animals no tail/appendage bones (fox + horse: zero tail joints), so
# prep_skin welds those verts to the nearest LEG bones — counter-swinging legs then
# shred the tail. Any limb weight on verts radially far outside that limb is
# cleared; orphans ride the nearest axial joint rigidly. Done here (plan knows the
# chains), never in prep_skin: bipeds untouched, no rig-cache invalidation.
def unshred_offlimb(limb_chains, axial):
    global weights
    axial = [j for j in axial if j >= 0]
    if not axial:
        return
    # radius: how far off a limb's axis its skin may reach. Fuzzy many-legged toys
    # are double-shelled (hairy outer + smooth core) — at 0.35L the fur got
    # re-seated on the body and the smooth core slid out of it. Quadruped/biped
    # keep the tight radius (it separates the fox's tail from its legs).
    R = 0.60 if PLAN == "many_legged" else 0.35
    touched = 0
    dists = []                                   # per-chain point-to-polyline distance
    for chain in limb_chains:
        pts = joints[np.array(chain)]
        L = float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()) or 1.0
        dmin = np.full(len(verts), np.inf)
        for a, b in zip(pts[:-1], pts[1:]):
            ab = b - a; L2 = float(ab @ ab)
            t = np.clip(((verts - a) @ ab) / max(L2, 1e-12), 0, 1)
            dmin = np.minimum(dmin, np.linalg.norm(verts - (a + t[:, None] * ab), axis=1))
        dists.append(dmin)
        far = dmin > R * L                       # any weight this limb holds out here is wrong
        cols = np.array(chain)
        had = weights[np.ix_(far, cols)].sum(1) > 1e-6
        weights[np.ix_(far, cols)] = 0.0
        touched += int(had.sum())
    # between limbs the NEAREST chain wins exclusively: packed adjacent legs (a
    # spider's) sit inside each other's radius, and shared hair/skin verts tear
    # when the legs counter-swing
    if len(limb_chains) > 1:
        D = np.stack(dists, 1)                   # (V, n_chains)
        owner = np.argmin(D, 1)
        for ci, chain in enumerate(limb_chains):
            cols = np.array(chain)
            lose = owner != ci
            had = weights[np.ix_(lose, cols)].sum(1) > 1e-6
            weights[np.ix_(lose, cols)] = 0.0
            touched += int(had.sum())
    orphans = weights.sum(1) < 1e-8              # verts that belonged only to distant limbs
    if orphans.any():
        ax_pts = joints[np.array(axial)]
        nearest = np.array(axial)[np.argmin(
            np.linalg.norm(verts[orphans][:, None, :] - ax_pts[None, :, :], axis=2), axis=1)]
        weights[np.where(orphans)[0], nearest] = 1.0
    if touched:
        weights /= (weights.sum(1, keepdims=True) + 1e-8)
        print(f"unshred: cleared cross/far-limb weights on {touched} verts "
              f"({int(orphans.sum())} re-seated on axial bones)")

# ---------- geodesic voxel re-foundation (opt-out via RIG_GEODESIC=0) ----------
# Ported from SkinTokens (MIT): per-joint distances flow through mesh edges + an
# occupied voxel grid instead of Euclidean space, so fur stays with its leg,
# armor stays with its plate, and influence can't leak across empty space.
# Applied to limbed animal plans before unshred (which still handles boneless
# appendages like tails); limbless keeps its proven arc-gaussian resmooth.
if PLAN != "limbless" and os.environ.get("RIG_GEODESIC", _FILT) == "1":
    try:
        from voxel_skin import geodesic_filter
        import time as _time
        _t0 = _time.time()
        weights = geodesic_filter(weights, verts, faces, joints, parents)
        print(f"geodesic filter applied in {_time.time() - _t0:.1f}s")
    except Exception as _e:                    # never block the animation on it
        print(f"geodesic filter skipped: {_e}")

if os.environ.get("RIG_UNSHRED", _FILT) == "1":
    unshred_offlimb(LIMB_CHAINS, [root] + list(spine))


# ---------- smooth axial skinning for limbless bodies ----------
# A snake toy gets ~8 joints for a body the source bends with 22 — UniRig's
# near-binary weights turn high-curvature side-winding into sheared card-stack
# slabs. For a tube body the ideal weights ARE a smooth falloff over arc
# position, so re-skin chain-dominated verts with a gaussian over the chain.
def resmooth_axial(chains, claim_all=False):
    global weights
    for chain in chains:
        if len(chain) < 3:
            continue
        pts = joints[np.array(chain)]
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        t_j = np.concatenate([[0], np.cumsum(seg)])          # joint arc positions
        sigma = 0.8 * float(seg.mean() or 1.0)
        # vert arc position = projection onto the chain polyline
        t_v = np.zeros(len(verts)); d_v = np.full(len(verts), np.inf)
        for i, (a, b) in enumerate(zip(pts[:-1], pts[1:])):
            ab = b - a; L2 = float(ab @ ab)
            u = np.clip(((verts - a) @ ab) / max(L2, 1e-12), 0, 1)
            d = np.linalg.norm(verts - (a + u[:, None] * ab), axis=1)
            closer = d < d_v
            d_v[closer] = d[closer]
            t_v[closer] = t_j[i] + u[closer] * seg[i]
        cols = np.array(chain)
        # claim_all: a limbless toy's WHOLE mesh is the body — the >0.5 ownership
        # mask left root-stub verts on their original weights, tearing the shark's
        # nose at the mask boundary while gaussian-skinned neighbors waved
        mask = np.ones(len(verts), bool) if claim_all else weights[:, cols].sum(1) > 0.5
        g = np.exp(-0.5 * ((t_v[mask, None] - t_j[None, :]) / sigma) ** 2)
        g /= (g.sum(1, keepdims=True) + 1e-12)
        weights[np.ix_(mask, cols)] = g.astype(np.float32)
        other = [c for c in range(weights.shape[1]) if c not in set(chain)]
        if other:
            weights[np.ix_(mask, np.array(other))] = 0.0
        print(f"resmooth: {int(mask.sum())} verts gaussian-skinned along {len(chain)}-joint chain")
    weights /= (weights.sum(1, keepdims=True) + 1e-8)

if PLAN == "limbless":
    # one continuous polyline over the WHOLE body (tail chain, reversed, then root,
    # then head chain) so the gaussian blends across the root stub instead of
    # leaving a static-vs-waving seam there
    _chains = [p[0] for p in PAIRING]
    if len(_chains) == 2:
        full = list(reversed(_chains[1])) + [root] + _chains[0]
    else:
        full = [root] + _chains[0]
    resmooth_axial([full], claim_all=True)

# ---------- solve (shared machinery) ----------
NFR = rt.trim_loop_or_full(mpos)   # animal libs include one-shot clips (roar, death)
world_target = rt.aim_targets(joints, PAIRING, mpos, Rm, NFR, mrest=mrest)

# root: two-vector frame (spine direction + hip line), the torso sway.
# Limbless plans skip it (no hip line; the axial chains carry all the motion).
if spine and o_hips is not None:
    hp = cfg["hip_pair"]
    s_hipL, s_hipR = mix[hp[0]], mix[hp[1]]
    o_hipL, o_hipR = o_hips
    hips_i, spine_i = S_SPINE[0], S_SPINE[1]
    o_sd = joints[spine[0]] - joints[root]; o_sd /= (np.linalg.norm(o_sd) + 1e-12)
    m_sd0 = Rm @ (mrest[spine_i] - mrest[hips_i]); m_sd0 /= (np.linalg.norm(m_sd0) + 1e-12)
    hl0 = Rm @ (mrest[s_hipR] - mrest[s_hipL]); hl0 /= (np.linalg.norm(hl0) + 1e-12)
    def frame(a, b):
        x = a
        z = np.cross(a, b); z /= (np.linalg.norm(z) + 1e-12)
        yv = np.cross(z, x)
        return np.stack([x, yv, z], 1)
    Fm0 = frame(m_sd0, hl0)
    rots_r = []
    for fr in range(NFR):
        sd = Rm @ (mpos[spine_i, fr] - mpos[hips_i, fr]); sd /= (np.linalg.norm(sd) + 1e-12)
        hl = Rm @ (mpos[s_hipR, fr] - mpos[s_hipL, fr]); hl /= (np.linalg.norm(hl) + 1e-12)
        rots_r.append(Rot.from_matrix(frame(sd, hl) @ Fm0.T))
    world_target[root] = rots_r

rots = rt.solve_locals(J, parents, children, root, world_target, {}, NFR)
rt.self_check(joints, PAIRING, mpos, Rm, world_target, NFR, mrest=mrest)

root_trans = np.tile(joints[root], (NFR, 1)).astype(np.float32)
# vertical bob (#14): legged plans carry the source hips' bounce so footfalls
# read grounded. Limbless bodies skip it (no gait; keeps snake/shark byte-frozen).
if PLAN != "limbless":
    toy_hip_h = float(joints[root, 1] - verts[:, 1].min())
    root_trans[:, 1] += rt.root_bob(mpos, mrest, S_SPINE[0], NFR, toy_hip_h,
                                    loop=NFR < mpos.shape[1])
SHOW_SKELETON = os.environ.get("SHOW_SKELETON", "0") == "1"
rt.bake(os.environ["OUT_GLB"], verts, faces, weights, joints, parents, children, root,
        rots, root_trans, NFR, uv=uv, tex_png=tex_png, show_skeleton=SHOW_SKELETON, msize=msize)
