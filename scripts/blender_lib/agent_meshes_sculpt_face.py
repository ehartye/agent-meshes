"""Fit bilateral lids and restrained expressions to an existing skinned sculpt.

This is not the complete ARKit contract: jaw, teeth, gaze and speech remain
separate work. Blender imports are lazy so field/timing checks run in NumPy.
"""
import math
import numpy as np


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
