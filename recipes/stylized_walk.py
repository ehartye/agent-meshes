"""Shared in-place walk for the stylized character recipe.

Pure functions author rest joints, two-link leg targets and skin weights. The
Blender adapter binds existing named meshes and bakes the same gait into a GLB.
"""
import math

WALK_VERSION=1

def w_add(a,b):return tuple(x+y for x,y in zip(a,b))
def w_sub(a,b):return tuple(x-y for x,y in zip(a,b))
def w_mul(a,s):return tuple(x*s for x in a)
def w_unit(a):return w_mul(a,1/math.hypot(*a))
def w_dot(a,b):return sum(x*y for x,y in zip(a,b))
def w_smooth(lo,hi,v):
    t=max(0,min(1,(v-lo)/(hi-lo)));return t*t*(3-2*t)
def w_rotate_x(p,angle):
    x,y,z=p;c=math.cos(angle);s=math.sin(angle);return(x,y*c-z*s,y*s+z*c)

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

def walk_pose(d,phase):
    if not isinstance(phase,(int,float)) or not math.isfinite(phase):raise ValueError('phase must be finite')
    phase=phase%1;rest=rest_bones(d);s=d['s']
    leg_length=sum(math.dist(rest[n]['head'],rest[n]['tail']) for n in ['left-thigh','left-shin'])
    dip=-leg_length*(.03+.006*(.5+.5*math.cos(phase*math.tau*2)))
    shift=(0,dip,0)
    pose={n:(w_add(b['head'],shift),w_add(b['tail'],shift)) for n,b in rest.items()}
    for name,offset in [('left',0),('right',.5)]:
        p=(phase+offset)%1;stride=leg_length*.43
        if p<.6:z=stride*(.5-p/.6);lift=0
        else:
            u=(p-.6)/.4;z=stride*(-.5+u*u*(3-2*u));lift=leg_length*.12*math.sin(math.pi*u)**1.3
        ankle=w_add(rest[name+'-foot']['head'],(0,lift,z))
        hip=pose[name+'-thigh'][0]
        l1=math.dist(rest[name+'-thigh']['head'],rest[name+'-thigh']['tail'])
        l2=math.dist(rest[name+'-shin']['head'],rest[name+'-shin']['tail'])
        knee=_knee(hip,ankle,l1,l2)
        pose[name+'-thigh']=(hip,knee);pose[name+'-shin']=(knee,ankle)
        pose[name+'-foot']=(ankle,w_add(ankle,w_sub(rest[name+'-foot']['tail'],rest[name+'-foot']['head'])))
        angle=.29*math.cos((phase+offset)*math.tau)
        shoulder=pose[name+'-upper-arm'][0]
        upper=w_sub(rest[name+'-upper-arm']['tail'],rest[name+'-upper-arm']['head'])
        elbow=w_add(shoulder,w_rotate_x(upper,angle))
        lower=w_sub(rest[name+'-forearm']['tail'],rest[name+'-forearm']['head'])
        wrist=w_add(elbow,w_rotate_x(lower,angle-.13))
        hand=w_sub(rest[name+'-hand']['tail'],rest[name+'-hand']['head'])
        pose[name+'-upper-arm']=(shoulder,elbow);pose[name+'-forearm']=(elbow,wrist)
        pose[name+'-hand']=(wrist,w_add(wrist,w_rotate_x(hand,angle-.13)))
    return pose

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
                row={'spine':1-arm,side+'-upper-arm':arm*(1-forearm),side+'-forearm':arm*forearm}
            else:
                pelvis=w_smooth(hip-.15*s,hip-.035*s,y)
                lower=1-w_smooth(knee-.055*s,knee+.055*s,y)
                row={'pelvis':pelvis,side+'-thigh':(1-pelvis)*(1-lower),side+'-shin':(1-pelvis)*lower}
            rows.append({bone:value for bone,value in row.items() if value>0})
        return rows
    if name in ['chest-terminal','chest-readout','front-fastener','collar','neck','air-hose'] or name.startswith(('air-tank','tank-band')):return rigid('spine')
    return rigid('head')

def rig_character(objects,layout,duration=1.2):
    """Bind named character geometry and bake a looping 60 Hz walk action."""
    if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or not .6<=duration<=3:
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
    fps=60;frames=round(duration*fps);scene=bpy.context.scene;scene.render.fps=fps;scene.frame_start=0;scene.frame_end=frames
    for frame in range(frames+1):
        pose=walk_pose(layout,frame/frames);matrices={}
        for name,bone in bones.items():
            start,end=map(convert,pose[name]);rest_dir=convert(bone['tail'])-convert(bone['head'])
            delta=rest_dir.rotation_difference(end-start)
            rotation=delta @ data.bones[bone_name(name)].matrix_local.to_quaternion()
            matrices[name]=Matrix.Translation(start) @ rotation.to_matrix().to_4x4()
            parent=bone['parent'];rest_matrix=data.bones[bone_name(name)].matrix_local
            if parent:
                rest_relative=data.bones[bone_name(parent)].matrix_local.inverted() @ rest_matrix
                basis=rest_relative.inverted() @ matrices[parent].inverted() @ matrices[name]
            else:basis=rest_matrix.inverted() @ matrices[name]
            pb=rig.pose.bones[bone_name(name)];pb.rotation_mode='QUATERNION';pb.matrix_basis=basis
            pb.keyframe_insert('location',frame=frame);pb.keyframe_insert('rotation_quaternion',frame=frame)
    rig.animation_data.action.name='walk'
    scene.frame_set(0)
    return objects+[rig]
