"""Rig any body from a reference rig and play the reference's clips on it (Blender side).

A reference GLB carries a skinned mesh, its skeleton and clips (e.g. Mesh2Motion's CC0 human: 66 bones, 88 clips).
`rig_from_reference` fits that skeleton to a body, transfers the reference's artist skin weights and retargets the
chosen clips:

1. The reference is posed to the body's rest pose (limbs turned to point where the body's do), so a T-posed
   reference and an A-posed body line up.
2. A thin-plate spline through joint correspondences (reference joint name -> body point) warps the posed
   reference skeleton and mesh onto the body: every bone (fingers too) lands in the body's proportions.
3. The body takes the warped reference mesh's weights (nearest surface, interpolated).
4. Each clip is baked onto the fitted skeleton by copying every bone's world orientation from the reference
   frame by frame (rest poses may differ), with the root/pelvis travel scaled by the leg-length ratio.

Blender frame throughout (Z up). Correspondence points are world positions.
"""
import math

import numpy as np

from agent_meshes_reproportion import warp_points


def import_reference(path):
    """Import a rigged GLB; returns (armature, [skinned meshes], {action name: action})."""
    import bpy
    before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    meshes = [o for o in new if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
    actions = {a.name: a for a in bpy.data.actions if a not in actions_before}
    if arm.animation_data:
        arm.animation_data.action = None
        for track in list(arm.animation_data.nla_tracks):
            arm.animation_data.nla_tracks.remove(track)
    # glTF import evaluates the first animation. Unlinking its action/NLA leaves
    # those pose values behind: reset explicitly before fitting the rest skeleton
    # or transferring weights (curled fingers otherwise warp into nearby limbs).
    for bone in arm.pose.bones:
        bone.matrix_basis.identity()
    bpy.context.view_layer.update()
    return arm, meshes, actions


def _world_heads(arm):
    return {b.name: np.array(arm.matrix_world @ b.head_local) for b in arm.data.bones}


def pose_to_directions(arm, directions):
    """Pose `arm` so each named bone points along a world direction (bone name -> 3-vector), parents first."""
    import bpy
    from mathutils import Vector
    bpy.context.view_layer.objects.active = arm
    for name in [b.name for b in arm.data.bones]:           # parents precede children in bones order
        if name not in directions:
            continue
        pb = arm.pose.bones[name]
        bpy.context.view_layer.update()
        current = (arm.matrix_world.to_3x3() @ (pb.tail - pb.head)).normalized()
        want = Vector(directions[name]).normalized()
        delta = current.rotation_difference(want).to_matrix().to_4x4()
        M = arm.matrix_world @ pb.matrix
        head = M.translation.copy()
        R = delta @ M.to_3x3().to_4x4()
        R.translation = head
        pb.matrix = arm.matrix_world.inverted() @ R
    bpy.context.view_layer.update()


def posed_positions(arm, meshes):
    """World joint heads/tails of the posed armature and the posed (evaluated) mesh vertices."""
    import bpy
    deps = bpy.context.evaluated_depsgraph_get()
    joints, frames = {}, {}
    for pb in arm.pose.bones:
        joints[pb.name] = (np.array(arm.matrix_world @ pb.head), np.array(arm.matrix_world @ pb.tail))
        frames[pb.name] = (arm.matrix_world @ pb.matrix).to_3x3().normalized()
    verts = []
    for m in meshes:
        ev = m.evaluated_get(deps)
        data = ev.to_mesh()
        verts.append(np.array([tuple(m.matrix_world @ v.co) for v in data.vertices]))
        ev.to_mesh_clear()
    return joints, verts, frames


def fit_skeleton(ref_arm, joints, fitted, name='rig', frames=None):
    """A new armature shaped like `ref_arm` with each bone's head at its `fitted` position (name -> (head, tail)).

    With `frames` (name -> world 3x3 orientation of the posed reference bone) each bone takes that exact
    orientation, twist included, and the fitted length: the rest pose is then the reference posed like the body,
    so world-orientation retargeting applies no spurious twist. Without it the tail goes to the fitted tail and the
    reference roll is kept."""
    import bpy
    from mathutils import Vector
    data = ref_arm.data.copy()
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    arm.matrix_world.identity()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for eb in data.edit_bones:
        eb.use_connect = False
    for eb in data.edit_bones:
        if eb.name not in fitted:
            continue
        head, tail = (Vector(p) for p in fitted[eb.name])
        if frames and eb.name in frames:
            M = frames[eb.name].to_4x4()
            M.translation = head
            length = max((tail - head).length, 1e-4)
            eb.matrix = M
            eb.length = length
        else:
            eb.head, eb.tail = head, tail
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def transfer_weights(source, target, smooth=0):
    """Copy vertex-group weights from `source` (a mesh lying on the target's surface) to `target`, nearest face
    interpolated, then keep four influences and normalize."""
    import bpy
    for g in list(target.vertex_groups):
        target.vertex_groups.remove(g)
    for g in source.vertex_groups:
        target.vertex_groups.new(name=g.name)
    mod = target.modifiers.new('weights', 'DATA_TRANSFER')
    mod.object = source
    mod.use_vert_data = True
    mod.data_types_verts = {'VGROUP_WEIGHTS'}
    mod.vert_mapping = 'POLYINTERP_NEAREST'
    mod.layers_vgroup_select_src = 'ALL'
    mod.layers_vgroup_select_dst = 'NAME'
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.select_all(action='DESELECT')
    target.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if smooth:
        # Soften hard edges left where neighbouring vertices found different donor faces.
        bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
        bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=.5, repeat=smooth)
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)


def world_frames(arm, names):
    """World 3x3 orientation of each named pose bone, as posed now."""
    import bpy
    bpy.context.view_layer.update()
    return {n: (arm.matrix_world @ arm.pose.bones[n].matrix).to_3x3().normalized() for n in names}


def retarget(ref_arm, arm, action, root='pelvis', travel_scale=1.0, fps=None, neutral=None):
    """Bake `action` (on ref_arm) onto `arm` by copying every shared bone's world orientation each frame; the root
    bone's travel from its rest is scaled by `travel_scale`. Returns the new action.

    neutral: {'source': {bone: world 3x3}, 'target': {bone: world 3x3}} for bones whose motion, not absolute
    angle, should carry over: each frame applies the reference's world-space motion delta to the target neutral.
    Unconfigured descendants inherit their parent's correction and keep their relative animated articulation.
    A body shaped unlike the reference keeps its own relaxed arm hang without erasing the clip's finger grip."""
    import bpy
    scene = bpy.context.scene
    ref_arm.animation_data_create()
    ref_arm.animation_data.action = action
    start, end = (int(round(v)) for v in action.frame_range)
    shared = [b.name for b in arm.data.bones if b.name in ref_arm.pose.bones]
    arm.animation_data_create()
    out = bpy.data.actions.new(action.name)
    arm.animation_data.action = out
    ref_root_rest = ref_arm.matrix_world @ ref_arm.data.bones[root].head_local
    tgt_root_rest = arm.matrix_world @ arm.data.bones[root].head_local
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        worlds = {n: ref_arm.matrix_world @ ref_arm.pose.bones[n].matrix for n in shared}
        corrected = {}
        for n in shared:                                    # bones order: parents before children
            pb = arm.pose.bones[n]
            if neutral and n in neutral['target']:
                R = (worlds[n].to_3x3().normalized() @ neutral['source'][n].inverted() @ neutral['target'][n]).to_4x4()
                corrected[n] = R.to_3x3()
            elif pb.parent and pb.parent.name in corrected:
                parent = pb.parent.name
                # Carry the calibrated parent's change through its descendants;
                # retain their animated relative articulation (especially grips).
                R = (corrected[parent] @ worlds[parent].to_3x3().normalized().inverted()
                     @ worlds[n].to_3x3().normalized()).to_4x4()
                corrected[n] = R.to_3x3()
            else:
                R = worlds[n].to_3x3().normalized().to_4x4()
            if n == root:
                R.translation = tgt_root_rest + (worlds[n].translation - ref_root_rest) * travel_scale
            else:
                bpy.context.view_layer.update()
                R.translation = (arm.matrix_world @ pb.matrix).translation   # keep the fitted bone lengths
            pb.matrix = arm.matrix_world.inverted() @ R
            pb.keyframe_insert('rotation_quaternion', frame=frame - start)
            if n == root:
                pb.keyframe_insert('location', frame=frame - start)
        bpy.context.view_layer.update()
    arm.animation_data.action = None
    ref_arm.animation_data.action = None
    return out


def rig_from_reference(body, reference, correspondence, clips, directions=None, root='pelvis', leg=('thigh_l', 'foot_l'),
                       rigid=None, ground=None, limbs=None, smooth=2, regions=None, neutral=None, weight_limits=None):
    """Rig `body` (a mesh at rest, Blender frame) from a reference GLB.

    correspondence: reference joint name -> body world point (bone heads; 'name:tail' for a bone's tail). At least
    the limb joints, pelvis/neck/head and the extremities. directions: reference bone name -> world direction the
    body's limb points at rest (to pose the reference like the body first). clips: reference action names to bake.
    rigid: bone -> (point, normal), a region that rides that bone alone (e.g. a big head above the neck).
    limbs: (head joint, tail joint) correspondence names whose cross-sections are matched too, so the reference
    wraps the body's limbs before its weights transfer. smooth: weight smoothing passes after the transfer.
    regions: exclusive limb regions (lists of subtree roots, see exclusive_regions), so a hand resting by a thigh
    never takes the thigh's weights.
    neutral: {'source': (reference action, frame), 'target': {bone: world direction of the body's relaxed pose},
    'bones': [subtree roots]} carries those subtrees' motion around the body's own neutral pose instead of copying
    absolute angles (see retarget).
    ground: clip -> 'always' | 'lowest' (see ground_clip).
    weight_limits: optional restrict_weights keyword dicts (bones, fallback, point, normal, band), applied after
    region isolation and before rigid overrides. Use anatomical constraints where transferred weights are unreliable.
    Returns (armature, {clip: action}).
    """
    import bpy
    ref_arm, ref_meshes, actions = import_reference(reference)
    if directions:
        pose_to_directions(ref_arm, directions)
    joints, verts, frames = posed_positions(ref_arm, ref_meshes)
    point = lambda key: joints[key.split(':')[0]][1 if key.endswith(':tail') else 0]
    src = np.array([point(k) for k in correspondence])
    dst = np.array([correspondence[k] for k in correspondence], float)
    if limbs:
        # Wrap the reference's limbs onto the body's: cross-section rings along each segment, matched.
        body_V = np.array([tuple(body.matrix_world @ v.co) for v in body.data.vertices])
        ref_J = {k.split(':')[0]: point(k) for k in correspondence}
        body_J = {k.split(':')[0]: np.asarray(correspondence[k], float) for k in correspondence}
        rs, rd = limb_rings(np.vstack(verts), body_V, ref_J, body_J, limbs)
        if len(rs):
            src, dst = np.vstack([src, rs]), np.vstack([dst, rd])
    heads = np.array([joints[n][0] for n in joints]); tails = np.array([joints[n][1] for n in joints])
    wh, wt = warp_points(src, dst, heads), warp_points(src, dst, tails)
    fitted = {n: (wh[i], wt[i]) for i, n in enumerate(joints)}
    arm = fit_skeleton(ref_arm, joints, fitted, frames=frames)
    # The reference mesh, posed and warped onto the body, lends its weights.
    donors = []
    for m, V in zip(ref_meshes, verts):
        W = warp_points(src, dst, V)
        donor = bpy.data.objects.new(m.name + '-donor', m.data.copy())
        bpy.context.scene.collection.objects.link(donor)
        donor.matrix_world.identity()
        for v, p in zip(donor.data.vertices, W):
            v.co = p
        for g in m.vertex_groups:
            donor.vertex_groups.new(name=g.name)
        for v in m.data.vertices:
            for g in v.groups:
                donor.vertex_groups[m.vertex_groups[g.group].name].add([v.index], g.weight, 'REPLACE')
        donors.append(donor)
    donor = donors[0]
    transfer_weights(donor, body, smooth)
    for d in donors:
        bpy.data.objects.remove(d, do_unlink=True)
    if regions:
        exclusive_regions(body, arm, regions)
    for limit in weight_limits or []:
        for name in limit['bones']:
            if name not in arm.data.bones:
                raise ValueError(f'Unknown weight-limit bone: {name}')
        restrict_weights(body, **limit)
    for bone, (point, normal) in (rigid or {}).items():
        make_rigid(body, bone, point, normal)
    body.parent = arm
    mod = body.modifiers.new('armature', 'ARMATURE')
    mod.object = arm
    # Travel scales by leg length (thigh head to foot head).
    ref_bones = ref_arm.data.bones
    ref_leg = (ref_bones[leg[0]].head_local - ref_bones[leg[1]].head_local).length
    tgt_leg = (arm.data.bones[leg[0]].head_local - arm.data.bones[leg[1]].head_local).length
    for pb in ref_arm.pose.bones:                           # clips start from the reference's own rest
        pb.matrix_basis.identity()
    calibration = None
    if neutral:
        names = [n for r in neutral['bones'] for n in _subtree(arm, r)]
        # The reference's neutral: its chosen clip at the chosen frame.
        src_action, src_frame = neutral['source']
        ref_arm.animation_data_create(); ref_arm.animation_data.action = actions[src_action]
        bpy.context.scene.frame_set(int(src_frame))
        source = world_frames(ref_arm, names)
        ref_arm.animation_data.action = None
        for pb in ref_arm.pose.bones:
            pb.matrix_basis.identity()
        # The body's neutral: its limbs turned to the relaxed directions (children follow), then back to rest.
        pose_to_directions(arm, neutral['target'])
        # Only explicitly requested joints get their own neutral correction. The
        # remaining descendants inherit it; resetting each finger to its rest
        # would erase the reference idle's grip from every retargeted clip.
        target = world_frames(arm, [n for n in names if n in neutral['target']])
        for pb in arm.pose.bones:
            pb.matrix_basis.identity()
        calibration = {'source': source, 'target': target}
    baked = {name: retarget(ref_arm, arm, actions[name], root, tgt_leg / ref_leg, neutral=calibration) for name in clips}
    for name, action in baked.items():                      # ground each clip on the body's own feet
        mode = (ground or {}).get(name)
        if mode:
            ground_clip(arm, body, action, root, mode)
    for m in ref_meshes:
        bpy.data.objects.remove(m, do_unlink=True)
    bpy.data.objects.remove(ref_arm, do_unlink=True)
    for action in actions.values():                         # the reference's clips must not ride into the export
        bpy.data.actions.remove(action)
    return arm, baked


def ring_points(vertices, head, tail, t=0.5, band=0.012, radius=None):
    """Four extremes (front, back, inner, outer in the segment's own frame) of a mesh's cross-section around a limb
    segment at fraction t from head to tail, or None if the section is empty. Only vertices within `radius` of the
    axis count (so a hanging arm's section ignores the torso beside it)."""
    head, tail = np.asarray(head, float), np.asarray(tail, float)
    axis = tail - head
    length = np.linalg.norm(axis)
    if length < 1e-6:
        return None
    u = axis / length
    c = head + u * length * t
    rel = np.asarray(vertices, float) - c
    along = rel @ u
    perp = rel - np.outer(along, u)
    dist = np.linalg.norm(perp, axis=1)
    keep = (np.abs(along) < band) & (dist < (radius if radius else length * .45))
    if keep.sum() < 6:
        return None
    P, D = perp[keep], np.asarray(vertices, float)[keep]
    side = np.array([1.0, 0, 0]) if abs(u[0]) < .9 else np.array([0, 0, 1.0])
    e1 = side - np.dot(side, u) * u; e1 /= np.linalg.norm(e1)
    e2 = np.cross(u, e1)
    picks = [np.argmax(P @ e1), np.argmin(P @ e1), np.argmax(P @ e2), np.argmin(P @ e2)]
    return [D[i] for i in picks]


def limb_rings(ref_verts, body_verts, ref_joints, body_joints, segments, fractions=(.3, .6)):
    """Extra correspondences that wrap the reference's limbs onto the body's: matched cross-section extremes along
    each (head joint, tail joint) segment. Returns (reference points, body points)."""
    src, dst = [], []
    for a, b in segments:
        for t in fractions:
            r = ring_points(ref_verts, ref_joints[a], ref_joints[b], t)
            q = ring_points(body_verts, body_joints[a], body_joints[b], t)
            if r is None or q is None:
                continue
            src += r; dst += q
    return np.array(src), np.array(dst)


def _subtree(arm, root):
    out, stack = [], [arm.data.bones[root]]
    while stack:
        b = stack.pop(); out.append(b.name); stack.extend(b.children)
    return out


def segment_distance(points, heads, tails):
    """Distance from each point to each segment: (points, segments) array."""
    P = np.asarray(points, float)[:, None, :]
    A, B = np.asarray(heads, float)[None], np.asarray(tails, float)[None]
    AB = B - A
    t = np.clip(((P - A) * AB).sum(-1) / np.maximum((AB * AB).sum(-1), 1e-12), 0, 1)
    return np.linalg.norm(P - (A + AB * t[..., None]), axis=-1)


def surface_labels(vertices, edges, seeds):
    """Multi-source shortest paths over mesh edges: each vertex takes the label of its nearest seed along the
    surface (seeds: vertex index -> label). Vertices no seed reaches keep None."""
    import heapq
    V = np.asarray(vertices, float)
    nb = [[] for _ in range(len(V))]
    for a, b in edges:
        w = float(np.linalg.norm(V[a] - V[b]))
        nb[a].append((b, w)); nb[b].append((a, w))
    dist = np.full(len(V), np.inf)
    label = [None] * len(V)
    heap = []
    for i, lab in seeds.items():
        dist[i] = 0.0; label[i] = lab; heapq.heappush(heap, (0.0, i))
    while heap:
        d, i = heapq.heappop(heap)
        if d > dist[i]:
            continue
        for j, w in nb[i]:
            if d + w < dist[j]:
                dist[j] = d + w; label[j] = label[i]; heapq.heappush(heap, (d + w, j))
    return label


def region_masks(vertices, edges, labels, transition):
    """Soft region support measured along the surface, never across a nearby limb.

    Each region (including None, the trunk) owns its interior. Its weights may cross a
    shared attachment by `transition` metres, fading smoothly to zero beyond it.
    """
    import heapq
    if not math.isfinite(transition) or transition <= 0:
        raise ValueError('Region transition must be positive and finite')
    V = np.asarray(vertices, float)
    neighbors = [[] for _ in V]
    for a, b in edges:
        distance = float(np.linalg.norm(V[a] - V[b]))
        neighbors[a].append((b, distance)); neighbors[b].append((a, distance))
    masks = {}
    for region in dict.fromkeys(labels):
        distances = np.full(len(V), np.inf)
        queue = []
        for i, label in enumerate(labels):
            if label == region:
                distances[i] = 0
                queue.append((0.0, i))
        heapq.heapify(queue)
        while queue:
            distance, i = heapq.heappop(queue)
            if distance > distances[i]:
                continue
            for j, length in neighbors[i]:
                d = distance + length
                if d < transition and d < distances[j]:
                    distances[j] = d
                    heapq.heappush(queue, (d, j))
        t = np.clip(1 - distances / transition, 0, 1)
        masks[region] = t * t * (3 - 2 * t)
    return masks


def exclusive_regions(body, arm, regions, trust=0.8, core_depth=2):
    """Keep each vertex's weights inside one limb: `regions` lists subtree roots (e.g. ['clavicle_l'], ['thigh_r']).

    Transferred weights can cross between body parts that touch at rest (a hand hanging by a thigh). A vertex's
    limb is decided along the surface, not through space: seeds are vertices where the nearest bone and the
    dominant transferred weight agree (at least `trust` of it), and every other vertex takes the label of its
    nearest seed over mesh edges (the hand and thigh are far apart along the skin). Only a limb's core bones (its
    root and `core_depth` - 1 levels below: clavicle, upper arm, forearm; thigh, calf) seed labels: a finger bone
    that a fitted hand rests inside a thigh must not claim the thigh. Each region's weights (including the trunk)
    fade outside its surface region over 4% of body extent, retaining a blend at attachments but excluding remote
    influences. A vertex left without weight rides its own region's nearest bone (the trunk's if unlabeled)."""
    import bpy
    member, core = {}, set()
    for i, roots in enumerate(regions):
        for r in roots:
            for n in _subtree(arm, r):
                member[n] = i
            level = [arm.data.bones[r]]
            for _ in range(core_depth):
                core.update(b.name for b in level)
                level = [c for b in level for c in b.children]
    names = {g.index: g.name for g in body.vertex_groups}
    bones = [b for b in arm.data.bones]
    heads = [tuple(arm.matrix_world @ b.head_local) for b in bones]
    tails = [tuple(arm.matrix_world @ b.tail_local) for b in bones]
    V = np.array([tuple(body.matrix_world @ v.co) for v in body.data.vertices])
    D = segment_distance(V, heads, tails)
    seeders = [k for k, b in enumerate(bones) if b.name not in member or b.name in core]
    nearest = [member.get(bones[seeders[k]].name) for k in np.argmin(D[:, seeders], axis=1)]
    seeds = {}
    for v, geo in zip(body.data.vertices, nearest):
        totals = {}
        for g in v.groups:
            r = member.get(names[g.group]); totals[r] = totals.get(r, 0.0) + g.weight
        total = sum(totals.values())
        if total > 0 and totals.get(geo, 0.0) >= trust * total:
            seeds[v.index] = geo
    edges = [tuple(e.vertices) for e in body.data.edges]
    labels = surface_labels(V, edges, seeds)
    # Trunk weights are just as harmful on the middle of a limb as weights from
    # another limb. Keep blending at attachments, but exclude every remote region.
    transition = float(np.ptp(V, axis=0).max()) * .04
    masks = region_masks(V, edges, labels, max(transition, 1e-6))
    for v, home in zip(body.data.vertices, labels):
        for g in list(v.groups):
            r = member.get(names[g.group])
            factor = masks[r][v.index] if r in masks else 0.0
            if factor <= 0:
                body.vertex_groups[names[g.group]].remove([v.index])
            elif factor < 1:
                body.vertex_groups[names[g.group]].add([v.index], g.weight * factor, 'REPLACE')
        if sum(g.weight for g in v.groups) < 1e-6:
            allowed = [k for k, b in enumerate(bones) if member.get(b.name) == home]
            k = allowed[int(np.argmin(D[v.index, allowed]))] if allowed else int(np.argmin(D[v.index]))
            group = body.vertex_groups.get(bones[k].name) or body.vertex_groups.new(name=bones[k].name)
            group.add([v.index], 1.0, 'REPLACE')
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=.5, repeat=1)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)

def _write_limited_weights(body, vertex, weights, protected):
    """Four exportable influences, preserving the protected/unprotected blend totals."""
    weights = {n: w for n, w in weights.items() if w > 0}
    if len(weights) > 4:
        buckets = [{n: w for n, w in weights.items() if (n in protected) == own} for own in (True, False)]
        rank = lambda n: (-weights[n], n)
        # Reserve one slot per nonempty side so a small anatomical blend is not
        # discarded by the GLB exporter's largest-four truncation.
        selected = {min(bucket, key=rank) for bucket in buckets if bucket}
        selected.update(sorted(weights.keys() - selected, key=rank)[:4 - len(selected)])
        limited = {}
        for bucket in buckets:
            kept = sum(w for n, w in bucket.items() if n in selected)
            if kept:
                scale = sum(bucket.values()) / kept
                limited.update({n: w * scale for n, w in bucket.items() if n in selected})
        weights = limited
    for g in list(vertex.groups):
        group = body.vertex_groups[g.group]
        if group.name not in weights:
            group.remove([vertex.index])
    for name, weight in weights.items():
        body.vertex_groups[name].add([vertex.index], weight, 'REPLACE')


def restrict_weights(body, bones, fallback, point, normal, band=0.02):
    """Past a world-space plane, retain only allowed bones, easing over `band` metres.

    Preserve their relative transferred weights. If none remain, assign `fallback` (one of `bones`). This constrains
    anatomical ownership without making a multi-bone region rigid; e.g. a chin can follow head/neck, never clavicles.
    Vertices behind the plane are unchanged. Apply before rigid overrides and clip grounding.
    """
    from mathutils import Vector
    allowed = set(bones)
    point, normal = Vector(point), Vector(normal)
    if fallback not in allowed or not math.isfinite(band) or band <= 0:
        raise ValueError('Weight limit requires an allowed fallback and a positive finite band')
    if len(point) != 3 or len(normal) != 3 or not all(math.isfinite(x) for x in (*point, *normal)) or normal.length < 1e-8:
        raise ValueError('Weight limit requires a finite point and a nonzero finite normal')
    normal.normalize()
    body.vertex_groups.get(fallback) or body.vertex_groups.new(name=fallback)
    for v in body.data.vertices:
        t = min(max(((body.matrix_world @ v.co) - point).dot(normal) / band, 0.0), 1.0)
        if t <= 0:
            continue
        t = t * t * (3 - 2 * t)
        weights = {body.vertex_groups[g.group].name: g.weight for g in v.groups}
        total = sum(weights.values())
        weights = {n: w / total for n, w in weights.items()} if total > 1e-8 else {fallback: 1.0}
        retained = sum(w for n, w in weights.items() if n in allowed)
        target = {n: w / retained for n, w in weights.items() if n in allowed} if retained > 1e-8 else {fallback: 1.0}
        blended = {n: weights.get(n, 0) * (1 - t) + target.get(n, 0) * t for n in weights.keys() | target.keys()}
        _write_limited_weights(body, v, blended, allowed)


def make_rigid(body, bone, point, normal, band=0.02):
    """Vertices past the plane (point, normal) ride `bone` alone, eased in over `band` metres: a big stylized head
    must not take neck weights across the face."""
    import bpy
    from mathutils import Vector
    point, normal = Vector(point), Vector(normal).normalized()
    group = body.vertex_groups.get(bone) or body.vertex_groups.new(name=bone)
    for v in body.data.vertices:
        t = min(max(((body.matrix_world @ v.co) - point).dot(normal) / band, 0.0), 1.0)
        if t <= 0:
            continue
        weights = {body.vertex_groups[g.group].name: g.weight for g in v.groups}
        own = weights.get(bone, 0)
        weights = {n: w * (1 - t) for n, w in weights.items() if n != bone}
        weights[bone] = own + (1 - own) * t
        _write_limited_weights(body, v, weights, {bone})
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)


def ground_clip(arm, body, action, root='pelvis', mode='always', floor=0.0):
    """Lift or lower the root each frame so the body's lowest point meets the floor.

    mode 'always' grounds every frame (a walk: some foot is always down); 'lowest' applies one offset so the clip's
    lowest frame meets the floor (a jog keeps its flight)."""
    import bpy
    scene = bpy.context.scene
    arm.animation_data.action = action
    start, end = (int(round(v)) for v in action.frame_range)
    deps = bpy.context.evaluated_depsgraph_get
    lows = {}
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        ev = body.evaluated_get(deps())
        mesh = ev.to_mesh()
        lows[frame] = min((body.matrix_world @ v.co).z for v in mesh.vertices)
        ev.to_mesh_clear()
    lowest = min(lows.values())
    pb = arm.pose.bones[root]
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        dz = floor - (lows[frame] if mode == 'always' else lowest)
        world = arm.matrix_world @ pb.matrix
        world.translation.z += dz
        pb.matrix = arm.matrix_world.inverted() @ world
        pb.keyframe_insert('location', frame=frame)
    arm.animation_data.action = None
