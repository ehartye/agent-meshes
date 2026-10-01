"""Anatomical plant-kin skeleton, source-region skinning and diagnostic poses.

The fused surface is mapped back to named source surfaces, preventing nearby
arms, legs and tail from borrowing each other's weights. No gait is implied by
the diagnostic animation clips.
"""
import math
import numpy as np
from agent_meshes_sprout_kin import geometry, hand_point, _digit_chains


def skeleton(a):
    j={n:np.array(p,float) for n,p in a['joints'].items()};s=a['scale'];bones={}
    def add(n,h,t,parent):bones[n]={'head':list(map(float,h)),'tail':list(map(float,t)),'parent':parent}
    waist=j['pelvis']*.55+j['chest']*.45
    add('root',[0,0,0],[0,0,.1*s],None)
    add('pelvis',j['pelvis'],waist,'root')
    add('spine_low',waist,j['chest'],'pelvis')
    add('spine_high',j['chest'],j['neck_base'],'spine_low')
    lower=(j['neck_base']+j['neck_mid'])/2
    add('neck_lower',j['neck_base'],lower,'spine_high')
    add('neck_middle',lower,j['neck_mid'],'neck_lower')
    add('neck_upper',j['neck_mid'],j['neck_tip'],'neck_middle')
    add('head',j['neck_tip'],j['head']+[0,0,a['head_radii'][2]],'neck_upper')
    add('tail_base',j['tail_base'],j['tail_mid'],'pelvis')
    add('tail_tip',j['tail_mid'],j['tail_tip'],'tail_base')
    for side,sign in [('l',1),('r',-1)]:
        shoulder,elbow,wrist,hand=[j[n+'_'+side] for n in ['shoulder','elbow','wrist','hand']]
        add('clavicle_'+side,j['chest'],shoulder,'spine_high')
        add('upperarm_'+side,shoulder,elbow,'clavicle_'+side)
        add('forearm_'+side,elbow,wrist,'upperarm_'+side)
        add('hand_'+side,wrist,hand+[0,0,-.03*s],'forearm_'+side)
        for name,(root,mid,tip) in _digit_chains(a,side).items():
            add(name+'_base',root,mid,'hand_'+side)
            add(name+'_tip',mid,tip,name+'_base')
        hip,knee,hock,toe=[j[n+'_'+side] for n in ['hip','knee','hock','toe']]
        add('thigh_'+side,hip,knee,'pelvis')
        add('shin_'+side,knee,hock,'thigh_'+side)
        add('metatarsal_'+side,hock,toe,'shin_'+side)
        add('toes_'+side,toe,toe+[0,-.095*s,0],'metatarsal_'+side)
        eye=j['head']+[sign*a['head_radii'][0]*.59,-a['head_radii'][1]*.82,a['head_radii'][2]*.12]
        add('eye_'+side.upper(),eye,eye+np.array([sign*.5,-math.sqrt(.75),0])*.05*s,'head')
    for side in ['l','r']:
        for name,b in bones.items():
            if name=='hand_'+side:
                b['tail']=hand_point(b['tail'],a,side).tolist()
            elif name.startswith(('finger_'+side,'thumb_'+side)):
                b['head']=hand_point(b['head'],a,side).tolist();b['tail']=hand_point(b['tail'],a,side).tolist()
    for part in geometry(height=a['height'],age=a['age'],finger_scale=a.get('finger_scale',1.),thumb_scale=a.get('thumb_scale',1.)):
        if part['kind']!='crest':continue
        i=part['name'].split('-')[1];rings=np.array(part['vertices']).reshape(-1,12,3).mean(axis=1)
        add('crest_'+i+'_base',rings[0],rings[len(rings)//2],'head')
        add('crest_'+i+'_tip',rings[len(rings)//2],rings[-1],'crest_'+i+'_base')
    return bones


def _chain(point,nodes,names):
    nodes=np.array(nodes);v=nodes[1:]-nodes[:-1]
    t=np.clip(np.sum((point-nodes[:-1])*v,axis=1)/np.sum(v*v,axis=1),0,1)
    distance=np.linalg.norm(nodes[:-1]+t[:,None]*v-point,axis=1)
    i=int(np.argmin(distance));u=t[i]
    if u<.25 and i>0:
        w=.5+.5*(u/.25);return {names[i-1]:1-w,names[i]:w} if w<1 else {names[i]:1.}
    if u>.75 and i<len(names)-1:
        w=.5*(u-.75)/.25;return {names[i]:1-w,names[i+1]:w}
    return {names[i]:1.}


def weight_function(a):
    j={n:np.array(p,float) for n,p in a['joints'].items()};bones=skeleton(a);chains={}
    def chain(key,names):
        chains[key]=([bones[n]['head'] for n in names]+[bones[names[-1]]['tail']],names)
    chain('trunk',['pelvis','spine_low','spine_high'])
    chain('neck',['spine_high','neck_lower','neck_middle','neck_upper','head'])
    chains['tail']=([j['pelvis'],j['tail_base'],j['tail_mid'],j['tail_tip']],['pelvis','tail_base','tail_tip'])
    for side in ['l','r']:
        chain('arm_'+side,['clavicle_'+side,'upperarm_'+side,'forearm_'+side,'hand_'+side])
        chains['leg_'+side]=([j['pelvis'],j['hip_'+side],j['knee_'+side],j['hock_'+side],j['toe_'+side],np.array(bones['toes_'+side]['tail'])],
                             ['pelvis','thigh_'+side,'shin_'+side,'metatarsal_'+side,'toes_'+side])
        for prefix in ['finger_'+side+'0','finger_'+side+'1','thumb_'+side]:
            chains[prefix]=([j['hand_'+side],bones[prefix+'_base']['head'],bones[prefix+'_tip']['head'],bones[prefix+'_tip']['tail']],
                            ['hand_'+side,prefix+'_base',prefix+'_tip'])
    for i in range(a['crest_count']):chain('crest-'+str(i),['crest_'+str(i)+'_base','crest_'+str(i)+'_tip'])
    def weights(point,region):
        point=np.asarray(point,dtype=float)
        if point.shape!=(3,) or not np.isfinite(point).all():raise ValueError('Skin point must contain three finite coordinates')
        if region=='bulb-head' or region.startswith('tympanum_'):return {'head':1.}
        if region.startswith('eye_'):return {'eye_'+region[-1].upper():1.}
        if region.startswith('shoulder_'):region=region.replace('shoulder_','arm_')
        if region.startswith('palm_'):region=region.replace('palm_','arm_')
        if region.startswith('hock_') or region.startswith('foot_'):region='leg_'+region.rsplit('_',1)[1]
        if region.startswith('toe_'):region='leg_'+region.split('_')[1][0]
        if region.startswith('digit-tip_'):region=region.replace('digit-tip_','finger_')
        if region.startswith('thumb-tip_'):region=region.replace('thumb-tip_','thumb_')
        if region not in chains:raise ValueError('Unknown anatomy region: '+region)
        nodes,names=chains[region];return _chain(np.array(point,float),nodes,names)
    return weights


def region_weights(point,region,anatomy):
    return weight_function(anatomy)(point,region)


def skin_regions(a,include=None):
    """Return named skin source surfaces, optionally restricted before querying."""
    parts=[p for p in geometry(height=a['height'],age=a['age'],finger_scale=a.get('finger_scale',1.),thumb_scale=a.get('thumb_scale',1.)) if p['kind']=='skin']
    if include is None:return parts
    if not isinstance(include,(list,tuple,set,frozenset)) or not include or any(not isinstance(n,str) for n in include):
        raise ValueError('A nonempty collection of skin-region names is required')
    names=set(include);unknown=names-{p['name'] for p in parts}
    if unknown:raise ValueError('Unknown skin regions: '+', '.join(sorted(unknown)))
    return [p for p in parts if p['name'] in names]


def anatomy_weights(body,a,regions=None,smooth=5,hip_seams=False,neck_seam=False,waist_seam=False,thumb_seams=False):
    """Blender mesh weights from selected anatomical source surfaces.

    Selection happens before nearest-surface lookup, so adjacent excluded limbs
    cannot donate weights to a garment. Mesh and regions use rest-space Z-up
    coordinates. Optional seam passes require their specified source regions.
    Returns rows and a provenance report; does not bind or move geometry.
    """
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    if isinstance(smooth,bool) or not isinstance(smooth,int) or smooth<0:raise ValueError('Nonnegative integer smoothing passes required')
    if not isinstance(neck_seam,bool):raise ValueError('neck_seam must be boolean')
    if not isinstance(waist_seam,bool):raise ValueError('waist_seam must be boolean')
    if not isinstance(thumb_seams,bool):raise ValueError('thumb_seams must be boolean')
    bones=skeleton(a);parts=skin_regions(a,regions);weight=weight_function(a)
    if thumb_seams and not {'palm_l','palm_r','thumb_l','thumb_r'}<={p['name'] for p in parts}:
        raise ValueError('Thumb seams require both palm and thumb source regions')
    vertices=[];faces=[];regions=[]
    for p in parts:
        if p['kind']!='skin':continue
        offset=len(vertices);vertices.extend(p['vertices'])
        for f in p['faces']:
            for k in range(1,len(f)-1):
                faces.append((offset+f[0],offset+f[k],offset+f[k+1]));regions.append(p['name'])
    tree=BVHTree.FromPolygons([Vector(v) for v in vertices],faces,all_triangles=True)
    labels=[regions[tree.find_nearest(v.co)[2]] for v in body.data.vertices]
    names=list(bones);index={n:i for i,n in enumerate(names)}
    W=np.zeros((len(body.data.vertices),len(names)))
    for v,label in zip(body.data.vertices,labels):
        for n,w in weight(v.co,label).items():W[v.index,index[n]]=w
    # Diffuse over real skin edges, never world-nearest neighbours. Fixed bulb
    # skin retains head rigidity; only connected joint seams share influences.
    edges=np.array([e.vertices[:] for e in body.data.edges]);degree=np.bincount(edges.ravel(),minlength=len(W))
    pinned=np.array([n=='bulb-head' for n in labels])
    for _ in range(smooth):
        around=np.zeros_like(W)
        np.add.at(around,edges[:,0],W[edges[:,1]]);np.add.at(around,edges[:,1],W[edges[:,0]])
        proposed=.5*W+.5*around/np.maximum(degree,1)[:,None];proposed[pinned]=W[pinned];W=proposed
    # glTF skinning keeps four influences; prune deliberately before export.
    keep=np.argsort(W,axis=1)[:,-4:];filtered=np.zeros_like(W)
    np.put_along_axis(filtered,keep,np.take_along_axis(W,keep,axis=1),axis=1)
    W=filtered/filtered.sum(axis=1)[:,None]
    rows=[{names[i]:float(w) for i,w in enumerate(row) if w>1e-8} for row in W]
    report={'sourceRegions':sorted(set(labels)),'vertices':len(W),'maxInfluences':int((W>0).sum(axis=1).max())}
    if hip_seams:
        if not {'trunk','leg_l','leg_r'}<=set(labels):raise ValueError('Hip seams require trunk and both leg sources')
        from agent_meshes_skin_relax import relax_weights
        hip=a['joints']['hip_l'][2];scale=a['scale']
        # The fused hip spans distinct source surfaces. A geometric transition
        # band avoids the abrupt pelvis/thigh switch at their nearest-face seam.
        # Stop above the knee blend; only pelvic and thigh influences diffuse.
        free=[label in ('trunk','leg_l','leg_r') and hip-.08*scale<v.co.z<hip+.07*scale
              for label,v in zip(labels,body.data.vertices)]
        seam_names={'pelvis','thigh_l','thigh_r'}
        restricted=[{n:w for n,w in row.items() if n in seam_names} or {'pelvis':1.} for row in rows]
        fitted=relax_weights([v.co[:] for v in body.data.vertices],
                             [tuple(p.vertices) for p in body.data.polygons],restricted,free,iterations=500)
        rows=[fitted[i] if active else rows[i] for i,active in enumerate(free)]
        report['hipSeamVertices']=int(sum(free))
    if neck_seam:
        if not {'neck','bulb-head'}<=set(labels):raise ValueError('Neck seam requires neck and bulb-head sources')
        from agent_meshes_skin_relax import relax_weights
        # Head-region vertices stay rigid. Diffuse their influence down the
        # connected upper neck instead of switching at the nearest-source seam.
        # Pin the lower neck and every unrelated region to its existing weights.
        free=[label=='neck' and v.co.z>a['joints']['neck_mid'][2]-.06*a['scale']
              for label,v in zip(labels,body.data.vertices)]
        fitted=relax_weights([v.co[:] for v in body.data.vertices],
                             [tuple(p.vertices) for p in body.data.polygons],rows,free,iterations=150)
        rows=[fitted[i] if active else rows[i] for i,active in enumerate(free)]
        report['neckSeamVertices']=int(sum(free))
    if waist_seam:
        if 'trunk' not in labels:raise ValueError('Waist seam requires the trunk source')
        from agent_meshes_skin_relax import relax_weights
        # The chain's short nearest-segment blend concentrates the lumbar bend
        # into a narrow strip on the deep pear trunk. Spread that transition
        # over connected trunk skin; pin adjacent limbs, hip and upper chest.
        waist=.55*a['joints']['pelvis'][2]+.45*a['joints']['chest'][2]
        free=[label=='trunk' and abs(v.co.z-waist)<.075*a['scale']
              for label,v in zip(labels,body.data.vertices)]
        fitted=relax_weights([v.co[:] for v in body.data.vertices],
                             [tuple(p.vertices) for p in body.data.polygons],rows,free,iterations=300)
        rows=[fitted[i] if active else rows[i] for i,active in enumerate(free)]
        report['waistSeamVertices']=int(sum(free))
    if thumb_seams:
        from agent_meshes_skin_relax import relax_weights
        # Shorter digit chains can expose the nearest-source transition at the
        # fused thumb root. Relax only that connected patch; distant digits and
        # all rows outside the patch retain their exact prior values.
        vertices=[v.co[:] for v in body.data.vertices]
        masks={side:[bool(np.linalg.norm(np.asarray(p)-bones['thumb_'+side+'_base']['head'])<.03*a['scale']
                         and row.get('thumb_'+side+'_base',0)+row.get('thumb_'+side+'_tip',0)>.01)
                     for p,row in zip(vertices,rows)] for side in ('l','r')}
        free=[l or r for l,r in zip(masks['l'],masks['r'])]
        fitted=relax_weights(vertices,[tuple(p.vertices) for p in body.data.polygons],rows,free,iterations=20)
        # A hard mask endpoint can move the last relaxed vertex away from its
        # pinned neighbour and introduce a new fold. Fade the correction over
        # the outer third of the radius; retain exact original rows outside it.
        result=[]
        for i,(point,row,active) in enumerate(zip(vertices,rows,free)):
            if not active:result.append(row);continue
            distance=min(np.linalg.norm(np.asarray(point)-bones['thumb_'+side+'_base']['head'])
                         for side in ('l','r') if masks[side][i])
            t=float(np.clip((.03*a['scale']-distance)/(.01*a['scale']),0,1))
            blend=t*t*(3-2*t)
            mixed={n:(1-blend)*row.get(n,0)+blend*fitted[i].get(n,0) for n in sorted(set(row)|set(fitted[i]))}
            top=sorted(mixed.items(),key=lambda item:-item[1])[:4];total=sum(w for _,w in top)
            result.append({n:w/total for n,w in top if w>1e-12})
        rows=result
        report['thumbSeamVertices']=int(sum(free))
        report['thumbSeamVerticesBySide']={side:int(sum(mask)) for side,mask in masks.items()}
    return rows,report


def rig_anatomy(objects,a,diagnostics=True,*,thumb_seams=False):
    """Bind the shared fused anatomy; export all skins at scene root."""
    import bpy
    from mathutils import Vector,Quaternion
    from mathutils.bvhtree import BVHTree
    from agent_meshes_author import bind_skin
    bones=skeleton(a);weight=weight_function(a)
    body=next(o for o in objects if o.name=='sprout-body')
    rows,skin_report=anatomy_weights(body,a,hip_seams=True,neck_seam=True,waist_seam=True,thumb_seams=thumb_seams)
    data=bpy.data.armatures.new('sprout-skeleton');arm=bpy.data.objects.new('sprout-rig',data)
    bpy.context.scene.collection.objects.link(arm);bpy.context.view_layer.objects.active=arm;arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for n,b in bones.items():
        eb=data.edit_bones.new(n);eb.head=b['head'];eb.tail=b['tail']
        if b['parent']:eb.parent=data.edit_bones[b['parent']]
    bpy.ops.object.mode_set(mode='OBJECT')
    names=list(bones)
    for obj in objects:
        weights=rows if obj==body else [weight(v.co,obj.name) for v in obj.data.vertices]
        bind_skin(obj,arm,weights)
        matrix=obj.matrix_world.copy();obj.parent=None;obj.matrix_world=matrix
    arm.animation_data_create()
    if diagnostics:
        poses={
          'check-arms':{'forearm_l':((-1,0,0),65),'forearm_r':((-1,0,0),65),
                        'upperarm_l':((0,1,0),-30),'upperarm_r':((0,1,0),30)},
          'check-legs':{'thigh_l':((-1,0,0),30),'shin_l':((1,0,0),30),'metatarsal_l':((-1,0,0),25),
                        'toes_l':((1,0,0),20)},
          'check-legs-right':{'thigh_r':((-1,0,0),30),'shin_r':((1,0,0),30),'metatarsal_r':((-1,0,0),25),
                              'toes_r':((1,0,0),20)},
          'check-spine':{'pelvis':((0,0,1),8),'spine_low':((1,0,0),20),'spine_high':((1,0,0),-10)},
          'check-neck-tail':{'neck_lower':((1,0,0),15),'neck_middle':((1,0,0),-12),'neck_upper':((1,0,0),-15),
                             'head':((0,0,1),22),'tail_base':((0,0,1),30),'tail_tip':((0,0,1),20)},
          'check-hands-crest':{n:(((0,1 if '_l' in n else -1,0) if n.startswith(('finger','thumb')) else (0,1,0)),
                                  45 if n.startswith(('finger','thumb')) else (int(n.split('_')[1])-(a['crest_count']-1)/2)*12)
                               for n in names if n.startswith(('finger','thumb','crest'))}
        }
        bpy.context.scene.render.fps=30
        for clip,targets in poses.items():
            action=bpy.data.actions.new(clip);arm.animation_data.action=action
            for frame in range(61):
                amplitude=math.sin(math.pi*frame/60)**2
                for n in names:
                    pb=arm.pose.bones[n];pb.rotation_mode='QUATERNION';pb.location=(0,0,0);pb.scale=(1,1,1)
                    if n in targets:
                        axis,angle=targets[n];local=pb.bone.matrix_local.to_3x3().inverted()@Vector(axis)
                        pb.rotation_quaternion=Quaternion(local,math.radians(angle)*amplitude)
                    else:pb.rotation_quaternion=(1,0,0,0)
                    pb.keyframe_insert('rotation_quaternion',frame=frame)
            arm.animation_data.action=None
            track=arm.animation_data.nla_tracks.new();track.name=clip;track.strips.new(clip,0,action)
        for pb in arm.pose.bones:pb.matrix_basis.identity()
        bpy.context.scene.frame_set(0)
    return [*objects,arm],{'bones':bones,**skin_report}
