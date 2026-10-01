"""Conservative cleanup of shallow folded degree-three triangle fans."""
from numbers import Integral, Real
import numpy as np


def repair_folded_fans(vertices, faces, *, max_distance, minimum_alignment=.95):
    """Replace small, nearly planar folded three-triangle fans by their boundary.

    A candidate is an interior vertex with exactly three incident triangles and
    three neighbors. Its projection lies outside the boundary triangle, one fan
    face points backward, and all fan faces are nearly parallel to that triangle
    (absolute normal dot >= minimum_alignment). The vertex-to-triangle distance
    must not exceed max_distance. Ordinary curved fans and steep folds remain.

    Returns vertices, triangle faces, source_vertices for remapping attributes,
    removed_vertices and repair diagnostics. Retained positions are exact; no
    smoothing or weight interpolation occurs. Unrelated unused vertices remain.
    Independent fans are selected in source-index order; overlapping candidates
    are left for inspection. Inputs are not modified. This is a bounded rest
    geometry repair, not a self-collision, animation or Hausdorff-clearance proof.
    Use before skinning/morph creation, or explicitly remap every vertex attribute.
    """
    for value,name in [(max_distance,'max_distance'),(minimum_alignment,'minimum_alignment')]:
        if isinstance(value,bool) or not isinstance(value,Real) or not np.isfinite(value) or value<=0:
            raise ValueError(name+' must be positive and finite')
    if minimum_alignment>1:raise ValueError('minimum_alignment must be <= 1')
    try:
        points=np.asarray(vertices,dtype=float);triangles=[tuple(t) for t in faces]
    except (ValueError,TypeError) as exc:raise ValueError('Finite Nx3 vertices and triangle faces required') from exc
    if points.ndim!=2 or points.shape[1]!=3 or not len(points) or not np.isfinite(points).all():
        raise ValueError('Finite nonempty Nx3 vertices required')
    if not triangles or any(len(t)!=3 or len(set(t))!=3 or any(isinstance(i,bool) or not isinstance(i,Integral) or not 0<=i<len(points) for i in t) for t in triangles):
        raise ValueError('Faces require three distinct valid vertex indices')
    triangles=[tuple(int(i) for i in t) for t in triangles]
    face_keys={tuple(sorted(t)) for t in triangles}
    if len(face_keys)!=len(triangles):raise ValueError('Duplicate faces are not supported')
    edges={};incident=[[] for _ in points]
    for fi,t in enumerate(triangles):
        for i in t:incident[i].append(fi)
        for a,b in zip(t,t[1:]+t[:1]):edges.setdefault(tuple(sorted((a,b))),[]).append((a,b))
    if any(len(e)>2 or len(e)==2 and e[0]!=e[1][::-1] for e in edges.values()):
        raise ValueError('Faces require consistently wound manifold edges')
    removed=set();replaced=set();occupied=set();replacements=[];repairs=[]
    for vertex,fan in enumerate(incident):
        if len(fan)!=3:continue
        neighborhood={i for fi in fan for i in triangles[fi]}
        if len(neighborhood)!=4 or occupied.intersection(neighborhood):continue
        boundary=[(a,b) for fi in fan for a,b in zip(triangles[fi],triangles[fi][1:]+triangles[fi][:1]) if vertex not in (a,b)]
        following=dict(boundary)
        if len(following)!=3 or set(following)!=set(following.values()):continue
        a=min(following);b=following[a];c=following[b]
        if len({a,b,c})!=3 or following[c]!=a or tuple(sorted((a,b,c))) in face_keys:continue
        # Radial edges must be interior, even when the patch boundary is open.
        if any(len(edges[tuple(sorted((vertex,i)))])!=2 for i in (a,b,c)):continue
        base=points[[a,b,c]];u=base[1]-base[0];v=base[2]-base[0]
        cross=np.cross(u,v);length=np.linalg.norm(cross)
        if not np.isfinite(length) or length==0:continue
        normal=cross/length
        bary=np.linalg.lstsq(np.column_stack((u,v)),points[vertex]-base[0],rcond=None)[0]
        if min(1-bary.sum(),*bary)>=-1e-8:continue
        fan_points=points[np.array([triangles[i] for i in fan])]
        fan_normals=np.cross(fan_points[:,1]-fan_points[:,0],fan_points[:,2]-fan_points[:,0]);sizes=np.linalg.norm(fan_normals,axis=1)
        if np.any(sizes==0) or not np.isfinite(sizes).all():continue
        align=(fan_normals/sizes[:,None])@normal
        if min(align)>=0 or min(abs(align))<minimum_alignment:continue
        # Projection is outside: the nearest triangle point is on its boundary.
        distance=min(np.linalg.norm(points[vertex]-(p+np.clip(np.dot(points[vertex]-p,q-p)/np.dot(q-p,q-p),0,1)*(q-p)))
                     for p,q in zip(base,np.roll(base,-1,axis=0)))
        if distance>max_distance:continue
        removed.add(vertex);replaced.update(fan);occupied.update(neighborhood);replacements.append((a,b,c))
        repairs.append({'vertex':vertex,'source_faces':fan,'boundary':[a,b,c],
                        'distance':float(distance),'minimum_absolute_alignment':float(min(abs(align)))})
    keep=[i for i in range(len(points)) if i not in removed];mapping={old:new for new,old in enumerate(keep)}
    result_faces=[t for i,t in enumerate(triangles) if i not in replaced]+replacements
    return {'vertices':points[keep].copy(),'faces':[tuple(mapping[i] for i in t) for t in result_faces],
            'source_vertices':keep,'removed_vertices':sorted(removed),'repairs':repairs}
