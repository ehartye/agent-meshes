"""Isolated-env (bpy): import a Mixamo FBX and dump skeleton + local motion curves.

matrix_basis is the pose transform in each bone's local (rest-relative) space,
so its rotation is exactly the animation's local delta rotation per bone —
ideal for retargeting. Also grabs hip translation (root bob) and rest data.
"""
import os
import sys

import numpy as np

FBX = os.environ["FBX"]
OUT = os.environ["OUT_NPZ"]

import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=FBX)

arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
bones = list(arm.data.bones)
names = [b.name for b in bones]

# CMU mocap conversions (mesh2motion's CarnegieMellonAnimations, the rancidmilk
# FBX pack) use DAZ/Poser bone names — rename to the bare Mixamo suffixes
# retarget2 expects. Gated on a name signature so true Mixamo rigs
# (mixamorig:*) pass through untouched — the glb_clip.BONE_MAP lesson (its
# ungated version once renamed the snake's 'head'). Unmapped bones (fingers,
# eyes, buttock links) keep their names; retarget2 only reads mapped chains.
CMU_MAP = {
    "hip": "Hips", "abdomen": "Spine", "chest": "Spine1",
    "neck": "Neck", "head": "Head",
    "lCollar": "LeftShoulder", "lShldr": "LeftArm", "lForeArm": "LeftForeArm",
    "lHand": "LeftHand", "lMid1": "LeftHandMiddle1",
    "rCollar": "RightShoulder", "rShldr": "RightArm", "rForeArm": "RightForeArm",
    "rHand": "RightHand", "rMid1": "RightHandMiddle1",
    "lThigh": "LeftUpLeg", "lShin": "LeftLeg", "lFoot": "LeftFoot",
    "rThigh": "RightUpLeg", "rShin": "RightLeg", "rFoot": "RightFoot",
}
raw_names = list(names)                            # bpy lookups need the RAW names
idx = {n: i for i, n in enumerate(raw_names)}
parents = [idx[b.parent.name] if b.parent else -1 for b in bones]
IS_CMU = {"hip", "abdomen", "rShldr", "lThigh"} <= set(names)
if IS_CMU:
    names = [CMU_MAP.get(n, n) for n in names]     # only the SAVED names are renamed
    print("CMU rig detected -> renamed to Mixamo suffixes")
# rest data in armature space
rest_head = np.array([list(b.head_local) for b in bones], np.float32)
rest_tail = np.array([list(b.tail_local) for b in bones], np.float32)
rest_mat = np.array([[list(row) for row in b.matrix_local] for b in bones], np.float32)  # (B,4,4)

scene = bpy.context.scene
f0, f1 = scene.frame_start, scene.frame_end
nfr = f1 - f0 + 1
pbs = [arm.pose.bones[n] for n in raw_names]

# pose_bone.matrix is the FK-resolved WORLD (armature-space) transform per frame
pose_world = np.zeros((len(names), nfr, 4, 4), np.float32)
for k, f in enumerate(range(f0, f1 + 1)):
    scene.frame_set(f)
    for bi, pb in enumerate(pbs):
        pose_world[bi, k] = [[c for c in row] for row in pb.matrix]

# The CMU pack's armature space is NOT Y-up (its hips' walking travel ran along
# Y and launched the root-bob sky-high). Normalize: rotate everything so the
# frame-0 spine (Hips -> Head) points +Y — the downstream retarget assumes
# Y-vertical (heights, yaw search, root bob). Yaw stays free (retarget resolves
# it). Mixamo rigs import Y-up already and are untouched.
if IS_CMU:
    # pure-arithmetic math only: BLAS-backed numpy kernels (matmul/einsum, like
    # LAPACK svd before them) abort natively in this bpy/pixi env (OpenMP clash)
    import math
    hips0 = [float(v) for v in pose_world[names.index("Hips"), 0, :3, 3]]
    head0 = [float(v) for v in pose_world[names.index("Head"), 0, :3, 3]]
    a = [h - p for h, p in zip(head0, hips0)]
    n = math.sqrt(sum(x * x for x in a)) or 1.0
    a = [x / n for x in a]
    v = [a[1] * 0 - a[2] * 1, a[2] * 0 - a[0] * 0, a[0] * 1 - a[1] * 0]  # a x (0,1,0)
    c = a[1]
    s = math.sqrt(sum(x * x for x in v))
    if s < 1e-8:
        R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] if c > 0 else [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
    else:
        k = [x / s for x in v]
        K = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]]
        KK = [[sum(K[i][m] * K[m][j] for m in range(3)) for j in range(3)] for i in range(3)]
        R = [[(1.0 if i == j else 0.0) + s * K[i][j] + (1 - c) * KK[i][j]
              for j in range(3)] for i in range(3)]
    Rn = np.array(R, np.float32)                        # (3,3)
    # x @ R.T via broadcast multiply-sum (no BLAS gemm)
    rest_head = (rest_head[:, None, :] * Rn[None, :, :]).sum(-1)
    rest_tail = (rest_tail[:, None, :] * Rn[None, :, :]).sum(-1)
    R4 = np.eye(4, dtype=np.float32); R4[:3, :3] = Rn
    rest_mat = (R4[None, :, :, None] * rest_mat[:, None, :, :]).sum(2)
    pose_world = (R4[None, None, :, :, None] * pose_world[:, :, None, :, :]).sum(3)
    print(f"CMU up-axis normalized (spine was {[round(x, 2) for x in a]})", flush=True)

print(f"bones: {len(names)}  frames: {nfr}  fps~{scene.render.fps}")
print("names:", names)

# temp-write + atomic rename: with-skin Mixamo FBX (21MB scenes) segfaults bpy's
# teardown even under os._exit, so a nonzero exit code here is BENIGN NOISE —
# mocap gates on the npz existing, and the rename guarantees exists == complete.
tmp = OUT[:-4] + "_tmp.npz" if OUT.endswith(".npz") else OUT + "_tmp.npz"
np.savez(tmp, names=np.array(names, dtype=object), parents=np.array(parents),
         rest_head=rest_head, rest_tail=rest_tail, rest_mat=rest_mat,
         pose_world=pose_world)
os.replace(tmp, OUT)
print("saved", OUT, flush=True)
sys.stdout.flush(); sys.stderr.flush()
os._exit(0)
