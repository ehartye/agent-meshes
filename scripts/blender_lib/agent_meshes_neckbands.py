"""Closed ribbed crew-neck bands and open jacket stands, in rest-space Z-up."""
import numpy as np
from numbers import Real


def neckband_mesh(lower,upper,*,thickness=.002,ribs=0,rib_depth=0.,closed=True):
    """Loft a rounded fabric cross-section along matching neckline contours.

    Contours run counterclockwise viewed from above, without a repeated endpoint.
    Their points describe the inner lower/upper edges; outer-wall ribs follow
    corresponding points vertically. Open stands receive end caps. This pure
    geometry helper does not fit skin, assign weights or certify posed clearance.
    """
    a=np.asarray(lower,float);b=np.asarray(upper,float)
    if a.ndim!=2 or a.shape[1]!=3 or len(a)<3 or b.shape!=a.shape or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('Matching finite Nx3 contours with at least three points required')
    if not isinstance(closed,bool):raise ValueError('closed must be boolean')
    for value,name,positive in [(thickness,'thickness',True),(rib_depth,'rib_depth',False)]:
        if isinstance(value,bool) or not isinstance(value,Real) or not np.isfinite(value) or (value<=0 if positive else value<0):
            raise ValueError(name+' must be finite and '+('positive' if positive else 'nonnegative'))
    if isinstance(ribs,bool) or not isinstance(ribs,int) or ribs<0:raise ValueError('ribs must be a nonnegative integer')
    segments=len(a) if closed else len(a)-1
    if ribs*4>segments:raise ValueError('Use at least four segments per rib')
    rise=b-a
    if np.any(rise[:,2]<=1e-8):raise ValueError('Upper contour must be above lower contour')
    center=(a+b)/2;tangent=np.roll(center,-1,axis=0)-np.roll(center,1,axis=0)
    if not closed:tangent[0]=center[1]-center[0];tangent[-1]=center[-1]-center[-2]
    normal=np.cross(tangent,rise);length=np.linalg.norm(normal,axis=1)
    if np.any(length<1e-10):raise ValueError('Contour has a collapsed tangent or vertical edge')
    normal/=length[:,None]
    rib=rib_depth*(.5+.5*np.cos(np.arange(len(a))*2*np.pi*ribs/segments)) if ribs else np.zeros(len(a))
    profile=[(0,0),(0,.5),(.08,1),(.92,1),(1,.5),(1,0),(.92,-.15),(.08,-.15)]
    vertices=[]
    for i in range(len(a)):
        for j,(height,offset) in enumerate(profile):
            vertices.append((a[i]+rise[i]*height+normal[i]*(thickness*offset+(rib[i] if j in (2,3) else 0))).tolist())
    faces=[];n=len(profile)
    for i in range(segments):
        nxt=(i+1)%len(a)
        for j in range(n):
            k=(j+1)%n;faces.append((i*n+j,nxt*n+j,nxt*n+k,i*n+k))
    if not closed:faces.extend([tuple(range(n)),tuple(reversed(range((len(a)-1)*n,len(a)*n)))])
    return vertices,faces


def fit_neckband(body,garment,*,lower,upper,clearance=.009,surface_shape=None,
                 opening_width=None,embed=.002,thickness=.002,ribs=0,rib_depth=.0008,
                 smooth_distance=.015,attachment_band=.035,max_fabric_thickness=.004,
                 center=(0.,0.),ray_distance=.4,follow_garment_edge=False):
    """Fit a band to a Blender body's rest surface and share its seam weights.

    Body and garment must use the same local Z-up coordinate frame, front -Y.
    The garment must have applied Solidify topology with paired vertex halves.
    ``surface_shape(p, n)`` reproduces an authored garment offset at ``lower``;
    its stand rises vertically from that shaped edge, embedded by ``embed``.
    Otherwise both contours follow the body with radial ``clearance``.
    ``opening_width`` is the positive half-width of the front cut on the body.
    It is solved independently on each side rather than guessed as an angle.
    ``follow_garment_edge=True`` instead selects the closest closed garment
    boundary and raises it by ``upper-lower`` without re-projecting onto skin.

    Returns vertices/faces/weights for make_mesh + bind_skin. Updates only the
    garment's nearby weights, with equal rows across its fabric thickness.
    Does not change source anatomy, create an object, assign materials or prove
    posed clearance. Use after garment shaping, before dependent attachments.
    """
    import math
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree
    from agent_meshes_skin_relax import relax_weights

    values=(lower,upper,clearance,embed,thickness,rib_depth,smooth_distance,
            attachment_band,max_fabric_thickness,ray_distance)
    if any(isinstance(v,bool) or not isinstance(v,Real) or not np.isfinite(v) for v in values):
        raise ValueError('Neckband dimensions must be finite numbers')
    if upper<=lower or min(clearance,embed,rib_depth,smooth_distance)<0 or min(thickness,attachment_band,max_fabric_thickness,ray_distance)<=0:
        raise ValueError('Invalid neckband height, clearance or attachment dimensions')
    if isinstance(ribs,bool) or not isinstance(ribs,int) or ribs<0:raise ValueError('ribs must be a nonnegative integer')
    if opening_width is not None and (isinstance(opening_width,bool) or not isinstance(opening_width,Real) or not np.isfinite(opening_width) or opening_width<=0):
        raise ValueError('Opening half-width must be finite and positive')
    center=np.asarray(center,float)
    if center.shape!=(2,) or not np.isfinite(center).all():raise ValueError('Center must be finite XY')
    if surface_shape is not None and not callable(surface_shape):raise ValueError('surface_shape must be callable')
    if not isinstance(follow_garment_edge,bool):raise ValueError('follow_garment_edge must be boolean')
    if follow_garment_edge and (opening_width is not None or surface_shape is not None):
        raise ValueError('Following a closed garment edge cannot use an open stand or surface_shape')
    if not np.allclose(np.array(body.matrix_world),np.array(garment.matrix_world),atol=1e-7,rtol=0):
        raise ValueError('Body and garment must share a coordinate frame')
    garment_points=np.array([v.co[:] for v in garment.data.vertices]);half=len(garment_points)//2
    if not half or len(garment_points)!=half*2 or np.any(np.linalg.norm(garment_points[:half]-garment_points[half:],axis=1)>max_fabric_thickness+1e-6):
        raise ValueError('Expected applied Solidify fabric with paired vertex halves')
    vertices=np.array([v.co[:] for v in body.data.vertices]);normals=np.array([v.normal[:] for v in body.data.vertices])
    source_weights=[{body.vertex_groups[g.group].name:g.weight for g in v.groups if g.weight>1e-8} for v in body.data.vertices]
    body.data.calc_loop_triangles();triangles=[tuple(t.vertices) for t in body.data.loop_triangles]
    tree=BVHTree.FromPolygons([v.co for v in body.data.vertices],triangles,all_triangles=True)

    def sample(z,angle):
        direction=Vector((math.sin(angle),-math.cos(angle),0))
        hit,_,face,_=tree.ray_cast(Vector((*center,z)),direction,ray_distance)
        if hit is None:raise ValueError('Neckline ray missed body surface')
        ids=triangles[face];a,b,c=vertices[list(ids)]
        u,v=np.linalg.lstsq(np.column_stack((b-a,c-a)),np.array(hit)-a,rcond=None)[0]
        factors=(1-u-v,u,v);normal=sum(normals[i]*f for i,f in zip(ids,factors))
        length=np.linalg.norm(normal)
        if length<1e-10:raise ValueError('Neckline source normal collapsed')
        row={}
        for i,f in zip(ids,factors):
            for name,w in source_weights[i].items():row[name]=row.get(name,0)+max(0,float(f))*w
        row=dict(sorted(row.items(),key=lambda item:-item[1])[:4]);total=sum(row.values())
        if total<=0:raise ValueError('Neckline source has no usable skin weights')
        return hit,normal/length,{name:w/total for name,w in row.items() if w>1e-8},direction

    closed=opening_width is None;start=0.;end=math.tau
    if not closed:
        limits=[]
        for sign in (1,-1):
            low=0.;high=math.pi/2
            if sign*(sample(lower,sign*high)[0].x-center[0])<=opening_width:
                raise ValueError('Opening is wider than the neckline')
            for _ in range(28):
                middle=(low+high)/2
                if sign*(sample(lower,sign*middle)[0].x-center[0])<opening_width:low=middle
                else:high=middle
            limits.append((low+high)/2)
        start=limits[0];end=math.tau-limits[1]
    angles=np.linspace(start,end,max(144,ribs*6),endpoint=not closed)
    contours=[];columns=[]
    if follow_garment_edge:
        # Recover the original surface boundary from the outer Solidify half.
        # The closest loop to the requested neck center distinguishes neckline
        # from hem and cuffs, including a relaxed or non-planar opening.
        counts={}
        for face in garment.data.polygons:
            ids=list(face.vertices)
            if any(i>=half for i in ids):continue
            for a,b in zip(ids,ids[1:]+ids[:1]):
                edge=tuple(sorted((a,b)));counts[edge]=counts.get(edge,0)+1
        neighbors={}
        for (a,b),count in counts.items():
            if count==1:neighbors.setdefault(a,[]).append(b);neighbors.setdefault(b,[]).append(a)
        if not neighbors or any(len(adjacent)!=2 for adjacent in neighbors.values()):
            raise ValueError('Garment must have closed, unbranched boundary loops')
        loops=[];unvisited=set(neighbors)
        while unvisited:
            start=min(unvisited);loop=[];previous=None;current=start
            while current not in loop:
                loop.append(current);unvisited.remove(current)
                nxt=next(i for i in neighbors[current] if i!=previous)
                previous,current=current,nxt
            if current!=start:raise ValueError('Garment boundary failed to close')
            loops.append(loop)
        middle=(garment_points[:half]+garment_points[half:])/2
        target=np.array((*center,lower))
        loop=min(loops,key=lambda ids:np.linalg.norm(middle[ids].mean(axis=0)-target))
        edge=middle[loop]
        if np.sum(edge[:,0]*np.roll(edge[:,1],-1)-edge[:,1]*np.roll(edge[:,0],-1))<0:
            loop.reverse();edge=middle[loop]
        lengths=np.linalg.norm(np.roll(edge,-1,axis=0)-edge,axis=1)
        if np.any(lengths<1e-9):raise ValueError('Collapsed neckline boundary edge')
        distances=np.r_[0,np.cumsum(lengths)];bottom=[];top=[]
        for distance in np.linspace(0,distances[-1],len(angles),endpoint=False):
            i=min(len(loop)-1,int(np.searchsorted(distances,distance,side='right')-1));j=(i+1)%len(loop)
            t=(distance-distances[i])/lengths[i];p=edge[i]*(1-t)+edge[j]*t
            # A sewn trim rises from its attachment contour. Re-projecting the
            # top onto anatomy can bridge toward the chin or another nearby
            # surface, producing a broad membrane instead of a narrow band.
            bottom.append(p-np.array((0,0,embed)))
            top.append(p+np.array((0,0,upper-lower-embed)))
            row={}
            for index,factor in ((loop[i],1-t),(loop[j],t)):
                for g in garment.data.vertices[index].groups:
                    name=garment.vertex_groups[g.group].name;row[name]=row.get(name,0)+factor*g.weight
            row=dict(sorted(row.items(),key=lambda item:-item[1])[:4]);total=sum(row.values())
            if total<=0:raise ValueError('Neckline edge has no usable skin weights')
            columns.append({name:w/total for name,w in row.items() if w>1e-8})
        contours=[bottom,top]
    else:
        for z in (lower,upper):
            ring=[]
            for angle in angles:
                hit,normal,row,direction=sample(lower if surface_shape else z,angle)
                if z==lower:columns.append(row)
                point=(np.asarray(surface_shape(np.array(hit),normal),float)+np.array((0,0,z-lower-embed))) if surface_shape else np.array(hit+direction*clearance)
                if point.shape!=(3,) or not np.isfinite(point).all():raise ValueError('Invalid shaped neckline point')
                ring.append(point)
            contours.append(ring)
    band_vertices,faces=neckband_mesh(*contours,thickness=thickness,ribs=ribs,rib_depth=rib_depth if ribs else 0.,closed=closed)
    stride=len(band_vertices)//len(columns);rows=[row for row in columns for _ in range(stride)]
    if smooth_distance:
        pitch=float(np.median(np.linalg.norm(np.diff(contours[0],axis=0),axis=1)))
        rows=relax_weights(band_vertices,faces,rows,[True]*len(rows),iterations=max(1,round(2*(smooth_distance/pitch)**2)))
        columns=[rows[i*stride] for i in range(len(columns))]
        rows=[dict(row) for row in columns for _ in range(stride)]
    kd=KDTree(len(columns))
    for i,p in enumerate(contours[0]):kd.insert(Vector(p),i)
    kd.balance();updates=[]
    for i in range(half):
        _,column,distance=kd.find(Vector((garment_points[i]+garment_points[i+half])/2))
        if distance>=attachment_band:continue
        blend=float(np.clip((attachment_band-distance)/(attachment_band*6/7),0,1));blend=blend*blend*(3-2*blend)
        original={garment.vertex_groups[g.group].name:g.weight for g in garment.data.vertices[i].groups}
        fitted={n:original.get(n,0)*(1-blend)+columns[column].get(n,0)*blend for n in set(original)|set(columns[column])}
        fitted=dict(sorted(fitted.items(),key=lambda item:-item[1])[:4]);total=sum(fitted.values())
        if total<=0:raise ValueError('Garment attachment has no usable skin weights')
        updates.append((i,{n:w/total for n,w in fitted.items() if w>1e-8}))
    for i,fitted in updates:
        for group in garment.vertex_groups:group.remove([i,i+half])
        for name,w in fitted.items():
            group=garment.vertex_groups.get(name) or garment.vertex_groups.new(name=name)
            group.add([i,i+half],w,'REPLACE')
    return {'vertices':band_vertices,'faces':faces,'weights':rows}
