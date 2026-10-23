"""Render the Mixamo source skeleton by BAKING joint world positions per frame
(translation only, flat hierarchy) — foolproof: no rotation-frame ambiguity.
If this doesn't look like a clean walk, the problem is in extraction."""
import os
import numpy as np
from scipy.spatial.transform import Rotation as Rot
from pygltflib import (
    GLTF2, Scene, Node, Mesh, Primitive, Attributes, Skin, Buffer, BufferView,
    Accessor, Animation, AnimationChannel, AnimationChannelTarget, AnimationSampler,
    Material, PbrMetallicRoughness,
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, UNSIGNED_SHORT,
    SCALAR, VEC3, VEC4, MAT4,
)

sp = os.path.dirname(os.path.abspath(__file__))
m = np.load(os.path.join(sp, os.environ.get("CLIP_NPZ", "mixamo_walk.npz")), allow_pickle=True)
parents = [int(p) for p in m["parents"]]
pose = m["pose_world"].astype(np.float64)          # (B,F,4,4) Blender world
B, F = pose.shape[0], pose.shape[1]

# joint world positions per frame = translation of each bone's world matrix
posw = pose[:, :, :3, 3]                            # (B,F,3) — data is already Y-up
Cm = np.eye(3)                                       # no axis conversion needed
posg = np.einsum("ij,bfj->bfi", Cm, posw)          # (B,F,3)
allp = posg.reshape(-1, 3)
ctr = (allp.max(0) + allp.min(0)) / 2
scale = 2.0 / (allp[:, 1].max() - allp[:, 1].min() + 1e-9)
posg = ((posg - ctr) * scale).astype(np.float32)   # centered, ~2 units tall

# find a clean loop: first frame whose whole-skeleton pose returns closest to frame 0
ref = posg[:, 0]
MINP = max(20, F // 12)
D = np.array([float(np.linalg.norm(posg[:, t] - ref, axis=1).mean()) for t in range(F)])
T = MINP + int(np.argmin(D[MINP:]))
posg = posg[:, :T]; F = T
print(f"loop length: {T} frames (pose-return residual {D[T]:.4f})")

bind = posg[:, 0, :]                                # frame-0 positions as bind

children = {i: [] for i in range(B)}
for i, p in enumerate(parents):
    if p >= 0: children[p].append(i)

# ---- geometry: diamonds at bind, skinned weight-1 to each joint ----
DIA = np.array([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]], np.float32)
DT = np.array([[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]], np.uint32)
s = 0.02
ovp, ovj, ovf = [], [], []
for j in range(B):
    base = len(ovp)
    for d in DIA: ovp.append(bind[j] + s*d); ovj.append([j,0,0,0])
    for t in DT: ovf.append(t + base)
ovp = np.asarray(ovp, np.float32); ovj = np.asarray(ovj, np.uint16); ovf = np.asarray(ovf, np.uint32)
ovw = np.tile(np.array([1,0,0,0], np.float32), (len(ovp), 1))
lnp, lnj = [], []
for i in range(B):
    if parents[i] >= 0:
        lnp.append(bind[parents[i]]); lnj.append([parents[i],0,0,0]); lnp.append(bind[i]); lnj.append([i,0,0,0])
lnp = np.asarray(lnp, np.float32); lnj = np.asarray(lnj, np.uint16)
lnw = np.tile(np.array([1,0,0,0], np.float32), (len(lnp), 1)); lni = np.arange(len(lnp), dtype=np.uint32)
ibm = np.tile(np.eye(4, dtype=np.float32), (B,1,1))
for i in range(B): ibm[i,3,0:3] = -bind[i]          # flat hierarchy: IBM = translate(-bind)

blob = bytearray(); bviews=[]; accs=[]
def av(b,t=None):
    global blob
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
jt=prim(ovp,ovj,ovw,ovf.reshape(-1)); jt.material=0
bn=prim(lnp,lnj,lnw,lni,mode=1); bn.material=1
ibm_a=ac(av(ibm.tobytes()),FLOAT,B,MAT4)
times=(np.arange(F)/60.0).astype(np.float32)
time_a=ac(av(times.tobytes()),FLOAT,F,SCALAR,[float(times.min())],[float(times.max())])
# animate each joint node's TRANSLATION to its baked world position
trans_accs=[ac(av(np.ascontiguousarray(posg[i]).tobytes()),FLOAT,F,VEC3) for i in range(B)]

# flat hierarchy: all joint nodes are scene roots (no parenting)
nodes=[Node(mesh=0,skin=0,name="mixamo")]
for i in range(B): nodes.append(Node(translation=bind[i].tolist(), name=f"m{i}"))
joint_nodes=[1+i for i in range(B)]
samplers=[AnimationSampler(input=time_a,output=trans_accs[i],interpolation="LINEAR") for i in range(B)]
channels=[AnimationChannel(sampler=i,target=AnimationChannelTarget(node=1+i,path="translation")) for i in range(B)]
def mat(rgba,emit):
    return Material(pbrMetallicRoughness=PbrMetallicRoughness(baseColorFactor=list(rgba),metallicFactor=0.0,roughnessFactor=1.0),emissiveFactor=list(emit),doubleSided=True)
g=GLTF2(); g.scenes=[Scene(nodes=[0]+joint_nodes)]; g.scene=0; g.nodes=nodes
g.meshes=[Mesh(primitives=[jt,bn])]
g.materials=[mat((0.3,0.8,1,1),(0.1,0.5,1.0)),mat((0.5,0.9,1,1),(0.2,0.6,1.0))]
g.skins=[Skin(joints=joint_nodes,inverseBindMatrices=ibm_a)]
g.animations=[Animation(name="walk",samplers=samplers,channels=channels)]
g.bufferViews=bviews; g.accessors=accs; g.buffers=[Buffer(byteLength=len(blob))]; g.set_binary_blob(bytes(blob))
out=os.environ["OUT_GLB"]; g.save(out)
print(f"saved {out}: {B} bones, {F} frames (position-baked)")
