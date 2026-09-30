"""Clip a weighted sculpt surface into garment panels without staircase rims.

Pure NumPy. Positive scalar fields are retained, interpolating position, normal
and skin weights at each crossing. Construct thickness/materials in the caller.
"""
import numpy as np
from numbers import Real


def cut_surface(vertices, faces, normals, weights, fields, offset=0, shape=None, component=None):
    """Return vertices/faces/weights and fully covered source-face indices.

    Each field has one signed value per source vertex. All fields must be >= 0
    on the retained region. `offset` is metres or a position -> metres callable;
    `shape(position, unit_normal)` can replace the normal-offset operation.
    Source vertex provenance keeps coincident UV/normal/skinning seams separate.
    Returned weight rows are normalized and limited to four influences.
    Source polygons must be convex; scalar fields interpolate linearly per face.

    component='largest' retains only the connected output patch with greatest
    triangulated surface area (after shape/offset). Connectivity uses shared
    vertex indices, never welded positions; authoring seams can split patches.
    Exact area ties retain the earliest source patch. None retains every patch.
    Discarded patches never mark their source faces covered.

    covered_faces means geometrically covered, not safe to delete: open sleeves
    and necklines can expose the interior skin from another camera angle.
    """
    if component is not None and (not isinstance(component,str) or component!='largest'):
        raise ValueError("component must be None or 'largest'")
    v=np.asarray(vertices,float);n=np.asarray(normals,float)
    if v.ndim!=2 or v.shape[1]!=3 or not len(v) or n.shape!=v.shape or not np.isfinite(v).all() or not np.isfinite(n).all():
        raise ValueError('vertices and normals must be finite matching Nx3 arrays')
    if len(weights)!=len(v): raise ValueError('one weight row is required per vertex')
    rows=[]
    for row in weights:
        if not isinstance(row,dict) or not row or any(not isinstance(k,str) or not k or isinstance(w,bool) or not isinstance(w,Real) or not np.isfinite(w) or w<0 for k,w in row.items()) or max(row.values())<=0:
            raise ValueError('weight rows need named nonnegative finite influences')
        largest=max(row.values());scaled={k:w/largest for k,w in row.items() if w>0}
        total=sum(scaled.values());rows.append({k:w/total for k,w in scaled.items()})
    f=[np.asarray(field,float) for field in fields]
    if any(field.shape!=(len(v),) or not np.isfinite(field).all() for field in f):
        raise ValueError('fields must contain one finite scalar per vertex')
    output=[];polygons=[];skin=[];covered=[];lookup={};source_faces=[]
    def mix_row(a,b,t): return {k:(1-t)*a.get(k,0)+t*b.get(k,0) for k in a.keys()|b.keys()}
    for fi,face in enumerate(faces):
        if len(face)<3 or any(not isinstance(i,(int,np.integer)) or i<0 or i>=len(v) for i in face):
            raise ValueError('faces must contain valid source indices')
        poly=[(v[i],n[i],rows[i],np.array([field[i] for field in f]),{int(i):1.}) for i in face]
        if any(all(p[3][k]<0 for p in poly) for k in range(len(f))): continue
        if all(all(p[3]>=0) for p in poly): covered.append(fi)
        for k in range(len(f)):
            clipped=[]
            for a,b in zip(poly,poly[1:]+poly[:1]):
                if a[3][k]>=0: clipped.append(a)
                if (a[3][k]>=0)!=(b[3][k]>=0):
                    t=a[3][k]/(a[3][k]-b[3][k])
                    clipped.append(((1-t)*a[0]+t*b[0],(1-t)*a[1]+t*b[1],mix_row(a[2],b[2],t),
                                    (1-t)*a[3]+t*b[3],mix_row(a[4],b[4],t)))
            poly=clipped
            if len(poly)<3: break
        if len(poly)<3: continue
        ids=[]
        for p,normal,row,_,provenance in poly:
            key=tuple(sorted((i,round(t,10)) for i,t in provenance.items() if t>1e-10))
            if key not in lookup:
                length=np.linalg.norm(normal)
                if length<1e-12: raise ValueError('a garment vertex needs a nonzero interpolated normal')
                normal=normal/length
                point=np.asarray(shape(p.copy(),normal.copy()) if shape else p+normal*(offset(p.copy()) if callable(offset) else offset),float)
                if point.shape!=(3,) or not np.isfinite(point).all(): raise ValueError('garment shape returned a nonfinite XYZ point')
                top=sorted(((k,w) for k,w in row.items() if w>1e-12),key=lambda item:(-item[1],item[0]))[:4]
                total=sum(w for _,w in top)
                lookup[key]=len(output);output.append(point);skin.append({k:w/total for k,w in top})
            ids.append(lookup[key])
        ids=list(dict.fromkeys(ids))
        if len(ids)>=3:
            polygons.append(ids);source_faces.append(fi)
    if component=='largest' and polygons:
        parent=list(range(len(output)))
        def root(i):
            while parent[i]!=i:
                parent[i]=parent[parent[i]];i=parent[i]
            return i
        for face in polygons:
            for i in face[1:]:
                a,b=root(face[0]),root(i)
                if a!=b:parent[max(a,b)]=min(a,b)
        patches={}
        for fi,face in enumerate(polygons):
            patch=patches.setdefault(root(face[0]),{'area':0.,'faces':[]})
            p=np.asarray([output[i] for i in face])
            patch['area']+=sum(float(np.linalg.norm(np.cross(p[i]-p[0],p[i+1]-p[0])))*.5 for i in range(1,len(p)-1))
            patch['faces'].append(fi)
        selected=max(patches.values(),key=lambda patch:patch['area'])['faces']
        retained={source_faces[i] for i in selected}
        covered=[i for i in covered if i in retained]
        used=sorted({v for i in selected for v in polygons[i]})
        remap={v:i for i,v in enumerate(used)}
        polygons=[[remap[v] for v in polygons[i]] for i in selected]
        output=[output[i] for i in used];skin=[skin[i] for i in used]
    return {'vertices':np.asarray(output).reshape((-1,3)),'faces':polygons,'weights':skin,'covered_faces':covered}
