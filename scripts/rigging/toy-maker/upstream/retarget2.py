"""Direction-based retargeting v2.

Instead of copying Mixamo rotation deltas (fragile: assumes rests correspond via
one clean rotation; fails invisibly), we aim each of our bones along the SOURCE
skeleton's validated per-frame bone directions:

  1. Mixamo joint world positions per frame (the data the user visually verified).
  2. Discrete ambiguities (yaw facing, per-limb left/right pairing) are resolved
     NUMERICALLY: score every hypothesis against the two rest skeletons, pick min.
  3. Arc-length map each of our chains onto its mixamo chain (handles differing
     joint counts), then per frame aim each bone via minimal rotation.
  4. Hips get a full two-vector frame (spine dir + hip line) for torso sway.
"""
import os
import numpy as np
from scipy.spatial.transform import Rotation as Rot

import rt_solve as rt   # shared chain-agnostic solve/bake (extracted from this file)

sp = os.path.dirname(os.path.abspath(__file__))

# ---------- our rig ----------
r = np.load(os.environ.get("RIGGED_INPUT", os.path.join(sp, "rigged_input.npz")), allow_pickle=True)
verts = r["vertices"].astype(np.float32); faces = r["faces"].astype(np.uint32)
weights = r["weights"].astype(np.float32); joints = r["joints"].astype(np.float64)
parents = [(-1 if p is None else int(p)) for p in r["parents"]]
uv = r["uv"].astype(np.float32) if "uv" in r.files else None
tex_png = r["texture_png"].tobytes() if "texture_png" in r.files else None
J, V = len(joints), len(verts); msize = float((joints.max(0) - joints.min(0)).max())
children = {i: [] for i in range(J)}
for i, p in enumerate(parents):
    if p >= 0: children[p].append(i)
root = parents.index(-1)
leaves = [i for i in range(J) if not children[i]]
y = joints[:, 1]; center = joints.mean(0)

def chain_up(leaf):
    ch, cur = [leaf], leaf
    while parents[cur] >= 0 and parents[cur] != root and len(children[parents[cur]]) == 1:
        cur = parents[cur]; ch.append(cur)
    return list(reversed(ch))

feet = [i for i in leaves if y[i] <= y.min() + 0.18 * (y.max() - y.min())]
legs = [chain_up(f) for f in feet]
P2 = joints[:, [0, 2]] - center[[0, 2]]; _, _, vt = np.linalg.svd(P2, full_matrices=False)
lateral = np.array([vt[1, 0], 0.0, vt[1, 1]])
if len(feet) == 2:
    fx = [joints[f, 0] for f in feet]
    fl, fr = feet[int(np.argmin(fx))], feet[int(np.argmax(fx))]
    lateral = joints[fr] - joints[fl]; lateral[1] = 0
lateral /= (np.linalg.norm(lateral) + 1e-9)
cand = [i for i in leaves if i not in feet]
lat_off = {i: float(np.dot(joints[i] - center, lateral)) for i in cand}
halfw = max((abs(v) for v in lat_off.values()), default=1.0) or 1.0
body_halfw = max((abs(float(np.dot(joints[j] - center, lateral))) for j in range(J)), default=1.0) or 1.0
# Arms end in a hand that may fan into fingers. chain_up() from a fingertip would
# stop at that branch and mistake a single finger for the whole arm (arm limp,
# finger twitching). Instead climb each lateral leaf up THROUGH the hand to the
# shoulder (the joint just below the central torso branch), then cut the finger
# tail off at the hand so fingers ride the hand rigidly.
torso = {j for j in range(J) if parents[j] == -1 or
         (len(children[j]) >= 3 and abs(np.dot(joints[j] - center, lateral)) < 0.3 * body_halfw)}
def arm_chain(leaf):
    path, cur = [leaf], leaf
    while parents[cur] >= 0 and parents[cur] not in torso:
        cur = parents[cur]; path.append(cur)
    path.reverse()                                    # shoulder .. hand .. fingertip
    hand = max((k for k, j in enumerate(path) if len(children[j]) > 1), default=len(path) - 1)
    return path[:hand + 1]                            # shoulder .. hand (drop fingers)
# one arm per side: group lateral leaves by the shoulder they hang from, keep the
# two most-lateral shoulders (skips the near-central head leaf)
shoulder_of = {}
for lf in cand:
    if abs(lat_off[lf]) > 0.35 * halfw:
        shoulder_of.setdefault(arm_chain(lf)[0], []).append(lf)
shoulders = sorted(shoulder_of, key=lambda s: -max(abs(lat_off[l]) for l in shoulder_of[s]))[:2]
arms = [arm_chain(max(shoulder_of[s], key=lambda l: abs(lat_off[l]))) for s in shoulders]
# The Mixamo clips are bipedal; a toy without two legs + two arms (e.g. a treasure
# chest, a ball) can't be retargeted. Bail cleanly so the app shows a friendly
# "can't do that move" instead of an IndexError traceback.
if len(legs) < 2 or len(arms) < 2:
    raise SystemExit(f"NOT_BIPED legs={len(legs)} arms={len(arms)}")
leg_set = set(sum(legs, [])); arm_set = set(sum(arms, []))
spine = []; cur = root
while True:
    ks = [k for k in children[cur] if k not in leg_set and k not in arm_set]
    if not ks: break
    nxt = min(ks, key=lambda k: abs(np.dot(joints[k] - center, lateral))); spine.append(nxt); cur = nxt

# A spider/many-legged rig passes the leg/arm count above (8 legs + lateral chains
# read as arms) but has no central spine, so the Mixamo chain_cost below indexes an
# empty array and crashes. Fold the spine into the biped gate: no spine -> honest
# cantmove ("not two arms and two legs") instead of an IndexError traceback.
if len(spine) < 2:
    raise SystemExit(f"NOT_BIPED legs={len(legs)} arms={len(arms)} spine={len(spine)}")

# ---------- mixamo ----------
m = np.load(os.environ.get("CLIP_PATH", os.path.join(sp, os.environ.get("CLIP_NPZ", "mixamo_walk.npz"))), allow_pickle=True)
mnames = [str(n).split(":")[-1] for n in m["names"]]
mix = {n: i for i, n in enumerate(mnames)}
mpos = m["pose_world"][:, :, :3, 3].astype(np.float64)   # (B,F,3) world positions (VALIDATED)
mrest = m["rest_head"].astype(np.float64)                # (B,3) T-pose rest
F = mpos.shape[1]

M_CHAINS = {
    "legL": ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"],
    "legR": ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"],
    "armL": ["LeftArm", "LeftForeArm", "LeftHand", "LeftHandMiddle1"],
    "armR": ["RightArm", "RightForeArm", "RightHand", "RightHandMiddle1"],
    "spine": ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End"],
}
M_CHAINS = {k: [mix[n] for n in v if n in mix] for k, v in M_CHAINS.items()}

# This retarget is built around Mixamo's humanoid bone names. Drop clips from other
# rigs (mesh2motion's own skeletons, quadrupeds, etc.) won't have them, so the chains
# come up empty and m_root would KeyError below. Bail with a clear signal instead so
# the Rig Lab shows an honest "can't retarget this skeleton yet" (see mocap.animate).
if "Hips" not in mix or not (M_CHAINS["legL"] and M_CHAINS["legR"] and M_CHAINS["spine"]):
    raise SystemExit(f"SOURCE_INCOMPATIBLE non-Mixamo clip skeleton (joints={len(mnames)})")

# ---------- resolve ambiguities numerically ----------
m_root = mrest[mix["Hips"]]
m_h = np.ptp(mrest[:, 1]) or 1.0
o_h = np.ptp(y) or 1.0
scale = o_h / m_h
def m_rest_local(ids):    # mixamo rest, root-relative, scaled to our size
    return (mrest[ids] - m_root) * scale
def o_rest_local(ids):
    return joints[np.array(ids)] - joints[root]

def chain_cost(o_ids, m_ids, R):
    return rt.chain_cost(o_rest_local(o_ids), m_rest_local(m_ids), R)

best = None
for yaw in (0, 90, 180, 270):
    R = Rot.from_euler("y", yaw, degrees=True).as_matrix()
    sc = chain_cost(spine, M_CHAINS["spine"], R)
    lc0 = chain_cost(legs[0], M_CHAINS["legL"], R) + chain_cost(legs[1], M_CHAINS["legR"], R)
    lc1 = chain_cost(legs[0], M_CHAINS["legR"], R) + chain_cost(legs[1], M_CHAINS["legL"], R)
    leg_pair = ("legL", "legR") if lc0 <= lc1 else ("legR", "legL")
    ac0 = chain_cost(arms[0], M_CHAINS["armL"], R) + chain_cost(arms[1], M_CHAINS["armR"], R)
    ac1 = chain_cost(arms[0], M_CHAINS["armR"], R) + chain_cost(arms[1], M_CHAINS["armL"], R)
    arm_pair = ("armL", "armR") if ac0 <= ac1 else ("armR", "armL")
    total = sc + min(lc0, lc1) + min(ac0, ac1)
    if best is None or total < best[0]:
        best = (total, yaw, R, leg_pair, arm_pair)
total, yaw, Rm, leg_pair, arm_pair = best
print(f"resolved: yaw={yaw}  legs->{leg_pair}  arms->{arm_pair}  rest residual={total:.4f}")

def trim_to_shoulder(o_chain):
    """Pivot the arm from the shoulder, holding a near-centerline clavicle link
    static (like Mixamo's Shoulder bone) so the arm doesn't swing from the chest.

    A clavicle sits much closer to the midline than the shoulder it feeds, so we
    hold the lead joint static only when it is well inboard of the next joint;
    a rig with no clavicle (arm attaches at the shoulder) pivots from joint 0.
    Keyed on the first two joints' lateral offset -- NOT absolute position matched
    to Mixamo (distorted by toy proportions like a big head, and by UniRig's
    run-to-run skeleton wobble, which flipped the pivot between clavicle and
    shoulder) and NOT a fraction of hand reach (an unbranched finger tail inflates
    it and mis-holds the real shoulder)."""
    lat = np.abs([float(np.dot(joints[j] - joints[root], lateral)) for j in o_chain])
    k = 1 if (len(o_chain) >= 3 and lat[0] < 0.45 * lat[1]) else 0
    k = max(0, min(k, len(o_chain) - 3))   # keep >= 2 segments to animate
    return o_chain[k:], k

arm_trimmed = []
for o_chain, key in zip(arms, arm_pair):
    trimmed, k = trim_to_shoulder(o_chain)
    print(f"arm {key}: start at chain joint {k} (joint {trimmed[0]}), "
          f"{k} inner clavicle joint(s) held static")
    arm_trimmed.append(trimmed)

PAIRING = [(legs[0], M_CHAINS[leg_pair[0]]), (legs[1], M_CHAINS[leg_pair[1]]),
           (arm_trimmed[0], M_CHAINS[arm_pair[0]]), (arm_trimmed[1], M_CHAINS[arm_pair[1]]),
           ([root] + spine, M_CHAINS["spine"])]

# ---------- loop trim + per-frame aim targets (shared machinery) ----------
# trim_loop_or_full computes the IDENTICAL frame count for cyclic clips
# (walk/run/wave byte-safe); one-shots (zombie death/stand-up) play full length
# instead of truncating at the arbitrary post-MINP minimum (Death was 20 frames).
NFR = rt.trim_loop_or_full(mpos)
world_target = rt.aim_targets(joints, PAIRING, mpos, Rm, NFR)

# hips: full two-vector frame (spine direction + hip line) for torso sway/twist
if spine and all(n in mix for n in ("Hips", "Spine", "LeftUpLeg", "RightUpLeg")):
    hips_i, spine_i = mix["Hips"], mix["Spine"]
    lu, ru = mix["LeftUpLeg"], mix["RightUpLeg"]
    o_sd = joints[spine[0]] - joints[root]; o_sd /= (np.linalg.norm(o_sd) + 1e-12)
    o_hl = None
    if len(legs) == 2:
        o_hl = joints[legs[1][0]] - joints[legs[0][0]]
        o_hl /= (np.linalg.norm(o_hl) + 1e-12)
    m_sd0 = Rm @ (mrest[spine_i] - mrest[hips_i]); m_sd0 /= (np.linalg.norm(m_sd0) + 1e-12)
    rots_r = []
    for fr in range(NFR):
        sd = Rm @ (mpos[spine_i, fr] - mpos[hips_i, fr]); sd /= (np.linalg.norm(sd) + 1e-12)
        hl = Rm @ (mpos[ru, fr] - mpos[lu, fr]); hl /= (np.linalg.norm(hl) + 1e-12)
        hl0 = Rm @ (mrest[ru] - mrest[lu]); hl0 /= (np.linalg.norm(hl0) + 1e-12)
        def frame(a, b):
            x = a
            z = np.cross(a, b); z /= (np.linalg.norm(z) + 1e-12)
            yv = np.cross(z, x)
            return np.stack([x, yv, z], 1)
        Fm0 = frame(m_sd0, hl0); Fm = frame(sd, hl)
        rots_r.append(Rot.from_matrix(Fm @ Fm0.T))
    world_target[root] = rots_r

# De-twist the arms: direction aiming leaves each bone's roll (twist about its own
# axis) uncontrolled, so under a big swing (run) adjacent arm bones end up with
# very different roll and the elbow/upper-arm skin wrings (candy-wrapper). Remove
# the twist component of each arm bone's LOCAL rotation -- keeps the aim (swing),
# drops the roll -- and propagate the de-twisted frame to children so the whole
# arm shares one roll. Arms don't need axial twist; legs are left alone (feet do).
detwist_axis = rt.detwist_axes(joints, arm_trimmed)

# ---------- FK solve + self-check (shared machinery) ----------
rots = rt.solve_locals(J, parents, children, root, world_target, detwist_axis, NFR)
rt.self_check(joints, PAIRING, mpos, Rm, world_target, NFR)

root_trans = np.tile(joints[root], (NFR, 1)).astype(np.float32)
# vertical bob (#14): the hips' bounce is most of what makes a gait read as
# grounded; without it every walk/run floats. Horizontal stays static (in-place).
toy_hip_h = float(joints[root, 1] - verts[:, 1].min())
root_trans[:, 1] += rt.root_bob(mpos, mrest, mix["Hips"], NFR, toy_hip_h,
                                loop=NFR < mpos.shape[1])

# ---------- author GLB + usdz (shared machinery) ----------
SHOW_SKELETON = os.environ.get("SHOW_SKELETON", "1") == "1"
rt.bake(os.environ["OUT_GLB"], verts, faces, weights, joints, parents, children, root,
        rots, root_trans, NFR, uv=uv, tex_png=tex_png, show_skeleton=SHOW_SKELETON, msize=msize)
