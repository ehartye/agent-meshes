"""Extract one animation from a mesh2motion library GLB into our clip .npz — in the
stable venv (pygltflib + numpy), NO Blender.

The mesh2motion originals (`<library>-animations.glb`) hold every clip as a glTF
animation on a shared skin whose bones use UE-mannequin names (pelvis/spine_01/
upperarm_l/thigh_l/…). We rename those to the bare Mixamo suffixes our retarget wants
(BONE_MAP, ported from mesh2motion's own src/retarget/bone-automap/MixamoMapper.ts,
MIT) and bake per-frame FK world transforms, producing the SAME npz schema
extract_mixamo.py emits so retarget2.py consumes it unchanged:
  names(object) parents(int,-1=root) rest_head(B,3) rest_tail(B,3)
  rest_mat(B,4,4) pose_world(B,F,4,4)   # retarget uses names, pose_world[:,:,:3,3], rest_head

glTF is Y-up right-handed — the same space extract_mixamo reports (identity), so no
axis conversion. glTF stores LOCAL TRS keyframes; we sample a uniform grid and compose
FK to world.
"""
import numpy as np
from pygltflib import GLTF2

# mesh2motion bone name -> bare Mixamo suffix (mixamorig prefix stripped).
# Source: mesh2motion-app src/retarget/bone-automap/MixamoMapper.ts (MIT).
BONE_MAP = {
    "pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine1", "spine_03": "Spine2",
    "neck_01": "Neck", "head": "Head", "head_leaf": "HeadTop_End",
    "clavicle_l": "LeftShoulder", "upperarm_l": "LeftArm", "lowerarm_l": "LeftForeArm", "hand_l": "LeftHand",
    "clavicle_r": "RightShoulder", "upperarm_r": "RightArm", "lowerarm_r": "RightForeArm", "hand_r": "RightHand",
    "thigh_l": "LeftUpLeg", "calf_l": "LeftLeg", "foot_l": "LeftFoot", "ball_l": "LeftToeBase", "ball_leaf_l": "LeftToe_End",
    "thigh_r": "RightUpLeg", "calf_r": "RightLeg", "foot_r": "RightFoot", "ball_r": "RightToeBase", "ball_leaf_r": "RightToe_End",
    "thumb_01_l": "LeftHandThumb1", "thumb_02_l": "LeftHandThumb2", "thumb_03_l": "LeftHandThumb3", "thumb_04_leaf_l": "LeftHandThumb4",
    "index_01_l": "LeftHandIndex1", "index_02_l": "LeftHandIndex2", "index_03_l": "LeftHandIndex3", "index_04_leaf_l": "LeftHandIndex4",
    "middle_01_l": "LeftHandMiddle1", "middle_02_l": "LeftHandMiddle2", "middle_03_l": "LeftHandMiddle3", "middle_04_leaf_l": "LeftHandMiddle4",
    "ring_01_l": "LeftHandRing1", "ring_02_l": "LeftHandRing2", "ring_03_l": "LeftHandRing3", "ring_04_leaf_l": "LeftHandRing4",
    "pinky_01_l": "LeftHandPinky1", "pinky_02_l": "LeftHandPinky2", "pinky_03_l": "LeftHandPinky3", "pinky_04_leaf_l": "LeftHandPinky4",
    "thumb_01_r": "RightHandThumb1", "thumb_02_r": "RightHandThumb2", "thumb_03_r": "RightHandThumb3", "thumb_04_leaf_r": "RightHandThumb4",
    "index_01_r": "RightHandIndex1", "index_02_r": "RightHandIndex2", "index_03_r": "RightHandIndex3", "index_04_leaf_r": "RightHandIndex4",
    "middle_01_r": "RightHandMiddle1", "middle_02_r": "RightHandMiddle2", "middle_03_r": "RightHandMiddle3", "middle_04_leaf_r": "RightHandMiddle4",
    "ring_01_r": "RightHandRing1", "ring_02_r": "RightHandRing2", "ring_03_r": "RightHandRing3", "ring_04_leaf_r": "RightHandRing4",
    "pinky_01_r": "RightHandPinky1", "pinky_02_r": "RightHandPinky2", "pinky_03_r": "RightHandPinky3", "pinky_04_leaf_r": "RightHandPinky4",
}

SKIP_CLIPS = {"rest_pose", "tpose", "t-pose", "t_pose"}   # bind/reference poses, not moves

_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor(g, blob, ai):
    acc = g.accessors[ai]
    bv = g.bufferViews[acc.bufferView]
    dtype = np.dtype(_CT[acc.componentType]); nc = _NC[acc.type]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    stride = bv.byteStride or (dtype.itemsize * nc)
    if stride == dtype.itemsize * nc:
        a = np.frombuffer(blob, dtype=dtype, count=acc.count * nc, offset=base)
    else:  # interleaved — gather each element's row
        rows = [np.frombuffer(blob, dtype=dtype, count=nc, offset=base + i * stride) for i in range(acc.count)]
        a = np.concatenate(rows)
    a = a.reshape(acc.count, nc).astype(np.float64)
    return a.reshape(acc.count) if nc == 1 else a


def _quat_to_mat(q):           # glTF quat = (x, y, z, w)
    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3)
    s = 2.0 / n
    return np.array([
        [1 - s * (y * y + z * z), s * (x * y - w * z),     s * (x * z + w * y)],
        [s * (x * y + w * z),     1 - s * (x * x + z * z), s * (y * z - w * x)],
        [s * (x * z - w * y),     s * (y * z + w * x),     1 - s * (x * x + y * y)],
    ])


def _slerp(a, b, u):
    a = np.asarray(a, float); b = np.asarray(b, float)
    d = float(np.dot(a, b))
    if d < 0:
        b = -b; d = -d
    if d > 0.9995:
        q = a + u * (b - a)
    else:
        th = np.arccos(np.clip(d, -1, 1)); s = np.sin(th)
        q = (np.sin((1 - u) * th) / s) * a + (np.sin(u * th) / s) * b
    return q / (np.linalg.norm(q) + 1e-12)


def _sample(times, values, t, is_quat, step):
    """Value of a channel at time t (times ascending, clamped)."""
    if t <= times[0]:
        return values[0]
    if t >= times[-1]:
        return values[-1]
    i = int(np.searchsorted(times, t) - 1)
    i = max(0, min(i, len(times) - 2))
    if step:
        return values[i]
    u = (t - times[i]) / (times[i + 1] - times[i] + 1e-12)
    if is_quat:
        return _slerp(values[i], values[i + 1], u)
    return values[i] * (1 - u) + values[i + 1] * u


def extract(glb_path, anim_name, out_npz, fps=60.0, bone_map=BONE_MAP):
    # fps=60 matches the bake's fixed 60fps playback (times = frame/60), so clips
    # play at real-time speed; 30 would double the apparent speed.
    g = GLTF2().load(str(glb_path))
    blob = g.binary_blob()
    skin = g.skins[0]
    joints = list(skin.joints)                       # node indices, bone order
    J = len(joints)
    jpos = {n: i for i, n in enumerate(joints)}      # node index -> bone index

    anim = next((a for a in g.animations if a.name == anim_name), None)
    if anim is None:
        raise ValueError(f"animation {anim_name!r} not in {glb_path}")

    # names (renamed to Mixamo suffix where known) + parent bone indices.
    # BONE_MAP contains generic names ('head') that also exist on animal rigs —
    # apply it only when this skeleton IS the mesh2motion humanoid (it renamed a
    # snake's 'head' to 'Head' and broke the snake source config).
    raw_names = {g.nodes[n].name for n in joints}
    is_humanoid = {"pelvis", "spine_01", "upperarm_l"} <= raw_names
    names = []
    for n in joints:
        nm = g.nodes[n].name or f"bone{n}"
        names.append(bone_map.get(nm, nm) if is_humanoid else nm)
    parents = [-1] * J
    for n in joints:
        for c in (g.nodes[n].children or []):
            if c in jpos:
                parents[jpos[c]] = jpos[n]

    # base local TRS per bone (node defaults; animation overrides below)
    baseT = np.zeros((J, 3)); baseR = np.tile([0, 0, 0, 1.0], (J, 1)); baseS = np.ones((J, 3))
    for n in joints:
        nd = g.nodes[n]; i = jpos[n]
        if nd.translation: baseT[i] = nd.translation
        if nd.rotation:    baseR[i] = nd.rotation
        if nd.scale:       baseS[i] = nd.scale

    # rest (bind) world transform from inverse bind matrices
    ibm = _accessor(g, blob, skin.inverseBindMatrices).reshape(J, 4, 4).transpose(0, 2, 1)  # glTF column-major
    bind_world = np.linalg.inv(ibm)                  # (J,4,4)
    rest_head = bind_world[:, :3, 3].astype(np.float32)
    rest_mat = bind_world.astype(np.float32)
    rest_tail = rest_head.copy()                     # viz-only (retarget ignores); point at child if any
    for i in range(J):
        kids = [k for k in range(J) if parents[k] == i]
        if kids:
            rest_tail[i] = rest_head[kids[0]]

    # per-channel (times, values) keyed by (bone index, path)
    chan = {}
    for ch in anim.channels:
        if ch.target.node not in jpos:
            continue
        smp = anim.samplers[ch.sampler]
        t = _accessor(g, blob, smp.input)
        v = _accessor(g, blob, smp.output)
        chan[(jpos[ch.target.node], ch.target.path)] = (np.atleast_1d(t), v, smp.interpolation == "STEP")

    # uniform sample grid over the clip's duration
    dur = max((c[0][-1] for c in chan.values()), default=0.0)
    F = max(2, int(round(dur * fps)) + 1)
    grid = np.linspace(0.0, dur, F)

    # FK order: parents before children
    order, seen = [], set()
    def visit(i):
        if i in seen: return
        if parents[i] >= 0: visit(parents[i])
        seen.add(i); order.append(i)
    for i in range(J): visit(i)

    pose_world = np.zeros((J, F, 4, 4), np.float32)
    for fi, t in enumerate(grid):
        world = [None] * J
        for i in order:
            tt = baseT[i]; rr = baseR[i]; ss = baseS[i]
            if (i, "translation") in chan:
                tm, tv, stp = chan[(i, "translation")]; tt = _sample(tm, tv, t, False, stp)
            if (i, "rotation") in chan:
                rm, rv, stp = chan[(i, "rotation")]; rr = _sample(rm, rv, t, True, stp)
            if (i, "scale") in chan:
                sm, sv, stp = chan[(i, "scale")]; ss = _sample(sm, sv, t, False, stp)
            local = np.eye(4)
            local[:3, :3] = _quat_to_mat(rr) * np.asarray(ss)      # scale columns
            local[:3, 3] = tt
            world[i] = local if parents[i] < 0 else world[parents[i]] @ local
        for i in range(J):
            pose_world[i, fi] = world[i]

    np.savez(out_npz, names=np.array(names, dtype=object), parents=np.array(parents),
             rest_head=rest_head, rest_tail=rest_tail, rest_mat=rest_mat, pose_world=pose_world)
    return out_npz


def list_clips(glb_path):
    """Animatable clip names in a library GLB (Rest_Pose/TPose excluded).
    Names come back RAW (some libraries use spaces: snake's 'Side winding');
    callers sanitize for ids but must extract by the raw name."""
    g = GLTF2().load(str(glb_path))
    return [a.name for a in g.animations
            if (a.name or "").lower().replace(" ", "_") not in SKIP_CLIPS]
