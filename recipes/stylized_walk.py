"""Shared in-place walk and light jog for the stylized character recipe.

Pure functions author rest joints, two-link leg targets and skin weights. The
Blender adapter binds existing named meshes and bakes the same gait into a GLB.
"""
import math
from functools import lru_cache

WALK_VERSION=3

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

# Phase 0 is the touchdown of the rig-left foot (-X, the anatomical right of a
# figure facing +Z); the rig-right foot lands half a cycle later.
#
# Leg timing, fractions of the cycle or of leg length:
#   stance: duty factor. A jog below .5 has two flight intervals.
#   stride: rearward contact travel during stance.
#   lift: swing clearance (fractions of leg length), B-spline control points
#   over swing progress; reach: the same, added to the fore-aft swing path
#   (fractions of stride).
#   heel/toe/peak: sole roll in radians (positive points the toe down) at
#   heel strike, toe-off and in early swing; heel_flat/toe_from end the heel
#   rocker and start the toe rocker within stance; peak_at/flat_at time swing.
#   arm, arm_phase, bend: shoulder swing (rad), its lag, and elbow bend.
#
# Body curves follow the symmetric part of Mesh2Motion's CC0 Walk_Loop and
# Jog_Fwd_Loop (github.com/Mesh2Motion/mesh2motion-app): each shape is
# harmonics (k, cos, sin) normalized to unit amplitude and shifted to this
# phase convention; amplitudes follow human gait ranges.
#   base, bob: pelvis height offset and half range, fractions of leg length.
#   roll: pelvis roll (deg); positive raises the +X hip.
#   lean, lumbar: mean forward chest lean (deg) and the lumbar's share of it.
#   pitch: chest pitch half range (deg), shared by lumbar and chest.
#   head: head pitch half range as a fraction of the chest's.
#   yaw, chest_yaw: pelvis turn with the forward leg; chest turn against it.
#   body_phase: delay of the body curves relative to the feet.
GAITS={
    'walk':dict(stance=.591,stride=.478,sway=.018,arm=.32,arm_phase=-.1,bend=.25,
                lift=[.0674,.102,.116,.0941,.107,.146,.101,.0369],
                reach=[-.0475,.0785,-.131,-.256,.0454,.31,.0485,.052],
                heel=-.0605,toe=.83,peak=1.07,heel_flat=.159,toe_from=.683,peak_at=.291,flat_at=.756,
                base=-.0329,bob=.0239,bob_shape=[(2,-.636,-.772)],
                roll=4.5,roll_shape=[(1,.992,.126)],
                lean=5.98,lumbar=.55,pitch=1.8,pitch_shape=[(2,-.98,.199)],
                head=.5,head_lean=2.0,head_shape=[(2,-.93,-.337),(4,.079,-.028)],
                yaw=4.5,chest_yaw=3.5,yaw_phase=0,body_phase=-.0587),
    'jog':dict(stance=.42,stride=.50,lift=[.1,.2,.25,.25,.2,.1],reach=[],sway=.012,arm=.48,arm_phase=0,bend=.95,
               heel=-.23,toe=.52,peak=.70,heel_flat=.23,toe_from=.60,peak_at=.22,flat_at=.72,
               base=-.06,bob=.022,bob_shape=[(2,-.469,-.873),(4,.131,-.1)],
               roll=5.0,roll_shape=[(1,-.888,.473),(3,-.052,-.026)],
               lean=12.0,lumbar=.55,pitch=3.0,pitch_shape=[(2,-.757,-.541),(4,.177,-.086)],
               head=.5,head_lean=4.0,head_shape=[(2,-.95,.273),(4,-.071,-.046)],
               yaw=6.0,chest_yaw=8.0,yaw_phase=0,body_phase=0),
}
TORSO=['root','pelvis','spine','chest','neck','head']

def gait_settings(gait='walk'):
    """Dimensionless gait parameters; stride/lift are fractions of leg length.

    Stance rolls heel to toe at constant rearward contact speed per cycle.
    """
    if gait not in GAITS:raise ValueError('gait must be walk or jog')
    return {k:(list(v) if isinstance(v,list) else v) for k,v in GAITS[gait].items()}

def _series(phase,terms):
    return sum(a*math.cos(math.tau*k*phase)+b*math.sin(math.tau*k*phase) for k,a,b in terms)

def body_height(phase,settings,leg_length):
    """Pelvis height offset from rest: low after contact, high mid-stance or in flight."""
    return leg_length*(settings['base']+settings['bob']*_series(phase-settings['body_phase'],settings['bob_shape']))

def gait_rotations(phase,gait='walk',settings=None):
    """World (yaw, pitch, roll) of each torso joint in radians.

    Explicit frames retain the axial twist that head/tail cannot express. The
    pelvis turns and rolls, the lumbar and chest share the lean and counter-turn,
    and the neck lets the head pitch through only part of the chest's range.
    """
    s=settings or gait_settings(gait);p=(phase%1)-s['body_phase'];r=math.radians
    yaw=r(s['yaw'])*math.cos(math.tau*(phase-s['yaw_phase']))
    chest_yaw=-r(s['chest_yaw'])*math.cos(math.tau*(phase-s['yaw_phase']))
    roll=r(s['roll'])*_series(p,s['roll_shape'])
    pitch=r(s['pitch'])*_series(p,s['pitch_shape']);lean=r(s['lean']);share=s['lumbar']
    head=r(s['head_lean'])+r(s['pitch'])*s['head']*_series(p,s['head_shape'])
    chest=lean+pitch
    return {'root':(0,0,0),'pelvis':(yaw,0,roll),
            'spine':((yaw+chest_yaw)*.5,share*chest,roll*.4),
            'chest':(chest_yaw,chest,roll*.1),
            'neck':(chest_yaw*.5,(chest+head)*.5,0),
            'head':(0,head,0)}

def _foot_path(phase,settings,length):
    stance=settings['stance'];stride=length*settings['stride']
    if phase<stance:return (0,stride*(.5-phase/stance))
    u=(phase-stance)/(1-stance)
    # Continuing the stance travel and adding a septic smoothstep matches stance
    # velocity, acceleration and jerk at toe-off and at the next contact.
    travel=stride*(1-stance)/stance
    z=-stride*.5-travel*u+(stride+travel)*_ease(u)
    # Both profiles are exactly zero near toe-off and touchdown, so they add no
    # velocity, acceleration or jerk where the sole leaves or meets the ground.
    z+=stride*_profile(u,settings['reach'])
    return length*_profile(u,settings['lift']),z

def _profile(u,points):
    """Uniform cubic B-spline over swing progress u through `points`, padded with
    four zero control points at each end (the first and last spans vanish)."""
    if not points:return 0.0
    p=[0]*4+list(points)+[0]*4;spans=len(p)-3;x=max(0,min(1,u))*spans;k=min(int(x),spans-1);t=x-k
    w=((1-t)**3,3*t**3-6*t*t+4,-3*t**3+3*t*t+3*t+1,t**3)
    return sum(a*b for a,b in zip(w,p[k:k+4]))/6

def _ease(t):
    """Septic smoothstep: zero velocity, acceleration and jerk at both ends, so a
    sole roll that starts or ends at a contact change adds no velocity pop."""
    t=max(0,min(1,t));return t**4*(35+t*(-84+t*(70-20*t)))

def _foot_roll(phase,settings):
    """Heel-led contact, flat support, toe-off, then ankle recovery (X angle)."""
    stance=settings['stance'];heel=settings['heel'];toe=settings['toe'];peak=settings['peak']
    if phase<stance:
        u=phase/stance;flat=settings['heel_flat'];start=settings['toe_from']
        if u<flat:return heel*(1-_ease(u/flat))
        return toe*_ease((u-start)/(1-start))
    u=(phase-stance)/(1-stance);at=settings['peak_at'];level=settings['flat_at']
    if u<at:return toe+(peak-toe)*_ease(u/at)
    # Pause angular velocity at flat so changing the compensation pivot is C2,
    # including in the air; a linear crossing would kink the ankle trajectory.
    if u<level:return peak*(1-_ease((u-at)/(level-at)))
    return heel*_ease((u-level)/(1-level))

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

def leg_length(d):
    rest=rest_bones(d);return sum(math.dist(rest[n]['head'],rest[n]['tail']) for n in ['left-thigh','left-shin'])

def foot_target(d,phase,gait='walk',settings=None):
    """Return ankle offset and roll, compensating around the planted sole.

    The material heel/toe moves rearward at stride/stance during support.
    Changing pivots at zero rotation keeps the ankle continuous. During swing
    the lowest actual outsole vertex follows the authored clearance curve.
    """
    settings=settings or gait_settings(gait);length=leg_length(d)
    phase=phase%1;lift,z=_foot_path(phase,settings,length);angle=_foot_roll(phase,settings)
    pivot=w_mul(_sole_pivots()[0 if angle<0 else 1],d['s'])
    rotated=w_rotate_x(pivot,angle)
    return (0,lift-rotated[1]-.14*d['s'],z+pivot[2]-rotated[2]),angle

def travel_speed(d,gait='walk',seconds=1.0,settings=None):
    """Ground speed (m/s) the in-place loop represents: stance contact travel over stance time."""
    s=settings or gait_settings(gait);return leg_length(d)*s['stride']/(s['stance']*seconds)

def rest_bones(d):
    s=d['s'];hip=d['hip_y'];shoulder=d['shoulder_y'];wrist=hip+.095*s;elbow=(wrist+shoulder)/2
    sx=d['shoulder_w']*.49;wx=sx+.092*s;waist=hip+(shoulder-hip)*.45;skull=d['head_y']-d['ry']*.5
    bones={}
    def add(name,head,tail,parent=None):bones[name]=dict(head=head,tail=tail,parent=parent)
    add('root',(0,0,0),(0,.1*s,0))
    add('pelvis',(0,hip,0),(0,hip+.1*s,0),'root')
    add('spine',(0,hip+.06*s,0),(0,waist,0),'pelvis')
    add('chest',(0,waist,0),(0,shoulder+.04*s,0),'spine')
    add('neck',(0,shoulder+.05*s,0),(0,skull,0),'chest')
    add('head',(0,skull,0),(0,d['head_y']+d['ry'],0),'neck')
    for side,name in [(-1,'left'),(1,'right')]:
        x=side*.096*s
        add(name+'-thigh',(x,hip,0),(x,hip*.53,.015*s),'pelvis')
        add(name+'-shin',(x,hip*.53,.015*s),(x,.14*s,0),name+'-thigh')
        add(name+'-foot',(x,.14*s,0),(x,.06*s,.20*s),name+'-shin')
        add(name+'-upper-arm',(side*sx,shoulder,0),(side*(wx-.015*s),elbow,.012*s),'chest')
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

def gait_pose(d,phase,gait='walk',settings=None):
    if not isinstance(phase,(int,float)) or not math.isfinite(phase):raise ValueError('phase must be finite')
    phase=phase%1;rest=rest_bones(d);s=d['s'];settings=settings or gait_settings(gait)
    length=leg_length(d)
    shift=(-settings['sway']*s*math.sin(phase*math.tau),body_height(phase,settings,length),0)
    rotations=gait_rotations(phase,gait,settings);pose={}
    for name in TORSO:
        b=rest[name];parent=b['parent']
        start=w_add(b['head'],shift) if parent is None else w_add(pose[parent][0],_body_rotate(w_sub(b['head'],rest[parent]['head']),rotations[parent]))
        pose[name]=(start,w_add(start,_body_rotate(w_sub(b['tail'],b['head']),rotations[name])))
    for name,offset in [('left',0),('right',.5)]:
        p=(phase+offset)%1;foot_offset,foot_angle=foot_target(d,p,gait,settings)
        ankle=w_add(rest[name+'-foot']['head'],foot_offset)
        hip=w_add(pose['pelvis'][0],_body_rotate(w_sub(rest[name+'-thigh']['head'],rest['pelvis']['head']),rotations['pelvis']))
        l1=math.dist(rest[name+'-thigh']['head'],rest[name+'-thigh']['tail'])
        l2=math.dist(rest[name+'-shin']['head'],rest[name+'-shin']['tail'])
        knee=_knee(hip,ankle,l1,l2)
        pose[name+'-thigh']=(hip,knee);pose[name+'-shin']=(knee,ankle)
        pose[name+'-foot']=(ankle,w_add(ankle,w_rotate_x(w_sub(rest[name+'-foot']['tail'],rest[name+'-foot']['head']),foot_angle)))
        # Arms counterswing their own leg: back at that foot's touchdown.
        swing=math.tau*(p-settings['arm_phase']);angle=settings['arm']*math.cos(swing);frame=rotations['chest']
        shoulder=w_add(pose['chest'][0],_body_rotate(w_sub(rest[name+'-upper-arm']['head'],rest['chest']['head']),frame))
        upper=w_sub(rest[name+'-upper-arm']['tail'],rest[name+'-upper-arm']['head'])
        elbow=w_add(shoulder,_body_rotate(w_rotate_x(upper,angle),frame))
        lower=w_sub(rest[name+'-forearm']['tail'],rest[name+'-forearm']['head'])
        bend=settings['bend']+.09*math.sin(swing-.5)
        wrist=w_add(elbow,_body_rotate(w_rotate_x(lower,angle-bend),frame))
        hand=w_sub(rest[name+'-hand']['tail'],rest[name+'-hand']['head'])
        pose[name+'-upper-arm']=(shoulder,elbow);pose[name+'-forearm']=(elbow,wrist)
        pose[name+'-hand']=(wrist,w_add(wrist,_body_rotate(w_rotate_x(hand,angle-bend),frame)))
    return pose

def walk_pose(d,phase):return gait_pose(d,phase,'walk')
def jog_pose(d,phase):return gait_pose(d,phase,'jog')

def _torso_row(y,d):
    """Pelvis, lumbar and chest weights up the trunk, blended across each joint."""
    s=d['s'];hip=d['hip_y'];waist=hip+(d['shoulder_y']-hip)*.45
    lumbar=w_smooth(hip+.065*s,hip+.20*s,y);chest=w_smooth(waist-.06*s,waist+.06*s,y)
    return {'pelvis':1-lumbar,'spine':lumbar*(1-chest),'chest':lumbar*chest}

def skin_weights(name,vertices,d):
    s=d['s'];hip=d['hip_y'];knee=hip*.53;shoulder=d['shoulder_y'];wrist=hip+.095*s;elbow=(wrist+shoulder)/2;sx=d['shoulder_w']*.49
    side='left' if name.startswith('left-') else 'right'
    def rigid(bone):return [{bone:1} for _ in vertices]
    def clean(row):return {bone:value for bone,value in row.items() if value>0}
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
                row={bone:(1-arm)*w for bone,w in _torso_row(y,d).items()}
                row.update({side+'-upper-arm':arm*(1-forearm),side+'-forearm':arm*forearm})
            else:
                pelvis=w_smooth(hip-.15*s,hip-.035*s,y)
                lower=1-w_smooth(knee-.055*s,knee+.055*s,y)
                row={'pelvis':pelvis,side+'-thigh':(1-pelvis)*(1-lower),side+'-shin':(1-pelvis)*lower}
            rows.append(clean(row))
        return rows
    if name=='neck':
        # Chest at the collar, the neck joint along its length, the head under the skull.
        skull=d['head_y']-d['ry']*.5
        return [clean({'chest':1-w_smooth(shoulder,shoulder+.05*s,y),'neck':w_smooth(shoulder,shoulder+.05*s,y)*(1-w_smooth(skull-.04*s,skull+.01*s,y)),
                       'head':w_smooth(skull-.04*s,skull+.01*s,y)}) for _,y,_ in vertices]
    if name=='front-fastener':return [clean(_torso_row(y,d)) for _,y,_ in vertices]
    if name in ['chest-terminal','chest-readout','collar','air-hose'] or name.startswith(('air-tank','tank-band')):return rigid('chest')
    return rigid('head')

def rig_character(objects,layout,duration=1.2,jog_duration=None):
    """Bind geometry and bake walk, plus optional light jog, as named actions.

    Named NLA tracks preserve both clips through the authored glTF exporter.
    Durations are rounded to the nearest frame at 60 Hz. The rig carries
    `agent-meshes/gait/1` extras: height, stance, contact phases and travel speed.
    """
    for value in [duration]+([] if jog_duration is None else [jog_duration]):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not .6<=value<=3:
            raise ValueError('duration must be 0.6..3 seconds')
    import json
    import bpy
    from mathutils import Matrix,Vector
    from agent_meshes_author import bind_skin,EXTRAS_PROPERTY
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
    rig.animation_data_create();actions=[];declared={}
    for gait,seconds in clips:
        frames=round(seconds*fps);action=bpy.data.actions.new(gait);rig.animation_data.action=action
        settings=gait_settings(gait)
        declared[gait]={'stance':settings['stance'],'travelSpeed':travel_speed(layout,gait,frames/fps),
                        'contactPhase':{bone_name('left-foot'):0,bone_name('right-foot'):.5}}
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
    extras=json.loads(rig.get(EXTRAS_PROPERTY,'{}'))
    extras['gait']={'format':'agent-meshes/gait/1','version':WALK_VERSION,'height':layout['h'],'clips':declared}
    rig[EXTRAS_PROPERTY]=json.dumps(extras)
    scene.frame_set(0)
    return objects+[rig]
