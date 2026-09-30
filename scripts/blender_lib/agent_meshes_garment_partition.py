"""Partition donor skin and garment on the same weighted cut vertices."""
from numbers import Integral,Real
import numpy as np


def partition_surface(vertices, faces, normals, weights, fields, component=None):
    """Return a complete subdivided ``source`` and its retained ``garment``.

    Input faces must be rest triangles. Signed fields retain their intersection
    (all >= 0). Every field splits both sides, so neighboring donor triangles
    share edge intersections without T-junctions. The full donor remains present.
    Callers must replace the original donor with ``source`` before binding and
    offsetting the garment; using the garment alone does not repair skin drift.

    Both results carry vertices, triangle faces, unit normals and <=4-influence
    weights. Source original vertices come first; their normalized weights are
    preserved. Source also carries per-vertex barycentric ``provenance`` and
    per-triangle ``source_faces`` for transferring other attributes. Garment
    ``source_vertices`` maps its vertices to source indices. No offset is added.
    ``component='largest'`` selects the largest connected garment patch only;
    the complete donor is unaffected. Seams with distinct indices stay distinct.

    This changes the donor's topology and interpolated motion near cut edges,
    not its rest surface, skeleton or animation. It guarantees shared cut vertex
    motion, not garment clearance after offsetting or cloth self-collision.
    Input must be edge-manifold with consistent winding (open seams are allowed).
    Numerically unresolved cuts that leave cracks are rejected, never exported.
    Provenance coefficients within 2e-12 identify the same cut point.
    Other donor attributes (UVs, colors, morphs, face materials) must be transferred
    using the returned provenance. Increasing field count increases subdivision.
    """
    if component is not None and component!='largest':raise ValueError("component must be None or 'largest'")
    v=np.asarray(vertices,dtype=float);n=np.asarray(normals,dtype=float)
    if v.ndim!=2 or v.shape[1]!=3 or not len(v) or n.shape!=v.shape or not np.isfinite(v).all() or not np.isfinite(n).all() or np.max(abs(v))>np.finfo(np.float32).max:
        raise ValueError('vertices/normals must be finite matching Nx3 arrays')
    faces=[tuple(f) for f in faces]
    if not faces or any(len(f)!=3 or any(isinstance(i,bool) or not isinstance(i,Integral) or i<0 or i>=len(v) for i in f) or len(set(f))!=3 for f in faces):
        raise ValueError('faces must be valid triangles with distinct indices')
    if any(np.linalg.norm(np.cross(v[b]-v[a],v[c]-v[a]))==0 for a,b,c in faces):raise ValueError('source triangles must have nonzero area')
    def edges(polygons):
        result={}
        for face in polygons:
            for a,b in zip(face,face[1:]+face[:1]):result.setdefault(tuple(sorted((a,b))),[]).append((a,b))
        return result
    input_edges=edges(faces)
    if any(len(uses)>2 or len(uses)==2 and uses[0]!=tuple(reversed(uses[1])) for uses in input_edges.values()):
        raise ValueError('source requires manifold consistently wound edges')
    boundaries={edge for edge,uses in input_edges.items() if len(uses)==1}
    if len(weights)!=len(v):raise ValueError('one weight row per vertex is required')
    rows=[]
    for row in weights:
        if not isinstance(row,dict) or not row or any(not isinstance(k,str) or not k or isinstance(w,bool) or not isinstance(w,Real) or not np.isfinite(w) or w<0 for k,w in row.items()):
            raise ValueError('named finite nonnegative weights required')
        positive={k:float(w) for k,w in row.items() if w>0}
        if not positive or len(positive)>4:raise ValueError('source weights require one to four positive influences')
        scale=max(positive.values());scaled={k:w/scale for k,w in positive.items()};total=sum(scaled.values())
        rows.append({k:w/total for k,w in scaled.items()})
    values=np.array([np.asarray(f,dtype=float) for f in fields])
    if len(values) and (values.ndim!=2 or values.shape[1]!=len(v) or not np.isfinite(values).all()):raise ValueError('fields need one finite scalar per vertex')
    if not len(values):values=np.empty((0,len(v)))
    else:values=values/np.maximum(np.max(abs(values),axis=1),np.finfo(float).tiny)[:,None]
    scale=np.max(abs(n),axis=1)
    if np.any(scale==0):raise ValueError('normals must be nonzero')
    scaled=n/scale[:,None];original_normals=scaled/np.linalg.norm(scaled,axis=1)[:,None]
    output=v.tolist();directions=original_normals.tolist();skin=[dict(r) for r in rows]
    provenance=[{i:1.} for i in range(len(v))]
    by_support={(i,):[i] for i in range(len(v))}
    def key(row):return tuple(sorted((i,round(t,12)) for i,t in row.items() if t>1e-12))
    def add(row):
        row={i:t for i,t in row.items() if t>1e-12};total=sum(row.values());row={i:t/total for i,t in row.items()}
        support=tuple(sorted(row))
        # Quantized hash keys alone split identical edge crossings when floating
        # arithmetic lands on opposite sides of a rounding boundary.
        for index in by_support.get(support,[]):
            if max(abs(row[i]-provenance[index][i]) for i in support)<=2e-12:return index
        point=sum((v[i]*t for i,t in row.items()),np.zeros(3))
        normal=sum((original_normals[i]*t for i,t in row.items()),np.zeros(3));length=np.linalg.norm(normal)
        if length<1e-12:raise ValueError('interpolated normal vanishes')
        influence={}
        for i,t in row.items():
            for name,w in rows[i].items():influence[name]=influence.get(name,0)+t*w
        top=sorted(influence.items(),key=lambda pair:(-pair[1],pair[0]))[:4];total=sum(w for _,w in top)
        index=len(output);by_support.setdefault(support,[]).append(index);output.append(point.tolist());directions.append((normal/length).tolist())
        skin.append({name:w/total for name,w in top});provenance.append(row)
        return index
    def mix(a,b,t):return {i:(1-t)*a.get(i,0)+t*b.get(i,0) for i in a.keys()|b.keys()}
    def clip(poly,k,positive):
        out=[]
        for a,b in zip(poly,poly[1:]+poly[:1]):
            av=a[1][k] if positive else -a[1][k];bv=b[1][k] if positive else -b[1][k]
            if av>=0:out.append(a)
            if (av>=0)!=(bv>=0):
                t=av/(av-bv);val=(1-t)*a[1]+t*b[1];val[k]=0
                out.append((mix(a[0],b[0],t),val))
        result=[]
        for item in out:
            if not result or key(item[0])!=key(result[-1][0]):result.append(item)
        if len(result)>1 and key(result[0][0])==key(result[-1][0]):result.pop()
        return result
    all_faces=[];parents=[];retained=[]
    for fi,face in enumerate(faces):
        cells=[([({int(i):1.},values[:,i].copy()) for i in face],True)]
        for k in range(len(values)):
            split=[]
            for poly,inside in cells:
                vals=[p[1][k] for p in poly]
                if min(vals)>=0:split.append((poly,inside));continue
                if max(vals)<=0:split.append((poly,False));continue
                for positive in (True,False):
                    piece=clip(poly,k,positive)
                    if len(piece)>=3:split.append((piece,inside and positive))
            cells=split
        for poly,inside in cells:
            indices=list(dict.fromkeys(add(p[0]) for p in poly))
            if len(indices)<3:continue
            points=np.asarray([output[i] for i in indices])
            area=sum((np.cross(points[i]-points[0],points[i+1]-points[0]) for i in range(1,len(indices)-1)),np.zeros(3))
            if np.linalg.norm(area)==0:continue
            if len(indices)==3:triangles=[tuple(indices)]
            else:
                center={}
                for vertex in indices:
                    for i,t in provenance[vertex].items():center[i]=center.get(i,0)+t/len(indices)
                pivot=add(center)
                triangles=[(pivot,a,b) for a,b in zip(indices,indices[1:]+indices[:1])]
            for triangle in triangles:
                a,b,c=(np.asarray(output[i]) for i in triangle)
                if np.linalg.norm(np.cross(b-a,c-a))==0:continue
                if inside:retained.append(len(all_faces))
                all_faces.append(triangle);parents.append(fi)
    for (a,b),uses in edges(all_faces).items():
        boundary=tuple(sorted(set(provenance[a])|set(provenance[b]))) in boundaries
        if len(uses)!=(1 if boundary else 2) or len(uses)==2 and uses[0]!=tuple(reversed(uses[1])):
            raise ValueError('Cut fields leave unresolved topology; separate near-coincident boundaries')
    if component=='largest' and retained:
        links={i:i for fi in retained for i in all_faces[fi]}
        def root(i):
            while links[i]!=i:links[i]=links[links[i]];i=links[i]
            return i
        for fi in retained:
            a,b,c=all_faces[fi]
            for i in (b,c):
                ra,rb=root(a),root(i)
                if ra!=rb:links[max(ra,rb)]=min(ra,rb)
        groups={}
        for fi in retained:
            face=all_faces[fi];group=groups.setdefault(root(face[0]),{'area':0.,'faces':[]})
            a,b,c=(np.asarray(output[i]) for i in face);group['area']+=np.linalg.norm(np.cross(b-a,c-a))/2;group['faces'].append(fi)
        retained=max(groups.values(),key=lambda group:group['area'])['faces']
    used=sorted({i for fi in retained for i in all_faces[fi]});remap={i:j for j,i in enumerate(used)}
    output=np.asarray(output);directions=np.asarray(directions)
    source={'vertices':output,'faces':all_faces,'normals':directions,'weights':skin,'provenance':provenance,'source_faces':parents}
    garment={'vertices':output[used].copy(),'faces':[tuple(remap[i] for i in all_faces[fi]) for fi in retained],
             'normals':directions[used].copy(),'weights':[dict(skin[i]) for i in used],'source_vertices':used,
             'source_faces':[parents[fi] for fi in retained]}
    return {'source':source,'garment':garment}
