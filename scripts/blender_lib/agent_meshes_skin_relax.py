"""Topology-based skin-weight relaxation with pinned garment regions."""
import numpy as np
from numbers import Real


def relax_weights(vertices,faces,weights,free,iterations=150,max_influences=4):
    """Relax free rows along inverse-length mesh edges; keep fixed rows anchored.

    Disconnected surfaces never exchange weights even if they touch in space.
    Rows are normalized and pruned to max_influences after relaxation. This
    reduces discontinuities; it does not certify collision-free deformation.
    """
    v=np.asarray(vertices,float);mask=np.asarray(free)
    if v.ndim!=2 or v.shape[1]!=3 or not len(v) or not np.isfinite(v).all():raise ValueError('Finite Nx3 vertices required')
    if mask.shape!=(len(v),) or mask.dtype!=np.dtype(bool):raise ValueError('One boolean free flag per vertex required')
    if isinstance(iterations,bool) or not isinstance(iterations,int) or iterations<1:raise ValueError('Positive integer iterations required')
    if isinstance(max_influences,bool) or not isinstance(max_influences,int) or max_influences<1:raise ValueError('Positive integer influence limit required')
    if len(weights)!=len(v):raise ValueError('One named weight row per vertex required')
    names=set()
    for row in weights:
        if not isinstance(row,dict) or not row or any(not isinstance(n,str) or not n or isinstance(w,bool) or not isinstance(w,Real) or not np.isfinite(w) or w<0 for n,w in row.items()) or sum(row.values())<=0:raise ValueError('Named nonnegative finite weights required')
        names.update(row)
    names=sorted(names);index={n:i for i,n in enumerate(names)};w=np.zeros((len(v),len(names)))
    for i,row in enumerate(weights):
        largest=max(row.values());total=sum(value/largest for value in row.values())
        for n,value in row.items():w[i,index[n]]=(value/largest)/total
    edges=set()
    for face in faces:
        if len(face)<3 or any(not isinstance(i,(int,np.integer)) or i<0 or i>=len(v) for i in face):raise ValueError('Faces need valid vertex indices')
        for a,b in zip(face,(*face[1:],face[0])):
            if a!=b:edges.add(tuple(sorted((a,b))))
    if edges:
        e=np.array(sorted(edges));a,b=e.T
        c=1/np.maximum(np.linalg.norm(v[a]-v[b],axis=1),1e-8)
        degree=np.bincount(np.r_[a,b],weights=np.r_[c,c],minlength=len(v))
        active=mask&(degree>0)
        for _ in range(iterations):
            around=np.zeros_like(w)
            np.add.at(around,a,w[b]*c[:,None]);np.add.at(around,b,w[a]*c[:,None])
            proposed=.5*w+.5*around/np.maximum(degree,1e-20)[:,None]
            w[active]=proposed[active]
    out=[]
    for row in w:
        top=np.argsort(-row,kind='stable')[:max_influences];total=sum(row[i] for i in top)
        out.append({names[i]:float(row[i]/total) for i in top if row[i]>1e-12})
    return out


def relax_mesh_weights(mesh,free,iterations=150):
    """Blender adapter; changes only deform-group weights on the supplied mesh."""
    rigs=[m.object for m in mesh.modifiers if m.type=='ARMATURE' and m.object is not None]
    if len(rigs)!=1:raise ValueError('One armature modifier is required for garment weight relaxation')
    deform={b.name for b in rigs[0].data.bones if b.use_deform}
    vertices=[v.co[:] for v in mesh.data.vertices];faces=[tuple(p.vertices) for p in mesh.data.polygons]
    rows=[{mesh.vertex_groups[g.group].name:g.weight for g in v.groups if g.weight>0 and mesh.vertex_groups[g.group].name in deform} for v in mesh.data.vertices]
    result=relax_weights(vertices,faces,rows,free,iterations)
    groups={g.name:g for g in mesh.vertex_groups if g.name in deform}
    for group in groups.values():group.remove(list(range(len(vertices))))
    for i,row in enumerate(result):
        for name,value in row.items():groups[name].add([i],value,'REPLACE')
    return {'vertices':len(vertices),'freeVertices':int(sum(free)),'iterations':iterations}
