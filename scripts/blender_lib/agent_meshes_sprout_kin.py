"""Digitigrade plant-kin anatomy, Z-up and facing -Y, in metres.

Pure geometry plus a Blender adapter. The anatomical landmarks explicitly include
the raised hock, long metatarsal, S-neck and counterweight tail. This is a static
foundation; it does not claim a working gait or facial contract.
"""
import math
import numpy as np
from agent_meshes_author import sweep_mesh


def anatomy(*, height=1.7, age='adult'):
    if isinstance(height,bool) or not isinstance(height,(int,float)) or not math.isfinite(height) or not .7<=height<=2.5:
        raise ValueError('height must be finite and within 0.7..2.5 metres')
    if age not in ('adult','child'): raise ValueError('age must be adult or child')
    scale=height/1.7; child=age=='child'
    # Child has a larger head and shorter limbs relative to total height.
    def point(p):
        x,y,z=p
        if child:
            z=z*.90 if z<1.12 else 1.008+(z-1.12)*1.22
            x*=1.05 if z>1.2 else .95
        return [x*scale,y*scale,z*scale]
    joints={'pelvis':(0,.025,.72),'chest':(0,-.01,1.035),
            'neck_base':(0,.005,1.115),'neck_mid':(0,.025,1.235),
            'neck_tip':(0,-.10,1.335),'head':(0,-.115,1.42),
            'tail_base':(0,.105,.735),'tail_mid':(0,.285,.655),'tail_tip':(0,.48,.51)}
    for s,sign in [('l',1),('r',-1)]:
        for name,p in {'shoulder':(.125,0,1.09),'elbow':(.225,-.015,.845),
                       'wrist':(.270,-.025,.625),'hand':(.278,-.045,.58),
                       'hip':(.086,.025,.70),'knee':(.118,-.095,.515),
                       'hock':(.12,.105,.25),'toe':(.12,-.045,.038)}.items():
            joints[name+'_'+s]=(sign*p[0],p[1],p[2])
    return {'height':height,'age':age,'scale':scale,'joints':{n:point(p) for n,p in joints.items()},
            'head_radii':[v*scale*(1.18 if child else 1) for v in (.185,.125,.135)],
            'crest_count':3 if child else 5}


def _sphere(center,radii,segments=40,rows=24):
    c=np.array(center); r=np.array(radii)
    vertices=[(c+[0,0,-r[2]]).tolist()]
    for i in range(1,rows):
        lat=-math.pi/2+math.pi*i/rows
        for j in range(segments):
            phi=math.tau*j/segments
            vertices.append((c+r*[math.cos(lat)*math.cos(phi),math.cos(lat)*math.sin(phi),math.sin(lat)]).tolist())
    top=len(vertices);vertices.append((c+[0,0,r[2]]).tolist())
    faces=[(0,1+(j+1)%segments,1+j) for j in range(segments)]
    for i in range(rows-2):
        for j in range(segments):
            a=1+i*segments+j;b=1+i*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    faces.extend((top,1+(rows-2)*segments+j,1+(rows-2)*segments+(j+1)%segments) for j in range(segments))
    return vertices,faces


def _curve(points,radii,steps=8):
    """Centripetal shape is bounded per segment to avoid negative radii/overshoot."""
    rows=np.column_stack((points,radii));out=[]
    for i in range(len(rows)-1):
        a,b=rows[i:i+2];prev=rows[max(i-1,0)];nxt=rows[min(i+2,len(rows)-1)]
        for t in np.linspace(0,1,steps,endpoint=False):
            v=.5*(2*a+(-prev+b)*t+(2*prev-5*a+4*b-nxt)*t*t+(-prev+3*a-3*b+nxt)*t**3)
            out.append(np.clip(v,np.minimum(a,b),np.maximum(a,b)))
    out.append(rows[-1]);out=np.array(out)
    return out[:,:3],out[:,3:]


def hand_point(points,a,side):
    """Turn the palm toward the thigh about the forearm axis; preserve its center."""
    j=a['joints'];center=np.array(j['hand_'+side]);axis=np.array(j['wrist_'+side])-j['elbow_'+side]
    axis=axis/np.linalg.norm(axis);angle=(1 if side=='l' else -1)*math.pi/2
    v=np.asarray(points)-center
    return center+v*math.cos(angle)+np.cross(axis,v)*math.sin(angle)+np.sum(v*axis,axis=-1,keepdims=True)*axis*(1-math.cos(angle))


def geometry(*,height=1.7,age='adult'):
    a=anatomy(height=height,age=age);s=a['scale'];j={n:np.array(v) for n,v in a['joints'].items()};parts=[]
    def add(name,data,kind='skin'):
        v,f=data
        if name.startswith(('palm_','finger_','digit-tip_','thumb_','thumb-tip_')):
            v=hand_point(v,a,name.split('_')[1][0])
        parts.append({'name':name,'vertices':[tuple(map(float,p)) for p in v],
                              'faces':[tuple(map(int,p)) for p in f],'kind':kind})
    def sphere(name,c,r,kind='skin'):add(name,_sphere(c,r),kind)
    def tube(name,points,radii,kind='skin',normal=None):
        p,r=_curve(points,[(v,v) if np.isscalar(v) else v for v in radii])
        add(name,sweep_mesh(p,r,radial_segments=24,initial_normal=normal),kind)
    # The trunk is narrow at the shoulders and full around the low belly.
    zfactor=.90 if age=='child' else 1
    p=[(0,y*s,z*s*zfactor) for y,z in [(0,.635),(.01,.70),(-.025,.83),(-.005,.97),(.005,1.075),(.005,1.14)]]
    r=[(x*s,y*s) for x,y in [(.015,.015),(.125,.10),(.152,.124),(.115,.09),(.101,.068),(.02,.02)]]
    tube('trunk',p,r,normal=(1,0,0))
    tube('neck',[j['chest'],j['neck_base'],j['neck_mid'],j['neck_tip'],j['head']],[.055*s,.052*s,.043*s,.044*s,.060*s],normal=(1,0,0))
    sphere('bulb-head',j['head'],a['head_radii'])
    tube('tail',[j['pelvis'],j['tail_base'],j['tail_mid'],j['tail_tip']],[.07*s,.064*s,.039*s,.002*s])
    for side,sign in [('l',1),('r',-1)]:
        shoulder,elbow,wrist,hand=[j[n+'_'+side] for n in ['shoulder','elbow','wrist','hand']]
        sphere('shoulder_'+side,shoulder,[.047*s,.044*s,.047*s])
        tube('arm_'+side,[shoulder,elbow,wrist,hand],[.046*s,.034*s,.024*s,.028*s])
        sphere('palm_'+side,hand,[.031*s,.024*s,.043*s])
        for n,dx in enumerate([-.015,.015]):
            root=hand+np.array([sign*dx,-.005*s,-.024*s])
            tube('finger_'+side+str(n),[root,root+[0,-.012*s,-.036*s],root+[0,-.025*s,-.064*s]],
                 [.013*s,.011*s,.009*s])
            sphere('digit-tip_'+side+str(n),root+[0,-.025*s,-.064*s],[.009*s]*3)
        root=hand+np.array([sign*.02*s,0,.012*s])
        tube('thumb_'+side,[root,root+[sign*.029*s,-.013*s,-.013*s],root+[sign*.025*s,-.034*s,-.027*s]],
             [.014*s,.012*s,.009*s])
        sphere('thumb-tip_'+side,root+[sign*.025*s,-.034*s,-.027*s],[.009*s]*3)
        hip,knee,hock,toe=[j[n+'_'+side] for n in ['hip','knee','hock','toe']]
        tube('leg_'+side,[hip,knee,hock,toe],[.066*s,.040*s,.028*s,.025*s])
        sphere('hock_'+side,hock,[.033*s,.031*s,.033*s])
        sphere('foot_'+side,toe+[0,-.005*s,-.008*s],[.054*s,.045*s,.028*s])
        for n,dx in enumerate([-.036,0,.036]):
            sphere('toe_'+side+str(n),[toe[0]+dx*s,toe[1]-.043*s,.024*s],[.021*s,.061*s,.024*s])
    hc=j['head'];rx,ry,rz=a['head_radii']
    # Side-set eyes are separate editable anatomy. Sockets/lids are added by the
    # facial-rig stage; keep the skin mesh topology independent of expression work.
    for side,sign in [('l',1),('r',-1)]:
        sphere('eye_'+side,hc+[sign*rx*.59,-ry*.82,rz*.12],[.058*s]*3,'eye')
        sphere('tympanum_'+side,hc+[sign*rx*.98,-.002*s,-.018*s],[.008*s,.023*s,.027*s],'detail')
    count=a['crest_count']
    for n,t in enumerate(np.linspace(-1,1,count)):
        base=hc+[t*rx*.4,.01*s,rz*.82]
        # Broad lanceolate leaves, each with a curved midrib and closed thickness.
        verts=[];rings=18;radial=12
        length=height-hc[2]-rz*.82-.027*abs(t)*s
        for k in range(rings+1):
            u=k/rings;center=base+np.array([t*.07*s*u,.01*s*math.sin(math.pi*u),length*u])
            width=.001*s+.024*s*math.sin(math.pi*u)**.8
            thick=.001*s+.004*s*math.sin(math.pi*u)
            for angle in np.linspace(0,math.tau,radial,endpoint=False):
                verts.append(center+[width*math.cos(angle),thick*math.sin(angle),0])
        faces=[(k*radial+l,k*radial+(l+1)%radial,(k+1)*radial+(l+1)%radial,(k+1)*radial+l) for k in range(rings) for l in range(radial)]
        faces.extend([tuple(reversed(range(radial))),tuple(range(rings*radial,(rings+1)*radial))])
        add('crest-'+str(n),(verts,faces),'crest')
    return parts


def _smooth_hip_join(body,a):
    """Round the fused trunk/thigh junction before weights or clothes are fitted.

    Voxel fusion closes the thigh caps but leaves a shelf under the pear trunk.
    Local relaxation blends that contour without shrinking hands, feet or head.
    Run after decimation so its relative edge density is stable across heights.
    """
    import bpy
    s=a['scale'];hip=a['joints']['hip_l'][2]
    vertices=np.array([v.co[:] for v in body.data.vertices])
    q=(vertices[:,2]-hip)/(.15*s)
    mask=np.where(np.abs(q)<1,np.cos(np.clip(q,-1,1)*math.pi/2)**2,0)
    mask*=np.clip((.18*s-np.abs(vertices[:,0]))/(.04*s),0,1)
    mask*=np.clip((.13*s-vertices[:,1])/(.04*s),0,1)
    group=body.vertex_groups.new(name='hip_join_relaxation');group_name=group.name
    for i,w in enumerate(mask):
        if w>0:group.add([i],float(w),'REPLACE')
    bpy.context.view_layer.objects.active=body
    modifier=body.modifiers.new('Continuous hip contours','SMOOTH')
    modifier.factor=.5;modifier.iterations=80;modifier.vertex_group=group_name
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Applying a modifier invalidates Blender's original DeformGroup handle.
    body.vertex_groups.remove(body.vertex_groups[group_name])


def build_anatomy(*,height=1.7,age='adult',skin='#b79ad6',crest='#79b25c',clay=False):
    """Fuse continuous skin before rigging; eyes, tympana and fronds stay editable."""
    import bpy
    from agent_meshes_author import make_mesh,material,fuse_meshes
    a=anatomy(height=height,age=age);objects=[];skin_parts=[]
    mats={kind:material('sprout-'+kind,color,roughness=.75) for kind,color in
          [('skin',skin),('eye','#eee9df'),('detail',skin),('crest',crest)]}
    if clay:
        neutral=material('sprout-clay','#a7adb2',roughness=.8)
        mats={kind:neutral for kind in mats}
    for p in geometry(height=height,age=age):
        obj=make_mesh(p['name'],p['vertices'],p['faces'],mats[p['kind']])
        for f in obj.data.polygons:f.use_smooth=True
        (skin_parts if p['kind']=='skin' else objects).append(obj)
    # A fixed relative voxel size preserves child-scale fingers. Fusion validates
    # one closed component; a detached finger/neck/tail must fail visibly.
    body=fuse_meshes(skin_parts,'sprout-body',voxel_size=.004*a['scale'],smooth_passes=5)
    body.data.materials.clear();body.data.materials.append(mats['skin'])
    bpy.context.view_layer.objects.active=body
    dec=body.modifiers.new('Anatomy triangle budget','DECIMATE');dec.ratio=min(1,28000/max(1,len(body.data.polygons)*2))
    bpy.ops.object.modifier_apply(modifier=dec.name)
    _smooth_hip_join(body,a)
    objects.insert(0,body)
    return objects,a
