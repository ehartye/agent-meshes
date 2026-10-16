"""Source-chain configs for the mesh2motion animal libraries (body-plan retargeting).

Each library's skeleton is fixed and known (dumped from the original
`<library>-animations.glb`), so source chains are hardcoded by joint name — the
animal analog of retarget2's Mixamo M_CHAINS. Conventions:

- Chains are ordered proximal → tip, POSITIONALLY along the limb/body (what the
  arc-length aim consumes) — not necessarily one hierarchy path.
- Anchor/clavicle-like lead joints (fox Front_Leg_Shoulder, dragon collar_anchor /
  shoulder, spider legs_anchor_*) are EXCLUDED: they stay static on the toy, the limb
  pivots from its first real joint — same reasoning as the biped trim_to_shoulder.
- Feather / mouth / horn / ear joints ride their parent rigidly (never aimed).

`plan` names the TARGET detection strategy retarget_plan.py must run on the toy's
UniRig skeleton; `requires` is the human-readable chain requirement for the specific
cantmove message when a toy doesn't have the anatomy.
"""

# leg keys: F/B = front/back, L/R = left/right (source's own left/right)
LIBRARIES = {
    "fox": {
        "plan": "quadruped",
        "spine": ["Hips", "Spine_1", "Spine_2", "Spine_2.001", "Spine_3", "Spine_4", "Head", "Head.tip"],
        "legs": {
            "FL": ["Front_Leg_Upper_L", "Front_Leg_Lower_L", "Front_Leg_Ankle_L", "Front_Leg_Foot_L", "Front_Leg_Tip_L"],
            "FR": ["Front_Leg_Upper_R", "Front_Leg_Lower_R", "Front_Leg_Ankle_R", "Front_Leg_Foot_R", "Front_Leg_Tip_R"],
            "BL": ["Back_Leg_Upper_L", "Back_Leg_Lower_L", "Back_Leg_Ankle_L", "Back_Leg_Foot_L", "Back_Leg_Foot_1_L", "Back_Leg_Tip_L"],
            "BR": ["Back_Leg_Upper_R", "Back_Leg_Lower_R", "Back_Leg_Ankle_R", "Back_Leg_Foot_R", "Back_Leg_Foot_1_R", "Back_Leg_Tip_R"],
        },
        "tail": ["Tail_Base", "Tail_Mid", "Tail_Mid.001", "Tail_End", "Tail_Tip"],
        "hip_pair": ("Back_Leg_Upper_L", "Back_Leg_Upper_R"),   # root two-vector frame
        "requires": "four legs",
    },

    "kaiju": {
        "plan": "biped_tail",
        "spine": ["Hips", "Spine_1", "Spine_2", "Spine_2.001", "Spine_3", "Spine_4", "Head", "Head.tip"],
        "arms": {   # kaiju "Front_Leg" chains are arms ending in hands with fingers
            "L": ["Front_Leg_Upper_L", "Front_Leg_Lower_L", "Hand_L", "Finger_Index_L"],
            "R": ["Front_Leg_Upper_R", "Front_Leg_Lower_R", "Hand_R", "Finger_Index_R"],
        },
        "legs": {
            "L": ["Back_Leg_Upper_L", "Back_Leg_Lower_L", "Back_Leg_Ankle_L", "Back_Leg_Foot_L", "Back_Leg_Foot_1_L", "Back_Leg_Foot_2_L", "Back_Leg_Tip_L"],
            "R": ["Back_Leg_Upper_R", "Back_Leg_Lower_R", "Back_Leg_Ankle_R", "Back_Leg_Foot_R", "Back_Leg_Foot_1_R", "Back_Leg_Foot_2_R", "Back_Leg_Tip_R"],
        },
        "tail": ["Tail_Base", "Tail_Mid", "Tail_Mid.001", "Tail_Mid.002", "Tail_Mid.003", "Tail_Tip"],
        "hip_pair": ("Back_Leg_Upper_L", "Back_Leg_Upper_R"),
        "requires": "two legs and two arms",
    },

    "snake": {
        "plan": "limbless",
        # one axial chain, head -> tail tip (positional order along the body)
        "spine": ["head", "neck"] + [f"tail{i:02d}" for i in range(1, 21)] + ["tail_tip"],
        "requires": "a long bendy body",
    },

    "shark": {
        "plan": "limbless",
        # axial chain nose -> tail tip; pelvis sits mid-body between neck and tail_1
        "spine": ["head", "neck", "pelvis", "tail_1", "tail_2", "tail_3", "tail_4",
                  "tail_5", "tail_6", "tail_7", "tail_8", "tail_tip"],
        # pectoral fins: optional lateral pair (aimed only if the toy has side leaves)
        "side_pair": {
            "L": ["front_fin_0_l", "front_fin_1_l", "front_fin_2_l", "front_fin_tip_l"],
            "R": ["front_fin_0_r", "front_fin_1_r", "front_fin_2_r", "front_fin_tip_r"],
        },
        "requires": "a long bendy body",
    },

    "spider": {
        "plan": "many_legged",
        "spine": ["hips", "spine_1", "spine_2", "head", "head_tip"],
        # a=frontmost .. d=rearmost per side (anchors excluded)
        "legs": {
            "L1": ["leg_a_1_l", "leg_a_2_l", "leg_a_3_l", "leg_a_tip_l"],
            "L2": ["leg_b_1_l", "leg_b_2_l", "leg_b_3_l", "leg_b_tip_l"],
            "L3": ["leg_c_1_l", "leg_c_2_l", "leg_c_3_l", "leg_c_tip_l"],
            "L4": ["leg_d_1_l", "leg_d_2_l", "leg_d_3_l", "leg_d_tip_l"],
            "R1": ["leg_a_1_r", "leg_a_2_r", "leg_a_3_r", "leg_a_tip_r"],
            "R2": ["leg_b_1_r", "leg_b_2_r", "leg_b_3_r", "leg_b_tip_r"],
            "R3": ["leg_c_1_r", "leg_c_2_r", "leg_c_3_r", "leg_c_tip_r"],
            "R4": ["leg_d_1_r", "leg_d_2_r", "leg_d_3_r", "leg_d_tip_r"],
        },
        "tail": ["tail_1", "tail_2", "tail_3", "tail_tip"],   # abdomen
        "requires": "lots of legs",
    },

    "bird": {
        "plan": "winged_biped",
        "spine": ["hips", "spine_0", "spine_1", "spine_2", "spine_3", "head"],
        "legs": {
            "L": ["UpperLeg_L", "LowerLeg_L", "AnkleLeg_L", "Foot_L", "Toes_L", "Toes_tip_L"],
            "R": ["UpperLeg_R", "LowerLeg_R", "AnkleLeg_R", "Foot_R", "Toes_R", "Toes_tip_R"],
        },
        "wings": {
            "L": ["wing_1_L", "wing_2_L", "wing_3_L", "wing_4_L", "wing_5_L", "wing_tip_L"],
            "R": ["wing_1_R", "wing_2_R", "wing_3_R", "wing_4_R", "wing_5_R", "wing_tip_R"],
        },
        "tail": ["tail_1", "tail_2", "tail_3", "tail_tip"],
        "hip_pair": ("UpperLeg_L", "UpperLeg_R"),
        "requires": "two legs and two wings",
    },

    "dragon": {
        "plan": "winged_quadruped",
        "spine": ["hips", "spine_0", "spine_1", "spine_2", "spine_3", "spine_4", "head"],
        "legs": {
            "FL": ["front_leg_collar_l", "front_leg_l", "front_ankle_l", "front_foot_l", "front_toes_l", "front_toes_tip_l"],
            "FR": ["front_leg_collar_r", "front_leg_r", "front_ankle_r", "front_foot_r", "front_toes_r", "front_toes_tip_r"],
            "BL": ["back_leg_hip_l", "back_leg_l", "back_ankle_l", "back_foot_l", "back_toes_l", "back_toes_tip_l"],
            "BR": ["back_leg_hip_r", "back_leg_r", "back_ankle_r", "back_foot_r", "back_toes_r", "back_toes_tip_r"],
        },
        "wings": {
            "L": ["wing_1_l", "wing_2_l", "wing_3_l", "wing_4_l", "wing_5_l", "wing_tip_l"],
            "R": ["wing_1_r", "wing_2_r", "wing_3_r", "wing_4_r", "wing_5_r", "wing_tip_r"],
        },
        "tail": ["tail_1", "tail_2", "tail_3", "tail_4", "tail_5", "tail_6", "tail_tip"],
        "hip_pair": ("back_leg_hip_l", "back_leg_hip_r"),
        "requires": "four legs and two wings",
    },
}

# libraries that route to retarget_plan.py instead of the biped retarget2.py
ANIMAL_LIBS = set(LIBRARIES)


def resolve(cfg_names, name_index):
    """Map a chain's joint names to indices; None if any joint is missing."""
    try:
        return [name_index[n] for n in cfg_names]
    except KeyError:
        return None


# pose preset (workflows.POSES key, persisted in meta.json) -> expected plan(s)
POSE_EXPECTATION = {
    "humanoid": {"plans": ("biped",), "feet": 2, "side": 2, "tail": False},
    "quadruped": {"plans": ("quadruped", "winged_quadruped"), "feet": 4, "side": 0, "tail": True},
    "winged": {"plans": ("winged_biped", "winged_quadruped"), "feet": 2, "side": 2, "tail": True},
    "longbody": {"plans": ("limbless",), "feet": 0, "side": 0, "tail": False},
    "manylegs": {"plans": ("many_legged",), "feet": 8, "side": 0, "tail": True},
}


def tail_chain_len(joints, parents):
    """Longest single-child chain at the SPARSE end of the body axis — a
    plausible tail (0 = none). The head end carries a cluster of leaves
    (nose/ears/jaw); a tail end carries one — without that asymmetry check a
    fox's nose chain scores as a tail."""
    import numpy as np
    joints = np.asarray(joints, float)
    J = len(joints)
    parents = [(-1 if p is None else int(p)) for p in parents]
    kids = {i: [] for i in range(J)}
    for i, p in enumerate(parents):
        if p >= 0:
            kids[p].append(i)
    leaves = [i for i in range(J) if not kids[i]]
    c = joints.mean(0)
    ext = joints[:, [0, 2]] - c[[0, 2]]
    axis = int(np.argmax(np.ptp(ext, axis=0)))
    lo, hi = float(ext[:, axis].min()), float(ext[:, axis].max())
    band = 0.15 * (hi - lo)

    y = joints[:, 1]
    floor_band = y.min() + 0.30 * ((y.max() - y.min()) or 1.0)

    def end_chains(is_hi):
        out = []
        for lf in leaves:
            if joints[lf, 1] <= floor_band:
                continue                    # feet: a rear LEG is not a tail
            e = float(ext[lf, axis])
            if (e > hi - band) if is_hi else (e < lo + band):
                n, cur = 1, lf
                while parents[cur] >= 0 and len(kids[parents[cur]]) == 1:
                    cur = parents[cur]; n += 1
                out.append(n)
        return out

    a, b = end_chains(False), end_chains(True)
    # the tail end is the SPARSER end (1-2 leaves); a leaf-cluster end is a head
    best = 0
    for chains in (a, b):
        if 1 <= len(chains) <= 2:
            best = max(best, max(chains))
    return best


def arm_mirror_error(joints, parents):
    """How badly the two most-lateral side chains mirror each other across the
    sagittal plane (arc-resampled, size-normalized). Healthy T-pose arms measure
    ~0.001-0.006; the alien's gear-chains-as-arms measured 0.066. None when
    fewer than two side chains exist. The QUALITY probe behind score_skeleton:
    arms that COUNT are not necessarily arms that WORK (the alien lesson)."""
    import numpy as np
    j = np.asarray(joints, float)
    J = len(j)
    par = [(-1 if p is None else int(p)) for p in parents]
    kids = {i: [] for i in range(J)}
    for i, p in enumerate(par):
        if p >= 0:
            kids[p].append(i)
    leaves = [i for i in range(J) if not kids[i]]
    y = j[:, 1]; span = (y.max() - y.min()) or 1.0
    size = float((j.max(0) - j.min(0)).max()) or 1.0
    feet = [i for i in leaves if y[i] <= y.min() + 0.22 * span]
    c = j.mean(0)
    P2 = j[:, [0, 2]] - c[[0, 2]]
    _, _, vt = np.linalg.svd(P2, full_matrices=False)
    lat = np.array([vt[1, 0], 0.0, vt[1, 1]])
    if len(feet) >= 2:
        fpos = j[feet]
        a, b = max(((x, z) for x in range(len(feet)) for z in range(x + 1, len(feet))),
                   key=lambda p: np.linalg.norm(fpos[p[0], [0, 2]] - fpos[p[1], [0, 2]]))
        l2 = fpos[b] - fpos[a]; l2[1] = 0
        if np.linalg.norm(l2) > 1e-6:
            lat = l2
    lat = lat / (np.linalg.norm(lat) + 1e-9)
    body_halfw = max(abs(float(np.dot(j[k] - c, lat))) for k in range(J)) or 1.0
    torso = {i for i in range(J) if par[i] == -1 or
             (len(kids[i]) >= 3 and abs(np.dot(j[i] - c, lat)) < 0.3 * body_halfw)}

    def side_chain(leaf):
        path, cur = [leaf], leaf
        while par[cur] >= 0 and par[cur] not in torso:
            cur = par[cur]; path.append(cur)
        path.reverse()
        hand = max((k for k, q in enumerate(path) if len(kids[q]) > 1), default=len(path) - 1)
        return path[:hand + 1]

    cand = [l for l in leaves if l not in feet]
    offs = {l: float(np.dot(j[l] - c, lat)) for l in cand}
    halfw = max((abs(v) for v in offs.values()), default=1.0) or 1.0
    chains = {}
    for l in cand:
        if abs(offs[l]) > 0.35 * halfw:
            ch = side_chain(l)
            chains.setdefault(ch[0], ch)
    chs = sorted(chains.values(), key=lambda ch: -abs(offs.get(ch[-1], 0)))[:2]
    if len(chs) < 2:
        return None

    def resample(pts, k=6):
        pts = np.asarray(pts, float)
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)]); cum /= (cum[-1] or 1.0)
        return np.stack([np.interp(np.linspace(0, 1, k), cum, pts[:, d]) for d in range(3)], 1)

    A = resample(j[np.array(chs[0])]) - c
    B = resample(j[np.array(chs[1])]) - c
    Bm = B - 2 * (B @ lat)[:, None] * lat
    return float(np.linalg.norm(A - Bm, axis=1).mean() / size)


def score_skeleton(info, expected_pose=None, tail_len=0, joints=None, parents=None):
    """Score a classify() result against the pose the kid picked (0..100-ish).

    Plan match dominates; feet/side counts and tail presence refine; generic
    sanity (enough-but-not-absurd joints) applies when there is no expectation.
    With joints/parents supplied and side limbs claimed, the arm-mirror QUALITY
    probe penalizes junk arms steeply (calibrated: healthy ~0.001-0.006, junk
    0.066 -> the alien's arms-candidate must rank below its armless rolls).
    Used by best-of-N skeleton selection (rig_skin_test) and E0 analysis."""
    s = 0.0
    exp = POSE_EXPECTATION.get(expected_pose)
    if exp:
        if info["plan"] in exp["plans"]:
            s += 50.0
        s -= 8.0 * abs(info["feet"] - exp["feet"])
        if exp["side"]:
            s -= 8.0 * abs(info["side_limbs"] - exp["side"])   # extra "arms" count against
        if exp["tail"]:
            s += 15.0 if tail_len >= 2 else 0.0
    else:
        # no expectation: prefer a decisive plan over degenerate skeletons, and
        # more expressed structure over less (a spider's 8-leg roll must beat its
        # 6- and 4-leg rolls — they all tied at 35 before this term)
        s += 25.0 if info["plan"] != "biped_armless" else 0.0
        s += 10.0 if tail_len >= 2 else 0.0
        s += 1.5 * min(info["feet"], 8)
    # generic sanity: reward a reasonable articulation budget
    j = info.get("joints", 0)
    if 12 <= j <= 80:
        s += 10.0
    elif j < 6:
        s -= 20.0
    # QUALITY probe: only when the candidate is being credited for side limbs
    if joints is not None and parents is not None and info.get("side_limbs", 0) >= 2 \
            and (exp is None or exp.get("side")):
        me = arm_mirror_error(joints, parents)
        if me is not None:
            s -= min(100.0, 1500.0 * max(0.0, me - 0.02))
    return s


def classify(joints, parents):
    """Classify a UniRig toy skeleton's body plan — same geometric rules as
    retarget_plan's detector (low leaves = feet, lateral leaves = arms/wings).
    Informational: stamped into rig/bodyplan.json at rig time and surfaced in the
    Rig Lab; the retarget itself always re-detects per clip."""
    import numpy as np
    joints = np.asarray(joints, float)
    J = len(joints)
    parents = [(-1 if p is None else int(p)) for p in parents]
    kids = {i: [] for i in range(J)}
    for i, p in enumerate(parents):
        if p >= 0:
            kids[p].append(i)
    leaves = [i for i in range(J) if not kids[i]]
    y = joints[:, 1]
    span = (y.max() - y.min()) or 1.0
    size = float((joints.max(0) - joints.min(0)).max()) or 1.0
    feet = [i for i in leaves if y[i] <= y.min() + 0.22 * span]
    center = joints.mean(0)
    # lateral axis: the feet line when we have feet (what the detectors use — the
    # PCA minor axis flips to front-back on wide T-pose figures), else PCA minor
    P2 = joints[:, [0, 2]] - center[[0, 2]]
    _, _, vt = np.linalg.svd(P2, full_matrices=False)
    lateral = np.array([vt[1, 0], 0.0, vt[1, 1]])
    if len(feet) >= 2:
        fpos = joints[feet]
        a, b = max(((i, j) for i in range(len(feet)) for j in range(i + 1, len(feet))),
                   key=lambda p: np.linalg.norm(fpos[p[0], [0, 2]] - fpos[p[1], [0, 2]]))
        lat = fpos[b] - fpos[a]; lat[1] = 0
        if np.linalg.norm(lat) > 1e-6:
            lateral = lat
    lateral /= (np.linalg.norm(lateral) + 1e-9)

    def chain_len(leaf):
        # climb THROUGH small branches (a hand fanning into fingers) to the torso —
        # stopping at the first branch measured only a fingertip and misread armed
        # bipeds as armless
        L, cur = 0.0, leaf
        while parents[cur] >= 0 and parents[cur] != (parents.index(-1)) and len(kids[parents[cur]]) < 3:
            L += float(np.linalg.norm(joints[cur] - joints[parents[cur]])); cur = parents[cur]
        return L

    lat_off = [abs(float(np.dot(joints[i] - center, lateral))) for i in leaves]
    halfw = max(lat_off, default=1.0) or 1.0
    # a side limb is a LONG lateral chain — ear/nose stubs on a head don't count
    side = [l for l, off in zip(leaves, lat_off)
            if l not in feet and off > 0.35 * halfw and chain_len(l) > 0.12 * size]

    n_feet, n_side = len(feet), len(side)
    if n_feet == 0:
        plan = "limbless"
    elif n_feet >= 6:
        plan = "many_legged"
    elif n_feet >= 3:
        plan = "winged_quadruped" if n_side >= 2 else "quadruped"
    elif n_side >= 2:
        plan = "biped"          # 2 feet + 2 lateral chains (arms or wings)
    else:
        plan = "biped_armless"
    return {"plan": plan, "feet": n_feet, "side_limbs": n_side, "leaves": len(leaves), "joints": J}
