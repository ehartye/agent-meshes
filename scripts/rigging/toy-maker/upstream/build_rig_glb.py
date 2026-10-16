"""Body-plan-aware gait + skeleton overlay, authored as one skinned glTF.

Detects legs from skeleton geometry, classifies the body plan (biped /
quadruped / many-legged), assigns per-leg gait phases, and renders a
bright bone+joint overlay over a see-through toy so the rig is visible.
"""
import math
import os
import numpy as np
from pygltflib import (
    GLTF2, Scene, Node, Mesh, Primitive, Attributes, Skin, Buffer, BufferView,
    Accessor, Animation, AnimationChannel, AnimationChannelTarget, AnimationSampler,
    Material, PbrMetallicRoughness,
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, UNSIGNED_SHORT,
    SCALAR, VEC3, VEC4, MAT4,
)

sp = os.path.dirname(os.path.abspath(__file__))
r = np.load(os.path.join(sp, "rigged_input.npz"), allow_pickle=True)
verts = r["vertices"].astype(np.float32)
faces = r["faces"].astype(np.uint32)
weights = r["weights"].astype(np.float32)
joints = r["joints"].astype(np.float64)
parents = [(-1 if p is None else int(p)) for p in r["parents"]]
J, V = len(joints), len(verts)
msize = float((joints.max(0) - joints.min(0)).max())

children = {i: [] for i in range(J)}
for i, p in enumerate(parents):
    if p >= 0:
        children[p].append(i)
root = parents.index(-1)
leaves = [i for i in range(J) if not children[i]]
y = joints[:, 1]

def chain_up(leaf):
    ch, cur = [leaf], leaf
    while parents[cur] >= 0 and parents[cur] != root and len(children[parents[cur]]) == 1:
        cur = parents[cur]; ch.append(cur)
    return list(reversed(ch))

# ---- detect legs: leaves in the ground cluster (lowest band), traced up ----
foot_band = y.min() + 0.18 * (y.max() - y.min())
feet = [i for i in leaves if y[i] <= foot_band]
legs = [chain_up(f) for f in feet]
nlegs = len(legs)

# ---- body axes ----
center = joints.mean(0)
P = (joints[:, [0, 2]] - center[[0, 2]])
_, _, vt = np.linalg.svd(P, full_matrices=False)
forward = np.array([vt[0, 0], 0.0, vt[0, 1]])                 # body long axis
lateral = np.array([vt[1, 0], 0.0, vt[1, 1]])
if nlegs == 2:                                               # bipeds: feet define lateral
    fx = [joints[f, 0] for f in feet]
    fl, fr = feet[int(np.argmin(fx))], feet[int(np.argmax(fx))]
    lateral = joints[fr] - joints[fl]; lateral[1] = 0
    lateral /= (np.linalg.norm(lateral) + 1e-9)
    forward = np.cross([0, 1, 0], lateral)
forward /= (np.linalg.norm(forward) + 1e-9)
lateral /= (np.linalg.norm(lateral) + 1e-9)

# ---- assign gait phase per leg by body plan ----
def foot_pos(leg):
    return joints[leg[-1]]
side = [float(np.dot(foot_pos(l) - center, lateral)) for l in legs]   # -/+ = left/right
fb = [float(np.dot(foot_pos(l) - center, forward)) for l in legs]      # -/+ = back/front

phase = [0.0] * nlegs
if nlegs == 2:                       # contralateral
    phase = [0.0 if s < 0 else math.pi for s in side]
    plan = "biped"
elif nlegs == 4:                     # diagonal trot: (FL,BR)=0, (FR,BL)=pi
    plan = "quadruped"
    for i in range(4):
        front = fb[i] > 0
        left = side[i] < 0
        phase[i] = 0.0 if (front == left) else math.pi
else:                                # metachronal-ish: wave by side, alternating
    plan = f"{nlegs}-legged"
    left_ids = sorted([i for i in range(nlegs) if side[i] < 0], key=lambda i: fb[i])
    right_ids = sorted([i for i in range(nlegs) if side[i] >= 0], key=lambda i: fb[i])
    for rank, i in enumerate(left_ids):
        phase[i] = math.pi * (rank % 2)
    for rank, i in enumerate(right_ids):
        phase[i] = math.pi * ((rank + 1) % 2)   # offset from left side

# arms (bipeds): most laterally-offset non-foot leaves (works for arms-down);
# the central-most leaf is the head and is excluded.
arms = []
if nlegs == 2:
    cand = [i for i in leaves if i not in feet]
    lat_off = {i: float(np.dot(joints[i] - center, lateral)) for i in cand}
    halfw = max((abs(v) for v in lat_off.values()), default=1.0) or 1.0
    hands = [i for i in cand if abs(lat_off[i]) > 0.35 * halfw]
    arms = [chain_up(h) for h in sorted(hands, key=lambda i: -abs(lat_off[i]))[:2]]
    arms.sort(key=lambda c: float(np.dot(joints[c[-1]] - center, lateral)))

print(f"body plan: {plan} ({nlegs} legs), arms={len(arms)}")
print(f"forward={forward.round(2)}  lateral={lateral.round(2)}")
for i, l in enumerate(legs):
    print(f"  leg {i}: joints {l}  side={side[i]:+.2f} fb={fb[i]:+.2f} phase={phase[i]:.2f}")
for i, a in enumerate(arms):
    print(f"  arm {i}: joints {a}  y={[round(float(joints[j,1]),2) for j in a]}")

# ---- walk cycle ----
FPS, DUR = 24, 2.0
nfr = int(FPS * DUR) + 1
times = np.array([f / FPS for f in range(nfr)], dtype=np.float32)
SWING, KNEE, ARM, ELBOW, SPINE, BOB = 0.42, 0.48, 0.9, 0.4, 0.22, 0.05
up = np.array([0.0, 1.0, 0.0])

# spine = central chain from root upward (not legs/arms) -> torso, neck, head
leg_set = set(sum(legs, [])); arm_set = set(sum(arms, []))
spine = []
cur = root
while True:
    kids = [k for k in children[cur] if k not in leg_set and k not in arm_set]
    if not kids:
        break
    nxt = min(kids, key=lambda k: abs(np.dot(joints[k] - center, lateral)))
    spine.append(nxt); cur = nxt
ref = phase[0] if phase else 0.0
print("spine:", spine)

def q_about(axis, ang):
    s = math.sin(ang / 2)
    return np.array([axis[0]*s, axis[1]*s, axis[2]*s, math.cos(ang/2)], np.float32)

rots = np.zeros((J, nfr, 4), np.float32); rots[:, :, 3] = 1.0
root_trans = np.tile(joints[root], (nfr, 1)).astype(np.float32)
for f in range(nfr):
    p = 2 * math.pi * f / (nfr - 1)
    for li, leg in enumerate(legs):
        ph = p + phase[li]
        thigh = leg[0]; knee = leg[1] if len(leg) > 1 else leg[0]
        rots[thigh, f] = q_about(lateral, SWING * math.sin(ph))
        rots[knee, f] = q_about(lateral, KNEE * max(0.0, -math.sin(ph)))
    for ai, arm in enumerate(arms):
        ph = p + (math.pi if ai == 0 else 0.0)          # counter-swing vs legs
        rots[arm[0], f] = q_about(lateral, ARM * math.sin(ph))     # shoulder: full swing
        if len(arm) >= 3:                                          # elbow bend on the mid joint
            rots[arm[1], f] = q_about(lateral, ELBOW * (0.5 + 0.5 * max(0.0, math.sin(ph))))
    if spine:                                            # torso counter-rotates against the hips
        rots[spine[0], f] = q_about(up, -SPINE * math.sin(p + ref))
    root_trans[f, 1] = joints[root, 1] + BOB * abs(math.sin(2 * p))

# ---- skinning attrs (top-4) for the toy ----
order = np.argsort(-weights, axis=1)[:, :4]
jw = np.take_along_axis(weights, order, axis=1).astype(np.float32)
jw /= (jw.sum(1, keepdims=True) + 1e-8)
ji = order.astype(np.uint16)

# ---- overlay geometry: joint diamonds + bone lines, skinned rigidly ----
DIAMOND = np.array([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]], np.float32)
DTRIS = np.array([[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]], np.uint32)
s = 0.018 * msize
ov_pos, ov_ji, ov_faces = [], [], []
for j in range(J):
    base = len(ov_pos)
    for d in DIAMOND:
        ov_pos.append(joints[j] + s * d); ov_ji.append([j, 0, 0, 0])
    for tri in DTRIS:
        ov_faces.append(tri + base)
ov_pos = np.asarray(ov_pos, np.float32)
ov_ji = np.asarray(ov_ji, np.uint16)
ov_faces = np.asarray(ov_faces, np.uint32)
ov_jw = np.tile(np.array([1, 0, 0, 0], np.float32), (len(ov_pos), 1))

ln_pos, ln_ji = [], []
for i in range(J):
    if parents[i] >= 0:
        ln_pos.append(joints[parents[i]]); ln_ji.append([parents[i], 0, 0, 0])
        ln_pos.append(joints[i]); ln_ji.append([i, 0, 0, 0])
ln_pos = np.asarray(ln_pos, np.float32)
ln_ji = np.asarray(ln_ji, np.uint16)
ln_jw = np.tile(np.array([1, 0, 0, 0], np.float32), (len(ln_pos), 1))
ln_idx = np.arange(len(ln_pos), dtype=np.uint32)

# ---- ibm + local translations ----
ibm = np.tile(np.eye(4, dtype=np.float32), (J, 1, 1))
for i in range(J):
    ibm[i, 3, 0:3] = -joints[i]
local_t = joints.copy()
for i in range(J):
    if parents[i] >= 0:
        local_t[i] = joints[i] - joints[parents[i]]

blob = bytearray(); bviews = []; accs = []
def av(b, t=None):
    global blob
    blob += b"\x00" * (-len(blob) % 4); off = len(blob); blob += b
    bviews.append(BufferView(buffer=0, byteOffset=off, byteLength=len(b), target=t))
    return len(bviews) - 1
def ac(v, ct, n, at, mn=None, mx=None):
    accs.append(Accessor(bufferView=v, componentType=ct, count=n, type=at, min=mn, max=mx))
    return len(accs) - 1

def skinned_prim(pos, ji_, jw_, idx, mode=4):
    pa = ac(av(pos.tobytes(), ARRAY_BUFFER), FLOAT, len(pos), VEC3, pos.min(0).tolist(), pos.max(0).tolist())
    ja = ac(av(ji_.tobytes(), ARRAY_BUFFER), UNSIGNED_SHORT, len(pos), VEC4)
    wa = ac(av(jw_.tobytes(), ARRAY_BUFFER), FLOAT, len(pos), VEC4)
    ia = ac(av(idx.tobytes(), ELEMENT_ARRAY_BUFFER), UNSIGNED_INT, len(idx), SCALAR)
    return Primitive(attributes=Attributes(POSITION=pa, JOINTS_0=ja, WEIGHTS_0=wa), indices=ia, mode=mode)

toy_p = skinned_prim(verts, ji, jw, faces.reshape(-1)); toy_p.material = 0
jt_p = skinned_prim(ov_pos, ov_ji, ov_jw, ov_faces.reshape(-1)); jt_p.material = 1
bn_p = skinned_prim(ln_pos, ln_ji, ln_jw, ln_idx, mode=1); bn_p.material = 2   # LINES

ibm_a = ac(av(ibm.tobytes()), FLOAT, J, MAT4)
time_a = ac(av(times.tobytes()), FLOAT, nfr, SCALAR, [float(times.min())], [float(times.max())])
rot_accs = [ac(av(rots[i].tobytes()), FLOAT, nfr, VEC4) for i in range(J)]
roott_a = ac(av(root_trans.tobytes()), FLOAT, nfr, VEC3)

base = 1
nodes = [Node(mesh=0, skin=0, name="rig")]
for i in range(J):
    nodes.append(Node(translation=local_t[i].tolist(), name=f"bone_{i}"))
for i in range(J):
    kids = [base + c for c in children[i]]
    if kids:
        nodes[base + i].children = kids
root_node = base + root

samplers, channels = [], []
for i in range(J):
    samplers.append(AnimationSampler(input=time_a, output=rot_accs[i], interpolation="LINEAR"))
    channels.append(AnimationChannel(sampler=len(samplers)-1,
        target=AnimationChannelTarget(node=base + i, path="rotation")))
samplers.append(AnimationSampler(input=time_a, output=roott_a, interpolation="LINEAR"))
channels.append(AnimationChannel(sampler=len(samplers)-1,
    target=AnimationChannelTarget(node=root_node, path="translation")))

def mat(rgba, emit=(0, 0, 0), blend=False):
    m = Material(pbrMetallicRoughness=PbrMetallicRoughness(baseColorFactor=list(rgba), metallicFactor=0.0, roughnessFactor=1.0),
                 emissiveFactor=list(emit), doubleSided=True)
    if blend:
        m.alphaMode = "BLEND"
    return m

g = GLTF2()
g.scenes = [Scene(nodes=[0, root_node])]; g.scene = 0
g.nodes = nodes
g.meshes = [Mesh(primitives=[toy_p, jt_p, bn_p])]
g.materials = [mat((0.55, 0.55, 0.62, 0.22), blend=True),      # see-through toy
               mat((1, 0.75, 0.1, 1), emit=(1.0, 0.55, 0.0)),  # joints: amber glow
               mat((0.2, 1.0, 0.5, 1), emit=(0.1, 1.0, 0.4))]  # bones: green glow
g.skins = [Skin(joints=[base + i for i in range(J)], inverseBindMatrices=ibm_a, skeleton=root_node)]
g.animations = [Animation(name="walk", samplers=samplers, channels=channels)]
g.bufferViews = bviews; g.accessors = accs
g.buffers = [Buffer(byteLength=len(blob))]; g.set_binary_blob(bytes(blob))
out = os.environ["OUT_GLB"]; g.save(out)
print(f"saved {out}: toy {V}v + {J} joints/bones, {nfr} frames")
