"""Fit lids, expressions, gaze and anatomical jaw weights to an existing sculpt.

These helpers do not establish the complete ARKit contract. Dental geometry and
speech authoring remain separate. Blender imports are lazy for pure NumPy checks.
"""
import math
import numpy as np


def trace_quad_loop(faces, start, following):
    """Trace a closed regular quad edge loop from a directed seed edge.

    Return vertex indices, starting with the two supplied indices, without
    repeating the start. No spatial heuristics: poles, boundaries, triangles on
    the route and non-manifold edges fail rather than jumping to another loop.
    Unrelated mesh regions may contain triangles or boundaries.
    """
    from numbers import Integral
    valid = lambda i: isinstance(i, Integral) and not isinstance(i, bool) and i >= 0
    if not valid(start) or not valid(following) or start == following:
        raise ValueError('Quad loop needs two distinct nonnegative integer seed indices')
    polygons = [list(f) for f in faces]
    adjacency, edges = {}, {}
    for fi, face in enumerate(polygons):
        if len(face) < 3 or any(not valid(i) for i in face) or len(set(face)) != len(face):
            raise ValueError('Mesh polygons require distinct nonnegative integer indices')
        for a, b in zip(face, face[1:] + face[:1]):
            adjacency.setdefault(a, set()).add(b); adjacency.setdefault(b, set()).add(a)
            edges.setdefault(tuple(sorted((a, b))), []).append(fi)
    def continuation(a, b):
        adjacent = edges.get(tuple(sorted((a, b))), [])
        if len(adjacent) != 2 or any(len(polygons[i]) != 4 for i in adjacent):
            raise ValueError('Quad loop meets a boundary, non-manifold edge or non-quad face')
        neighbours = adjacency[b]
        if len(neighbours) != 4:
            raise ValueError('Quad loop meets a pole')
        candidates = neighbours - set(polygons[adjacent[0]]) - set(polygons[adjacent[1]])
        if len(candidates) != 1:
            raise ValueError('Quad loop continuation is ambiguous')
        return next(iter(candidates))
    result, seen = [int(start), int(following)], {start, following}
    while True:
        n = continuation(*result[-2:])
        if n == start:
            if continuation(result[-1], start) != following:
                raise ValueError('Quad loop does not close onto its seed edge')
            return result
        if n in seen:
            raise ValueError('Quad loop repeats a vertex before closing')
        result.append(int(n)); seen.add(n)


def faces_inside_loop(faces, loop, seed_face):
    """Select one side of a separating edge loop, e.g. an existing mouth pocket.

    The caller supplies a face on the desired side. Every loop edge must have
    two owners, exactly one in the selected component; a leaky/nonseparating
    boundary fails instead of coloring the rest of the sculpt.
    """
    from numbers import Integral
    valid = lambda i: isinstance(i, Integral) and not isinstance(i, bool) and i >= 0
    faces, loop = [list(f) for f in faces], list(loop)
    if not valid(seed_face) or seed_face >= len(faces):
        raise ValueError('Loop selection needs a valid seed face index')
    if len(loop) < 3 or any(not valid(i) for i in loop) or len(set(loop)) != len(loop):
        raise ValueError('Boundary loop needs at least three distinct vertex indices')
    edges = {}
    for fi, face in enumerate(faces):
        if len(face) < 3 or any(not valid(i) for i in face) or len(set(face)) != len(face):
            raise ValueError('Mesh polygons require distinct nonnegative integer indices')
        for a, b in zip(face, face[1:]+face[:1]):
            edges.setdefault(tuple(sorted((a,b))), []).append(fi)
    barrier = {tuple(sorted(edge)) for edge in zip(loop, loop[1:]+loop[:1])}
    if any(len(edges.get(edge, ())) != 2 for edge in barrier):
        raise ValueError('Boundary loop edges must have exactly two incident faces')
    dual = [set() for _ in faces]
    for edge, owners in edges.items():
        if edge not in barrier:
            for fi in owners: dual[fi].update(set(owners)-{fi})
    selected, pending = {int(seed_face)}, [int(seed_face)]
    while pending:
        for fi in dual[pending.pop()] - selected:
            selected.add(fi); pending.append(fi)
    if any(len(selected.intersection(edges[edge])) != 1 for edge in barrier):
        raise ValueError('Loop does not separate the seeded region from the rest of the mesh')
    return sorted(selected)


def sculpt_jaw_weights(vertices, faces, jaw, face_vertices, *, lower_lip, upper_lip, fixed_vertices=(), reach=.02):
    """Jaw weights for an existing mouth pocket with interlocking lip surfaces.

    Explicit upper/lower lip vertex selections override height classification.
    Weights relax along mesh edges within reach metres, never through
    empty space to the opposite lip. Vertices outside the anatomical face stay
    fixed. Additional fixed_vertices pin authored upper-jaw/cheek regions at zero.
    Coordinates and topology are read-only; pass the weights to jaw.targets.
    """
    from numbers import Integral
    import heapq
    v = np.asarray(vertices, float)
    if v.ndim != 2 or v.shape[1] != 3 or not len(v) or not np.isfinite(v).all():
        raise ValueError('Jaw vertices must be finite Nx3 coordinates')
    if isinstance(reach, bool) or not math.isfinite(reach) or reach <= 0:
        raise ValueError('Jaw correction reach must be positive and finite')
    def indices(values, label):
        ids = list(values)
        if not ids or any(isinstance(i, bool) or not isinstance(i, Integral) or i < 0 or i >= len(v) for i in ids):
            raise ValueError(label + ' must contain valid integer vertex indices')
        return set(ids)
    region = indices(face_vertices, 'Face region')
    lower, upper = indices(lower_lip, 'Lower lip'), indices(upper_lip, 'Upper lip')
    fixed_vertices = list(fixed_vertices)
    if fixed_vertices: upper |= indices(fixed_vertices, 'Fixed jaw region')
    if lower & upper or not (lower | upper) <= region:
        raise ValueError('Lip selections must be disjoint and within the face region')
    adjacency = [dict() for _ in v]
    for face in faces:
        face = list(face)
        if len(face) < 3 or len(indices(face, 'Face polygon')) != len(face):
            raise ValueError('Face polygons need at least three distinct vertices')
        for a, b in zip(face, face[1:] + face[:1]):
            distance = float(np.linalg.norm(v[a] - v[b]))
            if distance <= 0 or not math.isfinite(distance):
                raise ValueError('Jaw mesh edges need positive finite length')
            adjacency[a][b] = distance; adjacency[b][a] = distance
    base = np.zeros(len(v))
    for i in region: base[i] = jaw.weight(v[i])
    weights = base.copy()
    seeds = lower | upper
    for i in lower: weights[i] = jaw.weight(v[i], lower_lip=True)
    for i in upper: weights[i] = 0
    if not np.isfinite(base).all() or not np.isfinite(weights).all() or np.any((base < 0) | (base > 1)) or np.any((weights < 0) | (weights > 1)):
        raise ValueError('Jaw weights must be finite and between zero and one')
    distance = np.full(len(v), np.inf)
    pending = []
    for i in seeds: distance[i] = 0; heapq.heappush(pending, (0., i))
    while pending:
        d, i = heapq.heappop(pending)
        if d != distance[i]: continue
        for j, length in adjacency[i].items():
            candidate = d + length
            if j in region and candidate < reach and candidate < distance[j]:
                distance[j] = candidate; heapq.heappush(pending, (candidate, j))
    free = sorted(i for i in region - seeds if distance[i] < reach and adjacency[i])
    if not free: return weights
    offsets = np.cumsum([0] + [len(adjacency[i]) for i in free])[:-1]
    ids = np.array([j for i in free for j in adjacency[i]], dtype=int)
    conductance = np.array([1 / d for i in free for d in adjacency[i].values()])
    totals = np.add.reduceat(conductance, offsets)
    for _ in range(10000):
        updated = weights.copy()
        updated[free] = np.add.reduceat(weights[ids] * conductance, offsets) / totals
        error = float(np.max(np.abs(updated - weights)))
        weights = updated
        if error < 1e-10: return weights
    raise ValueError('Jaw weight relaxation did not converge; shorten reach or add lip constraints')


def replace_sculpt_mouth_pocket(body, *, upper_arc, lower_arc, cavity_faces,
                                rings, jaw_targets, cavity_color='#35131b'):
    """Replace only a selected interior disk, retaining exterior mesh data.

    Identity-world Z-up/-Y-forward body must have relative zero-weight morphs,
    one armature with a deforming head, and explicit POINT/FLOAT face ownership.
    jaw_targets is a supplied absolute target on the ORIGINAL body topology;
    this operation does not fit another jaw. Existing morphs follow the exact
    curved boundary into the new pocket; original exterior vertices, UV loops,
    deform weights, materials and shape-key animation remain on the same body.
    New pocket vertices bind to head and receive explicit face membership.

    The selected old pocket must be a connected disk whose boundary is exactly
    the two arcs. Native BMesh layers retain shape keys, UVs and weights while
    removing unused pocket vertices. Caller must independently check native
    partial/mixed triangles, collision, containment and changed-rest appearance.
    Dentals are not included; no facial-contract or art acceptance is claimed.
    """
    import bpy, bmesh
    from numbers import Integral
    from agent_meshes_author import material, linear_color
    from agent_meshes_face import curved_mouth_pocket_geometry, folded_faces
    if (getattr(body,'type',None)!='MESH' or body.mode!='OBJECT' or body.data.users!=1
            or body.library or body.data.library or body.override_library):
        raise ValueError('Pocket replacement needs local single-user body in Object mode')
    if not np.allclose(np.array(body.matrix_world),np.eye(4),rtol=0,atol=1e-10):
        raise ValueError('Pocket replacement needs identity world coordinates')
    modifiers=[m for m in body.modifiers if m.type=='ARMATURE']
    if len(modifiers)!=1 or modifiers[0].object is None:
        raise ValueError('Pocket replacement needs one body armature')
    rig=modifiers[0].object
    if rig.type!='ARMATURE' or 'head' not in rig.data.bones or not rig.data.bones['head'].use_deform:
        raise ValueError('Pocket replacement needs a deforming head bone')
    if 'head' not in body.vertex_groups:
        raise ValueError('Pocket replacement needs existing head skin weights')
    keys=body.data.shape_keys
    if not keys:
        raise ValueError('Pocket replacement needs an existing Basis and relative expression keys')
    if keys.key_blocks[0].name!='Basis':
        raise ValueError('Pocket replacement requires the reference shape key named Basis')
    if not keys.use_relative or 'jawOpen' in keys.key_blocks or any(k.value!=0 for k in list(keys.key_blocks)[1:]):
        raise ValueError('Pocket replacement needs relative zero-weight morphs and no jawOpen')
    if keys and any(k.relative_key!=keys.key_blocks[0] for k in list(keys.key_blocks)[1:]):
        raise ValueError('Pocket replacement needs all morphs relative to Basis')
    attribute=body.data.attributes.get('_FACE_REGION')
    if attribute is None or attribute.domain!='POINT' or attribute.data_type!='FLOAT':
        raise ValueError('Pocket replacement needs POINT/FLOAT face ownership')
    linear_color(cavity_color)
    rest=np.array([p.co[:] for p in (keys.key_blocks[0].data if keys else body.data.vertices)])
    target=np.asarray(jaw_targets,float)
    if target.shape!=rest.shape or not np.isfinite(target).all():
        raise ValueError('Supplied jaw target must match finite original mesh topology')
    membership=np.array([p.value for p in attribute.data])
    if np.any((np.linalg.norm(target-rest,axis=1)>1e-12)&(membership<.5)):
        raise ValueError('Supplied jaw must preserve vertices outside the declared face')
    faces=[list(p.vertices) for p in body.data.polygons]; selected=list(cavity_faces)
    if (not selected or len(set(selected))!=len(selected) or any(isinstance(i,bool) or not isinstance(i,Integral)
            or not 0<=i<len(faces) for i in selected)):
        raise ValueError('Pocket selection needs distinct existing polygon indices')
    selected=set(selected); exterior=[f for i,f in enumerate(faces) if i not in selected]
    morphs={k.name:[p.co[:] for p in k.data] for k in list(keys.key_blocks)[1:]} if keys else {}
    morphs['jawOpen']=target.tolist()
    pocket=curved_mouth_pocket_geometry(dict(vertices=rest.tolist(),faces=exterior,morphs=morphs),
                                       upper_arc,lower_arc,rings=rings)
    boundary=pocket['boundary']; count=len(boundary); rim=set(boundary)
    old_vertices={v for i in selected for v in faces[i]}
    if any(membership[v]<.5 for v in old_vertices):
        raise ValueError('Selected pocket must belong to the declared face')
    owners={}
    for i in selected:
        for a,b in zip(faces[i],faces[i][1:]+faces[i][:1]):
            owners.setdefault(tuple(sorted((a,b))),[]).append(i)
    rim_edges={tuple(sorted((a,b))) for a,b in zip(boundary,boundary[1:]+boundary[:1])}
    if ({e for e,ids in owners.items() if len(ids)==1}!=rim_edges or any(len(ids)>2 for ids in owners.values())
            or len(old_vertices)-len(owners)+len(selected)!=1):
        raise ValueError('Selected pocket must be a disk bounded by exactly the lip arcs')
    neighbours={i:set() for i in selected}
    for ids in owners.values():
        if len(ids)==2:
            a,b=ids;neighbours[a].add(b);neighbours[b].add(a)
    seen=set();pending=[next(iter(selected))]
    while pending:
        i=pending.pop()
        if i not in seen:seen.add(i);pending.extend(neighbours[i]-seen)
    if seen!=selected:
        raise ValueError('Selected pocket faces must be connected')
    interior=old_vertices-rim
    if any(interior.intersection(f) for f in exterior):
        raise ValueError('Old pocket interior must not own exterior vertices')
    if any(e.is_loose and interior.intersection(e.vertices) for e in body.data.edges):
        raise ValueError('Old pocket interior must not own unrelated loose edges')
    pv=np.array(pocket['vertices'])
    for name,points in pocket['morphs'].items():
        points=np.array(points)
        if any(folded_faces(pv,pv+(points-pv)*phase,pocket['faces']) for phase in [.25,.5,.75,1.]):
            raise ValueError('New pocket reverses triangles for '+name)
    bm=bmesh.new()
    try:
        bm.from_mesh(body.data);bm.verts.ensure_lookup_table();bm.faces.ensure_lookup_table()
        # Prepare all custom layers and geometry before committing the mesh.
        layers={name:bm.verts.layers.shape.get(name) for name in (['Basis']+list(morphs))}
        if keys and any(layers[k.name] is None for k in keys.key_blocks):
            raise ValueError('Native BMesh did not retain the original shape layers')
        for name in layers:
            if layers[name] is None:layers[name]=bm.verts.layers.shape.new(name)
        # Adding a custom-data layer can invalidate previously held BMVert refs.
        layers={name:bm.verts.layers.shape[name] for name in layers}
        deform=bm.verts.layers.deform.active
        if deform is None:raise ValueError('Native BMesh did not retain body skin weights')
        original=list(bm.verts)
        original_faces=list(bm.faces)
        for i,v in enumerate(original):
            v[layers['Basis']]=rest[i];v[layers['jawOpen']]=target[i]
        ownership=bm.verts.layers.float.get('_FACE_REGION')
        if ownership is None:raise ValueError('Native BMesh did not retain face ownership')
        head=body.vertex_groups['head'].index
        original_index={v:i for i,v in enumerate(original)}
        owned_edges={e for e in bm.edges if tuple(sorted(original_index[v] for v in e.verts)) in owners}
        bmesh.ops.delete(bm,geom=[bm.faces[i] for i in selected],context='FACES_ONLY')
        if interior:bmesh.ops.delete(bm,geom=[original[i] for i in interior],context='VERTS')
        # Remove only orphan edges from the selected patch, preserving other data.
        orphan=[e for e in bm.edges if not e.link_faces and e in owned_edges]
        if orphan:bmesh.ops.delete(bm,geom=orphan,context='EDGES')
        vertices=[original[i] for i in boundary]
        for i,point in enumerate(pocket['vertices'][count:],count):
            v=bm.verts.new(point);v[layers['Basis']]=point
            for name,points in pocket['morphs'].items():v[layers[name]]=points[i]
            v[deform][head]=1.;v[ownership]=1.;vertices.append(v)
        slot=len(body.data.materials)
        for f in pocket['faces']:
            p=bm.faces.new([vertices[i] for i in f]);p.material_index=slot;p.smooth=True
        # BMesh can reuse storage holes for new vertices/faces. Return explicit
        # correspondence instead of assuming old survivors form a sorted prefix.
        bm.verts.index_update();bm.faces.index_update()
        vertex_map=[-1 if i in interior else v.index for i,v in enumerate(original)]
        face_map=[-1 if i in selected else f.index for i,f in enumerate(original_faces)]
        # Native conversion creates the new key from its shape layer. Adding an
        # object key first would create a second key with a different layer UID.
        body.data.materials.append(material('mouth_cavity',cavity_color,roughness=.85,double_sided=True))
        bm.to_mesh(body.data);body.data.update()
    finally:bm.free()
    return {'removedPocketFaces':len(selected),'removedInteriorVertices':len(interior),
            'addedPocketFaces':len(pocket['faces']),'newInteriorVertices':len(pocket['vertices'])-count,
            'originalVertexMap':vertex_map,'originalPolygonMap':face_map,
            'fullFaceContractClaim':False}


def add_sculpt_mouth(body, rig, jaw, *, face_vertices, lower_lip, upper_lip,
                     cavity_faces, parts, fixed_vertices=(), reach=.035,
                     min_chin_drop=.1, cavity_color='#35131b'):
    """Open an authored sculpt pocket and join dental parts into its body skin.

    Geometry and hinge coordinates are world-space metres on an identity-world
    body, already bound to rig. Caller-owned cavity_faces select the existing
    pocket; anatomical upper/lower arcs belong to face_vertices. Each dental
    tuple is (semantic name, geometry dict, color, jaw_carried), using names
    teeth_upper, teeth_lower, tongue and optional gums_upper/gums_lower.
    Existing rest geometry, weights, UVs, morphs and NLA are retained by native
    join; dental vertices receive head binding and explicit face membership.
    Body must be visible/selectable in the active layer and already have a
    POINT/FLOAT _FACE_REGION attribute; its original membership is preserved.

    Preflights selections, targets and quarter/half/three-quarter/full jaw
    orientation before body mutation. This does not certify cavity collision,
    containment, expression combinations or the complete facial contract.
    """
    import bpy
    from numbers import Integral, Real
    from agent_meshes_author import make_mesh, material, shape_key, bind_skin, linear_color
    from agent_meshes_face import folded_faces, chin_drop, mark_face_region
    if getattr(body,'type',None)!='MESH' or getattr(rig,'type',None)!='ARMATURE' or body.mode!='OBJECT' or rig.mode!='OBJECT':
        raise ValueError('Sculpt mouth needs body and rig in Object mode')
    if body.data.users!=1 or body.library or body.data.library or body.override_library:
        raise ValueError('Sculpt mouth needs local single-user body data')
    if rig.library or rig.data.library or rig.override_library or bpy.context.view_layer.objects.get(rig.name)!=rig or bpy.context.view_layer.objects.get(body.name)!=body:
        raise ValueError('Sculpt mouth needs local editable body and rig in the active view layer')
    if not body.visible_get() or body.hide_select or body not in bpy.context.selectable_objects:
        raise ValueError('Sculpt mouth needs a visible selectable body for native join')
    membership=body.data.attributes.get('_FACE_REGION')
    if membership is None or membership.domain!='POINT' or membership.data_type!='FLOAT':
        raise ValueError('Sculpt mouth needs existing POINT/FLOAT body face membership')
    if not np.allclose(np.array(body.matrix_world),np.eye(4),rtol=0,atol=1e-10):
        raise ValueError('Sculpt mouth needs identity world body coordinates')
    armatures=[m for m in body.modifiers if m.type=='ARMATURE']
    if len(armatures)!=1 or armatures[0].object!=rig or 'head' not in rig.data.bones:
        raise ValueError('Sculpt mouth needs one body skin modifier for the rig and a head bone')
    if not rig.data.bones['head'].use_deform:
        raise ValueError('Sculpt mouth needs a deforming head bone')
    keys=body.data.shape_keys
    if keys and not keys.use_relative:
        raise ValueError('Sculpt mouth needs relative shape keys')
    if keys and ('jawOpen' in keys.key_blocks or any(k.value!=0 for k in list(keys.key_blocks)[1:])):
        raise ValueError('Sculpt mouth needs zero existing morph weights and no jawOpen: '+str([(k.name,k.value) for k in keys.key_blocks]))
    if isinstance(min_chin_drop,bool) or not isinstance(min_chin_drop,Real) or not math.isfinite(min_chin_drop) or not 0<min_chin_drop<=1:
        raise ValueError('Minimum chin drop must be a fraction in (0,1]')
    linear_color(cavity_color)
    vertices=np.array([p.co[:] for p in (keys.key_blocks[0].data if keys else body.data.vertices)])
    faces=[list(p.vertices) for p in body.data.polygons]
    region=list(face_vertices);cavity=list(cavity_faces)
    if not cavity or len(set(cavity))!=len(cavity) or any(isinstance(i,bool) or not isinstance(i,Integral) or not 0<=i<len(faces) for i in cavity):
        raise ValueError('Cavity faces need distinct existing polygon indices')
    if any(not set(faces[i])<=set(region) for i in cavity):
        raise ValueError('Cavity faces must belong to the authored face region')
    prepared=[];names=set();allowed={'teeth_upper','teeth_lower','tongue','gums_upper','gums_lower'}
    for part in parts:
        if len(part)!=4:raise ValueError('Dental parts need name, geometry, color and jaw ownership')
        name,geometry,color,moving=part
        if name not in allowed or name in names or type(moving)!=bool or moving!=(name in {'teeth_lower','tongue','gums_lower'}):
            raise ValueError('Dental semantic names and jaw ownership must be unique and consistent')
        names.add(name);linear_color(color)
        points=np.asarray(geometry['vertices'],float);polygons=[list(f) for f in geometry['faces']]
        if points.ndim!=2 or points.shape[1]!=3 or not len(points) or not np.isfinite(points).all() or not polygons:
            raise ValueError('Dental geometry needs finite vertices and polygons')
        if any(len(f)<3 or len(set(f))!=len(f) or any(isinstance(i,bool) or not isinstance(i,Integral) or not 0<=i<len(points) for i in f) for f in polygons):
            raise ValueError('Dental geometry needs distinct valid polygon indices')
        target=np.asarray(jaw.targets(points,1.),float) if moving else points.copy()
        if target.shape!=points.shape or not np.isfinite(target).all():raise ValueError('Dental jaw target must match finite rest geometry')
        if any(folded_faces(points,points+(target-points)*phase,polygons) for phase in [.25,.5,.75,1.]):
            raise ValueError('Dental jaw target reverses triangles')
        prepared.append((name,points,polygons,color,moving,target))
    if not {'teeth_upper','teeth_lower','tongue'}<=names:
        raise ValueError('Sculpt mouth requires upper teeth, lower teeth and tongue')
    weights=sculpt_jaw_weights(vertices,faces,jaw,region,lower_lip=lower_lip,
                              upper_lip=upper_lip,fixed_vertices=fixed_vertices,reach=reach)
    targets=np.asarray(jaw.targets(vertices,weights),float)
    if targets.shape!=vertices.shape or not np.isfinite(targets).all():raise ValueError('Sculpt jaw target must match finite rest geometry')
    phases=[.25,.5,.75,1.]
    for phase in phases:
        if folded_faces(vertices,vertices+(targets-vertices)*phase,faces):
            raise ValueError(f'Sculpt jaw reverses triangles at weight {phase}')
    drop=chin_drop(vertices[region],targets[region])
    if drop['ratio']<min_chin_drop:raise ValueError('Sculpt jaw does not lower the chin sufficiently')
    cavity_slot=len(body.data.materials)
    body.data.materials.append(material('mouth_cavity',cavity_color,roughness=.85,double_sided=True))
    for i in cavity:body.data.polygons[i].material_index=cavity_slot
    shape_key(body,'jawOpen',targets)
    dental=[]
    for name,points,polygons,color,moving,target in prepared:
        part=make_mesh(name,points,polygons,material(name,color,roughness=.4))
        for polygon in part.data.polygons:polygon.use_smooth=True
        bind_skin(part,rig,[{'head':1.} for _ in points]);mark_face_region(part,range(len(points)))
        if moving:shape_key(part,'jawOpen',target)
        world=part.matrix_world.copy();part.parent=None;part.matrix_world=world;dental.append(part)
    bpy.ops.object.select_all(action='DESELECT');body.select_set(True)
    for part in dental:part.select_set(True)
    bpy.context.view_layer.objects.active=body
    expected_vertices=len(vertices)+sum(len(p[1]) for p in prepared)
    expected_faces=len(faces)+sum(len(p[2]) for p in prepared)
    dental_names=[p.name for p in dental]
    if bpy.ops.object.join()!={'FINISHED'}:
        raise RuntimeError('Sculpt mouth native join did not finish')
    if len(body.data.vertices)!=expected_vertices or len(body.data.polygons)!=expected_faces or any(name in bpy.data.objects for name in dental_names):
        raise RuntimeError('Sculpt mouth native join did not transfer all dental geometry')
    return {'chin':drop,'mouthPocketFaces':len(cavity),'jawWeights':{'moving':int(np.count_nonzero(weights))},
            'checkedJawWeights':phases,'dentalParts':sorted(names),'foldedFaces':0,'fullFaceContractClaim':False}


def attach_sculpt_dentals(body, rig, *, parts):
    """Join explicit dental targets to a body with an already authored jawOpen.

    Each part is (semantic name, geometry dict, color). Required names are
    teeth_upper, teeth_lower and tongue; gums_upper/gums_lower are optional.
    Lower teeth, tongue and lower gums require absolute morphs['jawOpen']
    coordinates. Upper parts stay fixed. No body jaw fitting is performed.

    Uses identity-world coordinates on a local, selectable, single-user body
    bound to rig's deforming head. Existing Basis-relative keys must be at zero
    with an authored jawOpen and POINT/FLOAT _FACE_REGION. Native join retains
    the original body vertices, polygons, materials, UVs, skin, keys and NLA.
    Dental vertices get head binding, face membership and zero deltas for other
    body expressions. Selection changes to the joined body.

    Preflights inputs and sampled dental orientation before creating objects.
    This does not certify fit, collision, containment, combined expressions,
    parent-transform animation or the complete facial contract.
    """
    import bpy
    from numbers import Integral
    from collections.abc import Mapping
    from agent_meshes_author import make_mesh, material, shape_key, bind_skin, linear_color
    from agent_meshes_face import folded_faces, mark_face_region
    if getattr(body,'type',None)!='MESH' or getattr(rig,'type',None)!='ARMATURE' or body.mode!='OBJECT' or rig.mode!='OBJECT':
        raise ValueError('Dental attachment needs body and rig in Object mode')
    if body.data.users!=1 or body.library or body.data.library or body.override_library:
        raise ValueError('Dental attachment needs local single-user body data')
    if rig.library or rig.data.library or rig.override_library or bpy.context.view_layer.objects.get(rig.name)!=rig or bpy.context.view_layer.objects.get(body.name)!=body:
        raise ValueError('Dental attachment needs local editable body and rig in the active view layer')
    if not body.visible_get() or body.hide_select or body not in bpy.context.selectable_objects:
        raise ValueError('Dental attachment needs a visible selectable body')
    if not np.allclose(np.array(body.matrix_world),np.eye(4),rtol=0,atol=1e-10):
        raise ValueError('Dental attachment needs identity world body coordinates')
    membership=body.data.attributes.get('_FACE_REGION')
    if membership is None or membership.domain!='POINT' or membership.data_type!='FLOAT':
        raise ValueError('Dental attachment needs existing POINT/FLOAT body face membership')
    armatures=[m for m in body.modifiers if m.type=='ARMATURE']
    if len(armatures)!=1 or armatures[0].object!=rig or 'head' not in rig.data.bones or not rig.data.bones['head'].use_deform:
        raise ValueError('Dental attachment needs one body skin modifier for the rig and a deforming head bone')
    keys=body.data.shape_keys
    if not keys or not keys.use_relative or keys.reference_key.name!='Basis' or 'jawOpen' not in keys.key_blocks:
        raise ValueError('Dental attachment needs an existing relative Basis and jawOpen')
    if any(k.value!=0 or k.relative_key!=keys.reference_key for k in list(keys.key_blocks)[1:]):
        raise ValueError('Dental attachment needs zero Basis-relative morph weights')
    rest=np.array([p.co[:] for p in keys.reference_key.data])
    jaw=np.array([p.co[:] for p in keys.key_blocks['jawOpen'].data])
    if not np.isfinite(rest).all() or not np.isfinite(jaw).all() or not np.any(jaw!=rest):
        raise ValueError('Dental attachment needs finite body rest and nonzero jaw motion')
    prepared=[];names=set();allowed={'teeth_upper','teeth_lower','tongue','gums_upper','gums_lower'}
    phases=[.25,.5,.75,1.]
    for part in parts:
        if not isinstance(part,(tuple,list)) or len(part)!=3:
            raise ValueError('Dental parts need name, geometry and color')
        name,geometry,color=part
        if not isinstance(name,str) or name not in allowed or name in names:
            raise ValueError('Dental semantic names must be supported and unique')
        names.add(name);linear_color(color)
        if not isinstance(geometry,Mapping) or 'vertices' not in geometry or 'faces' not in geometry:
            raise ValueError('Dental geometry needs vertices and faces')
        try:
            points=np.asarray(geometry['vertices'],float)
            polygons=[list(f) for f in geometry['faces']]
        except (TypeError,ValueError) as exc:
            raise ValueError('Dental geometry needs finite vertices and polygons') from exc
        if points.ndim!=2 or points.shape[1]!=3 or not len(points) or not np.isfinite(points).all() or not polygons:
            raise ValueError('Dental geometry needs finite vertices and polygons')
        if any(len(f)<3 or any(isinstance(i,bool) or not isinstance(i,Integral) or not 0<=i<len(points) for i in f) or len(set(f))!=len(f) for f in polygons):
            raise ValueError('Dental geometry needs distinct valid polygon indices')
        morphs=geometry.get('morphs',{})
        if not isinstance(morphs,Mapping) or set(morphs)-{'jawOpen'}:
            raise ValueError('Dental attachment supports only explicit jawOpen targets')
        moving=name in {'teeth_lower','tongue','gums_lower'}
        if moving and 'jawOpen' not in morphs:
            raise ValueError('Moving dental parts require explicit jawOpen targets')
        try:target=np.asarray(morphs.get('jawOpen',points),float)
        except (TypeError,ValueError) as exc:
            raise ValueError('Dental jaw target must match finite rest geometry') from exc
        if target.shape!=points.shape or not np.isfinite(target).all():
            raise ValueError('Dental jaw target must match finite rest geometry')
        if bool(np.any(target!=points))!=moving:
            raise ValueError('Dental jaw motion must agree with upper/lower ownership')
        if any(folded_faces(points,points+(target-points)*phase,polygons) for phase in phases):
            raise ValueError('Dental jaw target reverses triangles')
        prepared.append((name,points,polygons,color,moving,target))
    if not {'teeth_upper','teeth_lower','tongue'}<=names:
        raise ValueError('Dental attachment requires upper teeth, lower teeth and tongue')
    dental=[]
    for name,points,polygons,color,moving,target in prepared:
        part=make_mesh(name,points,polygons,material(name,color,roughness=.4))
        for polygon in part.data.polygons:polygon.use_smooth=True
        bind_skin(part,rig,[{'head':1.} for _ in points]);mark_face_region(part,range(len(points)))
        if moving:shape_key(part,'jawOpen',target)
        world=part.matrix_world.copy();part.parent=None;part.matrix_world=world;dental.append(part)
    old_vertices=len(body.data.vertices);old_faces=len(body.data.polygons)
    added_vertices=sum(len(p[1]) for p in prepared);added_faces=sum(len(p[2]) for p in prepared)
    dental_names=[p.name for p in dental]
    bpy.ops.object.select_all(action='DESELECT');body.select_set(True)
    for part in dental:part.select_set(True)
    bpy.context.view_layer.objects.active=body
    if bpy.ops.object.join()!={'FINISHED'}:
        raise RuntimeError('Dental attachment native join did not finish')
    if len(body.data.vertices)!=old_vertices+added_vertices or len(body.data.polygons)!=old_faces+added_faces or any(name in bpy.data.objects for name in dental_names):
        raise RuntimeError('Dental attachment native join did not transfer all geometry')
    return {'existingJawReused':True,'newBodyJawFits':0,'addedDentalVertices':added_vertices,
            'addedDentalFaces':added_faces,'dentalParts':sorted(names),
            'checkedJawWeights':phases,'fullFaceContractClaim':False}


def rig_sculpt_eyes(body, rig, eye_vertices, centers, *, parts=None, head='head', gaze=None):
    """Give embedded, disconnected eye surfaces independent gaze without replacing their geometry.

    eye_vertices maps L/R to body vertex indices; centers maps L/R to authored world-space pivots.
    Optional parts maps L/R to already skinned iris/pupil/highlight objects. All meshes must use this
    armature in Object mode. Selected eye polygons get equivalent, side-specific materials so GLB
    keeps each eye in a distinct primitive. No coordinates, shape keys or animation curves change.
    Optional gaze={'yawMax': degrees, 'pitchMax': degrees} declares eye-gaze/1 preview controls,
    with exported eye-local +Z forward. Both limits must be in (0, 90]. This declares eye control
    only, with no automatic lid following or claim of complete facial-contract support.
    """
    import bpy
    import json
    from numbers import Integral, Real
    from mathutils import Vector
    from agent_meshes_face import add_eye_bones, EXTRAS_PROPERTY
    if getattr(rig, 'type', None) != 'ARMATURE' or rig.mode != 'OBJECT':
        raise ValueError('Eye rig requires an armature in Object mode')
    if rig.data.users != 1 or rig.library or rig.data.library or rig.override_library:
        raise ValueError('Eye rig requires local single-user armature data')
    if head not in rig.data.bones or any(n in rig.data.bones for n in ('eye_L', 'eye_R')):
        raise ValueError('Eye rig requires the head bone and no existing eye_L/eye_R bones')
    extras = None
    if gaze is not None:
        if not isinstance(gaze, dict) or set(gaze) != {'yawMax', 'pitchMax'}:
            raise ValueError('Gaze needs yawMax and pitchMax in degrees')
        if any(isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(v) or not 0 < v <= 90 for v in gaze.values()):
            raise ValueError('Gaze limits must be finite numbers in (0, 90] degrees')
        try: extras = json.loads(rig.get(EXTRAS_PROPERTY, '{}'))
        except (TypeError, ValueError) as exc: raise ValueError('Rig extras must be a JSON object') from exc
        if not isinstance(extras, dict) or 'arkitFace' in extras or 'eyeGaze' in extras:
            raise ValueError('Gaze declaration requires object extras without an existing face/gaze declaration')
        extras['eyeGaze'] = {'contract': 'eye-gaze/1', 'forward': '+Z',
                            'gaze': {k: float(v) for k, v in gaze.items()}}
    if set(eye_vertices) != {'L', 'R'} or set(centers) != {'L', 'R'}:
        raise ValueError('Eye vertices and centers must each declare L and R')
    centers = {s: np.asarray(centers[s], float) for s in ('L', 'R')}
    if any(c.shape != (3,) or not np.isfinite(c).all() for c in centers.values()) or centers['L'][0] <= centers['R'][0]:
        raise ValueError('Finite eye pivots must be ordered left (+X), right (-X)')
    parts = {} if parts is None else parts
    if set(parts) - {'L', 'R'}: raise ValueError('Eye parts must be keyed by L/R')
    parts = {s: list(parts.get(s, ())) for s in ('L', 'R')}
    objects = [body] + parts['L'] + parts['R']
    if len(set(objects)) != len(objects): raise ValueError('An eye part cannot belong to both eyes or be the body')
    for obj in objects:
        if getattr(obj, 'type', None) != 'MESH' or obj.mode != 'OBJECT' or obj.data.users != 1:
            raise ValueError('Eye surfaces must be single-user meshes in Object mode')
        if obj.library or obj.data.library or obj.override_library or obj.constraints:
            raise ValueError('Eye surfaces must be local and unconstrained')
        modifiers = [m for m in obj.modifiers if m.type == 'ARMATURE']
        if len(modifiers) != 1 or modifiers[0].object != rig or not modifiers[0].use_vertex_groups:
            raise ValueError('Eye surfaces must already be skinned to this armature')
        if any(name in obj.vertex_groups for name in ('eye_L', 'eye_R')):
            raise ValueError('Existing eye vertex groups would be overwritten')
        if not len(obj.data.vertices): raise ValueError('Eye surfaces cannot be empty')
        if not all(math.isfinite(v) for row in obj.matrix_world for v in row):
            raise ValueError('Eye surface transforms must be finite')
    count = len(body.data.vertices); selected = {}
    for side in ('L', 'R'):
        ids = list(eye_vertices[side])
        if not ids or any(isinstance(v, bool) or not isinstance(v, Integral) or v < 0 or v >= count for v in ids):
            raise ValueError('Eye vertices must be nonempty integer indices within the body')
        selected[side] = set(ids)
    if selected['L'] & selected['R']: raise ValueError('Eye vertex selections overlap')
    polygons = {s: [] for s in selected}
    for side, ids in selected.items():
        for polygon in body.data.polygons:
            overlap = ids.intersection(polygon.vertices)
            if overlap and len(overlap) != len(polygon.vertices):
                raise ValueError('Select complete disconnected eye surfaces, not part of a skin polygon')
            if overlap:
                if polygon.material_index >= len(body.material_slots) or body.material_slots[polygon.material_index].material is None:
                    raise ValueError('Embedded eye surfaces require an existing material')
                polygons[side].append(polygon)
        if not polygons[side]: raise ValueError('Eye selection contains no polygons')
        for obj, vertices in [(body, ids)] + [(p, range(len(p.data.vertices))) for p in parts[side]]:
            points = [obj.matrix_world @ obj.data.vertices[v].co for v in vertices]
            if any((p - Vector(centers[side])).length > (centers['L'][0] - centers['R'][0]) / 2 for p in points):
                raise ValueError('Eye selection reaches beyond its own eye; check ownership and pivot')
    # Validate the inverse before any material/group mutation or entering Edit mode.
    try: rig.matrix_world.inverted()
    except ValueError as exc: raise ValueError('Eye armature transform must be invertible') from exc
    deform = {bone.name for bone in rig.data.bones if bone.use_deform}
    add_eye_bones(rig, centers['L'], centers['R'], head=head)
    for side, ids in selected.items():
        material_slots = {}
        for polygon in polygons[side]:
            old = polygon.material_index
            if old not in material_slots:
                original = body.material_slots[old].material
                mat = original.copy(); mat.name = original.name + '-eye-' + side
                material_slots[old] = len(body.data.materials); body.data.materials.append(mat)
            polygon.material_index = material_slots[old]
        for obj, vertices in [(body, sorted(ids))] + [(p, list(range(len(p.data.vertices)))) for p in parts[side]]:
            for group in obj.vertex_groups:
                if group.name in deform: group.remove(vertices)
            obj.vertex_groups.new(name='eye_' + side).add(vertices, 1., 'REPLACE')
    bpy.context.view_layer.update()
    if extras is not None: rig[EXTRAS_PROPERTY] = json.dumps(extras)
    return {'centers': {s: centers[s].tolist() for s in centers},
            'vertices': {s: len(v) for s, v in selected.items()}, 'parts': {s: [p.name for p in parts[s]] for s in parts}}


def transfer_sculpt_morphs(vertices, source_vertices, source_faces, source_morphs,
                          source_landmarks, target_landmarks, *, face_vertices,
                          fixed_vertices=(), reach=.02):
    """Transfer donor expressions without replacing a sculpt's rest geometry.

    Both meshes and paired landmarks use the same coordinate frame. At least
    four noncoplanar, unique landmark pairs register the donor by a thin-plate
    spline. Absolute donor targets are warped along with rest positions, so
    rotation, scale and local registration transport their displacement too.
    Barycentric nearest-surface interpolation follows the registered donor
    within reach metres, fading beyond reach/4. Only explicit face_vertices
    receive motion; fixed_vertices remain exact. Inputs are read-only.

    Returns name -> absolute Nx3 targets. Missing motion in the selected region
    fails instead of producing placeholder shapes. This does not prove facial
    anatomy, lid clearance, mouth containment or safety of combined expressions;
    inspect and verify the resulting sculpt through those states separately.
    """
    from numbers import Integral, Real
    from agent_meshes_reproportion import tps_fit, tps_apply
    from agent_meshes_face import follow_skin
    def points(values, label):
        try: out = np.asarray(values, dtype=float)
        except (TypeError, ValueError) as exc: raise ValueError(label + ' must be finite Nx3 points') from exc
        if out.ndim != 2 or out.shape[1] != 3 or not len(out) or not np.isfinite(out).all():
            raise ValueError(label + ' must be finite Nx3 points')
        return out
    v, donor = points(vertices, 'Sculpt'), points(source_vertices, 'Donor')
    a, b = points(source_landmarks, 'Source landmarks'), points(target_landmarks, 'Target landmarks')
    if a.shape != b.shape or len(a) < 4 or any(
            len(np.unique(p, axis=0)) != len(p) or np.linalg.matrix_rank(p - p.mean(0)) != 3 for p in (a, b)):
        raise ValueError('Transfer needs matching unique noncoplanar landmark pairs')
    if isinstance(reach, bool) or not isinstance(reach, Real) or not math.isfinite(reach) or reach <= 0:
        raise ValueError('Transfer reach must be finite and positive')
    def indices(values, count, label):
        ids = list(values)
        if any(isinstance(i, bool) or not isinstance(i, Integral) or i < 0 or i >= count for i in ids):
            raise ValueError(label + ' must contain valid integer vertex indices')
        if len(set(ids)) != len(ids): raise ValueError(label + ' must not repeat vertex indices')
        return ids
    region = indices(face_vertices, len(v), 'Face region')
    fixed = set(indices(fixed_vertices, len(v), 'Fixed region'))
    selected = [i for i in region if i not in fixed]
    if not selected: raise ValueError('Transfer needs an unfixed face region')
    polygons = []
    for face in source_faces:
        ids = indices(face, len(donor), 'Donor polygon')
        if len(ids) < 3: raise ValueError('Donor polygons need at least three vertices')
        polygons.append(ids)
    if not polygons: raise ValueError('Transfer needs a donor surface')
    if not isinstance(source_morphs, dict) or not source_morphs:
        raise ValueError('Transfer needs named donor morphs')
    morphs = {}
    for name, target in source_morphs.items():
        if not isinstance(name, str) or not name or name.strip() != name:
            raise ValueError('Donor morph names must be nonempty strings')
        target = points(target, 'Donor morph ' + name)
        if target.shape != donor.shape or not np.any(target != donor):
            raise ValueError('Donor morph ' + name + ' needs motion with matching topology')
        morphs[name] = target
    registration = tps_fit(a, b)
    registered = tps_apply(registration, donor)
    skin = {'vertices': registered.tolist(), 'faces': polygons,
            'morphs': {name: tps_apply(registration, target).tolist() for name, target in morphs.items()}}
    followed = follow_skin({'vertices': v[selected].tolist()}, skin, reach)
    result = {}
    for name in morphs:
        if name not in followed['morphs']:
            raise ValueError('No transferred motion for ' + name + ' within the selected face/reach')
        target = v.copy()
        target[selected] = followed['morphs'][name]
        if not np.isfinite(target).all(): raise ValueError('Registered motion must remain finite')
        result[name] = target
    return result


def expression_fields(vertices, eye_centers, eye_radii, mouth_center):
    """Return brow/smile deltas scaled by the sculpt's interocular distance.

    Coordinates are Z-up, -Y forward; eyes are left (+X) then right. Translation
    and uniform scale of both geometry and landmarks preserve the expression.
    """
    v=np.asarray(vertices,float);eyes=np.asarray(eye_centers,float)
    radii=np.asarray(eye_radii,float);mouth=np.asarray(mouth_center,float)
    if v.ndim!=2 or v.shape[1]!=3 or eyes.shape!=(2,3) or radii.shape!=(2,) or mouth.shape!=(3,):
        raise ValueError('Expected Nx3 vertices, two XYZ eye centers/radii and an XYZ mouth center')
    if any(not np.isfinite(a).all() for a in (v,eyes,radii,mouth)) or (radii<=0).any():
        raise ValueError('Face landmarks and radii must be finite, with positive radii')
    iod=eyes[0,0]-eyes[1,0]
    if iod<=1e-8:raise ValueError('Left and right eyes must be distinct and ordered along X')
    def field(center,extent):
        t=np.clip(1-np.linalg.norm((v-center)/(iod*np.asarray(extent)),axis=1),0,1)
        return t*t*(3-2*t)
    deltas={};brow=np.zeros_like(v)
    for side,sign,center,radius in zip(('Left','Right'),(1,-1),eyes,radii):
        bcenter=center+np.array([-sign*.115*iod,-radius*.9,.48*iod])
        w=field(bcenter,(.56,.67,.43));brow[:,2]+=w*.115*iod
        down=np.zeros_like(v);down[:,2]=-w*.087*iod;down[:,0]=-sign*w*.029*iod
        deltas['browDown'+side]=down
        w=field(mouth+np.array([sign*.415*iod,0,0]),(.45,.53,.395))
        smile=np.zeros_like(v);smile[:,0]=sign*w*.077*iod;smile[:,2]=w*.087*iod
        deltas['mouthSmile'+side]=smile
    deltas['browInnerUp']=brow
    return deltas


def performance_samples(start,end,fps,phase=.63):
    """Loop-neutral frame/blink/expression samples, including exact blink peaks."""
    if not all(math.isfinite(x) for x in (start,end,fps,phase)) or end<=start or fps<=0 or not 0<phase<1:
        raise ValueError('Performance needs a positive frame range/FPS and phase strictly between zero and one')
    length=end-start;close=start+length*phase
    width=min(.12*fps,length*.1,(close-start)*.8,(end-close)*.5)
    hold=min(1,(end-close)*.05)
    times=sorted(set([float(start),float(end),close-width,close,close+hold,close+hold+width*1.4]
                     +[start+length*i/16 for i in range(17)]))
    samples=[]
    for frame in times:
        blink=max(0,1-(close-frame)/width) if frame<=close else max(0,1-max(0,frame-close-hold)/(width*1.4))
        expression=.5-.5*math.cos(math.tau*(frame-start)/length)
        samples.append((float(frame),float(blink),float(expression)))
    samples[0]=(float(start),0.,0.);samples[-1]=(float(end),0.,0.)
    return samples


def add_sculpt_face(body,arm,objects,eyes,*,head_min_z,mouth_center,attachments=(),
                    skin_material=0,eye_material=1,blink_phases=None):
    """Add sculpt-preserving lids/brows/smile and matching NLA performances.

    The face is centered on X=0. `eyes` contains two measured dictionaries with
    center/min/max. Accessories
    in `attachments` (brows, short beard) join the skin and its expression fields.
    All objects must already carry the character's skinning. The existing body
    must have no morphs. Head skin and eye material indices identify anatomy;
    garment/eyeball geometry must never drive the exterior lid solve.
    Returns a JSON-serializable report. Export with NLA_TRACKS.
    """
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    import agent_meshes_hm08 as hm
    from agent_meshes_author import shape_key
    if len(eyes)!=2 or not np.isfinite(head_min_z):raise ValueError('Bilateral face needs two eyes and a finite head boundary')
    if not min(e['center'][0] for e in eyes)<0<max(e['center'][0] for e in eyes):
        raise ValueError('Bilateral eyes must straddle X=0')
    if skin_material==eye_material:raise ValueError('Skin and eye material indices must differ')
    if body.data.shape_keys:raise ValueError('Fit the face before adding other morphs')
    # Validate author landmarks before mutating mesh ownership.
    expression_fields([[0,0,0]],sorted([e['center'] for e in eyes],key=lambda c:-c[0]),
                      [(e['max'][0]-e['min'][0])/2 for e in sorted(eyes,key=lambda e:-e['center'][0])],mouth_center)
    phases={**{'idle':.63,'walk':.72,'jog':.62,'harvest':.82,'watering':.66,'plant':.84},**(blink_phases or {})}
    attachments=list(attachments);attachment_count=sum(len(o.data.vertices) for o in attachments)
    if attachments:
        bpy.ops.object.select_all(action='DESELECT');body.select_set(True)
        for obj in attachments:
            matrix=obj.matrix_world.copy();obj.parent=None;obj.matrix_world=matrix;obj.select_set(True)
        bpy.context.view_layer.objects.active=body;bpy.ops.object.join()
        objects[:]=[o for o in objects if o not in attachments]
    V=np.array([v.co[:] for v in body.data.vertices]);body.data.calc_loop_triangles()
    faces=np.array([(*t.vertices,-1) for t in body.data.loop_triangles
                    if t.material_index==skin_material and V[list(t.vertices),2].min()>head_min_z])
    if not len(faces):raise ValueError('No exterior head skin candidates above head_min_z')
    geometry=[]
    for eye in sorted(eyes,key=lambda e:-e['center'][0]):
        center=np.array(eye['center'],float);lo=np.array(eye['min']);hi=np.array(eye['max'])
        radius=(hi[0]-lo[0])/2;center[1]=hi[1]-radius
        ef=np.array([(*t.vertices,-1) for t in body.data.loop_triangles
                     if t.material_index==eye_material and V[list(t.vertices),0].mean()*center[0]>0])
        if not len(ef):raise ValueError('Missing disconnected eye surface in eye material')
        geometry.append((center,radius,V,ef))
    marks=hm.eye_landmarks(V,faces,geometry)
    skin_ids=np.unique(faces[faces>=0]);tree=BVHTree.FromPolygons([Vector(p) for p in V],[list(f[:3]) for f in faces])
    visible=[]
    for i in skin_ids:
        hit,_,_,_=tree.ray_cast(Vector((V[i,0],-1,V[i,2])),Vector((0,1,0)),2)
        if hit is not None and abs(hit.y-V[i,1])<.001:visible.append(i)
    visible=np.array(visible,int);rest=V.copy();deltas={}
    for side,(center,radius,_,_) in zip(('Left','Right'),geometry):
        suffix=side[0];margin={'inner':marks['eye_inner_'+suffix],'outer':marks['eye_outer_'+suffix],'contour':marks['eye_margin_'+suffix]}
        front=min(e['min'][1] for e in eyes if e['center'][0]*center[0]>0)-.006
        envelope=max(radius,center[1]-front)
        exterior=visible[np.linalg.norm(V[visible]-center,axis=1)>radius*.9]
        if not len(exterior):raise ValueError('No visible exterior skin around eye')
        targets,push=hm.lid_morphs(V[exterior],center,envelope,margin,overlap=.18,
                                 wide=.03,proud=0,corner=.02,crease=.35,cheek=.25,reach=1.1,fade=.25)
        nearest=np.array([np.argmin(np.linalg.norm(V[exterior]-V[i],axis=1)) for i in skin_ids])
        distance=np.linalg.norm(V[skin_ids]-V[exterior[nearest]],axis=1)
        carry=np.clip(1-distance/(radius*.5),0,1)
        rest[skin_ids]+=push[nearest]*carry[:,None]
        for local,name in [('blink','eyeBlink'),('squint','eyeSquint'),('wide','eyeWide')]:
            delta=np.zeros_like(V);delta[skin_ids]=(targets[local]-(V[exterior]+push))[nearest]*carry[:,None]
            deltas[name+side]=delta
    deltas.update(expression_fields(rest,[e[0] for e in geometry],[e[1] for e in geometry],mouth_center))
    eye_ids=np.unique(np.concatenate([e[3][e[3]>=0] for e in geometry]))
    for delta in deltas.values():delta[eye_ids]=0
    for vertex,point in zip(body.data.vertices,rest):vertex.co=point
    for name,delta in deltas.items():shape_key(body,name,rest+delta)
    body.data.update();keys=body.data.shape_keys;keys.animation_data_create()
    fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    for track in arm.animation_data.nla_tracks:
        clip=track.name;strip=track.strips[0];strip.repeat={'walk':2,'jog':3}.get(clip,1)
        start,end=strip.frame_start,strip.frame_end
        action=bpy.data.actions.new('face-'+clip);keys.animation_data.action=action
        for frame,blink,expression in performance_samples(start,end,fps,phases.get(clip,.63)):
            for key in keys.key_blocks[1:]:
                key.value=(blink if key.name.startswith('eyeBlink') else .18*expression if key.name=='browInnerUp' else
                           (.25 if clip=='idle' else .13)*expression if key.name.startswith('mouthSmile') else
                           .08*expression if key.name.startswith('eyeSquint') and clip in ('jog','harvest','plant') else 0)
                key.keyframe_insert('value',frame=frame)
        for layer in action.layers:
            for keystrip in layer.strips:
                for bag in keystrip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:key.interpolation='LINEAR'
        keys.animation_data.action=None
        nla=keys.animation_data.nla_tracks.new();nla.name=clip
        facial_strip=nla.strips.new(action.name,int(start),action)
        facial_strip.frame_start=start
    for key in keys.key_blocks[1:]:key.value=0
    return {'morphs':list(deltas),'maxRestLidAdjustment':float(np.linalg.norm(rest-V,axis=1).max()),
            'eyes':[{'center':e[0].tolist(),'radius':e[1]} for e in geometry],
            'landmarks':{k:v.tolist() for k,v in marks.items()},'attachmentVertices':attachment_count}
