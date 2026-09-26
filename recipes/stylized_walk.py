"""Shared in-place walk and light jog for the stylized character recipe.

Pure functions author rest joints, two-link leg targets and skin weights. The
Blender adapter binds existing named meshes and bakes the same gait into a GLB.
"""
import math
from functools import lru_cache

WALK_VERSION=2

def w_add(a,b):return tuple(x+y for x,y in zip(a,b))
def w_sub(a,b):return tuple(x-y for x,y in zip(a,b))
def w_mul(a,s):return tuple(x*s for x in a)
def w_unit(a):return w_mul(a,1/math.hypot(*a))
def w_dot(a,b):return sum(x*y for x,y in zip(a,b))
def w_smooth(lo,hi,v):
    t=max(0,min(1,(v-lo)/(hi-lo)));return t*t*(3-2*t)
def w_rotate_x(p,angle):
    x,y,z=p;c=math.cos(angle);s=math.sin(angle);return(x,y*c-z*s,y*s+z*c)

def _body_rotate(p,angles):
    """World rotation: local yaw, forward pitch, then lateral roll (Y up)."""
    yaw,pitch,roll=angles;x,y,z=p;c=math.cos(yaw);s=math.sin(yaw)
    x,y,z=w_rotate_x((c*x+s*z,y,-s*x+c*z),pitch)
    c=math.cos(roll);s=math.sin(roll)
    return (c*x-s*y,s*x+c*y,z)

def gait_settings(gait='walk'):
    """Dimensionless gait parameters; stride/lift are fractions of leg length.

    Stance rolls heel to toe at constant rearward contact speed per cycle.
    The light jog has two flight intervals because stance is less than half.
    """
    if gait=='walk':return dict(stance=.6,stride=.43,lift=.12,sway=.018,arm=.32,bend=.25,lean=.025)
    if gait=='jog':return dict(stance=.42,stride=.50,lift=.23,sway=.012,arm=.48,bend=.95,lean=.11)
    raise ValueError('gait must be walk or jog')

def gait_rotations(phase,gait='walk'):
    """Explicit torso frames retain axial twist that head/tail cannot express."""
    settings=gait_settings(gait);t=(phase%1)*math.tau
    yaw=(.075 if gait=='walk' else .095)*math.cos(t)
    roll=.018*math.sin(t)
    return {'root':(0,0,0),'pelvis':(yaw,0,roll),
            'spine':(-yaw,settings['lean'],-roll*.5),'head':(0,0,0)}

def _foot_path(phase,settings,length):
    stance=settings['stance'];stride=length*settings['stride']
    if phase<stance:return (0,stride*(.5-phase/stance))
    u=(phase-stance)/(1-stance)
    # Quintic Hermite interpolation matches stance velocity AND acceleration
    # at toe-off and next contact; unlike smoothstep it never stops at contact.
    smooth=u**3*(10+u*(-15+6*u));travel=stride*(1-stance)/stance
    z=-stride*.5-travel*u+(stride+travel)*smooth
    # Recover the foot promptly after toe-off. The monotone warped phase has
    # doubled speed at either endpoint and zero speed at mid swing; sin cubed
    # still gives zero first/second derivatives where the sole leaves ground.
    recovery=u+math.sin(math.tau*u)/math.tau if settings['stance']<.5 else u
    lift=length*settings['lift']*math.sin(math.pi*recovery)**3
    return lift,z

def _ease(t):
    t=max(0,min(1,t));return t**3*(10+t*(-15+6*t))

def _foot_roll(phase,settings):
    """Heel-led contact, flat support, toe-off, then ankle recovery (X angle)."""
    stance=settings['stance'];jog=stance<.5
    heel=-.23 if jog else -.17;toe=.52 if jog else .34
    if phase<stance:
        u=phase/stance
        if u<.23:return heel*(1-_ease(u/.23))
        return toe*_ease((u-.60)/.40)
    u=(phase-stance)/(1-stance)
    peak=.70 if jog else .40
    if u<.22:return toe+(peak-toe)*_ease(u/.22)
    # Pause angular velocity at flat so changing the compensation pivot is C2,
    # including in the air; a linear crossing would kink the ankle trajectory.
    if u<.72:return peak*(1-_ease((u-.22)/.50))
    return heel*_ease((u-.72)/.28)

@lru_cache(maxsize=1)
def _sole_pivots():
    """Unit-scale heel/toe contacts come from the actual authored outsole mesh.

    Its bottom is planar. At these roll angles the lowest point is always a
    bottom vertex at the heel or toe. Cache geometry once, then scale with body.
    """
    mesh_geometry=globals().get('geometry')
    if mesh_geometry is None:
        from stylized_character import geometry as mesh_geometry
    sole=next(p['vertices'] for p in mesh_geometry({}) if p['name']=='left-outsole')
    bottom=min(v[1] for v in sole)
    points=[(0,v[1]-.14,v[2]) for v in sole if abs(v[1]-bottom)<1e-9]
    return min(points,key=lambda v:v[2]),max(points,key=lambda v:v[2])

def foot_target(d,phase,gait='walk'):
    """Return ankle offset and roll, compensating around the planted sole.

    The material heel/toe moves rearward at stride/stance during support.
    Changing pivots at zero rotation keeps the ankle continuous. During swing
    the lowest actual outsole vertex follows the authored clearance curve.
    """
    settings=gait_settings(gait);rest=rest_bones(d)
    length=sum(math.dist(rest[n]['head'],rest[n]['tail']) for n in ['left-thigh','left-shin'])
    phase=phase%1;lift,z=_foot_path(phase,settings,length);angle=_foot_roll(phase,settings)
    pivot=w_mul(_sole_pivots()[0 if angle<0 else 1],d['s'])
    rotated=w_rotate_x(pivot,angle)
    return (0,lift-rotated[1]-.14*d['s'],z+pivot[2]-rotated[2]),angle

def rest_bones(d):
    s=d['s'];hip=d['hip_y'];shoulder=d['shoulder_y'];wrist=hip+.095*s;elbow=(wrist+shoulder)/2
    sx=d['shoulder_w']*.49;wx=sx+.092*s
    bones={}
    def add(name,head,tail,parent=None):bones[name]=dict(head=head,tail=tail,parent=parent)
    add('root',(0,0,0),(0,.1*s,0))
    add('pelvis',(0,hip,0),(0,hip+.1*s,0),'root')
    add('spine',(0,hip+.06*s,0),(0,shoulder+.04*s,0),'pelvis')
    add('head',(0,shoulder+.05*s,0),(0,d['head_y']+d['ry'],0),'spine')
    for side,name in [(-1,'left'),(1,'right')]:
        x=side*.096*s
        add(name+'-thigh',(x,hip,0),(x,hip*.53,.015*s),'pelvis')
        add(name+'-shin',(x,hip*.53,.015*s),(x,.14*s,0),name+'-thigh')
        add(name+'-foot',(x,.14*s,0),(x,.06*s,.20*s),name+'-shin')
        add(name+'-upper-arm',(side*sx,shoulder,0),(side*(wx-.015*s),elbow,.012*s),'spine')
        add(name+'-forearm',(side*(wx-.015*s),elbow,.012*s),(side*wx,wrist,.055*s),name+'-upper-arm')
        add(name+'-hand',(side*wx,wrist,.055*s),(side*wx,wrist-.12*s,.084*s),name+'-forearm')
    return bones

def _knee(hip,ankle,l1,l2):
    delta=w_sub(ankle,hip);distance=math.hypot(*delta)
    if not abs(l1-l2)+1e-6<distance<l1+l2-1e-6:raise ValueError('Walk target is outside the leg reach')
    direction=w_mul(delta,1/distance)
    bend=w_unit(w_sub((0,0,1),w_mul(direction,direction[2])))
    along=(l1*l1-l2*l2+distance*distance)/(2*distance)
    height=math.sqrt(max(0,l1*l1-along*along))
    return w_add(hip,w_add(w_mul(direction,along),w_mul(bend,height)))

def gait_pose(d,phase,gait='walk'):
    if not isinstance(phase,(int,float)) or not math.isfinite(phase):raise ValueError('phase must be finite')
    phase=phase%1;rest=rest_bones(d);s=d['s'];settings=gait_settings(gait)
    leg_length=sum(math.dist(rest[n]['head'],rest[n]['tail']) for n in ['left-thigh','left-shin'])
    if gait=='walk':dip=leg_length*(-.04+.009*math.cos(phase*math.tau*2))
    else:dip=leg_length*(-.060+.022*math.cos((phase-.46)*math.tau*2))
    shift=(-settings['sway']*s*math.sin(phase*math.tau),dip,0)
    rotations=gait_rotations(phase,gait);pose={}
    for name in ['root','pelvis','spine','head']:
        b=rest[name];parent=b['parent']
        start=w_add(b['head'],shift) if parent is None else w_add(pose[parent][0],_body_rotate(w_sub(b['head'],rest[parent]['head']),rotations[parent]))
        pose[name]=(start,w_add(start,_body_rotate(w_sub(b['tail'],b['head']),rotations[name])))
    for name,offset in [('left',0),('right',.5)]:
        p=(phase+offset)%1;foot_offset,foot_angle=foot_target(d,p,gait)
        ankle=w_add(rest[name+'-foot']['head'],foot_offset)
        hip=w_add(pose['pelvis'][0],_body_rotate(w_sub(rest[name+'-thigh']['head'],rest['pelvis']['head']),rotations['pelvis']))
        l1=math.dist(rest[name+'-thigh']['head'],rest[name+'-thigh']['tail'])
        l2=math.dist(rest[name+'-shin']['head'],rest[name+'-shin']['tail'])
        knee=_knee(hip,ankle,l1,l2)
        pose[name+'-thigh']=(hip,knee);pose[name+'-shin']=(knee,ankle)
        pose[name+'-foot']=(ankle,w_add(ankle,w_rotate_x(w_sub(rest[name+'-foot']['tail'],rest[name+'-foot']['head']),foot_angle)))
        angle=settings['arm']*math.cos((phase+offset)*math.tau)
        shoulder=w_add(pose['spine'][0],_body_rotate(w_sub(rest[name+'-upper-arm']['head'],rest['spine']['head']),rotations['spine']))
        upper=w_sub(rest[name+'-upper-arm']['tail'],rest[name+'-upper-arm']['head'])
        elbow=w_add(shoulder,_body_rotate(w_rotate_x(upper,angle),rotations['spine']))
        lower=w_sub(rest[name+'-forearm']['tail'],rest[name+'-forearm']['head'])
        bend=settings['bend']+.09*math.sin((phase+offset)*math.tau-.5)
        wrist=w_add(elbow,_body_rotate(w_rotate_x(lower,angle-bend),rotations['spine']))
        hand=w_sub(rest[name+'-hand']['tail'],rest[name+'-hand']['head'])
        pose[name+'-upper-arm']=(shoulder,elbow);pose[name+'-forearm']=(elbow,wrist)
        pose[name+'-hand']=(wrist,w_add(wrist,_body_rotate(w_rotate_x(hand,angle-bend),rotations['spine'])))
    return pose

def walk_pose(d,phase):return gait_pose(d,phase,'walk')
def jog_pose(d,phase):return gait_pose(d,phase,'jog')

def skin_weights(name,vertices,d):
    s=d['s'];hip=d['hip_y'];knee=hip*.53;shoulder=d['shoulder_y'];wrist=hip+.095*s;elbow=(wrist+shoulder)/2;sx=d['shoulder_w']*.49
    side='left' if name.startswith('left-') else 'right'
    def rigid(bone):return [{bone:1} for _ in vertices]
    if any(token in name for token in ['boot','outsole','ankle']):return rigid(side+'-foot')
    if name in ['left-hand','right-hand']:return rigid(name)
    if 'wrist-seal' in name:return rigid(side+'-forearm')
    if name in ['waist-belt']:return rigid('pelvis')
    if name in ['flight-jacket','trousers'] or 'knee-panel' in name:
        rows=[]
        for x,y,z in vertices:
            side='left' if x<0 else 'right'
            if name=='flight-jacket':
                shoulder_blend=w_smooth(shoulder-.14*s,shoulder+.02*s,y)
                arm=w_smooth(sx+.015*s-shoulder_blend*.075*s,sx+.07*s-shoulder_blend*.055*s,abs(x))
                forearm=1-w_smooth(elbow-.045*s,elbow+.045*s,y)
                torso=w_smooth(hip+.065*s,hip+.20*s,y)
                row={'pelvis':(1-arm)*(1-torso),'spine':(1-arm)*torso,side+'-upper-arm':arm*(1-forearm),side+'-forearm':arm*forearm}
            else:
                pelvis=w_smooth(hip-.15*s,hip-.035*s,y)
                lower=1-w_smooth(knee-.055*s,knee+.055*s,y)
                row={'pelvis':pelvis,side+'-thigh':(1-pelvis)*(1-lower),side+'-shin':(1-pelvis)*lower}
            rows.append({bone:value for bone,value in row.items() if value>0})
        return rows
    if name in ['chest-terminal','chest-readout','front-fastener','collar','neck','air-hose'] or name.startswith(('air-tank','tank-band')):return rigid('spine')
    return rigid('head')

def rig_character(objects,layout,duration=1.2,jog_duration=None):
    """Bind geometry and bake walk, plus optional light jog, as named actions.

    Named NLA tracks preserve both clips through the authored glTF exporter.
    Durations are rounded to the nearest frame at 60 Hz.
    """
    for value in [duration]+([] if jog_duration is None else [jog_duration]):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not .6<=value<=3:
            raise ValueError('duration must be 0.6..3 seconds')
    import bpy
    from mathutils import Matrix,Vector
    from agent_meshes_author import bind_skin
    def convert(point):x,y,z=point;return Vector((x,-z,y))
    bones=rest_bones(layout)
    def bone_name(name):return 'rig-'+name
    data=bpy.data.armatures.new('settler-skeleton');rig=bpy.data.objects.new('settler-rig',data)
    bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name,bone in bones.items():
        b=data.edit_bones.new(bone_name(name));b.head=convert(bone['head']);b.tail=convert(bone['tail'])
        if bone['parent']:b.parent=data.edit_bones[bone_name(bone['parent'])]
    bpy.ops.object.mode_set(mode='OBJECT')
    for obj in objects:
        vertices=[(v.co.x,v.co.z,-v.co.y) for v in obj.data.vertices]
        weights=[{bone_name(n):w for n,w in row.items()} for row in skin_weights(obj.name,vertices,layout)]
        bind_skin(obj,rig,weights)
        # The modifier still points to the rig. Export skins at scene root so
        # consumers do not need nonstandard parent-transform behavior for skins.
        world=obj.matrix_world.copy();obj.parent=None;obj.matrix_world=world
    fps=60;scene=bpy.context.scene;scene.render.fps=fps;scene.frame_start=0
    clips=[('walk',duration)]+([] if jog_duration is None else [('jog',jog_duration)])
    scene.frame_end=max(round(seconds*fps) for _,seconds in clips)
    rig.animation_data_create();actions=[]
    for gait,seconds in clips:
        frames=round(seconds*fps);action=bpy.data.actions.new(gait);rig.animation_data.action=action
        for frame in range(frames+1):
            phase=frame/frames;pose=gait_pose(layout,phase,gait);rotations=gait_rotations(phase,gait);matrices={}
            for name,bone in bones.items():
                start,end=map(convert,pose[name]);rest_dir=convert(bone['tail'])-convert(bone['head'])
                if name in rotations:
                    # Coordinate conjugation maps Y-up anatomical frames into
                    # Blender's Z-up frame, preserving real axial torso yaw.
                    axes=[convert(_body_rotate(v,rotations[name])) for v in [(1,0,0),(0,0,-1),(0,1,0)]]
                    delta=Matrix(axes).transposed().to_quaternion()
                else:delta=rest_dir.rotation_difference(end-start)
                rotation=delta @ data.bones[bone_name(name)].matrix_local.to_quaternion()
                matrices[name]=Matrix.Translation(start) @ rotation.to_matrix().to_4x4()
                parent=bone['parent'];rest_matrix=data.bones[bone_name(name)].matrix_local
                if parent:
                    rest_relative=data.bones[bone_name(parent)].matrix_local.inverted() @ rest_matrix
                    basis=rest_relative.inverted() @ matrices[parent].inverted() @ matrices[name]
                else:basis=rest_matrix.inverted() @ matrices[name]
                pb=rig.pose.bones[bone_name(name)];pb.rotation_mode='QUATERNION';pb.matrix_basis=basis
                pb.keyframe_insert('location',frame=frame);pb.keyframe_insert('rotation_quaternion',frame=frame)
        actions.append(action)
    if len(actions)>1:
        rig.animation_data.action=None
        for action in actions:
            track=rig.animation_data.nla_tracks.new();track.name=action.name
            track.strips.new(action.name,0,action)
    scene.frame_set(0)
    return objects+[rig]
