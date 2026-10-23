"""Write a skinned, animated toy as a .usdz for iOS AR Quick Look (UsdSkel).

Fed directly from retarget2's in-memory arrays (same data that builds the animated
glTF), so the AR clip matches the in-browser one. glTF skinning maps cleanly onto
UsdSkel: static local bone translations + per-frame local rotation quaternions,
skinned by 4 joint indices/weights per vertex.
"""
import os
import tempfile
import shutil
import numpy as np
from pxr import Usd, UsdGeom, UsdSkel, UsdShade, Sdf, Gf, Vt, UsdUtils

TARGET_METERS = 0.22   # longest dim in the room before pinch-scale (matches static usdz)


def _joint_paths(parents):
    """Hierarchical token paths encoding the skeleton topology: J0, J0/J3, ..."""
    names = [f"J{i}" for i in range(len(parents))]
    paths = [None] * len(parents)

    def build(i):
        if paths[i] is None:
            p = parents[i]
            paths[i] = names[i] if p < 0 else build(p) + "/" + names[i]
        return paths[i]

    for i in range(len(parents)):
        build(i)
    return paths


def _bind_texture(stage, mesh, work, uv, tex_png, verts_n):
    surf = UsdShade.Shader.Define(stage, "/Toy/Mat/Surface")
    surf.CreateIdAttr("UsdPreviewSurface")
    surf.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.85)
    surf.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
    mat = UsdShade.Material.Define(stage, "/Toy/Mat")
    mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")

    has_tex = uv is not None and tex_png is not None and len(uv) == verts_n
    if has_tex:
        st = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar(
            "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
        # Callers pass glTF-convention UVs (top-left origin); USD/UsdUVTexture is
        # bottom-left, so flip V here (a baked atlas would otherwise scramble).
        uvf = np.asarray(uv, np.float32).copy()
        uvf[:, 1] = 1.0 - uvf[:, 1]
        st.Set(Vt.Vec2fArray.FromNumpy(uvf))
        os.makedirs(os.path.join(work, "tex"), exist_ok=True)
        with open(os.path.join(work, "tex", "albedo.png"), "wb") as f:
            f.write(tex_png)
        reader = UsdShade.Shader.Define(stage, "/Toy/Mat/stReader")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
        tex = UsdShade.Shader.Define(stage, "/Toy/Mat/DiffuseTex")
        tex.CreateIdAttr("UsdUVTexture")
        tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set("./tex/albedo.png")
        tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
        tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
        tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
        tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
        surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
    else:
        surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0.8, 0.8, 0.8))
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim())
    UsdShade.MaterialBindingAPI(mesh).Bind(mat)


def write_animated_usdz(out_path, verts, faces, ji, jw, joints, parents, local_t,
                        rots, root_trans, root, uv=None, tex_png=None,
                        target_meters=TARGET_METERS, fps=60.0):
    """rots: (J, NFR, 4) glTF quats (x,y,z,w). local_t: (J,3). root_trans: (NFR,3)."""
    verts = np.asarray(verts, np.float32)
    faces = np.asarray(faces, np.int32)
    J = len(joints)
    NFR = rots.shape[1]

    ext = verts.max(0) - verts.min(0)
    scale = target_meters / (float(ext.max()) or 1.0)

    work = tempfile.mkdtemp(prefix="ausdz_")
    try:
        stage = Usd.Stage.CreateNew(os.path.join(work, "scene.usdc"))
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        stage.SetStartTimeCode(0)
        stage.SetEndTimeCode(NFR - 1)
        stage.SetTimeCodesPerSecond(fps)
        stage.SetFramesPerSecond(fps)

        root_prim = UsdSkel.Root.Define(stage, "/Toy")
        UsdGeom.Xform(root_prim.GetPrim()).AddScaleOp().Set(Gf.Vec3f(scale, scale, scale))
        stage.SetDefaultPrim(root_prim.GetPrim())

        paths = _joint_paths(parents)

        # ---- Skeleton: world bind + local rest transforms (identity rotation) ----
        skel = UsdSkel.Skeleton.Define(stage, "/Toy/Skel")
        skel.CreateJointsAttr(Vt.TokenArray(paths))
        bind, rest = [], []
        for i in range(J):
            b = Gf.Matrix4d(1.0); b.SetTranslateOnly(Gf.Vec3d(*[float(x) for x in joints[i]])); bind.append(b)
            r = Gf.Matrix4d(1.0); r.SetTranslateOnly(Gf.Vec3d(*[float(x) for x in local_t[i]])); rest.append(r)
        skel.CreateBindTransformsAttr(Vt.Matrix4dArray(bind))
        skel.CreateRestTransformsAttr(Vt.Matrix4dArray(rest))

        # ---- Animation: per-frame local translations / rotations / scales ----
        anim = UsdSkel.Animation.Define(stage, "/Toy/Skel/Anim")
        anim.CreateJointsAttr(Vt.TokenArray(paths))
        t_attr = anim.CreateTranslationsAttr()
        r_attr = anim.CreateRotationsAttr()
        s_attr = anim.CreateScalesAttr()
        scales = Vt.Vec3hArray([Gf.Vec3h(1.0, 1.0, 1.0)] * J)
        for f in range(NFR):
            tr = [Gf.Vec3f(*[float(x) for x in (root_trans[f] if i == root else local_t[i])])
                  for i in range(J)]
            quats = []
            for i in range(J):
                x, y, z, w = [float(v) for v in rots[i, f]]
                quats.append(Gf.Quatf(w, x, y, z))
            tc = Usd.TimeCode(f)
            t_attr.Set(Vt.Vec3fArray(tr), tc)
            r_attr.Set(Vt.QuatfArray(quats), tc)
            s_attr.Set(scales, tc)
        UsdSkel.BindingAPI.Apply(skel.GetPrim()).CreateAnimationSourceRel().SetTargets([anim.GetPath()])

        # ---- Mesh + skin binding ----
        mesh = UsdGeom.Mesh.Define(stage, "/Toy/Mesh")
        mesh.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(verts))
        mesh.CreateFaceVertexCountsAttr(Vt.IntArray.FromNumpy(np.full(len(faces), 3, np.int32)))
        mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(faces.ravel().astype(np.int32)))
        mn, mx = verts.min(0), verts.max(0)
        mesh.CreateExtentAttr([Gf.Vec3f(*mn.tolist()), Gf.Vec3f(*mx.tolist())])

        _bind_texture(stage, mesh, work, uv, tex_png, len(verts))

        mbind = UsdSkel.BindingAPI.Apply(mesh.GetPrim())
        mbind.CreateSkeletonRel().SetTargets([skel.GetPath()])
        ip = mbind.CreateJointIndicesPrimvar(False, 4)
        ip.Set(Vt.IntArray.FromNumpy(np.ascontiguousarray(ji).astype(np.int32).ravel()))
        wp = mbind.CreateJointWeightsPrimvar(False, 4)
        wp.Set(Vt.FloatArray.FromNumpy(np.ascontiguousarray(jw).astype(np.float32).ravel()))
        mbind.CreateGeomBindTransformAttr(Gf.Matrix4d(1.0))

        stage.GetRootLayer().Save()

        cwd = os.getcwd()
        os.chdir(work)
        try:
            UsdUtils.CreateNewUsdzPackage("scene.usdc", "out.usdz")
        finally:
            os.chdir(cwd)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        shutil.move(os.path.join(work, "out.usdz"), out_path)
        return out_path
    finally:
        shutil.rmtree(work, ignore_errors=True)


_CT = {5120: "i1", 5121: "u1", 5122: "i2", 5123: "u2", 5125: "u4", 5126: "f4"}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def animated_glb_to_usdz(glb_path, usdz_path):
    """Build an animated .usdz from a cached toy_mocap_<move>.glb (no re-rig needed).

    Reverses the skinned glTF retarget2 wrote — mesh, skin, one animation, embedded
    texture — back into the arrays write_animated_usdz wants. Lets old cached clips
    get iOS animated AR on demand without regenerating the whole pipeline.
    """
    import pygltflib
    g = pygltflib.GLTF2().load(glb_path)
    blob = g.binary_blob()

    def acc(i):
        a = g.accessors[i]; bv = g.bufferViews[a.bufferView]
        off = (bv.byteOffset or 0) + (a.byteOffset or 0)
        n = a.count * _NC[a.type]
        arr = np.frombuffer(blob, dtype=np.dtype("<" + _CT[a.componentType]), count=n, offset=off)
        return arr.reshape(a.count, _NC[a.type])

    prim = g.meshes[0].primitives[0]
    verts = acc(prim.attributes.POSITION).astype(np.float32)
    faces = acc(prim.indices).astype(np.int32).reshape(-1, 3)
    ji = acc(prim.attributes.JOINTS_0).astype(np.int32)
    jw = acc(prim.attributes.WEIGHTS_0).astype(np.float32)
    uv = (acc(prim.attributes.TEXCOORD_0).astype(np.float32)
          if prim.attributes.TEXCOORD_0 is not None else None)

    skin = g.skins[0]
    jnodes = list(skin.joints)
    J = len(jnodes)
    node2j = {n: k for k, n in enumerate(jnodes)}
    IBM = acc(skin.inverseBindMatrices).reshape(-1, 4, 4).astype(np.float64)
    joints = np.array([-IBM[k][3, 0:3] for k in range(J)], np.float32)  # IBM = translate(-joint)
    parents = [-1] * J
    for k, n in enumerate(jnodes):
        for c in (g.nodes[n].children or []):
            if c in node2j:
                parents[node2j[c]] = k
    root = parents.index(-1)
    local_t = np.array([g.nodes[n].translation or [0, 0, 0] for n in jnodes], np.float32)

    anim = g.animations[0]
    rot_by_node, tr_by_node, times = {}, {}, None
    for ch in anim.channels:
        smp = anim.samplers[ch.sampler]
        if times is None:
            times = acc(smp.input)[:, 0]
        out = acc(smp.output)
        (rot_by_node if ch.target.path == "rotation" else tr_by_node)[ch.target.node] = out
    NFR = len(times)
    rots = np.zeros((J, NFR, 4), np.float32); rots[:, :, 3] = 1.0
    for k, n in enumerate(jnodes):
        if n in rot_by_node:
            rots[k] = rot_by_node[n]
    root_trans = tr_by_node.get(jnodes[root], np.tile(joints[root], (NFR, 1))).astype(np.float32)

    tex_png = None
    if uv is not None and g.images:
        img = g.images[0]
        if img.bufferView is not None:
            bv = g.bufferViews[img.bufferView]; off = bv.byteOffset or 0
            tex_png = bytes(blob[off:off + bv.byteLength])

    return write_animated_usdz(usdz_path, verts, faces, ji, jw, joints, parents,
                               local_t, rots, root_trans, root, uv=uv, tex_png=tex_png)
